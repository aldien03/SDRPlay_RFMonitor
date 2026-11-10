import type { Duplex } from "node:stream";

/**
 * A WebSocket protocol fault (frame over maxPayload, bad UTF-8, invalid frame) is reported as an
 * 'error' event on the socket. With no listener that is an uncaught exception that ends the whole
 * monitoring service, so every socket the service owns gets one.
 */
export function guardWebSocket(
  socket: { on(event: "error", listener: (error: Error) => void): unknown; terminate(): void },
  onFault?: (error: Error) => void,
): void {
  socket.on("error", (error) => {
    try { onFault?.(error); } catch { /* a fault reporter must never throw */ }
    try { socket.terminate(); } catch { /* already gone */ }
  });
}

/** A client that resets mid-handshake emits 'error' on the raw upgrade socket. */
export function guardUpgradeSocket(socket: Duplex, onFault?: (error: Error) => void): void {
  socket.on("error", (error) => {
    try { onFault?.(error); } catch { /* ignore */ }
    socket.destroy();
  });
}

export interface ShutdownStep {
  name: string;
  run: () => unknown | Promise<unknown>;
}

export interface ShutdownCoordinatorOptions {
  steps: ReadonlyArray<ShutdownStep>;
  exit: (code: number) => void;
  log: (message: string) => void;
  /** Hard ceiling; the process exits non-zero if cleanup has not finished by then. */
  forceExitAfterMs?: number;
}

/**
 * Runs cleanup once, in order. A failing step is logged and the remaining steps still run, so a
 * rejected flush can no longer stop the evidence session from closing or the lease from releasing.
 * Repeated calls (a second SIGTERM, a fault during shutdown) join the run already in progress.
 */
export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): (reason: string, exitCode?: number) => Promise<void> {
  const { steps, exit, log, forceExitAfterMs = 30_000 } = options;
  let running: Promise<void> | undefined;
  return (reason, exitCode = 0) => {
    if (running) {
      log(`Shutdown already in progress; ignoring ${reason}`);
      return running;
    }
    log(`Shutting down: ${reason}`);
    const forced = setTimeout(() => {
      log(`Shutdown did not finish within ${forceExitAfterMs} ms; forcing exit`);
      exit(1);
    }, forceExitAfterMs);
    forced.unref();
    running = (async () => {
      let code = exitCode;
      for (const step of steps) {
        try {
          await step.run();
        } catch (error) {
          code = code || 1;
          log(`Shutdown step "${step.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      clearTimeout(forced);
      exit(code);
    })();
    return running;
  };
}
