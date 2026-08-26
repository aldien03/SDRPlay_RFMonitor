# V5 held-out replay and V6 installed-chain handoff

This procedure prepares external evidence. It does not qualify the current release by itself.

Current state: **V5 not run**. No independently sealed real FFT corpus has been supplied. **V6 not run**. No witnessed, calibrated installed-chain campaign has been supplied.

## Roles

Use four different people or controlled identities:

1. **Acquisition custodian** — collects real RSPdx/RSPdx R2 normalized FFT sessions and closes the acquisition set.
2. **Truth custodian** — labels event windows independently and creates truth commitments.
3. **Detector custodian** — freezes the release, configuration, catalog, rules, acceptance criteria, and session list before truth is revealed.
4. **External witness** — holds an Ed25519 signing key outside the corpus and signs the exact precommitment digest before unblinding. The reviewer pins this public-key fingerprint through a separate approved channel.

Stop if one person must fill more than one role, the witness key comes from inside the corpus, or its fingerprint was not approved out of band. A signature authenticates the witness statement; it cannot by itself prove that an RF capture or truth label is physically correct.

## V5 — prepare the corpus

1. Build the exact release candidate. Do not modify it after acquisition is assigned to the candidate.

   ```bash
   cd /path/to/rf-monitor
   /usr/bin/npm ci
   /usr/bin/npm run build
   /usr/bin/npm run validate:release
   ```

   Expected: the release-package validator ends in `PASS` and `dist/release.json` contains the release version, build ID, and three SHA-256 digests.

   Stop if the package validator fails, `dist/release.json` is absent, or `/usr/bin/node` is not the active runtime.

2. Copy [the acquisition worksheet](../config/v5-held-out-acquisition-manifest.template.json). It is intentionally not accepted as a corpus manifest. Replace every `REQUIRED_*` value from source records; do not guess.

3. Collect only real receiver FFT display values:

   - original RSPdx and RSPdx R2 are separate receiver models;
   - store a SHA-256 of the serial, never the raw serial in the corpus;
   - record exact SDRconnect version, read-back sample rate, center, grid, central mask, display reference/base, antenna ID, and fixed gain profile;
   - production acquisition is 10 MS/s, normalized uint8 FFT only, with IQ absent;
   - keep the full captured FFT row in `fft.uint8`; the runner applies the exact central analysis mask;
   - record valid visits and explicit Unknown intervals in `observations.jsonl`; do not fill tuner gaps with clean rows.

   Stop if the source is synthetic, simulation, generated, IQ, mixed field/test data, an unsupported receiver, a raw serial, a changed RF fingerprint, or an unconfirmed sample rate.

4. Predeclare all 40 Tier-1 target/family criteria: four physical targets multiplied by ten frozen held-out families. Assign at least 30 unique, independent session IDs to each criterion. Predeclare:

   - the tested envelope and units;
   - expected Alert, No alert, or Unknown outcome;
   - one-sided 95% Wilson lower limit for Alert and No alert criteria;
   - maximum Unknown fraction;
   - maximum Unobserved fraction.

   A session boundary is the scoring unit. Adjacent FFT frames are not independent trials.

5. Close acquisitions. The truth custodian labels monotonic event windows, adds a random nonce, and computes `SHA-256(canonical JSON truth disclosure)` for every session. Seal `precommitment.json` before revealing labels to the detector custodian.

   Give only the exact `precommitment.json` SHA-256, corpus ID, commitment time, and planned not-before-unblinding time to the external witness. Retain the witness receipt, signing time, Ed25519 signature, and public-key fingerprint. Do not place the witness private key in the corpus or on the RF Monitor host.

6. Build `corpus-manifest.json` from the sealed precommitment. List every file with exact byte count and SHA-256. Compute `corpusTreeSha256` over the sorted file entries. Do not include `corpus-manifest.json` in its own file list.

7. Put the sealed corpus in a dedicated read-only directory. Do not point the runner at the live field evidence tree. Keep results outside both directories.

## V5 — validate and run

Use exact paths. This example does not contain site-specific values:

```bash
cd /path/to/frozen/rf-monitor
/usr/bin/npm run validate:v5:replay -- \
  --corpus /path/to/read-only/v5-corpus \
  --witness-public-key /path/from/independent-approval/v5-witness-public.pem \
  --witness-key-sha256 APPROVED_64_CHARACTER_LOWERCASE_SHA256 \
  --catalog /path/to/exact/band-catalog.json \
  --operational /path/to/exact/operational.json \
  --field-root /var/lib/rf-monitor/evidence/field \
  --output-root /path/to/qualification-results/v5
```

