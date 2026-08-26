# Simulation And Software Validation — 2026-08-23

## Result

**Passed — Validation Level 1 only.** The final source passed TypeScript, 247 automated tests, the production build, four Sites packaging tests, and rendered-browser checks. Ten blinded synthetic FFT fixtures passed through the real visit aggregator and `DetectionEngine`.

This result does not qualify the antenna, RSPdx, SDRconnect RF path, field sensitivity, false-alarm rate, navigation integrity, or spoofing detection.

## Automated Verification

Environment:

- Ubuntu kernel: `Linux 7.0.0-30-generic x86_64`
- System Node.js: `v24.19.0`
- Source/config manifest SHA-256: `20597655b51e61f5df10cd7b66060e9334020a6f29e189556346fd0295975a41`

Commands and results:

| Command | Result |
|---|---:|
| `npm run check` | 32 test files, 247 tests passed; TypeScript passed |
| `npm run build` | Client, Sites worker and Node server built |
| `npm run test:sites` | 4 of 4 passed |

Final build hashes:

| Artifact | SHA-256 |
|---|---|
| `dist/client/index.html` | `f0736cb11ddd82f020d07a2d18cfe509565b138bb49adf27f3728a5079c93475` |
| `dist/server/index.js` | `2dd0615a445143933d88d4271f54f5d63ee951421fcd08c5a7617bb09c564389` |
| `dist/.openai/hosting.json` | `d532abb65cf9ae20634b464d954cb4a08a0de9f3cd3cdf7f9c3ec8948826d947` |
| `dist/server-node/index.js` | `35b7a7d5806b6c12f87d11a4c4c62cc529f46be340a02560f812c49909fc63ab` |

## Synthetic Qualification

Every report was marked `synthetic: true`, used blinded metadata until detector processing completed, verified its SHA-256 truth commitment, and stayed below the 64 KiB response limit. The generated evidence archive SHA-256 is `6cc4272f803fbf5bab2e037147ee68b1f13c7cfc06b9c09f9b4a7572fe02ec97`.

| Fixture | Expected | Observed | Result |
|---|---|---|---:|
| Normal signal | No alert | No alert | Pass |
| Wideband rise | Alert | Alert | Pass |
| Pulsed wideband | Alert | Alert | Pass |
| Single tone | Alert | Alert | Pass |
| Multiple tones | Alert | Alert | Pass |
| Moving narrowband | Alert | Alert | Pass |
| Receiver overload | Alert | Alert | Pass |
| Configuration change | Unknown | Unknown | Pass |
| Data gap | Unknown | Unknown | Pass |
| Matched-power control | No alert | No alert | Pass |

The matched-power control is a required correct non-detection. It does not validate spoofing detection. Results apply only to the exact versioned and hashed bin count, levels, widths, timing, rule set and synthetic baseline in each report.

## Rendered-Browser Verification

The built isolated simulation at `http://127.0.0.1:18080/` was checked in the Codex in-app Chromium browser:

- Verdict screenshot SHA-256: `43728e92c6a51aaa0e2f5668120c2f620d5aea0c30d964663540b507d373a456`

- Simulation source shown; physical USB and SDRconnect shown as Not tested.
- Dashboard and feed state remained Checking without a protected exact-fingerprint baseline.
- Wideband led with **Suspected RF interference** in red, the exact combined GNSS band and 1575.420 MHz; **Test passed** remained secondary.
- Receiver overload led with **Receiver overloaded** in amber and was not classified as interference.
- Data gap led with **Test inconclusive**; matched-power remained a neutral **No RF change detected** control; the normal fixture was green **No RF anomaly**.
- The 443-pixel result card had equal client and scroll widths, with the report button fully visible.
- The result live region exposed `status`, `polite`, `atomic`, labelled-by and described-by semantics.
- Monitoring missions and System health rendered with concise operator copy.
- Settings tabs supported arrow-key and End-key navigation.
- 1920×1080 and 1366×768 had no horizontal or page-level vertical overflow.
- 375×812 had no horizontal overflow.
- No console warnings, console errors, React error screen, or framework error overlay.

## Remaining Gates

> **Contract supersession:** This simulation result remains historical evidence.
> The former 72-hour readiness requirement is superseded. Required development
> and production qualification end at V7, and no required run exceeds 24 hours.

Production qualification remains incomplete until the installed receiver and final RF chain pass the bounded 24-hour V7 timing/resource measurement, clean baseline approval, calibrated/conducted or shielded tests, evidence-continuity checks, and managed-switch counter review. Synthetic results must not be used to approve a protected production baseline. Optional V8/V9 site records do not block readiness.
