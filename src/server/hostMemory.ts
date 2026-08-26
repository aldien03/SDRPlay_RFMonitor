import { readFileSync } from "node:fs";
import type { HostMemoryHealth, HostMemoryPressureState } from "../shared/types";

export const HOST_MEMORY_LIMITS = Object.freeze({
  pressureAvailableRatio: 0.20,
  criticalAvailableRatio: 0.10,
  pressureSwapFreeRatio: 0.25,
  criticalSwapFreeRatio: 0.10,
  pressurePsiSomeAvg10: 10,
  criticalPsiSomeAvg10: 25,
  pressurePsiFullAvg10: 1,
  psiSustainMs: 20_000,
  recoveryDwellMs: 120_000,
  recentOomMs: 120_000,
} as const);

export interface HostMemorySample {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  psiSomeAvg10: number;
  psiFullAvg10: number;
  oomKillCount: number;
}

export interface HostMemorySources {
  readText(path: string): string;
}

const defaultSources: HostMemorySources = {
  readText: (filePath) => readFileSync(filePath, "utf8"),
};

function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function parseHostMemorySample(meminfo: string, pressure: string, vmstat: string): HostMemorySample | undefined {
  const memory = new Map(meminfo.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    return match ? [[match[1], Number(match[2]) * 1024] as const] : [];
  }));
  const psi = new Map(pressure.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(some|full)\s+avg10=([0-9.]+)/);
    return match ? [[match[1], Number(match[2])] as const] : [];
  }));
  const oomMatch = vmstat.match(/^oom_kill\s+(\d+)$/m);
  const totalBytes = finite(String(memory.get("MemTotal")));
  const availableBytes = finite(String(memory.get("MemAvailable")));
  const swapTotalBytes = finite(String(memory.get("SwapTotal") ?? 0));
  const swapFreeBytes = finite(String(memory.get("SwapFree") ?? 0));
  const psiSomeAvg10 = finite(String(psi.get("some")));
  const psiFullAvg10 = finite(String(psi.get("full")));
  const oomKillCount = finite(oomMatch?.[1]);
  if (!totalBytes || availableBytes === undefined || swapTotalBytes === undefined || swapFreeBytes === undefined
    || psiSomeAvg10 === undefined || psiFullAvg10 === undefined || oomKillCount === undefined) return undefined;
  return { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes, psiSomeAvg10, psiFullAvg10, oomKillCount };
}

function rank(state: HostMemoryPressureState): number {
  return state === "critical" ? 3 : state === "pressure" ? 2 : state === "normal" ? 1 : 0;
}

export class HostMemoryController {
  private state: HostMemoryPressureState = "unknown";
  private enteredAt: number;
  private normalSince?: number;
  private psiPressureSince?: number;
  private previousOomKillCount?: number;
  private lastOomKillAt?: number;
  private lastHealth?: HostMemoryHealth;

  constructor(private readonly sources: HostMemorySources = defaultSources, now = Date.now()) {
    this.enteredAt = now;
  }

