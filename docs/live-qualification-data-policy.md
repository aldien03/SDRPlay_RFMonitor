# Live Qualification Data Policy

Production qualification uses the installed SDRplay RSPdx or RSPdx R2 and its real normalized-uint8 SDRconnect spectrum stream.

| Gate | Allowed input | Not accepted |
|---|---|---|
| V0–V4 | Software fixtures and isolated synthetic scenarios | Any claim of physical RF performance or production readiness |
| V5 | Independently captured, sealed RSPdx/RSPdx R2 field FFT sessions with receiver, RF-chain, time, target, and truth provenance | Generated spectra, simulation, test-domain sessions, IQ, relabelled replay, or missing receiver identity |
| V6 | Live RSPdx/RSPdx R2 frames from the final installed chain during a witnessed, shielded conducted test | Simulation, file replay, IQ, radiated GNSS transmission, generic SDR, or an uncalibrated source |
| V7 | Live field-domain frames from the final installed receiver and antenna chain for the bounded run | Simulation, replay, test domain, missing USB/SDRconnect/frame flow, wrong sample rate, or changed identity/configuration |

V6 uses the isolated **Test** storage domain because its RF stimulus is controlled test activity. That label separates its evidence from operational field records; it does not mean the receiver data is simulated.

Every V5–V7 artifact binds the release, receiver model and serial hash, SDRconnect version, confirmed 10 MS/s readback, RF-chain fingerprint, configuration, catalog, detector rules, target, FFT grid, analysis mask, timestamps, data domain, and witness/custody record. A mismatch stops the gate.

The live 24-hour V7 clock starts with the first accepted sample and may never extend past 24 elapsed hours. Fault, recovery, backup/restore, and switch checks are bounded prerequisites; their evidence is verified before V7 starts.
