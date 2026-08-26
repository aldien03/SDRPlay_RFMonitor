import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const executeFile = promisify(execFile);

describe("SDRconnect verification command", () => {
  const closers: Array<() => void> = [];
  afterEach(() => closers.splice(0).forEach((close) => close()));

  it("proves JSON properties and a binary spectrum frame", async () => {
    const httpServer = createServer();
    const server = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    closers.push(() => { server.close(); httpServer.close(); });

    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { event_type: string; property: string; value: string };
        if (message.event_type === "get_property" && message.property === "api_version") {
          socket.send(JSON.stringify({ event_type: "property_changed", property: "api_version", value: "1.0.3" }));
        }
        if (message.event_type === "get_property" && message.property === "active_device") {
          socket.send(JSON.stringify({ event_type: "property_changed", property: "active_device", value: "RSPdx-R2" }));
        }
        if (message.event_type === "get_property" && message.property === "device_serial") {
          socket.send(JSON.stringify({ event_type: "property_changed", property: "device_serial", value: "RSPDX-R2-0001" }));
        }
        if (message.event_type === "spectrum_enable" && message.value === "true") {
          socket.send(Buffer.from([3, 0, 10, 20, 30, 40]));
        }
      });
    });

    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing mock SDRconnect address");
    const result = await executeFile(process.execPath, [
      path.resolve("scripts/verify-sdrconnect.mjs"),
      `--url=ws://127.0.0.1:${address.port}/`,
      "--spectrum",
    ], {
      env: { ...process.env, SDRCONNECT_VERIFY_TIMEOUT_MS: "500" },
    });

    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      connected: true,
      apiVersion: "1.0.3",
      activeDevice: "RSPdx-R2",
      deviceSerialPresent: true,
      readiness: { device: true },
      spectrumRequested: true,
      spectrumFrames: 1,
      lastSpectrumType: 3,
      lastSpectrumBytes: 4,
    });
  });
});
