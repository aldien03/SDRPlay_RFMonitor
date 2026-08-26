# Wave A packaged-browser acceptance

Date: 2026-08-23 UTC  
Candidate: packaged `dist/server-node/index.js` on `127.0.0.1:18080`  
Mode: Simulation / test domain  
Result: PASS for the Wave A browser checks below. This is software evidence only and is not physical or production qualification.

> **Contract supersession:** This browser result remains historical evidence.
> The former V6-V9 blocker wording is superseded. Required qualification ends
> at V7 and no required run exceeds 24 hours.

## Checks

| Check | Result | Evidence |
|---|---|---|
| Live control remains fresh while RF state is stable | PASS | Protocol-v2 state deltas refresh the canonical server clock every two seconds; the UI did not enter `Data late` after repeated 7-second observation periods. |
| Recording truth | PASS | Bootstrap and periodic deltas reported `recording`; the operator footer remained `Recording`. |
| Initial learning does not imply an anomaly | PASS | Zero-vote detector work renders `Signal learning`; no target appears affected until a real candidate exists. |
| Main graphs receive bounded live frames | PASS | Both visible feeds rendered spectrum and waterfall data; no `Spectrum waiting for data` state remained after startup. |
| 1920×1080 fixed workspace | PASS | Document and viewport were both exactly 1920×1080, with no page overflow. See `2026-08-23-wave-a-browser-1920.png`. |
| 1366×768 fixed workspace | PASS | Document and viewport were both exactly 1366×768, with no horizontal or vertical page overflow. See `2026-08-23-wave-a-browser-1366.png`. |
| Task-focused Settings | PASS | Navigation order was Monitoring, System health, Recording, Site, Advanced. System health was usable while locked. The removed feasibility prose was absent. |
| Normal-user System health | PASS | The default view showed Simulation, Receiver, RF data, Data loss, Recording, Disk space, CPU, Memory, and Data rate. Event-loop, heap, queue, and NIC internals remained under collapsed Engineer details. |
| Simulation hardware truth | PASS | USB and SDRconnect-dependent states rendered `Not tested`; virtual frames did not make a physical receiver claim. |
| Live synthetic wideband exercise | PASS | The exercise played through the main L1 spectrum, waterfall, candidate, alert/recovery, action, Low-evidence, and completion UI. The affected target was L1/E1/B1C/SBAS. See `2026-08-23-wave-a-wideband-exercise.png`. |
| Test-domain isolation | PASS for exercised packaged path | The isolated storage root contained only `test/baselines`, `test/evidence`, and `test/qualification`; no `field` tree was created by startup or two dashboard exercises. Automated domain tests separately cover byte-stable field data. |
| Health payload bound | PASS | `/api/health` was 20,359 bytes, below the 64 KiB contract. It reported schema 2, test domain, Simulation current health, `productionQualification.ready=false`, exact release IDs, and a simulated receiver with physical transport/stream offline. |

## Captures

- [1920×1080 dashboard](./2026-08-23-wave-a-browser-1920.png)
- [1366×768 dashboard](./2026-08-23-wave-a-browser-1366.png)
- [Wideband exercise on the main graphs](./2026-08-23-wave-a-wideband-exercise.png)

## Remaining gates

This acceptance does not test the RSPdx, SDRconnect, antenna path, managed switch, installed Ubuntu service, or the required V6-V7 installed-chain and bounded 24-hour gates. Production remains blocked until V0-V7 pass for one frozen candidate; optional V8/V9 records do not affect that decision.
