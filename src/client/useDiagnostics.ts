import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendDiagnosticsTrend,
  buildDiagnosticsModel,
  diagnosticsTrendSample,
  isHealthSnapshotV2,
  type DiagnosticsHealth,
  type DiagnosticsTrendSample,
  type DiagnosticsViewModel,
} from "./diagnosticsModel";

const DEFAULT_VISIBLE_INTERVAL_MS = 2_000;
const DEFAULT_HIDDEN_INTERVAL_MS = 10_000;

export interface UseDiagnosticsOptions {
  endpoint?: string;
  visibleIntervalMs?: number;
  hiddenIntervalMs?: number;
  fetcher?: typeof fetch;
}

export interface UseDiagnosticsResult {
  health?: DiagnosticsHealth;
  trend: DiagnosticsTrendSample[];
  model: DiagnosticsViewModel;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  lastSuccessfulAt?: number;
  refresh: () => void;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function useDiagnostics(options: UseDiagnosticsOptions = {}): UseDiagnosticsResult {
  const endpoint = options.endpoint ?? "/api/health";
  const visibleIntervalMs = Math.max(500, options.visibleIntervalMs ?? DEFAULT_VISIBLE_INTERVAL_MS);
  const hiddenIntervalMs = Math.max(2_000, options.hiddenIntervalMs ?? DEFAULT_HIDDEN_INTERVAL_MS);
  const fetcher = options.fetcher ?? fetch;
  const [health, setHealth] = useState<DiagnosticsHealth>();
  const [trend, setTrend] = useState<DiagnosticsTrendSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number>();
  const refreshRef = useRef<() => void>(() => undefined);
  const hasHealthRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), pageHidden() ? hiddenIntervalMs : visibleIntervalMs);
    };

    const poll = async () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const requestId = ++requestSequence;
      if (hasHealthRef.current) setRefreshing(true);
      else setLoading(true);
      try {
        const response = await fetcher(endpoint, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Health request failed (${response.status})`);
        const payload: unknown = await response.json();
        if (!isHealthSnapshotV2(payload)) throw new Error("Health response did not use diagnostics schema v2");
        if (stopped || requestId !== requestSequence) return;
        const receivedAt = Date.now();
        hasHealthRef.current = true;
        setHealth(payload);
        setTrend((current) => appendDiagnosticsTrend(current, diagnosticsTrendSample(payload, receivedAt)));
        setLastSuccessfulAt(receivedAt);
        setError(undefined);
      } catch (reason) {
        if (stopped || requestId !== requestSequence || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!stopped && requestId === requestSequence) {
          setLoading(false);
          setRefreshing(false);
          schedule();
        }
      }
    };

    const handleVisibility = () => {
      if (pageHidden()) schedule();
      else void poll();
    };

    refreshRef.current = () => void poll();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", handleVisibility);
    void poll();

    return () => {
      stopped = true;
      requestSequence += 1;
      if (timer) clearTimeout(timer);
      controller?.abort();
      refreshRef.current = () => undefined;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [endpoint, fetcher, hiddenIntervalMs, visibleIntervalMs]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const model = useMemo(() => buildDiagnosticsModel(health), [health]);
  return { health, trend, model, loading, refreshing, error, lastSuccessfulAt, refresh };
}
