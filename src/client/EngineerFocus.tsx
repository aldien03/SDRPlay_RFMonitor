import { AlertTriangle, Target } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { validFocusFrequencies } from "../shared/settings";
import type { MonitorSnapshot, SettingsRevision } from "../shared/types";

interface EngineerFocusProps {
  snapshot: MonitorSnapshot;
  getSettings: () => Promise<SettingsRevision>;
  startFocus: (bandId: string, centerHz: number | undefined, durationMs: number) => Promise<unknown>;
  stopFocus: () => Promise<unknown>;
  onToast: (message: string) => void;
}

export function EngineerFocus({ snapshot, getSettings, startFocus, stopFocus, onToast }: EngineerFocusProps) {
  const [settings, setSettings] = useState<SettingsRevision>();
  const [bandId, setBandId] = useState("");
  const [frequencyMhz, setFrequencyMhz] = useState(0);
  const [durationMinutes, setDurationMinutes] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void getSettings()
      .then((next) => {
        if (controller.signal.aborted) return;
        setSettings(next);
        const firstBand = next.effectiveBands[0] ?? next.catalog.bands[0];
        if (firstBand) {
          setBandId((current) => current || firstBand.id);
          setFrequencyMhz((current) => current || firstBand.centerHz / 1_000_000);
        }
        const maximum = Math.max(1, Math.floor(next.settings.liveFocusTimeoutMs / 60_000));
        setDurationMinutes((current) => Math.min(current, maximum));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [getSettings]);

  const band = settings?.catalog.bands.find((candidate) => candidate.id === bandId);
  const maximumMinutes = Math.max(1, Math.floor((settings?.settings.liveFocusTimeoutMs ?? 60_000) / 60_000));
  const durationOptions = useMemo(() => [...new Set([1, 2, 5, 10, 15, 30, 60, maximumMinutes])]
    .filter((value) => value <= maximumMinutes)
    .sort((left, right) => left - right), [maximumMinutes]);

  const selectBand = (nextBandId: string) => {
    const nextBand = settings?.catalog.bands.find((candidate) => candidate.id === nextBandId);
    setBandId(nextBandId);
    if (nextBand) setFrequencyMhz(nextBand.centerHz / 1_000_000);
    setConfirming(false);
    setError(undefined);
  };

  const begin = async () => {
    if (!band) return;
    const centerHz = Math.round(frequencyMhz * 1_000_000);
    if (!validFocusFrequencies(band).includes(centerHz)) {
      setError("Choose a frequency from this target's channel plan.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await startFocus(band.id, centerHz, durationMinutes * 60_000);
      setConfirming(false);
      onToast(`${band.label} is live for ${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await stopFocus();
      onToast("Full survey resumed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="engineer-focus" aria-labelledby="engineer-focus-title">
      <header><Target size={17} aria-hidden="true" /><strong id="engineer-focus-title">Check one frequency</strong></header>
      {snapshot.activeFocus ? (
        <div className="engineer-focus-active">
          <div><strong>{snapshot.activeFocus.label}</strong><span>Survey resumes {new Date(snapshot.activeFocus.expiresAt).toLocaleTimeString()}</span></div>
          <button type="button" disabled={busy} onClick={() => void resume()}>Resume survey</button>
        </div>
      ) : (
        <>
          <div className="engineer-focus-controls">
            <label><span>Target</span><select aria-label="Frequency check target" value={bandId} disabled={!settings || busy} onChange={(event) => selectBand(event.target.value)}>
              {settings?.catalog.services.map((service) => <optgroup key={service.id} label={service.label}>{settings.catalog.bands.filter((candidate) => candidate.service === service.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</optgroup>)}
            </select></label>
            <label><span>Frequency</span><div className="engineer-focus-frequency"><input aria-label="Frequency in megahertz" type="number" value={frequencyMhz || ""} min={(band?.startHz ?? 0) / 1_000_000} max={(band?.endHz ?? 0) / 1_000_000} step={(band?.channelSpacingHz ?? 1_000_000) / 1_000_000} readOnly={!band?.channelSpacingHz} disabled={!band || busy} onChange={(event) => { setFrequencyMhz(Number(event.target.value)); setConfirming(false); setError(undefined); }} /><span>MHz</span></div></label>
            <label><span>Time limit</span><select aria-label="Frequency check time limit" value={durationMinutes} disabled={!settings || busy} onChange={(event) => { setDurationMinutes(Number(event.target.value)); setConfirming(false); }}>{durationOptions.map((value) => <option key={value} value={value}>{value} min</option>)}</select></label>
          </div>
          {!confirming ? <button className="engineer-focus-review" type="button" disabled={!band || busy} onClick={() => setConfirming(true)}>Review coverage pause</button> : (
            <div className="engineer-focus-warning" role="alert">
              <div><AlertTriangle size={16} aria-hidden="true" /><span><strong>Coverage will pause</strong><small>Only {band?.label} will be live for {durationMinutes} min. Other objectives are suspended and logged.</small></span></div>
              <div><button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={() => void begin()}>{busy ? "Starting…" : "Start check"}</button></div>
            </div>
          )}
        </>
      )}
      {error ? <p className="engineer-focus-error" role="alert">{error}</p> : null}
    </section>
  );
}
