import { describe, expect, it } from "vitest";
import { SdrMetadataGate } from "../src/server/sdrMetadataGate";

describe("SDR metadata evidence gate", () => {
  it("records state changes, deduplicates equivalent responses, and refreshes stable state", () => {
    const gate = new SdrMetadataGate();
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "device_sample_rate", value: "2000000" }, 1_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "get_property_response", property: "device_sample_rate", value: "2000000" }, 1_001)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "device_sample_rate", value: "10000000" }, 1_002)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "get_property_response", property: "device_sample_rate", value: "10000000" }, 31_001)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "get_property_response", property: "device_sample_rate", value: "10000000" }, 31_002)).toBe(true);
  });

  it("time-decimates changing vendor display metrics", () => {
    const gate = new SdrMetadataGate();
    const signalPower = { event_type: "property_changed", property: "signal_power", value: "-90.1" } as const;
    expect(gate.shouldRecord(0, signalPower, 1_000)).toBe(true);
    expect(gate.shouldCheckpointContext(signalPower)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "signal_power", value: "-89.8" }, 2_000)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "signal_power", value: "-89.2" }, 3_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "signal_snr", value: "12.1" }, 3_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "signal_snr", value: "12.2" }, 4_999)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "signal_snr", value: "12.3" }, 5_000)).toBe(true);
  });

  it("suppresses per-tune state and unrecognized SDR chatter", () => {
    const gate = new SdrMetadataGate();

    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "device_center_frequency", value: "1575420000" }, 1_000)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "device_vfo_frequency", value: "1575420000" }, 1_001)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "rds_radiotext", value: "chatter" }, 1_002)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "future_vendor_property", value: 1 }, 1_003)).toBe(false);
    expect(gate.size).toBe(0);
  });

  it("retains baseline and receiver state, including immediate overload changes", () => {
    const gate = new SdrMetadataGate();

    const activeDevice = { event_type: "property_changed", property: "active_device", value: "RSPdx" } as const;
    expect(gate.shouldRecord(0, activeDevice, 1_000)).toBe(true);
    expect(gate.shouldCheckpointContext(activeDevice)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "active_antenna", value: "Antenna A" }, 1_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "lna_state", value: "4" }, 1_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "spectrum_ref_level", value: "-20" }, 1_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "spectrum_base", value: "-120" }, 1_000)).toBe(true);
    const overload = { event_type: "property_changed", property: "overload", value: false } as const;
    expect(gate.shouldRecord(0, overload, 1_000)).toBe(true);
    expect(gate.shouldCheckpointContext(overload)).toBe(false);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "overload", value: true }, 1_001)).toBe(true);
  });

  it("keeps independent receivers and allowlisted property keys within a fixed bound", () => {
    const gate = new SdrMetadataGate();
    for (let index = 0; index < 180; index += 1) {
      expect(gate.shouldRecord(index, { event_type: "property_changed", property: "device_sample_rate", value: index }, index)).toBe(true);
    }
    expect(gate.size).toBe(128);
  });

  it("handles undefined values without escaping the bound", () => {
    const gate = new SdrMetadataGate();
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "started", value: undefined }, 1_000)).toBe(true);
    expect(gate.shouldRecord(0, { event_type: "property_changed", property: "started", value: undefined }, 1_001)).toBe(false);
  });
});
