import { createPortal } from "react-dom";

let host: HTMLDivElement | undefined;

function toastHost(): HTMLDivElement {
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "rf-toast-layer";
    // DialogShell leaves this layer active, so messages stay visible and announced above drawers and dialogs.
    host.setAttribute("data-rf-toast-layer", "");
    document.body.append(host);
  }
  return host;
}

/** Short status message ("Note added.", export errors) shown above every surface. */
export function Toast({ message }: { message?: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(<div className="toast-region" role="status" aria-live="polite">{message ? <div className="toast">{message}</div> : null}</div>, toastHost());
}
