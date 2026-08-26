# Wave D UX-201 / UX-202 / UX-301 Validation — 2026-08-23

## Result

Source, API-contract, package-build, local HTTP, and source-preview browser checks pass. The browser checks do **not** qualify V3 because the exact frozen package, protected confirmation flows, polling-growth capture, and representative non-developer drills remain outstanding. This record does not qualify production.

## Implemented contract

- Normal System health shows one overall state and five checks: Receiver, RF data, Recording, Scan coverage, and Signal learning.
- Related reports are deduplicated only when they share the same operator problem and first action. Receiver RF overload remains separate from host/Node CPU or memory pressure.
- Every Needs attention item carries available value/limit data, latest occurrence, count, one safe action, a success condition, and a stop condition.
- CPU, memory, queues, NIC counters, timing distributions, trends, and support commands remain under collapsed Engineer details.
- Receiver retry and application restart show request progress, external verification, cooldown/lockout, and helper-unavailable truth. A verified application boot still tells the operator to check RF data and Recording.
- Protected actions remain separate: Clear test data, per-signal Restart learning, domain-scoped Delete recordings, and Restart software. Each states what changes and what is retained and requires an exact confirmation.
- Evidence History displays Active, Finalizing, Complete, Incomplete, and Corrupt. Complete and explicitly gap-labelled Incomplete sessions can be exported; Active, Finalizing, and Corrupt full-session exports remain disabled. A legacy closed alias fails closed as Incomplete.
- Every modal surface now uses one shared boundary for initial focus, Tab/Shift+Tab containment, inert background content, Escape/backdrop policy, nested-dialog order, and return focus.
- The packaged SPA owns a version-matched `/help` route organized by five operator tasks. It uses no network content and exposes no service-restart command.

## Automated evidence

Command:

```text
npx tsc --noEmit
npx vitest run tests/diagnosticsModel.test.ts tests/evidenceArchivePresentation.test.ts tests/settingsMaintenancePresentation.test.ts tests/useMonitor.test.ts tests/recordingsDeleteApi.test.ts --reporter=verbose
```

Result: **PASS** — 5 files, 39 tests, zero skipped.

Covered cases include:

- task-focused checks and collapsed engineering metrics;
- issue priority/deduplication, value/limit/count/time context, and recovery boundaries;
- browser loss without a false Recording fault;
- simultaneous receiver overload and host CPU critical without incorrect antenna/gain advice;
- data-late, learning-paused, recovery-progress, verified-recovery, and lockout presentation;
- simulation physical stages remain Not tested;
- all five evidence lifecycle labels, fail-closed legacy mapping, and gap-labelled Incomplete export;
- distinct maintenance scope/retention copy and confirmation phrases;
- protected recording deletion rejects missing authorization, stale revision, and cross-domain requests while retaining the active session and other-domain data.

Package command:

```text
npm run build
npm run test:sites
```

Result: **PASS** — client/server/Sites artifacts built; 4 Sites worker tests passed.

Local source preview:

```text
Frontend: http://127.0.0.1:4174/
Backend:  http://127.0.0.1:18082/
```

HTTP smoke: the app shell loaded and `/api/health` returned schema v2, Test-domain Simulation truth, recovery state, Not-tested physical receiver stages, and a normal evidence archive.

## Source-preview browser evidence

The in-app browser exercised the existing Quiet Mission Board and task-based Settings at 1920×1080, 1366×768, and a 683×384 viewport representing 200% zoom at 1366×768. Dashboard, Monitoring, System health, Recording, Site, Advanced, Engineer, Evidence history, and the empty incident state were inspected. No tested viewport had horizontal document overflow. Settings tab selection worked by keyboard with the expected arrow-key focus movement. The browser console contained only the expected Vite/HMR development messages and no application error.

An exact `axe-core` 4.13.0 query-gated scan ran in the rendered source preview. The final dashboard, every Settings task, Engineer drawer, Evidence history, and incident drawer reports contained zero accessibility violations and zero serious/critical violations. Axe retained incomplete contrast checks for a small set of text rendered inside the modal backdrop. Direct WCAG relative-luminance calculations for the explicit CSS pairs range from 7.95:1 to 14.48:1, but this record does not convert an incomplete automated result into a pass for the frozen package.

After the shared dialog and Help changes, the source preview was scanned again: both the dashboard and `/help` returned zero axe violations and no incomplete results. The feed manager opened with focus on Close; Shift+Tab wrapped to Done, Tab wrapped back to Close, Escape closed the dialog, and focus returned to Manage. Help was visually inspected at 1920×1080, 1366×768, and 683×384 (the 200%-equivalent viewport) with no visible horizontal clipping. These remain source-preview checks, not V3 qualification.

The live synthetic wideband-rise exercise played through the main spectrum, waterfall, target state, Alert/Recovering footer, and Low-evidence state in the Test domain. During a separate parallel-build stress period, the temporary preview correctly entered status-only mode and reported Recording Error after real writer delay/evidence loss. That contaminated run is fault evidence only and is not a soak or V3 pass.

## Required follow-up

- Repeat the browser gate against the exact frozen package at 1920×1080, 1366×768, keyboard-only, and 200% zoom.
- Capture System health Normal/Attention/Critical/Simulation, every protected confirmation, recovery progress/outcome, and each evidence lifecycle.
- Confirm zero serious/critical axe violations, resolve or manually adjudicate every incomplete result, and capture no overflow, no console errors, and no diagnostics polling growth.
- Complete representative non-developer recovery drills; source tests do not prove that operators understand the flows.

## Packaged-gate preparation added after this run

The source now includes a dormant `?qa=v3` recorder that starts before React, runs the existing axe scanner, records bounded runtime/request facts, checks overflow and Field/Test truth, inspects active dialogs and protected confirmations, validates the five Help tasks, and automatically measures System health polling while mounted and for eight seconds after unmount. Its pure contract tests and packaged Help rendering tests pass. The exact frozen-candidate procedure is in `docs/v3-packaged-browser-qualification.md`.

This improves repeatability but does not change the result above: V3 remains **not run** until the recorder, browser logs, screenshots, state fixtures, protected flows, and operator drills are captured from the exact frozen package.

## Scope limits

This wave improves presentation and bounded recovery access. It does not improve RSPdx sensitivity, calibration, tuner coverage, RF classification, spoofing detection, or navigation-integrity evidence. A synthetic or healthy UI state is not physical hardware qualification.
