import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

const COOKIE_NAME = "rf_monitor_admin";
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_GLOBAL_DERIVATIONS = 2;
const MAX_TRACKED_FAILURE_CLIENTS = 1_024;

export interface AdminCredentialFile {
  schemaVersion: 1;
  algorithm: "scrypt";
  salt: string;
  hash: string;
  keyLength: number;
  cost: number;
  blockSize: number;
  parallelization: number;
  sessionSecret: string;
  createdAt: string;
}

interface SessionRecord {
  ip: string;
  expiresAt: number;
}

function deriveKey(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export class AdminAuthenticationError extends Error {
  constructor(message: string, readonly status: 401 | 429 | 503) {
    super(message);
    this.name = "AdminAuthenticationError";
  }
}

export async function createAdminCredential(password: string): Promise<AdminCredentialFile> {
  if (password.length < 12 || password.length > 128) throw new Error("Settings password must contain 12 to 128 characters");
  const salt = randomBytes(24);
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const keyLength = 64;
  const hash = await deriveKey(password, salt, keyLength, { N: cost, r: blockSize, p: parallelization, maxmem: 64 * 1024 * 1024 });
  return {
    schemaVersion: 1,
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    keyLength,
    cost,
    blockSize,
    parallelization,
    sessionSecret: randomBytes(48).toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

export class AdminAuth {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly failures = new Map<string, number[]>();
  private readonly derivationsByIp = new Set<string>();
  private activeDerivations = 0;

  private constructor(private readonly credential: AdminCredentialFile | undefined, private readonly sessionMs: number) {}

  static async load(filePath: string, sessionMs: number): Promise<AdminAuth> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as AdminCredentialFile;
      if (parsed.schemaVersion !== 1 || parsed.algorithm !== "scrypt" || !parsed.salt || !parsed.hash || !parsed.sessionSecret) {
        throw new Error("unsupported credential format");
      }
      return new AdminAuth(parsed, sessionMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new AdminAuth(undefined, sessionMs);
      throw new Error(`Settings administrator file is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get available(): boolean {
    return Boolean(this.credential);
  }

  async unlock(password: string, ip: string): Promise<{ cookie: string; expiresAt: string }> {
    if (!this.credential) throw new AdminAuthenticationError("Settings password has not been configured. Run sudo rf-monitor reset-admin-password.", 503);
    const now = Date.now();
    this.pruneFailures(now);
    const recent = this.failures.get(ip) ?? [];
    if (recent.length >= MAX_FAILURES) throw new AdminAuthenticationError("Too many failed attempts. Wait 15 minutes or reset the password locally.", 429);
    if (this.derivationsByIp.has(ip)) {
      throw new AdminAuthenticationError("A settings unlock attempt is already being checked for this client.", 429);
    }
    if (this.activeDerivations >= MAX_GLOBAL_DERIVATIONS) {
      throw new AdminAuthenticationError("Settings unlock is busy. Retry shortly.", 503);
    }
    if (!this.failures.has(ip) && this.failures.size >= MAX_TRACKED_FAILURE_CLIENTS) {
      throw new AdminAuthenticationError("Settings unlock tracking is busy. Retry after the 15-minute attempt window.", 503);
    }

    // Reserve the attempt before yielding to scrypt. Without this reservation,
    // a concurrent burst observes the same failure count and queues many
    // memory-hard derivations before the first failure is recorded.
    this.failures.set(ip, [...recent, now]);
    this.derivationsByIp.add(ip);
    this.activeDerivations += 1;
    try {
      const salt = Buffer.from(this.credential.salt, "base64");
      const expected = Buffer.from(this.credential.hash, "base64");
      const actual = await deriveKey(password, salt, this.credential.keyLength, {
        N: this.credential.cost,
        r: this.credential.blockSize,
        p: this.credential.parallelization,
        maxmem: 64 * 1024 * 1024,
      });
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new AdminAuthenticationError("Incorrect settings password", 401);
      }
      this.failures.delete(ip);
      const id = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + this.sessionMs;
      this.sessions.set(id, { ip, expiresAt });
      return { cookie: this.signedToken(id), expiresAt: new Date(expiresAt).toISOString() };
    } finally {
      this.derivationsByIp.delete(ip);
      this.activeDerivations = Math.max(0, this.activeDerivations - 1);
    }
  }

  session(cookieHeader: string | undefined, ip: string, refresh = true): { unlocked: boolean; expiresAt?: string; id?: string } {
    if (!this.credential) return { unlocked: false };
    const signed = parseCookie(cookieHeader)[COOKIE_NAME];
    if (!signed) return { unlocked: false };
    const separator = signed.lastIndexOf(".");
    if (separator < 1) return { unlocked: false };
    const id = signed.slice(0, separator);
    const signature = signed.slice(separator + 1);
    const expected = this.signature(id);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return { unlocked: false };
    const record = this.sessions.get(id);
    if (!record || record.ip !== ip || record.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return { unlocked: false };
    }
    if (refresh) record.expiresAt = Date.now() + this.sessionMs;
    return { unlocked: true, expiresAt: new Date(record.expiresAt).toISOString(), id };
  }

  lock(cookieHeader: string | undefined, ip: string): void {
    const current = this.session(cookieHeader, ip, false);
    if (current.id) this.sessions.delete(current.id);
  }

  cookieHeader(signedToken: string, secure: boolean): string {
    return `${COOKIE_NAME}=${encodeURIComponent(signedToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionMs / 1_000)}${secure ? "; Secure" : ""}`;
  }

  clearCookieHeader(secure: boolean): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  private signedToken(id: string): string {
    return `${id}.${this.signature(id)}`;
  }

  private signature(id: string): string {
    return createHmac("sha256", Buffer.from(this.credential!.sessionSecret, "base64")).update(id).digest("base64url");
  }

  private pruneFailures(now: number): void {
    for (const [client, timestamps] of this.failures) {
      const recent = timestamps.filter((timestamp) => now - timestamp < FAILURE_WINDOW_MS);
      if (recent.length) this.failures.set(client, recent);
      else this.failures.delete(client);
    }
  }
}