Expected before scoring:

- candidate, configuration, catalog, detector thresholds/rule hash, receiver, grid, mask, fingerprint, baseline, criteria, session list, and truth commitments all match;
- every declared file, the corpus tree, and precommitment hash verify;
- the separately pinned Ed25519 key verifies the exact precommitment witness statement signed before unblinding;
- the protected field tree is unchanged;
- no detector training occurs.

Expected final lines for a qualifying corpus include the session count, separate Unknown and Unobserved counts, artifact path, and `V5 decision: PASS`. The same sealed corpus and candidate must produce the same `deterministicResultHash` on a controlled rerun.

An independent reviewer must recompute the recorded scores, not rely only on the bundle's self-consistent hashes:

```bash
cd /path/to/frozen/rf-monitor
/usr/bin/npm run validate:v5:replay -- \
  --corpus /path/to/read-only/v5-corpus \
  --verify-bundle /path/to/qualification-results/v5/RUN_ID \
  --witness-public-key /path/from/independent-approval/v5-witness-public.pem \
  --witness-key-sha256 APPROVED_64_CHARACTER_LOWERCASE_SHA256 \
  --catalog /path/to/exact/band-catalog.json \
  --operational /path/to/exact/operational.json \
  --field-root /var/lib/rf-monitor/evidence/field
```

Expected result: `Independent replay: PASS`. Stop if the bundle hashes pass but the independent replay fails; that means the recorded scores are not the output of the frozen detector over the supplied corpus.

Stop immediately on `V5 NOT RUN`. It means a prerequisite or trust binding is missing; no pass-shaped artifact is written. Do not repair a mismatch by editing thresholds, truth, criteria, or the corpus. A rule or preprocessing change creates a new detector version and requires a new independent holdout set.

If the command returns `V5 decision: FAIL`, preserve the artifact. Do not tune on the holdout. Investigate with development data, freeze a new candidate, and acquire a new held-out set.

## Reading V5 results

- **Detected** — an independently labelled Alert event was observed by the tuner and the frozen detector alerted.
- **Missed** — the event was observed with valid data but the detector did not alert.
- **Alert-free** — a labelled nuisance/control window had valid observations and no alert.
- **Unknown** — invalid, stale, incomplete, mistuned, or configuration-changed data overlaps the truth window. It is never clean.
- **Unobserved** — no valid or explicitly Unknown observation overlaps the event because the one tuner was elsewhere. It is not counted as a detector miss or success.

The report requires at least the predeclared minimum number of **evaluable** independent sessions for every Alert and No alert criterion; Unknown or Unobserved sessions cannot satisfy that minimum. It gives per-target/family counts and one-sided 95% Wilson limits for detection and alert-free criteria. It does not convert normalized values to dBm and does not establish spoofing, intent, deliberate jamming, navigation integrity, or installed-chain sensitivity.

## V5-to-V6 handoff

V5 pass authorizes only the next qualification step. It does not qualify hardware.

Before V6, hand the RF engineer:

- the unchanged V5 release/build/digests;
- exact catalog, operational configuration, detector rule, and fingerprint identities;
- V5 manifest, precommitment, report, hashes, and failure/coverage ledger;
- the receiver model being tested—RSPdx and RSPdx R2 require separate V6–V7 records;
- the list of tested and untested envelopes, Unknown intervals, Unobserved events, misses, and nuisance alerts.

Then follow [Hardware validation](hardware-validation.md) using the final receiver, antenna, cable, filter, LNA, fixed gain, and SDRconnect chain. Use calibrated, in-date equipment and a witnessed shielded/conducted method. Never radiate an unauthorized GNSS test signal.

Stop V6 if the release, receiver model/serial hash, antenna, cable/filter/LNA, gain, SDRconnect version, sample rate, FFT grid, or mask differs from the V5 handoff. Preserve the evidence and start a new fingerprint-specific qualification record.

V6 must characterize target/range response, tested detection envelope, overload separation, central-mask/guard behavior, and sham/nuisance alerts. Passive noise-floor comparisons cannot prove sensitivity or calibrated bandwidth.

## Evidence custody

Retain the original sealed corpus read-only. Copy only the result bundle for review. Keep acquisition/truth working notes under the external custodian's retention policy; do not place credentials, raw receiver serials, IP/MAC addresses, logs, IQ, or navigation-receiver data in the RF Monitor V5 bundle.

V7 remains the final required gate after V6.
