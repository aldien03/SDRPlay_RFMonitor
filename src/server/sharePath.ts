import path from "node:path";

const FORBIDDEN_PREFIXES = ["/home", "/root", "/run/user", "/tmp", "/var/tmp", "/proc", "/sys", "/dev", "/etc", "/usr", "/boot", "/bin", "/sbin", "/lib", "/opt"];

/**
 * Why a folder may not be used as the user-readable evidence share, or undefined when it is fine.
 *
 * The service runs with ProtectHome and a strict file system, and the share is written by it, so the
 * folder has to be an ordinary, absolute, space-free path outside the evidence store, home folders and
 * system directories. The same rules are enforced by the installer command and the deploy code.
 */
export function sharePathProblem(candidate: string, protectedRoots: readonly string[] = []): string | undefined {
  if (!candidate || !path.isAbsolute(candidate)) return "must be an absolute path";
  if (candidate.replace(/\/+$/, "") === "") return "must not be the file system root";
  if (!/^\/[A-Za-z0-9._@/+-]+$/.test(candidate)) return "may contain only letters, digits and . _ @ + - /";
  if (candidate.split("/").some((part) => part === "..")) return "must not contain ..";
  const normalized = path.posix.normalize(candidate).replace(/\/+$/, "");
  if (normalized !== candidate.replace(/\/+$/, "")) return "must be a clean path";
  if (normalized === "" || normalized === "/") return "must not be the file system root";
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return `must not be inside ${prefix}`;
  }
  for (const root of protectedRoots) {
    const resolved = path.posix.normalize(root).replace(/\/+$/, "");
    if (resolved && (normalized === resolved || normalized.startsWith(`${resolved}/`) || resolved.startsWith(`${normalized}/`))) {
      return `must be separate from ${resolved}`;
    }
  }
  return undefined;
}
