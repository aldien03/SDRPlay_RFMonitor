# V6 Installed-Chain Conducted Qualification

V6 is the first gate that exercises the final installed RF chain. It must be run by an authorized RF laboratory on the exact frozen package and exact site configuration. A framework unit test or synthetic exercise is not V6 evidence.

Current status: **Not run**. No calibrated, witnessed conducted campaign for the installed receiver and chain is present in this repository.

## What V6 can establish

For the exact tested receiver and conducted reference plane, V6 checks:

- the correct Tier-1 target, capture range, central analysis range, and frequency placement;
- repeated wideband, CW, multitone, and moving-narrowband detector response;
- separate receiver-overload handling;
- rejection of guard-only energy and sham runs;
- exact release, configuration, site, receiver, installed-chain, SDRconnect, gain, FFT grid, mask, and protected-baseline bindings.

The report contains only the tested envelope and its measurement uncertainty. It does not establish antenna sensitivity, passive coverage, calibrated field strength, spoofing, intent, or navigation integrity.

## Roles and stop conditions

Use three distinct people or controlled identities:

1. **Implementer** — prepares the frozen package and provides the exact configuration.
2. **RF acquisition custodian** — controls the conducted setup, calibration records, raw tables, FFT files, and evidence custody.
3. **Independent witness** — holds the Ed25519 private key away from the RF Monitor host and signs the pre-test protocol and final sealed tree.

Hash each identity according to the site privacy procedure. The three hashes must be different. Stop if the witness or custodian is the implementer.

Also stop if:

- any of V0 through V5 is not PASS for the same release and configuration;
- a prerequisite artifact belongs to another build;
- the model is not exactly RSPdx or RSPdx R2, or the serial hash is unavailable;
- any chain component, SDRconnect version, fixed gain, sample rate, FFT grid, central mask, site binding, or protected baseline differs from approval;
- calibration expires before the last exposure;
- IQ, replay, simulation, field-domain persistence, or a radiated source is proposed;
- the safe conducted level, attenuation, isolation, or receiver input protection has not been approved by the responsible RF engineer.

Never radiate a GNSS-band test signal from this procedure. Use an authorized shielded/cabled connection with suitable attenuation and input protection.

## 1. Freeze and verify the candidate

On the qualification host:

```bash
cd /path/to/frozen/rf-monitor
/usr/bin/npm ci
/usr/bin/npm run build
/usr/bin/npm run validate:release
```

Expected: release validation says `PASS`, and `dist/release.json` contains the frozen build ID plus source, package, and dependency-lock SHA-256 values.

Stop if the command fails, `/usr/bin/node` is not used, or the source changes afterward. V0 through V5 must then be rerun for the new candidate.

## 2. Approve one exact installed-chain binding

Create a JSON file outside the campaign tree using [the binding schema](../config/qualification-schemas/v6-approved-binding-v1.schema.json). The binding contains hashes rather than raw receiver serials or private site identifiers.

It must bind:

- one receiver model and one serial hash;
- the final site and installed-chain fingerprints;
- the injection reference plane and each installed component hash;
- exact SDRconnect version and fixed-gain profile;
- confirmed 10 MS/s, normalized uint8 display values, and IQ off;
- exact FFT grid, spectrum reference/base, and central analysis bins;
- all four default Tier-1 physical targets;
- the exact protected baseline descriptor and fingerprint for each target.

RSPdx and RSPdx R2 require separate campaigns. A different receiver serial or chain fingerprint also requires a new campaign.

An independent approver records the canonical SHA-256 of this JSON through a channel separate from the campaign. Do not copy the witness private key to the RF Monitor host.

## 3. Predeclare the complete matrix

Use [the preparation worksheet](../config/v6-conducted-campaign.template.json) and [the protocol schema](../config/qualification-schemas/v6-conducted-protocol-v1.schema.json). The runner accepts only 360 independent cases:

- 4 Tier-1 targets;
- 9 case kinds;
- 10 independent acquisitions for each target/kind pair.

The nine case kinds are target/range, frequency accuracy, wideband, CW, multitone, moving narrowband, overload, guard-only, and sham.

Before exposure, each case declares its unique acquisition, raw-table, FFT, and evidence paths; expected outcome; generator frequency; source-level range at the generator reference port; occupied-width range where applicable; and frequency-error tolerance where applicable.

Adjacent FFT frames are not independent runs. Unknown, invalid, stale, or incomplete observations cannot pass.

### Bind the actual V0-V5 records

Each protocol prerequisite points to an exact [V6 prerequisite wrapper](../config/qualification-schemas/v6-prerequisite-wrapper-v1.schema.json). A generic JSON file that merely says `passed` is rejected. Each wrapper repeats the exact candidate and configuration, lists its source artifacts and hashes, and is included in the pre-test protocol commitment.

Required source records are:

- V0: schema-v2 traceability result with `valid: true` and a verified release binding;
- V1: RF Monitor validation record with no failed or skipped tests/files;
- V2: packaged process/storage qualification PASS;
- V3: packaged browser/operator/accessibility result with zero accessibility violations;
- V4: packaged end-to-end sub-gate, complete 16,040-case detector sub-gate, and a combined result bound to both hashes;
- V5: passing held-out replay bundle manifest, exact replay report, and a distinct [Ed25519-signed independent-verifier record](../config/qualification-schemas/v5-independent-replay-verification-v1.schema.json) bound to the bundle, report, configuration, release, and original V5 witness-key hashes.

