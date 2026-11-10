import { useEffect, useState } from "react";

/** Usual level and alert level per display bin, from the detector's reference. */
export interface TargetReferenceView {
  targetId: string;
  revision: string;
  frameBinCount: number;
  analysisStartBin: number;
  analysisEndBin: number;
  analyzedRangeHz: [number, number];
  alertSigma: number;
  usual: number[];
  alertLevel: number[];
}

const REFRESH_MS = 15_000;
const cache = new Map<string, { view?: TargetReferenceView; etag?: string; fetchedAt: number; pending?: Promise<void> }>();
const listeners = new Map<string, Set<(view: TargetReferenceView | undefined) => void>>();

function notify(targetId: string): void {
  const view = cache.get(targetId)?.view;
  for (const listener of listeners.get(targetId) ?? []) listener(view);
}

async function refresh(targetId: string): Promise<void> {
  const entry = cache.get(targetId) ?? { fetchedAt: 0 };
  if (entry.pending) return entry.pending;
  entry.pending = (async () => {
    try {
      const response = await fetch(`/api/targets/${encodeURIComponent(targetId)}/reference`, {
        credentials: "same-origin",
        headers: entry.etag ? { "if-none-match": entry.etag } : {},
      });
      if (response.status === 304) return;
      if (!response.ok) {
        entry.view = undefined;
        return;
      }
      entry.view = await response.json() as TargetReferenceView;
      entry.etag = response.headers.get("etag") ?? undefined;
    } catch {
      // The spectrum falls back to the single usual-level line.
    } finally {
      entry.fetchedAt = Date.now();
      entry.pending = undefined;
      cache.set(targetId, entry);
      notify(targetId);
    }
  })();
  cache.set(targetId, entry);
  return entry.pending;
}

/** Shared, throttled: many feed cards for one window cost one request per 15 s. */
export function useTargetReference(targetId: string | undefined, enabled: boolean): TargetReferenceView | undefined {
  const [view, setView] = useState<TargetReferenceView | undefined>(() => (targetId ? cache.get(targetId)?.view : undefined));
  useEffect(() => {
    if (!targetId || !enabled) {
      setView(undefined);
      return;
    }
    const set = listeners.get(targetId) ?? new Set();
    set.add(setView);
    listeners.set(targetId, set);
    setView(cache.get(targetId)?.view);
    const tick = () => {
      const entry = cache.get(targetId);
      if (!entry || Date.now() - entry.fetchedAt >= REFRESH_MS) void refresh(targetId);
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      set.delete(setView);
    };
  }, [enabled, targetId]);
  return view;
}
