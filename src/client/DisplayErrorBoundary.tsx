import React from "react";

interface DisplayErrorBoundaryState {
  failed: boolean;
  detail?: string;
}

/**
 * A control-room display must fail closed rather than unmount to a blank page.
 * Monitoring, recording and evidence continue on the server while this shows,
 * so the operator recovery is a plain Reload rather than a developer contact.
 */
export class DisplayErrorBoundary extends React.Component<{ children: React.ReactNode }, DisplayErrorBoundaryState> {
  state: DisplayErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): DisplayErrorBoundaryState {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
    return { failed: true, detail };
  }

  componentDidCatch(error: unknown): void {
    console.error("RF Monitor display error", error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="display-failure" role="alert">
        <div>
          <strong>Display stopped</strong>
          <p>Monitoring, recording and evidence continue on the server. Reload to restore this dashboard.</p>
          <button className="button primary" type="button" onClick={() => location.reload()}>Reload</button>
          {this.state.detail ? <details><summary>Engineer details</summary><code>{this.state.detail}</code></details> : null}
        </div>
      </div>
    );
  }
}