The V5 independent verifier identity and Ed25519 key must differ from the V6 implementer, custodian, and witness. The verifier key's SPKI SHA-256 is pinned in the V6 protocol before exposure, so replacing the receipt and self-signing it with a new local key fails. A wrapper and its source files must all be inside the sealed campaign tree. Rehashing and re-signing a pass-shaped stub does not satisfy the gate-specific parser.

## 4. Bind calibrated equipment

Include at least one in-date certificate for each role:

- signal generator;
- frequency/power reference;
- attenuation path.

The protocol stores equipment/model/serial/certificate hashes, validity dates, and stated uncertainty. Every certificate file must be in the sealed tree and match its declared byte count and hash. Calibration must cover the first through last exposure.

Generator-port dBm is a laboratory source setting at the declared reference plane. It is not received field strength and must not be reported as RF Monitor dBm.

## 5. Witness the protocol before exposure

Finish `protocol.json`, including exact V0-V5 PASS artifact references, before applying any source. The witness signs the canonical Ed25519 protocol statement containing:

- campaign and protocol hashes;
- separately approved binding hash;
- commitment and signing times;
- first-exposure not-before time;
- implementer, custodian, and witness identity hashes.

The witness signing time must be after protocol commitment and no later than the declared first-exposure not-before time. Stop if any protocol or matrix field changes after signing.

The protocol also pins the distinct V5 independent-verifier identity and Ed25519 SPKI fingerprint. The final V6 witness key and V5 verifier key may not be the same.

## 6. Acquire test-domain evidence

For every case, retain:

- one acquisition descriptor;
- a packed `.uint8` FFT file with exact row/bin byte count;
- one raw measurement table;
- one bounded evidence artifact;
- UTC first/last exposure times;
- confirmed center and sample-rate readback;
- detector outcome, affected target, alert kind, overload state, and invalid/stale-frame count;
- measurement uncertainty.

All records must say `test`, `conducted-shielded`, `radiated: false`, and `iq: false`. They must name a real RSPdx/RSPdx R2 normalized display stream, not generated, simulated, replayed, or IQ input.

The completed tree may contain at most 5,000 declared files and 4 GiB. Individual JSON, FFT, certificate, prerequisite, and evidence limits are enforced by the runner.

## 7. Declare, witness, and seal the result

Mechanically calculate every case result using the frozen rules. The declared result records the case-result hash and PASS or FAIL. A guard/sham alert, unknown observation, wrong target/range, missed alert, or overload labelled as interference produces FAIL.

After the last exposure and declared result, the independent witness signs the exact protocol hash, complete evidence-tree hash, declared-result hash/decision, exposure interval, and role hashes.

The final campaign directory must contain only real directories and regular files. It must contain no links, no undeclared files, and no writable directory or file. The root manifest is `campaign-manifest.json` and follows [the campaign schema](../config/qualification-schemas/v6-conducted-campaign-v1.schema.json).

The signatures authenticate the witness statements and custody. They cannot prove that the physical connection, source setting, observation, or label is true. The RF custodian and independent reviewer remain responsible for physical evidence review.

## 8. Run V6

Use full paths:

```bash
cd /path/to/frozen/rf-monitor
/usr/bin/npm run validate:v6:conducted -- \
  --campaign /path/to/read-only/v6-campaign \
  --approved-binding /path/from/independent-approval/v6-binding.json \
  --approved-binding-sha256 APPROVED_CANONICAL_64_CHARACTER_SHA256 \
  --witness-public-key /path/from/independent-approval/v6-witness-public.pem \
  --witness-key-sha256 APPROVED_SPKI_64_CHARACTER_SHA256 \
  --catalog /path/to/exact/band-catalog.json \
  --operational /path/to/exact/operational.json \
  --output-root /path/to/qualification-results/v6
```

Expected on a valid qualifying campaign:

```text
Cases: 360; failed: 0; unknown: 0
Artifact verification: PASS
V6 decision: PASS
Development ready: NO (V7 and its exact external approval remain separate)
```

`V6 NOT RUN` means a trust, identity, chronology, custody, file, calibration, or domain prerequisite failed. No pass-shaped result is written. Do not edit a sealed campaign to repair it; preserve it and create a new campaign.

`V6 decision: FAIL` means the campaign was valid enough to score but at least one physical outcome failed. Preserve the atomic result bundle and investigate outside the campaign. A new tested envelope requires a new protocol and campaign.

## 9. Independent review

The reviewer checks:

- the approved binding and witness public-key fingerprints through their independent channels;
- the release/configuration identities against V0-V5 artifacts;
- every gate-specific prerequisite wrapper against its underlying source record(s), including the V4 combined and V5 verifier cross-hashes;
- calibration certificates and complete exposure interval;
- shielded/cabled setup records and safe input protection;
- raw tables, FFT byte counts, evidence hashes, case failures, and uncertainty;
- that the report states only the tested envelope;
- that no result claims sensitivity, field dBm, spoofing, intent, or navigation integrity.

V6 PASS authorizes only V7 installed 24-hour timing and baseline qualification. It is not a production release.
