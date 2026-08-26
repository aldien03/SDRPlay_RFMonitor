# P0 qualification and RF-claim trust boundary

Date: 2026-08-23  
Result: **software fail-closed checks passed; required external V6-V7 qualification and production approval do not exist**

> **Contract supersession:** The software-test result in this record remains
> historical evidence. Its former 72-hour, V8, and V9 readiness requirements
> are superseded. Required qualification ends at V7 and no required run exceeds
> 24 hours; optional V8/V9 records are never readiness inputs.

## Corrected behavior

- Only the exact bounded 24-hour V7 local window can satisfy the required local timing/resource window. A longer optional record cannot set `productionQualification.ready`, `productionReady`, the compatibility `ok` alias, doctor READY, or the operator qualification label.
- Readiness additionally requires one separately managed approval record that exactly matches release/browser/server and dependency digests, configuration/catalog, deployment/site binding, canonical receiver model and serial hash, and commissioning epoch/soak start.
- The record must state the required V0-V7 installed-chain, timing/baseline, hardware-recovery, fault-injection, bounded clean-window, and evidence-continuity gates. Every required gate must pass and the approval time must follow the local V7 window. Optional V8/V9 fields may be retained as metadata but never gate readiness.
- RF Monitor has no writer or endpoint for the approval. It loads the root/site-owner managed file at startup and fails closed on absence, tampering, incomplete gates, or any binding mismatch.
- Current monitoring health remains independent and may truthfully be Normal while qualification is Not qualified.

## Hardware identity correction

One shared parser accepts only original `RSPdx` and `RSPdx R2`; the exact SDRconnect alias `RSPdx-R2` canonicalizes to `RSPdx R2`. Prefixes, suffixes, clone/pro labels, parenthesized test labels, substrings, and deceptive variants are rejected. Runtime tuning, monitoring readiness, RF fingerprint readiness, the verification script, and production qualification also require a non-placeholder serial identity.

## Operator-copy correction

The runtime event-boundary guard now rejects standalone and inflected `jam`, spoofing, deliberate/deliberately, intent/intention/intentional/unintentional, integrity claims, and dBm copy. NFKC normalization, format-character removal, combining-mark removal, and bounded separator handling close simple case, punctuation, and zero-width bypasses. The exact approved sentence `RF data can show interference, not intent.` remains the only intent-language exception.

## Executed software evidence

- TypeScript: `npx tsc --noEmit` — passed.
- Combined qualification/hardware/API/doctor/operator regression: 14 files, 154 tests — passed.
- Production build: client, server, Sites preparation, and release metadata generation — passed. The dormant query-gated accessibility chunk still produces the existing Vite size warning; no new qualification code is shipped in that chunk.
- V0 source-matrix validation: 115 requirements, 10 risks, 55 references — valid. The immutable outer release binding must be regenerated after the shared candidate freezes; required V5-V7 remain externally not run.

The combined regression includes negative cases for healthy local-soak-only state, tampered/incomplete approval, release/configuration mismatch, unsupported or deceptive receiver names, missing serial identity, stale qualification ledger behavior, doctor defense-in-depth, API compatibility aliases, and operator presentation.

## Remaining external evidence

This record is software evidence only. It does not prove the installed RSPdx/RSPdx R2, antenna chain, hardware recovery, fault injection, bounded 24-hour V7 window, evidence continuity, or independent operators. `HLT-040` is therefore `in-progress`, not Passed; required V6 and V7 remain not run. Optional V8/V9 status does not affect readiness. A self-consistent approval-record digest is not a signature and does not replace root ownership, independent review, or evidence custody.
