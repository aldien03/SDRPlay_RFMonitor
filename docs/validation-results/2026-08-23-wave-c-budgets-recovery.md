# Wave C BUD-400 / REC-500 software validation

Recorded: `2026-08-23T11:23:44Z`

Result: **software gates passed; production qualification not established**.

> **Contract supersession:** This software result remains historical evidence.
> The former 72-hour readiness wording is superseded. Required development and
> production qualification end at V7, and no required run exceeds 24 hours.

## Implemented contract

- One `ResourceBudgetController` owns the documented pressure thresholds and degradation order. Memory, disk-reserve, and writer-latency escalation is immediate. Queue and event-loop pressure must persist for 10 seconds. Pressure clears only after one continuous 30-second fully healthy dwell.
- Pressure rejects new dashboards and exports and caps existing dashboards at 2 Hz. Critical pressure keeps existing dashboards status-only. Canonical bins-free incident, recording, health, and qualification state remains deliverable. Acquisition, scheduling, detection, and evidence are never disabled by the controller.
- Receiver and application recovery states distinguish `request-accepted`, `helper-pending`, `verified-recovery`, `cooldown`, `lockout`, and `unavailable`.
- Recovery requests and protected software-restart requests use no-follow path checks, bounded inputs, file fsync, atomic same-directory rename, and parent-directory fsync.
- Software restart requires the protected Settings session, matching configuration revision, exact confirmation text, and a serialized, fsynced, hash-chained audit entry before the request can be published. The root helper verifies that audit entry before invoking systemd.
- The external application heartbeat helper starts recovery after two consecutive 15-second failed checks. Attempts remain in the one-hour window across briefly healthy flaps. The application service has a five-start/hour systemd limit.
- Application restart is queued with `systemctl --no-block`. The request remains present while the helper polls for a different service boot ID for at most 120 seconds. A missing new boot becomes an explicit timeout; the 150-second oneshot limit does not silently kill the confirmation window.

## Verification evidence

Commands run from the repository root:

```text
bash -n deploy/recover-application.sh deploy/recover-sdrconnect.sh deploy/install-ubuntu.sh deploy/doctor.sh deploy/uninstall-ubuntu.sh
npx tsc --noEmit
npm test -- --run tests/resourceBudget.test.ts tests/liveControlQueue.test.ts tests/recoveryRequest.test.ts tests/settingsStore.test.ts tests/applicationRecoverySupervisor.test.ts tests/recoverySupervisor.test.ts tests/monitorService.test.ts tests/healthApi.test.ts
```

Results:

```text
TypeScript: PASS
Test files: 8 passed
Tests: 71 passed, 0 failed, 0 skipped
```

The fault matrix includes exact threshold entry, sustained-pressure qualification, interrupted healthy dwell, critical status-only control delivery, 100,000 control coalesces, eight-dashboard admission/ninth rejection, missing/malformed/oversized/symlinked supervisor files, audit fsync uncertainty, concurrent audit actions, rejected systemd jobs, cooldown, lockout, a healthy-flap restart loop, delayed new-boot confirmation, and confirmation timeout with request retention.

Key artifact SHA-256 values:

```text
edbf4577fc88a1097cdc2ea788404d125b321e60e093fcf9a7ebd4dd3b3bbd6b  src/server/resourceBudget.ts
f2607b25f0927acc7ee25f46c5aa6f808cd1455253f04cdc3704e12676ec9cf0  src/server/recoveryRequest.ts
bdb529b925d5556b31d513b0bee26173ffe3bb9f32b25cff39999e20341d52cb  deploy/recover-application.sh
16536159e68746d1105e3136dac3835c2b762281852a2b9ec59d5c935cd47263  deploy/recover-sdrconnect.sh
425eb21c6b2c35ef6a37c910e03f1406d61fce489be66764bd55a8a8125229fe  deploy/rf-monitor.service.template
f76c3141ba65113908a3e27ec45e9011a1a73873afe1b2f1f68d1e24e2fe6a1c  deploy/rf-monitor-application-recovery.timer
0687a15806f4a773bc4ea9027c44769bc30ed2c3e15b7c9cf345a39d07444feb  deploy/rf-monitor-application-recovery.service.template
```

## Scientific and operational limits

- These are deterministic software and mocked-supervisor tests. They do not prove behavior under real Ubuntu scheduler starvation, kernel memory pressure, a wedged USB stack, SDRconnect failure, disk exhaustion, or power loss.
- The pressure controller consumes bounded writer/disk health owned by the evidence subsystem; it does not replace evidence-queue durability or export reconstruction tests.
- No final installed V7 resource/load interval was run here. RSS slope, real NIC/switch counters, actual systemd timing, evidence priority under sustained load, and hardware recovery still require a bounded production-like qualification run capped at 24 hours.
- Automatic recovery timing is an objective based on the 15-second persistent timer, not a hard real-time guarantee. Every helper outcome remains explicit so a delayed or failed recovery cannot be presented as successful.
