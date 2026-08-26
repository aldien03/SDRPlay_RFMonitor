import { availableParallelism, platform } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type {
  CollectorAvailability,
  CommissioningHealth,
  DataContinuityHealth,
  DiagnosticCounter,
  DiagnosticIssue,
  DiagnosticSummaryState,
  EvidenceArchiveHealth,
  MetricWindow,
  NetworkInterfaceHealth,
  ProcessingHealth,
  ReceiverState,
  ResourceHealth,
  SchedulerHealth,
  StreamingHealth,
} from "../shared/types";

const SAMPLE_INTERVAL_MS = 1_000;
const MAX_METRIC_SAMPLES = 61;
const MAX_COUNTERS = 128;
const MAX_INTERFACES = 14;
const MAX_ISSUES = 128;
export const DEFAULT_SDRCONNECT_CGROUP_PATH = "/sys/fs/cgroup/system.slice/sdrconnect-headless.service";

interface TimedValue {
  at: number;
  value: number;
}

interface CounterSample {
  at: number;
  total: number;
}

interface RawHostCpu {
  idle: number;
  total: number;
}

interface RawNetworkInterface {
  id: string;
  state: NetworkInterfaceHealth["state"];
  receivedBytes: number;
  transmittedBytes: number;
  receiveErrors: number;
  transmitErrors: number;
  receiveDrops: number;
  transmitDrops: number;
}

export interface DiagnosticsRuntimeSample {
  generatedAt: string;
  simulation: boolean;
  expectedSampleRateHz: number;
  receivers: ReceiverState[];
  processing: ProcessingHealth;
  scheduler: SchedulerHealth;
  commissioning: CommissioningHealth;
  streaming: StreamingHealth;
  resources: ResourceHealth;
  evidenceHealthy: boolean;
  evidenceArchive: EvidenceArchiveHealth;
  diskPressure: boolean;
}

export interface DiagnosticsCollectorSnapshot {
  generatedAt: string;
  summary: { state: DiagnosticSummaryState; issues: DiagnosticIssue[] };
  processCollector: CollectorAvailability;
  hostCollector: CollectorAvailability;
  networkCollector: CollectorAvailability;
  rfMonitorCpuHostNormalized: MetricWindow;
  rfMonitorCpuCoreEquivalent: MetricWindow;
  hostCpu: MetricWindow;
  hostLoad1m: MetricWindow;
  sdrconnect: {
    availability: CollectorAvailability;
    cpuCoreEquivalent?: MetricWindow;
    memoryBytes?: number;
  };
  networkInterfaces: NetworkInterfaceHealth[];
  dataContinuity: DataContinuityHealth;
  browserDrops: DiagnosticCounter;
}

export interface DiagnosticsSources {
  wallNow: () => number;
  monotonicNow: () => number;
  processCpuUsage: () => NodeJS.CpuUsage;
  coreCount: () => number;
  platform: () => NodeJS.Platform;
  readText: (filePath: string) => Promise<string>;
  listDirectory: (directoryPath: string) => Promise<string[]>;
}

const defaultSources: DiagnosticsSources = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  processCpuUsage: () => process.cpuUsage(),
  coreCount: () => Math.max(1, availableParallelism()),
  platform,
  readText: (filePath) => readFile(filePath, "utf8"),
  listDirectory: (directoryPath) => readdir(directoryPath),
};

