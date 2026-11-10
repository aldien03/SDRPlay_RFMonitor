import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const dialogStack: symbol[] = [];

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface HiddenSiblingState {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

export interface DialogShellProps {
  children: ReactNode;
  onClose: () => void;
  backdropClassName: string;
  dialogClassName: string;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

/**
 * Shared modal boundary: initial focus, tab containment, Escape handling,
 * inert background, nested-dialog safety, and focus return live in one place.
 * Callers retain their existing visual classes and component anatomy.
 */
export function DialogShell({
  children,
  onClose,
  backdropClassName,
  dialogClassName,
  labelledBy,
  describedBy,
  ariaLabel,
  closeOnBackdrop = true,
  closeOnEscape = true,
}: DialogShellProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);
  onCloseRef.current = onClose;
  closeOnEscapeRef.current = closeOnEscape;
  const portalHostRef = useRef<HTMLDivElement | undefined>(undefined);
  if (!portalHostRef.current) {
    const host = document.createElement("div");
    host.className = "rf-dialog-root";
    portalHostRef.current = host;
  }

  useLayoutEffect(() => {
    const host = portalHostRef.current!;
    const token = Symbol("rf-dialog");
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    host.style.position = "relative";
    host.style.zIndex = String(1_000 + dialogStack.length);
    document.body.append(host);
    const hiddenSiblings: HiddenSiblingState[] = Array.from(document.body.children)
      .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && candidate !== host && !candidate.hasAttribute("data-rf-toast-layer"))
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const sibling of hiddenSiblings) {
      sibling.element.inert = true;
      sibling.element.setAttribute("aria-hidden", "true");
    }
    dialogStack.push(token);

    const dialog = dialogRef.current;
    const focusable = () => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true") : [];
    const preferred = dialog?.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusable()[0] ?? dialog;
    preferred?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== token) return;
      if (event.key === "Escape" && closeOnEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusable();
      if (!candidates.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const index = dialogStack.lastIndexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      for (const sibling of hiddenSiblings) {
        sibling.element.inert = sibling.inert;
        if (sibling.ariaHidden === null) sibling.element.removeAttribute("aria-hidden");
        else sibling.element.setAttribute("aria-hidden", sibling.ariaHidden);
      }
      host.remove();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return createPortal(
    <div
      className={backdropClassName}
      role="presentation"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={dialogClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    portalHostRef.current,
  );
}
