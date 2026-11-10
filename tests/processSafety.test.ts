import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createShutdownCoordinator, guardWebSocket } from "../src/server/processSafety";

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

async function startServer(guard: boolean) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: "/live", maxPayload: 16 });
  const faults: Error[] = [];
  wss.on("connection", (socket) => {
    if (guard) guardWebSocket(socket, (error) => faults.push(error));
    socket.on("message", () => undefined);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  closers.push(() => { for (const client of wss.clients) client.terminate(); wss.close(); http.close(); });
  return { port: (http.address() as AddressInfo).port, faults };
}

describe("live socket guard", () => {
  it("survives a frame over maxPayload without an uncaught exception", async () => {
    const uncaught: Error[] = [];
    const listener = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", listener);
    closers.push(() => process.off("uncaughtException", listener));
    const { port, faults } = await startServer(true);
    const client = new WebSocket(`ws://127.0.0.1:${port}/live`);
    await once(client, "open");
    client.send("x".repeat(4096));
    await once(client, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]);
    expect(faults.length).toBe(1);
    expect(faults[0].message).toMatch(/payload/i);
  });

  it("never lets a throwing fault reporter escape", () => {
    const handlers: Array<(error: Error) => void> = [];
    const terminate = vi.fn();
    guardWebSocket({ on: (_event, handler) => { handlers.push(handler); }, terminate }, () => { throw new Error("reporter"); });
    expect(() => handlers[0](new Error("boom"))).not.toThrow();
    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe("shutdown coordinator", () => {
  function setup(steps: Array<{ name: string; run: () => unknown }>, forceExitAfterMs?: number) {
    const exit = vi.fn();
    const log = vi.fn();
    return { exit, log, shutdown: createShutdownCoordinator({ steps, exit, log, forceExitAfterMs }) };
  }

  it("runs every step in order and exits 0", async () => {
    const order: string[] = [];
    const { shutdown, exit } = setup([
      { name: "a", run: () => { order.push("a"); } },
      { name: "b", run: async () => { order.push("b"); } },
    ]);
    await shutdown("SIGTERM");
    expect(order).toEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("still stops the monitor when an earlier flush rejects, and exits non-zero", async () => {
    const stopMonitor = vi.fn();
    const { shutdown, exit, log } = setup([
      { name: "flush", run: async () => { throw new Error("disk full"); } },
      { name: "stop monitor", run: stopMonitor },
    ]);
    await shutdown("SIGTERM");
    expect(stopMonitor).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"flush" failed: disk full'));
  });

  it("keeps a requested failure exit code", async () => {
    const { shutdown, exit } = setup([{ name: "a", run: () => undefined }]);
    await shutdown("uncaughtException", 1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("joins a second signal to the run already in progress", async () => {
    const run = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const { shutdown, exit } = setup([{ name: "slow", run }]);
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("forces a non-zero exit when cleanup hangs", async () => {
    vi.useFakeTimers();
    try {
      const { shutdown, exit } = setup([{ name: "hang", run: () => new Promise(() => undefined) }], 1_000);
      void shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_001);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