function finiteNonNegative(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class RollingMetricWindow {
  private readonly samples: TimedValue[] = [];

  constructor(private readonly unit: MetricWindow["unit"]) {}

  add(value: number, at: number): void {
    if (!Number.isFinite(value)) return;
    const sample = { at, value: Math.max(0, value) };
    if (this.samples.at(-1)?.at === at) this.samples[this.samples.length - 1] = sample;
    else this.samples.push(sample);
    while (this.samples.length > MAX_METRIC_SAMPLES) this.samples.shift();
    while (this.samples[0] && at - this.samples[0].at > 60_000) this.samples.shift();
  }

  snapshot(at: number): MetricWindow {
    const within = (durationMs: number) => this.samples.filter((sample) => at - sample.at <= durationMs);
    const ten = within(10_000);
    const sixty = within(60_000);
    const current = this.samples.at(-1)?.value ?? 0;
    const average = (samples: TimedValue[]) => samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : 0;
    const peak = (samples: TimedValue[]) => samples.length ? Math.max(...samples.map((sample) => sample.value)) : 0;
    return {
      unit: this.unit,
      current: round(current),
      average10s: round(average(ten)),
      average60s: round(average(sixty)),
      peak10s: round(peak(ten)),
      peak60s: round(peak(sixty)),
      sampleCount: sixty.length,
    };
  }
}

export class DiagnosticCounterWindow {
  private lastRaw?: number;
  private logicalTotal = 0;
  private lastOccurredAt?: string;
  private readonly samples: CounterSample[] = [];

  update(rawTotal: number, at: number): void {
    const safeRaw = finiteNonNegative(rawTotal);
    if (safeRaw === undefined) return;
    if (this.lastRaw === undefined) {
      this.lastRaw = safeRaw;
      this.logicalTotal = safeRaw;
    } else {
      const increment = safeRaw >= this.lastRaw ? safeRaw - this.lastRaw : safeRaw;
      this.lastRaw = safeRaw;
      this.logicalTotal += increment;
      if (increment > 0) this.lastOccurredAt = new Date(at).toISOString();
    }
    const sample = { at, total: this.logicalTotal };
    if (this.samples.at(-1)?.at === at) this.samples[this.samples.length - 1] = sample;
    else this.samples.push(sample);
    while (this.samples.length > MAX_METRIC_SAMPLES) this.samples.shift();
    while (this.samples[0] && at - this.samples[0].at > 60_000) this.samples.shift();
  }

  snapshot(at: number): DiagnosticCounter {
    const delta = (windowMs: number) => {
      const cutoff = at - windowMs;
      const baseline = [...this.samples].reverse().find((sample) => sample.at <= cutoff) ?? this.samples[0];
      return baseline ? Math.max(0, this.logicalTotal - baseline.total) : 0;
    };
    return {
      total: this.logicalTotal,
      delta10s: delta(10_000),
      delta60s: delta(60_000),
      lastOccurredAt: this.lastOccurredAt,
    };
  }
}

class BoundedIssueStore {
  private readonly issues = new Map<string, DiagnosticIssue>();

  update(candidates: Array<Omit<DiagnosticIssue, "active" | "count" | "firstOccurredAt" | "lastOccurredAt">>, at: number): void {
    const observedAt = new Date(at).toISOString();
    const activeIds = new Set(candidates.map((candidate) => candidate.id));
    for (const issue of this.issues.values()) if (!activeIds.has(issue.id)) issue.active = false;
    for (const candidate of candidates) {
      const previous = this.issues.get(candidate.id);
      this.issues.set(candidate.id, {
        ...previous,
        ...candidate,
        active: true,
        count: previous ? previous.count + (previous.active ? 0 : 1) : 1,
        firstOccurredAt: previous?.firstOccurredAt ?? observedAt,
        lastOccurredAt: observedAt,
      });
    }
    if (this.issues.size > MAX_ISSUES) {
      const oldest = [...this.issues.values()].sort((left, right) => {
        if (left.active !== right.active) return left.active ? 1 : -1;
        return Date.parse(left.lastOccurredAt) - Date.parse(right.lastOccurredAt);
      });
      for (const issue of oldest.slice(0, this.issues.size - MAX_ISSUES)) this.issues.delete(issue.id);
    }
  }

  active(): DiagnosticIssue[] {
    return [...this.issues.values()]
      .filter((issue) => issue.active)
      .sort((left, right) => (left.severity === right.severity ? Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt) : left.severity === "critical" ? -1 : 1));
  }
}

function parseHostCpu(text: string): RawHostCpu | undefined {
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("cpu "));
  if (!line) return undefined;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  return { idle: values[3] + (values[4] ?? 0), total: values.reduce((sum, value) => sum + value, 0) };
}

function parseCgroupCpu(text: string): number | undefined {
  const match = text.match(/^usage_usec\s+(\d+)$/m);
  return match ? finiteNonNegative(match[1]) : undefined;
}

function counterKeys(): Array<keyof DataContinuityHealth> {
  return [
    "receivedFrames", "analyzedObservations", "intentionalTuneGateFrames", "intentionalTuneDiscards",
    "intentionalRateCoalescing", "invalidOrStaleFrames", "unexpectedIqPayloads", "unknownVisits",
    "missedObjectives", "evidenceFramesRecorded", "evidenceFramesLost", "browserFramesCoalesced", "browserFramesDropped",
  ];
}

