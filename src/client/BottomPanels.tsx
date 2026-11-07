import { Copy, Download, Eye, FolderArchive, Pause, Play, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DetectionEvent, EvidenceArchiveEventPage, EvidenceArchivePage, EvidenceArchiveSession, EvidenceLifecycle, EvidenceReplayBatch, EvidenceReplayFrame, MonitorSnapshot, MonitorStatus, SignalMetricSample, SpectrumFrame } from "../shared/types";
import { dateTime, formatBytes, formatDuration, formatRange, timeOnly } from "./format";
import { SpectrumView, WaterfallView } from "./SpectrumViews";

export interface DisplayOptions {
  waterfall: boolean;
  baseline: boolean;
  markers: boolean;
  traceMode: "current" | "peak" | "average";
  engineer: boolean;
  audioAlerts: boolean;
  popupAlerts: boolean;
}

export function RecentIncidents({ snapshot, selectedEventId, onSelect }: { snapshot: MonitorSnapshot; selectedEventId?: string; onSelect: (id: string) => void }) {
  return (
    <section className="panel incident-history-panel" aria-labelledby="recent-incidents-title">
      <div className="panel-heading-line">
        <div><h2 id="recent-incidents-title" className="panel-title">Recent incidents</h2><p>Recorded signal changes and operator actions.</p></div>
        <span>{snapshot.events.length} recorded</span>
      </div>
      {snapshot.events.length ? (
        <div className="incident-history-list">
          {snapshot.events.slice(0, 6).map((event) => {
            const active = event.id === snapshot.activeEvent?.id;
            const service = snapshot.services.find((candidate) => candidate.service === event.service)?.label ?? event.bandLabel;
            const state = active ? "Happening now" : event.acknowledgedAt ? "Reviewed" : "Ended";
            const evidence = event.evidenceStrength;
            return (
              <article key={event.id} className={`incident-history-item ${active ? "active" : ""} ${selectedEventId === event.id ? "selected" : ""}`}>
                <header>
                  <div className="incident-history-state"><StatusDot status={event.status} /><strong>{state}</strong><span>{statusLabel(event.status)}</span></div>
                  <time dateTime={event.startedAt}>{timeOnly(event.startedAt, snapshot.displayTimeZone)} · {formatDuration(event.startedAt, event.lastSeenAt)}</time>
                </header>
                <button className="incident-row-select" type="button" onClick={() => onSelect(event.id)} aria-pressed={selectedEventId === event.id}>
                  <span><small>Affected signal</small><strong>{event.affectedLabel ?? service}</strong><em>{formatRange(...event.affectedRangeHz)}</em></span>
                  <span><small>Observed</small><strong>{event.observed}</strong></span>
                  <span><small>Evidence</small><strong>{evidence}</strong><em>Peak {event.metrics.peakLevel.toFixed(0)} / 255</em></span>
                  <b>View details</b>
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="incident-history-empty"><strong>No incidents recorded</strong><span>Recent scans look normal.</span></div>
      )}
    </section>
  );
}

function statusLabel(status: MonitorStatus): string {
  if (status === "interference-likely") return "Signal above normal";
  if (status === "suspicious") return "Checking signal change";
  return "Normal";
}

function StatusDot({ status }: { status: MonitorStatus }) {
  return <span className={`table-status-dot ${status}`} aria-hidden="true" />;
}

const ARCHIVE_PAGE_SIZE = 20;
const REPLAY_BATCH_SIZE = 12;

export function evidenceSessionLifecycle(session: Pick<EvidenceArchiveSession, "lifecycle" | "status">): EvidenceLifecycle {
  if (session.lifecycle) return session.lifecycle;
  if (session.status === "recording") return "Active";
  if (session.status === "storage-error") return "Corrupt";
  // A legacy closed alias is not proof of a durable manifest-v2 commit.
  return "Incomplete";
}

export function evidenceLifecycleCopy(lifecycle: EvidenceLifecycle): { label: string; detail: string; exportable: boolean } {
  if (lifecycle === "Active") return { label: "Active", detail: "Recording now", exportable: false };
  if (lifecycle === "Finalizing") return { label: "Finalizing", detail: "Securing files", exportable: false };
  if (lifecycle === "Complete") return { label: "Complete", detail: "Ready to download", exportable: true };
  if (lifecycle === "Corrupt") return { label: "Corrupt", detail: "Verification failed", exportable: false };
  return { label: "Incomplete", detail: "Contains gaps", exportable: true };
}

function incidentStatus(event: DetectionEvent): string {
  if (event.lifecycle === "active") return "Alert";
  if (event.lifecycle === "recovering") return "Recovering";
  if (event.acknowledgedAt) return "Reviewed";
  return "Ended";
}

function replaySpectrumFrame(entry: EvidenceReplayFrame | undefined): SpectrumFrame | undefined {
  return entry ? { ...entry.frame, bins: Uint8Array.from(entry.frame.bins) } : undefined;
}

function replayMetrics(frame: SpectrumFrame | undefined, supplied: SignalMetricSample | undefined): SignalMetricSample | undefined {
  if (!frame?.bins.length) return undefined;
  if (supplied) return supplied;
  let total = 0;
  let peak = 0;
  for (const value of frame.bins) {
    total += value;
    peak = Math.max(peak, value);
  }
  return {
    timestamp: frame.timestamp,
    bandId: frame.bandId,
    meanLevel: total / frame.bins.length,
    peakLevel: peak,
    baselineLevel: 0,
    baselineDelta: 0,
    occupiedRatio: 0,
    overload: false,
  };
}

function EvidenceReplay({
  session,
  displayTimeZone,
  getBatch,
  signalLabel,
  onClose,
}: {
  session: EvidenceArchiveSession;
  displayTimeZone: string;
  getBatch: (sessionId: string, cursor?: string, limit?: number) => Promise<EvidenceReplayBatch>;
  signalLabel: (bandId: string) => string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<EvidenceReplayFrame[]>([]);
  const [index, setIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string>();
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<SpectrumFrame[]>([]);

  const load = useCallback(async (cursor?: string, restart = false): Promise<boolean> => {
    setLoading(true);
    setError(undefined);
    try {
      const batch = await getBatch(session.id, cursor, REPLAY_BATCH_SIZE);
      setEntries(batch.frames);
      setIndex(0);
      setNextCursor(batch.nextCursor);
      setDone(batch.done);
      if (restart) setHistory([]);
      return batch.frames.length > 0;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setEntries([]);
      setPlaying(false);
      return false;
    } finally {
      setLoading(false);
    }
  }, [getBatch, session.id]);

  useEffect(() => {
    let mounted = true;
    void load(undefined, true).then((available) => {
      if (mounted && available) setPlaying(true);
    });
    return () => { mounted = false; };
  }, [load]);

  const currentEntry = entries[index];
  const frame = useMemo(() => replaySpectrumFrame(currentEntry), [currentEntry]);
  const metrics = replayMetrics(frame, currentEntry?.metrics);

  useEffect(() => {
    if (!frame) return;
    setHistory((current) => {
      if (current.at(-1)?.id === frame.id) return current;
      const aligned = current.filter((candidate) => (
        candidate.startHz === frame.startHz
        && candidate.endHz === frame.endHz
        && candidate.bins.length === frame.bins.length
      ));
      return [...aligned, frame].slice(-24);
    });
  }, [frame]);

  const advance = useCallback(async () => {
    if (loading) return;
    if (index + 1 < entries.length) {
      setIndex((current) => current + 1);
      return;
    }
    if (nextCursor) {
      const available = await load(nextCursor);
      if (!available) setPlaying(false);
      return;
    }
    setPlaying(false);
  }, [entries.length, index, load, loading, nextCursor]);

  useEffect(() => {
    if (!playing || loading || !frame) return;
    const next = entries[index + 1];
    const recordedDelay = next ? Date.parse(next.frame.timestamp) - Date.parse(frame.timestamp) : 125;
    const delay = Math.max(125, Math.min(2_000, Number.isFinite(recordedDelay) ? recordedDelay / speed : 125));
    const timer = window.setTimeout(() => void advance(), delay);
    return () => window.clearTimeout(timer);
  }, [advance, entries, frame, index, loading, playing, speed]);

  const restart = async () => {
    setPlaying(false);
    const available = await load(undefined, true);
    if (available) setPlaying(true);
  };
  const atEnd = done && index >= entries.length - 1;

  return (
    <section className="evidence-replay" aria-label={`Read-only replay for ${session.id}`}>
      <header>
        <div><small>ARCHIVED REPLAY</small><strong>{session.lifecycle === "Incomplete" ? "Incomplete · recorded gaps" : "Read only"}</strong></div>
        <button type="button" onClick={onClose} aria-label="Close archived replay"><X size={16} /></button>
      </header>
      <p className="evidence-replay-scope">Saved observations only · No detector rerun · Monitoring unchanged</p>
      {session.lifecycle === "Incomplete" && session.incompleteReasons?.length ? <p className="evidence-replay-gap">Gaps: {session.incompleteReasons.join(", ")}</p> : null}
      {error ? <div className="evidence-history-error" role="alert">{error}</div> : null}
      <div className="evidence-replay-view">
        <div className="evidence-replay-spectrum"><SpectrumView frame={frame} metrics={metrics} showBaseline={false} showMarkers={false} /></div>
        <div className="evidence-replay-waterfall"><WaterfallView frames={history} /></div>
      </div>
      <dl className="evidence-replay-facts">
        <div><dt>Observed</dt><dd>{frame ? dateTime(frame.timestamp, displayTimeZone) : loading ? "Loading" : "No saved observations"}</dd></div>
        <div><dt>Signal</dt><dd>{frame ? signalLabel(frame.bandId) : "—"}</dd></div>
        <div><dt>Range</dt><dd>{frame ? formatRange(frame.startHz, frame.endHz) : "—"}</dd></div>
        <div><dt>Level</dt><dd>{metrics ? `${Math.round(metrics.peakLevel)} / 255 relative` : "—"}</dd></div>
      </dl>
      <div className="evidence-replay-controls">
        <button type="button" disabled={loading || !frame || atEnd} onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "Pause" : "Play"}</button>
        <button type="button" disabled={loading || !frame || atEnd} onClick={() => { setPlaying(false); void advance(); }}>Next observation</button>
        <label><span>Speed</span><select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={1}>1×</option><option value={4}>4×</option><option value={16}>16×</option></select></label>
        <button type="button" disabled={loading} onClick={() => void restart()}><RotateCcw size={14} />Restart</button>
      </div>
    </section>
  );
}

export function EvidenceArchive({
  snapshot,
  getArchive,
  getSessionEvents,
  getReplayBatch,
  onExportEvent,
  onExportSession,
  onOpenIncident,
}: {
  snapshot: MonitorSnapshot;
  getArchive: (offset?: number, limit?: number) => Promise<EvidenceArchivePage>;
  getSessionEvents: (sessionId: string, offset?: number, limit?: number) => Promise<EvidenceArchiveEventPage>;
  getReplayBatch: (sessionId: string, cursor?: string, limit?: number) => Promise<EvidenceReplayBatch>;
  onExportEvent: (event: DetectionEvent) => Promise<void>;
  onExportSession: (session: EvidenceArchiveSession) => Promise<void>;
  onOpenIncident: (event: DetectionEvent) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sessions, setSessions] = useState<EvidenceArchiveSession[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingEventsId, setLoadingEventsId] = useState<string>();
  const [error, setError] = useState<string>();
  const [downloadingId, setDownloadingId] = useState<string>();
  const [replaySessionId, setReplaySessionId] = useState<string>();

  const loadPage = useCallback(async (offset: number, replace: boolean) => {
    replace ? setLoading(true) : setLoadingMore(true);
    setError(undefined);
    try {
      const page = await getArchive(offset, ARCHIVE_PAGE_SIZE);
      setTotalSessions(page.totalSessions);
      setSessions((current) => replace ? page.sessions : [...current, ...page.sessions.filter((session) => !current.some((item) => item.id === session.id))]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [getArchive]);

  const loadMoreEvents = useCallback(async (session: EvidenceArchiveSession) => {
    setLoadingEventsId(session.id);
    setError(undefined);
    try {
      const page = await getSessionEvents(session.id, session.events.length, 20);
      setSessions((current) => current.map((item) => {
        if (item.id !== session.id) return item;
        const known = new Set(item.events.map((event) => event.id));
        const events = [...item.events, ...page.events.filter((event) => !known.has(event.id))];
        return {
          ...item,
          events,
          totalEvents: page.totalEvents,
          eventsOffset: 0,
          eventsLimit: events.length,
          hasMoreEvents: events.length < page.totalEvents,
        };
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingEventsId(undefined);
    }
  }, [getSessionEvents]);

  useEffect(() => {
    void loadPage(0, true);
  }, [loadPage]);

  const copyPath = async () => {
    await navigator.clipboard.writeText(snapshot.evidencePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  const download = async (id: string, action: () => Promise<void>) => {
    setDownloadingId(id);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDownloadingId(undefined);
    }
  };

  return (
    <section className="panel evidence-panel evidence-history" aria-labelledby="archive-title">
      <header className="evidence-history-heading">
        <div><span>Archive</span><h2 id="archive-title">Evidence history</h2><p>Recorded monitoring sessions and incident files.</p></div>
        <button type="button" onClick={() => void loadPage(0, true)} disabled={loading} aria-label="Refresh evidence history"><RefreshCw size={16} />Refresh</button>
      </header>
      <div className={`evidence-archive-state ${snapshot.evidenceHealthy ? "ready" : "error"}`}>
        <div><strong>{snapshot.evidenceHealthy ? "Recording ready" : "Recording error"}</strong><span>{totalSessions} session{totalSessions === 1 ? "" : "s"} in this archive</span></div>
        <small>RF data can show interference, not intent.</small>
      </div>
      {error ? <div className="evidence-history-error" role="status">{error}</div> : null}
      {loading ? <div className="evidence-history-empty"><strong>Loading evidence history</strong><span>Reading saved sessions and incident logs.</span></div> : sessions.length ? (
        <div className="evidence-session-list">
          {sessions.map((session, sessionIndex) => {
            const lifecycle = evidenceSessionLifecycle(session);
            const lifecycleCopy = evidenceLifecycleCopy(lifecycle);
            const replayable = session.lifecycle === "Complete"
              || (session.lifecycle === "Incomplete" && session.evidenceGap === true && Boolean(session.incompleteReasons?.length));
            return (
            <article className="evidence-session" key={session.id}>
              <header>
                <div className="evidence-session-title"><FolderArchive size={18} aria-hidden="true" /><span><small>Monitoring session</small><strong>{dateTime(session.startedAt, snapshot.displayTimeZone)}</strong></span></div>
                <span className={`evidence-status lifecycle-${lifecycle.toLowerCase()}`}>{lifecycleCopy.label}</span>
              </header>
              <p className="evidence-session-description">{lifecycleCopy.detail}. {session.totalEvents ? `${session.totalEvents} incident${session.totalEvents === 1 ? "" : "s"} recorded.` : "No incidents recorded."}</p>
              <dl className="evidence-session-facts">
                <div><dt>Ended</dt><dd>{session.endedAt ? dateTime(session.endedAt, snapshot.displayTimeZone) : "In progress"}</dd></div>
                <div><dt>Observations</dt><dd>{session.frameCount.toLocaleString()}</dd></div>
                <div><dt>Size</dt><dd>{formatBytes(session.byteCount)}</dd></div>
              </dl>
              <div className="evidence-session-actions">
                <code title={session.id}>{session.id}</code>
                <button type="button" title={replayable ? "Review saved spectrum observations" : `${lifecycleCopy.label} session is not eligible for replay`} disabled={!replayable || session.frameCount === 0} onClick={() => setReplaySessionId(session.id)}><Play size={15} />Play session</button>
                <button type="button" title={lifecycle === "Incomplete" ? "Download session with recorded gaps" : lifecycleCopy.exportable ? "Download verified session" : `${lifecycleCopy.label} sessions cannot be downloaded`} disabled={!snapshot.evidenceHealthy || !lifecycleCopy.exportable || Boolean(downloadingId)} onClick={() => void download(session.id, () => onExportSession(session))}><Download size={15} />{downloadingId === session.id ? "Preparing…" : "Download session"}</button>
              </div>
              {replaySessionId === session.id ? (
                <EvidenceReplay
                  session={session}
                  displayTimeZone={snapshot.displayTimeZone}
                  getBatch={getReplayBatch}
                  signalLabel={(bandId) => snapshot.bands.find((band) => band.id === bandId)?.label
                    ?? snapshot.monitorFeeds.find((feed) => feed.id === bandId)?.label
                    ?? bandId}
                  onClose={() => setReplaySessionId(undefined)}
                />
              ) : null}
              {session.events.length ? (
                <details className="evidence-event-log" open={sessionIndex === 0}>
                  <summary><span>{session.totalEvents} incident{session.totalEvents === 1 ? "" : "s"}</span><small>{session.hasMoreEvents ? `Newest ${session.events.length}` : "Event log"}</small></summary>
                  <div>
                    {session.events.map((event) => (
                      <article className="evidence-event" key={event.id}>
                        <header><span className={`evidence-status event-${incidentStatus(event).toLowerCase()}`}>{incidentStatus(event)}</span><time dateTime={event.startedAt}>{dateTime(event.startedAt, snapshot.displayTimeZone)}</time></header>
                        <strong>{event.affectedLabel ?? event.bandLabel}</strong>
                        <small>{formatRange(...event.affectedRangeHz)}</small>
                        <p>{event.observed}</p>
                        <footer>
                          <button type="button" onClick={() => onOpenIncident(event)}><Eye size={15} />View incident</button>
                          <button type="button" disabled={!snapshot.evidenceHealthy || Boolean(downloadingId)} onClick={() => void download(event.id, () => onExportEvent(event))}><Download size={15} />{downloadingId === event.id ? "Preparing…" : "Download"}</button>
                          {event.figureAvailable ? <a className="text-button" href={`/api/events/${encodeURIComponent(event.id)}/figure.svg`} target="_blank" rel="noopener noreferrer" aria-label="Open the saved incident image in a new tab"><Eye size={15} />Image</a> : null}
                        </footer>
                      </article>
                    ))}
                    {session.hasMoreEvents ? <button className="evidence-load-more" type="button" disabled={Boolean(loadingEventsId)} onClick={() => void loadMoreEvents(session)}>{loadingEventsId === session.id ? "Loading…" : "Load older incidents"}</button> : null}
                  </div>
                </details>
              ) : <p className="evidence-no-events">No incident events in this session.</p>}
            </article>
          );})}
          {sessions.length < totalSessions ? <button className="evidence-load-more" type="button" disabled={loadingMore} onClick={() => void loadPage(sessions.length, false)}>{loadingMore ? "Loading…" : "Load older sessions"}</button> : null}
        </div>
      ) : <div className="evidence-history-empty"><strong>No sessions recorded</strong><span>New monitoring sessions will appear here automatically.</span></div>}
      <div className="archive-actions evidence-history-path">
        <span title={snapshot.evidencePath}>Storage: {snapshot.evidencePath}</span>
        <button className="text-button" type="button" onClick={() => void copyPath()}><Copy size={15} /> {copied ? "Path copied" : "Copy path"}</button>
      </div>
    </section>
  );
}

export function OptionsPanel({ options, onChange }: { options: DisplayOptions; onChange: (next: DisplayOptions) => void }) {
  const toggle = (key: "waterfall" | "baseline" | "markers") => onChange({ ...options, [key]: !options[key] });
  return (
    <section className="panel options-panel" aria-labelledby="view-title">
      <h2 id="view-title" className="panel-title">Engineer view</h2>
      <h3>Display options</h3>
      <div className="trace-mode-control" role="group" aria-label="Spectrum trace"><span>Trace</span>{(["current", "peak", "average"] as const).map((mode) => <button key={mode} type="button" className={options.traceMode === mode ? "selected" : ""} onClick={() => onChange({ ...options, traceMode: mode })}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>
      <CheckOption label="Show waterfall" checked={options.waterfall} onChange={() => toggle("waterfall")} />
      <CheckOption label="Show baseline" checked={options.baseline} onChange={() => toggle("baseline")} />
      <CheckOption label="Show markers" checked={options.markers} onChange={() => toggle("markers")} />
    </section>
  );
}

function CheckOption({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: () => void; icon?: React.ReactNode }) {
  return (
    <label className="check-option">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {icon}
      <span>{label}</span>
    </label>
  );
}
