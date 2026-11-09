import { useEffect, useMemo, useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { alertPresetLabel, describeAlertPolicy, matchingAlertPreset } from "../shared/alertPolicy";
import { selectedMonitoringTargetIds } from "../shared/settings";
import type {
  AlertPolicyBound,
  AlertPolicySetting,
  AlertPolicyValues,
  AlertPresetId,
  AlertPreview,
  OperationalSettings,
  ReportLogo,
  SettingsRevision,
} from "../shared/types";

const PRESET_ORDER: AlertPresetId[] = ["conservative", "standard", "sensitive", "very-sensitive"];

function presetValues(response: SettingsRevision, id: AlertPresetId): AlertPolicyValues | undefined {
  return response.alertPresets?.find((preset) => preset.id === id)?.values;
}

function settingFor(response: SettingsRevision, id: AlertPresetId): AlertPolicySetting | undefined {
  const values = presetValues(response, id);
  return values ? { preset: id, values: { ...values } } : undefined;
}

function primarySpanHz(response: SettingsRevision, draft: OperationalSettings): number | undefined {
  const targetIds = selectedMonitoringTargetIds(draft, response.catalog);
  const target = response.catalog.captureTargets.find((candidate) => candidate.id === targetIds[0]);
  return target?.analysisSpanHz;
}

/**
 * Alert sensitivity: how much raised energy, how wide and how often, before an
 * alert. Presets and their values come from the server. Changing sensitivity
 * never restarts signal learning and never ends an open incident.
 */
export function AlertSensitivitySection({ response, draft, setDraft, disabled, errors, getAlertPreview }: {
  response: SettingsRevision;
  draft: OperationalSettings;
  setDraft: (value: OperationalSettings) => void;
  disabled: boolean;
  errors: Record<string, string>;
  getAlertPreview?: () => Promise<AlertPreview>;
}) {
  const [preview, setPreview] = useState<AlertPreview>();
  useEffect(() => {
    if (!getAlertPreview) return;
    let active = true;
    const load = () => void getAlertPreview().then((next) => active && setPreview(next)).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [getAlertPreview]);
  const current = draft.alerting.default;
  const facts = useMemo(() => describeAlertPolicy(current.values, primarySpanHz(response, draft)), [current.values, draft, response]);
  const presets = response.alertPresets ?? [];
  const choose = (id: AlertPresetId) => {
    const setting = settingFor(response, id);
    if (!setting) return;
    setDraft({ ...draft, alerting: { ...draft.alerting, default: setting } });
  };
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + PRESET_ORDER.length) % PRESET_ORDER.length;
    choose(PRESET_ORDER[next]);
    const group = event.currentTarget.parentElement;
    window.requestAnimationFrame(() => group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus());
  };
  const monitoredTargets = response.catalog.captureTargets.filter((target) => selectedMonitoringTargetIds(draft, response.catalog).includes(target.id));
  const sensitivityErrors = Object.entries(errors).filter(([key]) => key.startsWith("alerting."));

  return (
    <section className="settings-subsection sensitivity-panel" aria-labelledby="alert-sensitivity-title">
      <div>
        <h2 id="alert-sensitivity-title" className="settings-subheading">Alert sensitivity</h2>
        <p className="sensitivity-note">Signal learning continues and open incidents stay open when you change this.</p>
      </div>
      <div className="sensitivity-choices" role="radiogroup" aria-label="Alert sensitivity">
        {PRESET_ORDER.map((id, index) => {
          const preset = presets.find((candidate) => candidate.id === id);
          const checked = current.preset === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              className="sensitivity-choice"
              aria-checked={checked}
              tabIndex={checked || (current.preset === "custom" && index === 1) ? 0 : -1}
              disabled={disabled || !preset}
              onKeyDown={(event) => move(event, index)}
              onClick={() => choose(id)}
            >
              <strong>{preset?.label ?? alertPresetLabel(id)}</strong>
              <span>{preset?.effect ?? ""}</span>
            </button>
          );
        })}
      </div>
      {current.preset === "custom" ? <p className="sensitivity-note">Custom values are set in Advanced › Alert rules.</p> : null}
      <dl className="sensitivity-facts" aria-label="What triggers an alert">
        {facts.map((fact) => <div key={fact.id}><dt>{fact.label}</dt><dd>{fact.text}</dd></div>)}
      </dl>
      <p className="sensitivity-note">“Normal variation” is how much each frequency usually moves around its learned level. Levels are relative, not calibrated power.</p>

      {preview?.targets.length ? (
        <div>
          <h3 className="settings-subheading">Estimated alerts, last {Math.max(...preview.targets.map((target) => target.observedHours)).toFixed(1)} h</h3>
          <table className="sensitivity-preview">
            <thead><tr><th scope="col">Window</th>{PRESET_ORDER.map((id) => <th key={id} scope="col">{alertPresetLabel(id)}</th>)}</tr></thead>
            <tbody>
              {preview.targets.map((target) => (
                <tr key={target.targetId}>
                  <th scope="row">{target.label}</th>
                  {PRESET_ORDER.map((id) => <td key={id} className={response.settings.alerting.default.preset === id ? "active" : undefined}>{target.onsets[id]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sensitivity-note">Counted from live checks since the service started. An estimate, not a guarantee.</p>
        </div>
      ) : null}

      {monitoredTargets.length > 1 || Object.keys(draft.alerting.targetOverrides).length ? (
        <div className="sensitivity-windows">
          <h3 className="settings-subheading">Per window</h3>
          {response.catalog.captureTargets
            .filter((target) => monitoredTargets.some((candidate) => candidate.id === target.id) || draft.alerting.targetOverrides[target.id])
            .map((target) => {
              const override = draft.alerting.targetOverrides[target.id];
              return (
                <label key={target.id} className="sensitivity-window">
                  <span>{target.label}</span>
                  <select
                    disabled={disabled}
                    value={override?.preset ?? "default"}
                    onChange={(event) => {
                      const value = event.target.value;
                      const overrides = { ...draft.alerting.targetOverrides };
                      if (value === "default") delete overrides[target.id];
                      else if (value !== "custom") {
                        const setting = settingFor(response, value as AlertPresetId);
                        if (setting) overrides[target.id] = setting;
                      }
                      setDraft({ ...draft, alerting: { ...draft.alerting, targetOverrides: overrides } });
                    }}
                  >
                    <option value="default">Same as above ({alertPresetLabel(current.preset)})</option>
                    {PRESET_ORDER.map((id) => <option key={id} value={id}>{alertPresetLabel(id)}</option>)}
                    {override?.preset === "custom" ? <option value="custom">Custom</option> : null}
                  </select>
                </label>
              );
            })}
        </div>
      ) : null}
      {sensitivityErrors.length ? <ul className="field-errors">{sensitivityErrors.map(([key, text]) => <li key={key}>{text}</li>)}</ul> : null}
    </section>
  );
}

function boundValue(bound: AlertPolicyBound, values: AlertPolicyValues): number {
  const raw = values[bound.key] as number | boolean;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (bound.unit === "ratio") return Number((raw * 100).toFixed(2));
  if (bound.unit === "ms") return Number((raw / 1_000).toFixed(2));
  return raw;
}

function fromInput(bound: AlertPolicyBound, value: number): number {
  if (bound.unit === "ratio") return value / 100;
  if (bound.unit === "ms") return Math.round(value * 1_000);
  return value;
}

function unitLabel(bound: AlertPolicyBound): string {
  switch (bound.unit) {
    case "x": return "× normal variation";
    case "ratio": return "% of window";
    case "checks": return "checks";
    case "ms": return "seconds";
    case "bins": return "bins";
    default: return "";
  }
}

/** Advanced › Alert rules: every value the alert classifier uses, with plain units. */
export function AlertRulesEditor({ response, draft, setDraft, disabled, errors }: {
  response: SettingsRevision;
  draft: OperationalSettings;
  setDraft: (value: OperationalSettings) => void;
  disabled: boolean;
  errors: Record<string, string>;
}) {
  const values = draft.alerting.default.values;
  const bounds = response.alertPolicyBounds ?? [];
  const update = (bound: AlertPolicyBound, input: number | boolean) => {
    const nextValues = { ...values, [bound.key]: typeof input === "boolean" ? input : fromInput(bound, input) } as AlertPolicyValues;
    const preset = matchingAlertPreset(nextValues) ?? "custom";
    setDraft({ ...draft, alerting: { ...draft.alerting, default: { preset, values: nextValues } } });
  };
  return (
    <div className="alert-rules-editor">
      <p className="protected-action-hint">Editing any value switches sensitivity to Custom. Learning continues; open incidents stay open.</p>
      <div className="settings-form-grid detection-grid">
        {bounds.map((bound) => bound.unit === "boolean" ? (
          <label key={bound.key} className="form-field">
            <span>{bound.label}</span>
            <label className="switch-control"><input type="checkbox" role="switch" aria-label={bound.label} disabled={disabled} checked={Boolean(values[bound.key])} onChange={(event) => update(bound, event.target.checked)} /><span aria-hidden="true" /><b className="service-state">{values[bound.key] ? "On" : "Off"}</b></label>
          </label>
        ) : (
          <ValidatedNumberField
            key={bound.key}
            label={bound.zeroMeansOff ? `${bound.label} (0 = off)` : bound.label}
            suffix={unitLabel(bound)}
            min={bound.zeroMeansOff ? 0 : bound.unit === "ratio" ? bound.min * 100 : bound.unit === "ms" ? bound.min / 1_000 : bound.min}
            max={bound.unit === "ratio" ? bound.max * 100 : bound.unit === "ms" ? bound.max / 1_000 : bound.max}
            step={bound.unit === "ratio" ? bound.step * 100 : bound.unit === "ms" ? bound.step / 1_000 : bound.step}
            value={boundValue(bound, values)}
            disabled={disabled}
            error={errors[`alerting.default.values.${bound.key}`]}
            onChange={(value) => update(bound, value)}
          />
        ))}
      </div>
    </div>
  );
}

/** A number input that never turns an empty or partial entry into 0. */
export function ValidatedNumberField({ label, value, min, max, step = 1, suffix, disabled = false, error, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  error?: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const lastValue = useRef(value);
  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setText(String(value));
    }
  }, [value]);
  const parsed = text.trim() === "" ? Number.NaN : Number(text);
  const localError = !Number.isFinite(parsed) ? "Enter a number" : parsed < min || parsed > max ? `Use ${min} to ${max}` : undefined;
  return (
    <label className="form-field number-field">
      <span>{label}</span>
      <div className="input-suffix">
        <input
          type="number"
          inputMode="decimal"
          disabled={disabled}
          value={text}
          min={min}
          max={max}
          step={step}
          aria-invalid={Boolean(localError || error)}
          onChange={(event) => {
            setText(event.target.value);
            const next = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value);
            if (Number.isFinite(next)) {
              lastValue.current = next;
              onChange(next);
            }
          }}
        />
        {suffix ? <b>{suffix}</b> : null}
      </div>
      {localError || error ? <span className="field-error" role="alert">{localError ?? error}</span> : null}
    </label>
  );
}

/** Settings › Site › Report identity: printed on every client incident report. */
export function ReportIdentitySection({ draft, setDraft, disabled, errors, uploadLogo, onToast }: {
  draft: OperationalSettings;
  setDraft: (value: OperationalSettings) => void;
  disabled: boolean;
  errors: Record<string, string>;
  uploadLogo?: (file: File) => Promise<ReportLogo>;
  onToast: (message: string) => void;
}) {
  const identity = draft.reportIdentity ?? {};
  const [uploading, setUploading] = useState(false);
  const update = (key: "companyName" | "clientName" | "vesselName" | "projectReference", value: string) => {
    const next = { ...identity, [key]: value };
    if (!value) delete next[key];
    setDraft({ ...draft, reportIdentity: next });
  };
  const fields: Array<{ key: "companyName" | "clientName" | "vesselName" | "projectReference"; label: string }> = [
    { key: "companyName", label: "Company name" },
    { key: "clientName", label: "Client" },
    { key: "vesselName", label: "Vessel or platform" },
    { key: "projectReference", label: "Project or job reference" },
  ];
  return (
    <section className="settings-subsection" aria-labelledby="report-identity-title">
      <h2 id="report-identity-title" className="settings-subheading">Report identity</h2>
      <p className="sensitivity-note">Printed on the cover and header of every incident report.</p>
      {fields.map((field) => (
        <label key={field.key} className="form-field">
          <span>{field.label}</span>
          <input disabled={disabled} value={identity[field.key] ?? ""} maxLength={120} onChange={(event) => update(field.key, event.target.value)} />
          {errors[`reportIdentity.${field.key}`] ? <span className="field-error" role="alert">{errors[`reportIdentity.${field.key}`]}</span> : null}
        </label>
      ))}
      <div className="form-field">
        <span>Logo</span>
        <div className="report-logo-row">
          {identity.logo ? <img className="report-logo-preview" src={`/api/site/report-logo?sha=${identity.logo.sha256}`} alt="Current report logo" /> : <span className="sensitivity-note">No logo. PNG or JPEG, up to 512 KB.</span>}
          <label className={`button secondary compact ${disabled || uploading ? "disabled" : ""}`}>
            <ImageUp size={15} aria-hidden="true" /> {uploading ? "Uploading…" : identity.logo ? "Replace" : "Upload"}
            <input
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              disabled={disabled || uploading || !uploadLogo}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file || !uploadLogo) return;
                setUploading(true);
                void uploadLogo(file)
                  .then((logo) => setDraft({ ...draft, reportIdentity: { ...identity, logo } }))
                  .catch((reason) => onToast(reason instanceof Error ? reason.message : String(reason)))
                  .finally(() => setUploading(false));
              }}
            />
          </label>
          {identity.logo ? <button type="button" className="button secondary compact" disabled={disabled} onClick={() => { const next = { ...identity }; delete next.logo; setDraft({ ...draft, reportIdentity: next }); }}><Trash2 size={15} aria-hidden="true" /> Remove</button> : null}
        </div>
        {errors["reportIdentity.logo"] ? <span className="field-error" role="alert">{errors["reportIdentity.logo"]}</span> : null}
      </div>
      <div className="report-cover-preview" aria-label="Report cover preview">
        {identity.logo ? <img src={`/api/site/report-logo?sha=${identity.logo.sha256}`} alt="" /> : null}
        <div>
          <strong>{identity.companyName || draft.siteName}</strong>
          <span>RF Incident Report</span>
          <small>{[identity.clientName, identity.vesselName, identity.projectReference].filter(Boolean).join(" · ") || "Client, vessel and project appear here"}</small>
        </div>
      </div>
    </section>
  );
}