export class DiagnosticsCollector {
  private readonly metrics = {
    processHostNormalized: new RollingMetricWindow("percent"),
    processCoreEquivalent: new RollingMetricWindow("percent"),
    hostCpu: new RollingMetricWindow("percent"),
    hostLoad1m: new RollingMetricWindow("load"),
    sdrconnectCpu: new RollingMetricWindow("percent"),
  };
  private readonly counters = new Map<string, DiagnosticCounterWindow>();
  private readonly nicRates = new Map<string, { received: RollingMetricWindow; transmitted: RollingMetricWindow; at?: number; receivedBytes?: number; transmittedBytes?: number }>();
  private readonly issueStore = new BoundedIssueStore();
  private timer?: NodeJS.Timeout;
  private sampling?: Promise<void>;
  private previousProcessCpu?: { usage: NodeJS.CpuUsage; at: number };
  private previousHostCpu?: RawHostCpu;
  private previousCgroupCpu?: { usageMicroseconds: number; at: number };
  private hostAvailability: CollectorAvailability = { state: "unavailable", reasonCode: "not-sampled" };
  private networkAvailability: CollectorAvailability = { state: "unavailable", reasonCode: "not-sampled" };
  private cgroupAvailability: CollectorAvailability = { state: "unavailable", reasonCode: "not-sampled" };
  private networkInterfaces: NetworkInterfaceHealth[] = [];
  private sdrconnectMemoryBytes?: number;
  private runtime?: DiagnosticsRuntimeSample;
  private lastSampleAt = 0;

  constructor(
    private readonly options: {
      sources?: Partial<DiagnosticsSources>;
      sdrconnectCgroupPath?: string;
      runtimeProvider?: () => DiagnosticsRuntimeSample;
    } = {},
  ) {
    const sources = { ...defaultSources, ...options.sources };
    this.sources = sources;
    for (const key of counterKeys()) this.counters.set(key, new DiagnosticCounterWindow());
  }

  private readonly sources: DiagnosticsSources;

