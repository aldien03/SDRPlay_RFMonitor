# V3 Packaged Browser Qualification

## Status

**Not run for the frozen release candidate.** Source-preview results are development evidence only. V3 may start only after V0–V2 pass for the same `dist/release.json` identity.

## Built-in browser recorder

Open the packaged application with `?qa=v3`. This enables two dormant test aids before React starts:

- the existing axe scanner; and
- a bounded V3 recorder exposed as `window.__RF_MONITOR_V3_QA__` and as the `data-rf-monitor-v3` attribute on `<html>`.

The recorder stores at most 32 runtime errors, 24 same-origin request paths, and 24 measurement windows. It records request paths and counts only. It does not retain response bodies, settings, credentials, addresses, logs, evidence, or command output.

System health polling is measured automatically. Opening System health creates a visible polling window. Closing it creates an eight-second stopped window. A visible window fails for duplicate request growth, more than two overlapping requests, or a failed request. A stopped window fails if any new health request starts.

The current marker also checks:

- meaningful packaged content and framework overlays;
- horizontal document overflow;
- Field versus Simulation/Test labelling;
- Data late or connection-error states that still show Normal;
- dialog name and focus containment;
- protected-action scope, guarded-button presence, and the exact-confirmation guard while its dialog is open; and
- all five Help tasks, packaged version/build, and external Help resources.

The marker is evidence input, not a self-issued pass. Console logs, screenshots, keyboard behavior, state fixtures, release binding, and operator drills remain independent evidence.

## Qualification runner

Use the packaged runner only after building and freezing the candidate:

```bash
npm run validate:v3 -- --capture /tmp/rf-monitor-v3-capture.json
```

The runner starts the packaged server on loopback in a disposable **Simulation/Test** data root, prints the exact run URL, and waits up to 30 minutes for an external browser capture. It does not start or control a browser. The capture file must not exist before the runner starts; write screenshots first, then publish the JSON atomically at the displayed path.

Run `npm run validate:v3 -- --help` for bounded port, timeout, output, exact catalog/profile, and verification options. By default, V3 uses the same example catalog and operational profile expected by later qualification; both input files and the resulting runtime configuration hash are committed. Verify a completed bundle without starting the application:

```bash
npm run validate:v3 -- --verify-bundle artifacts/validation/v3/BUNDLE
```

The immutable bundle contains `manifest.json`, `report.json`, `SHA256SUMS`, and the exact committed PNG set. The verifier rejects missing, extra, writable, stale, mismatched, or over-limit entries. The report is software-only, keeps V5–V7 at `not-run`, and cannot qualify live RF hardware or production readiness.

## Required runs

Run all cases against the same packaged build. Do not substitute Vite or another source server.

| Case | Viewport | Required surfaces |
|---|---:|---|
| Desktop | 1920×1080 | Dashboard, every Settings task, Engineer, incidents, Evidence history, Help |
| Compact | 1366×768 | Same critical surfaces and dialogs |
| 200% | Actual 200% browser zoom; record effective viewport | Dashboard, status strip, Settings navigation, Help, every protected dialog |

For each surface:

1. Confirm URL, title, meaningful content, and no framework overlay.
2. Press **Ctrl+Alt+A** after the surface settles, then capture the V3 marker and the completed axe result.
3. Require zero harness errors, zero axe violations, and zero incomplete axe results.
4. Require clean browser error/warning logs and capture a screenshot.
5. Confirm no horizontal overflow or clipped critical action.

The capture JSON schema is strict. It binds every entry to the runner's exact origin, run ID, release, client/server build, configuration hash, viewport, zoom, route, V3 marker, completed axe result, clean console/network state, keyboard result, and PNG hash. Required case IDs and screenshot names are printed by the runner contract and exported by `scripts/run-v3-packaged-browser-qualification.mjs`; missing, reordered, duplicated, or additional cases are rejected.

## State and workflow matrix

Each row needs a packaged fault/state fixture, a screenshot, the V3 marker, and the expected operator action. A unit test alone does not close the browser row.

| Area | Required cases |
|---|---|
| Canonical live state | Newer Alert cannot be replaced by older Normal; stale/malformed control fails to Data late with Reload and keeps the open incident |
| Trust domain | Field and Simulation/Test are visible on Dashboard, Settings, Help, incident/evidence views, and exports; simulation never appears qualified |
| System health | Normal, Attention, Critical, and Simulation; each issue appears once with one safe action |
| Evidence lifecycle | Active, Finalizing, Complete, gap-labelled Incomplete, and Corrupt; unsafe downloads remain disabled |
| Dialog keyboard | Initial focus, Tab and Shift+Tab wrap, Escape/backdrop policy, nested ordering, and focus return |
| Settings protection | Dirty-close warning; conflict keeps the draft; baseline restart confirmation; Clear test data, Delete recordings, and Restart software are never enabled before the exact phrase matches; another safety condition may keep a matched action disabled |
| Help | Five task flows work from the packaged `/help` route without external content or Linux commands |
| Polling | System health open for at least 12 seconds, then closed for at least 8 seconds; both automatic recorder windows have no issues |

Do not execute a destructive protected action merely to test button enablement. Exercise the actual operation only in its isolated, disposable qualification fixture.

## Pass boundary

V3 passes only when every required case is bound to the frozen package identity and has:

- no stale Normal or Field/Test contradiction;
- no browser console error;
- no harness or polling-window error;
- no accessibility violation or incomplete result;
- no critical overflow or mouse-only control; and
- a successful representative non-developer response drill.

Any source/package change invalidates the affected V3 evidence. V3 does not qualify hardware, RF performance, or production readiness.