  sample(now = Date.now()): HostMemoryHealth {
    let sample: HostMemorySample | undefined;
    try {
      sample = parseHostMemorySample(
        this.sources.readText("/proc/meminfo"),
        this.sources.readText("/proc/pressure/memory"),
        this.sources.readText("/proc/vmstat"),
      );
    } catch {
      sample = undefined;
    }
    if (!sample) {
      const unknown: HostMemoryHealth = {
        state: "unknown",
        reasonCodes: ["host-memory-collector-unavailable"],
        recentOomKill: false,
        sampledAt: new Date(now).toISOString(),
      };
      this.lastHealth = unknown;
      return unknown;
    }
    if (this.previousOomKillCount !== undefined && sample.oomKillCount > this.previousOomKillCount) this.lastOomKillAt = now;
    this.previousOomKillCount = sample.oomKillCount;
    const recentOomKill = this.lastOomKillAt !== undefined && now - this.lastOomKillAt <= HOST_MEMORY_LIMITS.recentOomMs;
    const availableRatio = sample.availableBytes / sample.totalBytes;
    const swapFreeRatio = sample.swapTotalBytes === 0 ? 1 : sample.swapFreeBytes / sample.swapTotalBytes;
    const psiPressure = sample.psiSomeAvg10 >= HOST_MEMORY_LIMITS.pressurePsiSomeAvg10
      || sample.psiFullAvg10 >= HOST_MEMORY_LIMITS.pressurePsiFullAvg10;
    this.psiPressureSince = psiPressure ? this.psiPressureSince ?? now : undefined;
    const sustainedPsi = this.psiPressureSince !== undefined && now - this.psiPressureSince >= HOST_MEMORY_LIMITS.psiSustainMs;
    const reasons: string[] = [];
    if (availableRatio < HOST_MEMORY_LIMITS.criticalAvailableRatio) reasons.push("host-memory-available-critical");
    else if (availableRatio < HOST_MEMORY_LIMITS.pressureAvailableRatio) reasons.push("host-memory-available-low");
    if (swapFreeRatio < HOST_MEMORY_LIMITS.criticalSwapFreeRatio) reasons.push("host-swap-critical");
    else if (swapFreeRatio < HOST_MEMORY_LIMITS.pressureSwapFreeRatio) reasons.push("host-swap-low");
    if (sample.psiSomeAvg10 >= HOST_MEMORY_LIMITS.criticalPsiSomeAvg10) reasons.push("host-memory-psi-critical");
    else if (sustainedPsi) reasons.push("host-memory-psi-pressure");
    if (recentOomKill) reasons.push("host-oom-kill");
    const rawState: HostMemoryPressureState = recentOomKill
      || availableRatio < HOST_MEMORY_LIMITS.criticalAvailableRatio
      || swapFreeRatio < HOST_MEMORY_LIMITS.criticalSwapFreeRatio
      || sample.psiSomeAvg10 >= HOST_MEMORY_LIMITS.criticalPsiSomeAvg10
      ? "critical"
      : availableRatio < HOST_MEMORY_LIMITS.pressureAvailableRatio
        || swapFreeRatio < HOST_MEMORY_LIMITS.pressureSwapFreeRatio
        || sustainedPsi
        ? "pressure"
        : "normal";

    if (this.state === "unknown" || rank(rawState) > rank(this.state)) {
      this.state = rawState;
      this.enteredAt = now;
      this.normalSince = rawState === "normal" ? now : undefined;
    } else if (rawState === this.state) {
      if (rawState !== "normal") this.normalSince = undefined;
    } else if (rawState === "normal") {
      this.normalSince ??= now;
      if (now - this.normalSince >= HOST_MEMORY_LIMITS.recoveryDwellMs) {
        this.state = "normal";
        this.enteredAt = now;
      }
    } else {
      this.normalSince = undefined;
    }
    const activeReasons = this.state === "normal" ? [] : reasons.length ? reasons : this.lastHealth?.reasonCodes ?? [];
    const health: HostMemoryHealth = {
      state: this.state,
      reasonCodes: [...new Set(activeReasons)],
      totalBytes: sample.totalBytes,
      availableBytes: sample.availableBytes,
      availableRatio: Number(availableRatio.toFixed(4)),
      swapTotalBytes: sample.swapTotalBytes,
      swapFreeBytes: sample.swapFreeBytes,
      swapFreeRatio: Number(swapFreeRatio.toFixed(4)),
      psiSomeAvg10: sample.psiSomeAvg10,
      psiFullAvg10: sample.psiFullAvg10,
      recentOomKill,
      sampledAt: new Date(now).toISOString(),
      ...(this.normalSince !== undefined ? { normalSince: new Date(this.normalSince).toISOString() } : {}),
    };
    this.lastHealth = health;
    return health;
  }
}
