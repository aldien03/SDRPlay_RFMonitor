import { describe, expect, it } from "vitest";
import { HOST_MEMORY_LIMITS, HostMemoryController, parseHostMemorySample } from "../src/server/hostMemory";

function sources(input: { availableKb?: number; swapFreeKb?: number; psiSome?: number; psiFull?: number; oomKills?: number } = {}) {
  const state = {
    availableKb: input.availableKb ?? 8_000,
    swapFreeKb: input.swapFreeKb ?? 2_000,
    psiSome: input.psiSome ?? 0,
    psiFull: input.psiFull ?? 0,
    oomKills: input.oomKills ?? 0,
  };
  return {
    state,
    source: {
      readText(filePath: string) {
        if (filePath === "/proc/meminfo") return `MemTotal:       10000 kB\nMemAvailable:   ${state.availableKb} kB\nSwapTotal:       2000 kB\nSwapFree:        ${state.swapFreeKb} kB\n`;
        if (filePath === "/proc/pressure/memory") return `some avg10=${state.psiSome.toFixed(2)} avg60=0.00 avg300=0.00 total=0\nfull avg10=${state.psiFull.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`;
        if (filePath === "/proc/vmstat") return `oom_kill ${state.oomKills}\n`;
        throw new Error("unexpected path");
      },
    },
  };
}

describe("host memory pressure controller", () => {
  it("parses Linux memory, PSI, swap, and OOM counters", () => {
    expect(parseHostMemorySample(
      "MemTotal: 10000 kB\nMemAvailable: 1500 kB\nSwapTotal: 2000 kB\nSwapFree: 400 kB\n",
      "some avg10=11.50 avg60=0.00 avg300=0.00 total=1\nfull avg10=1.20 avg60=0.00 avg300=0.00 total=1\n",
      "oom_kill 3\n",
    )).toEqual({
      totalBytes: 10_240_000,
      availableBytes: 1_536_000,
      swapTotalBytes: 2_048_000,
      swapFreeBytes: 409_600,
      psiSomeAvg10: 11.5,
      psiFullAvg10: 1.2,
      oomKillCount: 3,
    });
  });

  it("requires sustained PSI and 120 seconds of normal state before recovery", () => {
    const fixture = sources();
    const controller = new HostMemoryController(fixture.source, 0);
    expect(controller.sample(0).state).toBe("normal");
    fixture.state.psiSome = HOST_MEMORY_LIMITS.pressurePsiSomeAvg10;
    expect(controller.sample(1_000).state).toBe("normal");
    expect(controller.sample(21_000)).toMatchObject({ state: "pressure", reasonCodes: ["host-memory-psi-pressure"] });
    fixture.state.psiSome = 0;
    expect(controller.sample(22_000)).toMatchObject({ state: "pressure", normalSince: expect.any(String) });
    expect(controller.sample(141_999).state).toBe("pressure");
    expect(controller.sample(142_000).state).toBe("normal");
  });

  it("enters critical immediately after an OOM counter increase", () => {
    const fixture = sources();
    const controller = new HostMemoryController(fixture.source, 0);
    controller.sample(0);
    fixture.state.oomKills = 1;
    expect(controller.sample(1_000)).toMatchObject({ state: "critical", recentOomKill: true, reasonCodes: ["host-oom-kill"] });
  });

  it("reports unknown instead of inventing a healthy host state", () => {
    const controller = new HostMemoryController({ readText: () => { throw new Error("unavailable"); } }, 0);
    expect(controller.sample(0)).toMatchObject({ state: "unknown", reasonCodes: ["host-memory-collector-unavailable"] });
  });
});