  async start(): Promise<void> {
    if (this.timer) return;
    await this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sample(runtime = this.options.runtimeProvider?.()): Promise<void> {
    if (this.sampling) return this.sampling;
    this.sampling = this.collect(runtime).finally(() => { this.sampling = undefined; });
    return this.sampling;
  }

  updateRuntime(runtime: DiagnosticsRuntimeSample): void {
    this.runtime = runtime;
    const at = Math.floor(this.sources.wallNow() / 1_000) * 1_000;
    this.trackRuntime(runtime, at);
    this.evaluateIssues(at);
  }

  snapshot(): DiagnosticsCollectorSnapshot {
    const at = this.lastSampleAt || this.sources.wallNow();
    const dataContinuity = Object.fromEntries(counterKeys().map((key) => [key, this.counter(key).snapshot(at)])) as unknown as DataContinuityHealth;
    const issues = this.issueStore.active();
    const critical = issues.some((issue) => issue.severity === "critical");
    const state: DiagnosticSummaryState = critical
      ? "critical"
      : this.runtime?.simulation
        ? "simulation"
        : issues.length
          ? "attention"
          : "normal";
    return {
      generatedAt: new Date(at).toISOString(),
      summary: { state, issues },
      processCollector: { state: "available", lastSampleAt: new Date(at).toISOString() },
      hostCollector: this.hostAvailability,
      networkCollector: this.networkAvailability,
      rfMonitorCpuHostNormalized: this.metrics.processHostNormalized.snapshot(at),
      rfMonitorCpuCoreEquivalent: this.metrics.processCoreEquivalent.snapshot(at),
      hostCpu: this.metrics.hostCpu.snapshot(at),
      hostLoad1m: this.metrics.hostLoad1m.snapshot(at),
      sdrconnect: {
        availability: this.cgroupAvailability,
        ...(this.cgroupAvailability.state === "available" ? {
          cpuCoreEquivalent: this.metrics.sdrconnectCpu.snapshot(at),
          memoryBytes: this.sdrconnectMemoryBytes,
        } : {}),
      },
      networkInterfaces: this.networkInterfaces,
      dataContinuity,
      browserDrops: dataContinuity.browserFramesDropped,
    };
  }

  private counter(key: string): DiagnosticCounterWindow {
    let counter = this.counters.get(key);
    if (!counter) {
      if (this.counters.size >= MAX_COUNTERS) return new DiagnosticCounterWindow();
      counter = new DiagnosticCounterWindow();
      this.counters.set(key, counter);
    }
    return counter;
  }

  private async collect(runtime?: DiagnosticsRuntimeSample): Promise<void> {
    const at = this.sources.wallNow();
    const monotonicAt = this.sources.monotonicNow();
    this.collectProcessCpu(at, monotonicAt);
    await Promise.all([this.collectHost(at), this.collectNetwork(at), this.collectCgroup(at, monotonicAt)]);
    if (runtime) this.trackRuntime(runtime, at);
    this.lastSampleAt = at;
    this.evaluateIssues(at);
  }

  private collectProcessCpu(at: number, monotonicAt: number): void {
    const usage = this.sources.processCpuUsage();
    if (this.previousProcessCpu) {
      const elapsedMs = Math.max(1, monotonicAt - this.previousProcessCpu.at);
      const usedMicroseconds = Math.max(0, usage.user - this.previousProcessCpu.usage.user) + Math.max(0, usage.system - this.previousProcessCpu.usage.system);
      const coreEquivalent = (usedMicroseconds / (elapsedMs * 1_000)) * 100;
      this.metrics.processCoreEquivalent.add(coreEquivalent, at);
      this.metrics.processHostNormalized.add(coreEquivalent / Math.max(1, this.sources.coreCount()), at);
    } else {
      this.metrics.processCoreEquivalent.add(0, at);
      this.metrics.processHostNormalized.add(0, at);
    }
    this.previousProcessCpu = { usage, at: monotonicAt };
  }

  private async collectHost(at: number): Promise<void> {
    if (this.sources.platform() !== "linux") {
      this.hostAvailability = { state: "not-applicable", reasonCode: "linux-only" };
      return;
    }
    try {
      const [stat, load] = await Promise.all([this.sources.readText("/proc/stat"), this.sources.readText("/proc/loadavg")]);
      const cpu = parseHostCpu(stat);
      if (!cpu) throw new Error("invalid-proc-stat");
      if (this.previousHostCpu) {
        const totalDelta = Math.max(0, cpu.total - this.previousHostCpu.total);
        const idleDelta = Math.max(0, cpu.idle - this.previousHostCpu.idle);
        this.metrics.hostCpu.add(totalDelta ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0, at);
      } else this.metrics.hostCpu.add(0, at);
      this.previousHostCpu = cpu;
      this.metrics.hostLoad1m.add(finiteNonNegative(load.split(/\s+/)[0]) ?? 0, at);
      this.hostAvailability = { state: "available", lastSampleAt: new Date(at).toISOString() };
    } catch {
      this.hostAvailability = { state: "unavailable", reasonCode: "procfs-unavailable" };
    }
  }

  private async collectNetwork(at: number): Promise<void> {
    if (this.sources.platform() !== "linux") {
      this.networkAvailability = { state: "not-applicable", reasonCode: "linux-only" };
      this.networkInterfaces = [];
      return;
    }
    try {
      const allIds = (await this.sources.listDirectory("/sys/class/net"))
        .filter((id) => id !== "lo" && /^[A-Za-z0-9_.:-]{1,32}$/.test(id))
        .sort();
      const ids = allIds.slice(0, MAX_INTERFACES);
      const candidates = await Promise.all(ids.map((id) => this.readNetworkInterface(id)));
      const active = candidates.filter((entry): entry is RawNetworkInterface => Boolean(entry && entry.state !== "down"));
      const activeIds = new Set(active.map((entry) => entry.id));
      for (const id of this.nicRates.keys()) if (!activeIds.has(id)) this.nicRates.delete(id);
      for (const key of this.counters.keys()) {
        if (key.startsWith("nic:") && ![...activeIds].some((id) => key.startsWith(`nic:${id}:`))) this.counters.delete(key);
      }
      this.networkInterfaces = active.map((entry) => this.updateNetworkInterface(entry, at));
      this.networkAvailability = { state: "available", lastSampleAt: new Date(at).toISOString(), ...(allIds.length > MAX_INTERFACES ? { reasonCode: "interface-limit" } : {}) };
    } catch {
      this.networkAvailability = { state: "unavailable", reasonCode: "sysfs-network-unavailable" };
      this.networkInterfaces = [];
    }
  }

  private async readNetworkInterface(id: string): Promise<RawNetworkInterface | undefined> {
    try {
      const root = `/sys/class/net/${id}`;
      const [operstate, receivedBytes, transmittedBytes, receiveErrors, transmitErrors, receiveDrops, transmitDrops] = await Promise.all([
        this.sources.readText(`${root}/operstate`),
        this.sources.readText(`${root}/statistics/rx_bytes`),
        this.sources.readText(`${root}/statistics/tx_bytes`),
        this.sources.readText(`${root}/statistics/rx_errors`),
        this.sources.readText(`${root}/statistics/tx_errors`),
        this.sources.readText(`${root}/statistics/rx_dropped`),
        this.sources.readText(`${root}/statistics/tx_dropped`),
      ]);
      const state = operstate.trim() === "up" ? "up" : operstate.trim() === "down" ? "down" : "unknown";
      const values = [receivedBytes, transmittedBytes, receiveErrors, transmitErrors, receiveDrops, transmitDrops].map(finiteNonNegative);
      if (values.some((value) => value === undefined)) return undefined;
      return { id, state, receivedBytes: values[0]!, transmittedBytes: values[1]!, receiveErrors: values[2]!, transmitErrors: values[3]!, receiveDrops: values[4]!, transmitDrops: values[5]! };
    } catch {
      return undefined;
    }
  }

  private updateNetworkInterface(entry: RawNetworkInterface, at: number): NetworkInterfaceHealth {
    const key = (metric: string) => this.counter(`nic:${entry.id}:${metric}`);
    key("receivedBytes").update(entry.receivedBytes, at);
    key("transmittedBytes").update(entry.transmittedBytes, at);
    key("receiveErrors").update(entry.receiveErrors, at);
    key("transmitErrors").update(entry.transmitErrors, at);
    key("receiveDrops").update(entry.receiveDrops, at);
    key("transmitDrops").update(entry.transmitDrops, at);
    let rates = this.nicRates.get(entry.id);
    if (!rates) {
      rates = { received: new RollingMetricWindow("bytes-per-second"), transmitted: new RollingMetricWindow("bytes-per-second") };
      this.nicRates.set(entry.id, rates);
    }
    if (rates.at !== undefined && at > rates.at) {
      const elapsedSeconds = (at - rates.at) / 1_000;
      rates.received.add(Math.max(0, entry.receivedBytes - (rates.receivedBytes ?? entry.receivedBytes)) / elapsedSeconds, at);
      rates.transmitted.add(Math.max(0, entry.transmittedBytes - (rates.transmittedBytes ?? entry.transmittedBytes)) / elapsedSeconds, at);
    } else {
      rates.received.add(0, at);
      rates.transmitted.add(0, at);
    }
    rates.at = at;
    rates.receivedBytes = entry.receivedBytes;
    rates.transmittedBytes = entry.transmittedBytes;
    return {
      id: entry.id,
      state: entry.state,
      receivedBytes: key("receivedBytes").snapshot(at),
      transmittedBytes: key("transmittedBytes").snapshot(at),
      receivedBytesPerSecond: rates.received.snapshot(at),
      transmittedBytesPerSecond: rates.transmitted.snapshot(at),
      receiveErrors: key("receiveErrors").snapshot(at),
      transmitErrors: key("transmitErrors").snapshot(at),
      receiveDrops: key("receiveDrops").snapshot(at),
      transmitDrops: key("transmitDrops").snapshot(at),
    };
  }

  private async collectCgroup(at: number, monotonicAt: number): Promise<void> {
    if (this.sources.platform() !== "linux") {
      this.cgroupAvailability = { state: "not-applicable", reasonCode: "linux-only" };
      return;
    }
    const root = this.options.sdrconnectCgroupPath
      ?? process.env.RF_MONITOR_SDRCONNECT_CGROUP_PATH
      ?? DEFAULT_SDRCONNECT_CGROUP_PATH;
    try {
      const [cpuText, memoryText] = await Promise.all([this.sources.readText(`${root}/cpu.stat`), this.sources.readText(`${root}/memory.current`)]);
      const usageMicroseconds = parseCgroupCpu(cpuText);
      const memoryBytes = finiteNonNegative(memoryText);
      if (usageMicroseconds === undefined || memoryBytes === undefined) throw new Error("invalid-cgroup-data");
      if (this.previousCgroupCpu) {
        const elapsedMs = Math.max(1, monotonicAt - this.previousCgroupCpu.at);
        this.metrics.sdrconnectCpu.add(((usageMicroseconds - this.previousCgroupCpu.usageMicroseconds) / (elapsedMs * 1_000)) * 100, at);
      } else this.metrics.sdrconnectCpu.add(0, at);
      this.previousCgroupCpu = { usageMicroseconds, at: monotonicAt };
      this.sdrconnectMemoryBytes = memoryBytes;
      this.cgroupAvailability = { state: "available", lastSampleAt: new Date(at).toISOString() };
    } catch {
      this.cgroupAvailability = { state: "unavailable", reasonCode: "sdrconnect-cgroup-unavailable" };
      this.sdrconnectMemoryBytes = undefined;
    }
  }

  private trackRuntime(runtime: DiagnosticsRuntimeSample, at: number): void {
    this.runtime = runtime;
    at = Math.floor(at / 1_000) * 1_000;
    const processing = runtime.processing;
    const totals: Record<keyof DataContinuityHealth, number> = {
      receivedFrames: processing.spectrumFramesReceived,
      analyzedObservations: processing.spectrumFramesAnalyzed,
      intentionalTuneGateFrames: processing.tuneGateFramesIgnored,
      intentionalTuneDiscards: processing.tuneFramesDiscarded,
      intentionalRateCoalescing: processing.rateCoalescedFrames,
      invalidOrStaleFrames: processing.invalidSpectrumFramesDropped,
      unexpectedIqPayloads: processing.unexpectedIqPayloadsDropped,
      unknownVisits: runtime.scheduler.unknownVisits,
      missedObjectives: runtime.scheduler.missedObjectives,
      evidenceFramesRecorded: processing.evidenceFramesRecorded,
      evidenceFramesLost: processing.evidenceFramesDropped,
      browserFramesCoalesced: runtime.streaming.coalescedFrames,
      browserFramesDropped: runtime.streaming.slowClientDrops + runtime.streaming.budgetDrops,
    };
    for (const key of counterKeys()) this.counter(key).update(totals[key], at);
  }

  private evaluateIssues(at: number): void {
    const candidates: Parameters<BoundedIssueStore["update"]>[0] = [];
    const add = (candidate: typeof candidates[number]) => candidates.push(candidate);
    const hostCpu = this.metrics.hostCpu.snapshot(at);
    const processCpu = this.metrics.processHostNormalized.snapshot(at);
    const runtime = this.runtime;
    if (runtime?.resources.hostMemory?.state === "critical") add({ id: "host-memory-critical", code: "host-memory-critical", severity: "critical", subsystem: "software", action: "open-system-health" });
    else if (runtime?.resources.hostMemory?.state === "pressure") add({ id: "host-memory-pressure", code: "host-memory-pressure", severity: "attention", subsystem: "software", action: "open-system-health" });
    if ((runtime?.streaming.clients ?? 0) >= 4 && (runtime?.streaming.hiddenClients ?? 0) >= 2) add({ id: "multiple-dashboards", code: "multiple-dashboards", severity: "attention", subsystem: "software", value: runtime?.streaming.clients, threshold: 3, unit: "count", action: "open-system-health" });
    if (runtime?.resources.state === "critical") add({ id: "resource-critical", code: "resource-critical", severity: "critical", subsystem: "software", action: "open-system-health" });
    const sustainedHostSample = hostCpu.sampleCount >= 55;
    const sustainedProcessSample = processCpu.sampleCount >= 55;
    if (sustainedHostSample && hostCpu.average60s >= 95 && (runtime?.resources.eventLoopDelayP99Ms ?? 0) >= 100) add({ id: "host-cpu-event-loop-critical", code: "host-cpu-event-loop-critical", severity: "critical", subsystem: "software", value: hostCpu.average60s, threshold: 95, unit: "percent", action: "copy-doctor-command" });
    else if (sustainedHostSample && hostCpu.average60s >= 85) add({ id: "host-cpu-high", code: "host-cpu-high", severity: "attention", subsystem: "software", value: hostCpu.average60s, threshold: 85, unit: "percent", action: "copy-doctor-command" });
    if (sustainedProcessSample && processCpu.average60s >= 70) add({ id: "rf-monitor-cpu-high", code: "rf-monitor-cpu-high", severity: "attention", subsystem: "software", value: processCpu.average60s, threshold: 70, unit: "percent", action: "download-diagnostics" });
    for (const entry of this.networkInterfaces) {
      const faults = entry.receiveErrors.delta60s + entry.transmitErrors.delta60s + entry.receiveDrops.delta60s + entry.transmitDrops.delta60s;
      if (faults > 0) add({ id: `network-interface-fault:${entry.id}`, code: "network-interface-errors-or-drops", severity: "attention", subsystem: "network", value: faults, threshold: 0, unit: "count", action: "check-host-network" });
    }
    if (this.networkAvailability.state === "available" && this.networkInterfaces.length === 0) add({ id: "host-network-interface-unavailable", code: "host-network-interface-unavailable", severity: "attention", subsystem: "network", action: "check-host-network" });
    if (runtime) {
      const continuity = Object.fromEntries(counterKeys().map((key) => [key, this.counter(key).snapshot(at)])) as unknown as DataContinuityHealth;
      if (continuity.missedObjectives.delta60s > 0) add({ id: "schedule-objective-missed", code: "schedule-objective-missed", severity: "attention", subsystem: "schedule", value: continuity.missedObjectives.delta60s, threshold: 0, unit: "count", action: "open-monitoring" });
      if (continuity.unknownVisits.delta60s > 0 || continuity.invalidOrStaleFrames.delta60s > 0) add({ id: "tune-or-frame-fault", code: "tune-or-frame-fault", severity: "attention", subsystem: "data", value: continuity.unknownVisits.delta60s + continuity.invalidOrStaleFrames.delta60s, threshold: 0, unit: "count", action: "open-system-health" });
      if (continuity.browserFramesDropped.delta60s > 0) add({ id: "browser-delivery-loss", code: "browser-delivery-loss", severity: "attention", subsystem: "network", value: continuity.browserFramesDropped.delta60s, threshold: 0, unit: "count", action: "check-switch-counters" });
      if (continuity.evidenceFramesLost.delta60s > 0) add({ id: "evidence-frame-loss", code: "evidence-frame-loss", severity: "critical", subsystem: "evidence", value: continuity.evidenceFramesLost.delta60s, threshold: 0, unit: "count", action: "open-recording" });
      if (!runtime.evidenceHealthy) add({ id: "evidence-unavailable", code: "evidence-unavailable", severity: "critical", subsystem: "evidence", action: "open-recording" });
      if (runtime.diskPressure) add({ id: "disk-reserve-breached", code: "disk-reserve-breached", severity: "critical", subsystem: "evidence", action: "open-recording" });
      if (runtime.evidenceArchive.state === "attention") add({
        id: "evidence-archive-needs-attention",
        code: "evidence-archive-needs-attention",
        severity: "attention",
        subsystem: "evidence",
        value: runtime.evidenceArchive.incompleteSessions + runtime.evidenceArchive.corruptSessions,
        threshold: 0,
        unit: "count",
        action: "open-recording",
      });
      for (const receiver of runtime.receivers) {
        if (runtime.simulation) continue;
        if (receiver.recoveryState === "manual-required" && !receiver.streamReady) add({ id: `receiver-recovery-failed:${receiver.id}`, code: "receiver-recovery-failed", severity: "critical", subsystem: "receiver", action: "retry-receiver" });
        else if (!receiver.streamReady) add({ id: `receiver-path-unavailable:${receiver.id}`, code: "receiver-path-unavailable", severity: "attention", subsystem: "receiver", action: "retry-receiver" });
        if (receiver.confirmedSampleRateHz !== undefined && receiver.confirmedSampleRateHz !== runtime.expectedSampleRateHz) add({ id: `sample-rate-mismatch:${receiver.id}`, code: "sample-rate-mismatch", severity: "attention", subsystem: "receiver", value: receiver.confirmedSampleRateHz, threshold: runtime.expectedSampleRateHz, unit: "count", action: "open-monitoring" });
      }
    }
    this.issueStore.update(candidates, at);
  }
}
