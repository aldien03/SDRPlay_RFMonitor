import { X } from "lucide-react";
import { useId, useState } from "react";
import { DialogShell } from "./DialogShell";

interface ModalShellProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

function ModalShell({ title, children, onClose }: ModalShellProps) {
  const titleId = useId();
  return (
    <DialogShell backdropClassName="modal-backdrop" dialogClassName="modal" labelledBy={titleId} onClose={onClose}>
      <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={21} /></button></div>
      {children}
    </DialogShell>
  );
}

export function NoteModal({ onClose, onSave }: { onClose: () => void; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <ModalShell title="Add incident note" onClose={onClose}>
      <label className="field-label" htmlFor="incident-note">Operator note</label>
      <textarea id="incident-note" autoFocus rows={6} maxLength={2_000} value={text} onChange={(event) => setText(event.target.value)} placeholder="Add checks, equipment status, or actions taken." />
      <div className="modal-actions"><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" type="button" disabled={!text.trim() || saving} onClick={() => { setSaving(true); void onSave(text).finally(() => setSaving(false)); }}>{saving ? "Saving..." : "Save note"}</button></div>
    </ModalShell>
  );
}
