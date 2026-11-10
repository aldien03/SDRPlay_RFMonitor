import { useEffect, useState } from "react";
import type { DgnssConfig, DgnssSystemConfig } from "../shared/dgnss";
import { DgnssApiError, getDgnssConfig, saveDgnssConfig } from "./dgnssApi";

type Editable = Omit<DgnssConfig, "schemaVersion" | "revision" | "updatedAt">;

const COLUMNS: Array<{ key: keyof DgnssSystemConfig; label: string; placeholder: string }> = [
  { key: "id", label: "Gator system", placeholder: "DGPS1" },
  { key: "output", label: "Fugro output", placeholder: "G4" },
  { key: "receiver", label: "Receiver", placeholder: "Starpack A" },
  { key: "antenna", label: "Antenna", placeholder: "Calian" },
  { key: "antennaGroup", label: "Splitter group", placeholder: "Calian" },
  { key: "beam", label: "Beam", placeholder: "EASAT" },
  { key: "ip", label: "IP", placeholder: ".60" },
];

function blankSystem(index: number): DgnssSystemConfig {
  return { id: `DGPS${index + 1}`, output: "", receiver: "", antenna: "", antennaGroup: "", beam: "", ip: "" };
}

/** Settings › Site › DGNSS report. Saved on its own, with the Settings password. */
export function DgnssSettings({ unlocked, onToast }: { unlocked: boolean; onToast: (message: string) => void }) {
  const [draft, setDraft] = useState<Editable>();
  const [revision, setRevision] = useState(0);
  const [configured, setConfigured] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    try {
      const response = await getDgnssConfig();
      const { schemaVersion: _schema, revision: savedRevision, updatedAt: _updated, ...rest } = response.config;
      setDraft({ ...rest, systems: rest.systems.length ? rest.systems : Array.from({ length: 6 }, (_, index) => blankSystem(index)) });
      setRevision(savedRevision);
      setConfigured(response.configured);
      setDirty(false);
      setFields({});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!draft) return <section className="dgnss-settings" aria-labelledby="dgnss-settings-title"><h2 id="dgnss-settings-title" className="settings-subheading">DGNSS report</h2><p className="protected-action-hint">{error ?? "Loading…"}</p></section>;

  const disabled = !unlocked || saving;
  const change = (next: Editable) => {
    setDraft(next);
    setDirty(true);
  };
  const setSystem = (index: number, key: keyof DgnssSystemConfig, value: string) => {
    const systems = draft.systems.map((system, position) => (position === index ? { ...system, [key]: value } : system));
    change({ ...draft, systems, controlId: key === "id" && draft.controlId === draft.systems[index].id ? value : draft.controlId });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setFields({});
    try {
      const response = await saveDgnssConfig({ ...draft, systems: draft.systems.map((system) => ({ ...system, ip: system.ip || undefined })) }, revision);
      setRevision(response.config.revision);
      setConfigured(true);
      setDirty(false);
      onToast("DGNSS report settings saved");
    } catch (reason) {
      if (reason instanceof DgnssApiError && reason.fields) setFields(reason.fields);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="dgnss-settings" aria-labelledby="dgnss-settings-title">
      <h2 id="dgnss-settings-title" className="settings-subheading">DGNSS report</h2>
      <p className="protected-action-hint">Systems, control and limits used for every DGNSS report. Gator ids must match the SBS page names (DGPS1_QC → DGPS1). Solutions on one splitter share a group.{configured ? "" : " Not saved yet: reports cannot be generated until this is saved."}</p>
      <div className="dgnss-table-scroll">
        <table className="dgnss-systems">
          <thead><tr>{COLUMNS.map((column) => <th key={column.key} scope="col">{column.label}</th>)}<th scope="col">Control</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {draft.systems.map((system, index) => (
              <tr key={index}>
                {COLUMNS.map((column) => (
                  <td key={column.key}>
                    <input aria-label={`${column.label} ${index + 1}`} disabled={disabled} value={system[column.key] ?? ""} placeholder={column.placeholder} maxLength={column.key === "id" ? 32 : 80} onChange={(event) => setSystem(index, column.key, event.target.value)} aria-invalid={Boolean(fields[`systems.${index}.${column.key}`])} />
                    {fields[`systems.${index}.${column.key}`] ? <span className="field-error">{fields[`systems.${index}.${column.key}`]}</span> : null}
                  </td>
                ))}
                <td className="center"><input type="radio" name="dgnss-control" aria-label={`Control ${system.id}`} disabled={disabled} checked={draft.controlId === system.id} onChange={() => change({ ...draft, controlId: system.id })} /></td>
                <td><button type="button" className="text-button" disabled={disabled || draft.systems.length <= 1} onClick={() => change({ ...draft, systems: draft.systems.filter((_, position) => position !== index) })}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fields.systems || fields.controlId ? <span className="field-error">{fields.systems ?? fields.controlId}</span> : null}
      <button type="button" className="button secondary compact dgnss-add" disabled={disabled || draft.systems.length >= 12} onClick={() => change({ ...draft, systems: [...draft.systems, blankSystem(draft.systems.length)] })}>Add system</button>
      <div className="settings-form-grid">
        <label className="form-field"><span>Control threshold (m)</span><input type="number" step="0.01" min={0.01} max={10} disabled={disabled} value={draft.agreementM} onChange={(event) => change({ ...draft, agreementM: Number(event.target.value) })} />{fields.agreementM ? <span className="field-error">{fields.agreementM}</span> : null}</label>
        <label className="form-field"><span>Moving above (kn)</span><input type="number" step="0.1" min={0.05} max={5} disabled={disabled} value={draft.movingKnots} onChange={(event) => change({ ...draft, movingKnots: Number(event.target.value) })} />{fields.movingKnots ? <span className="field-error">{fields.movingKnots}</span> : null}</label>
        <label className="form-field"><span>Survey</span><input disabled={disabled} maxLength={80} value={draft.survey ?? ""} onChange={(event) => change({ ...draft, survey: event.target.value })} /></label>
        <label className="form-field"><span>Location</span><input disabled={disabled} maxLength={80} value={draft.location ?? ""} onChange={(event) => change({ ...draft, location: event.target.value })} /></label>
        <label className="form-field"><span>Geodetics</span><input disabled={disabled} maxLength={80} value={draft.geodetics ?? ""} onChange={(event) => change({ ...draft, geodetics: event.target.value })} /></label>
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dgnss-settings-actions">
        <span>{!unlocked ? "View only. Unlock to edit." : dirty ? "Unsaved DGNSS changes" : "Applies to new reports. No retune, no learning restart."}</span>
        {dirty && unlocked ? <button type="button" className="button secondary compact" disabled={saving} onClick={() => void load()}>Discard</button> : null}
        <button type="button" className="button primary compact" disabled={disabled || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save DGNSS report settings"}</button>
      </div>
    </section>
  );
}
