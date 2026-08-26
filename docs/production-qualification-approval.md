# Production qualification approval

RF Monitor keeps **Monitoring now** separate from **Development qualification**. A normal receiver path and the bounded 24-hour local gate are necessary, but they cannot set `productionReady` by themselves.

Production readiness requires a separately managed JSON approval at `/etc/rf-monitor/qualification-approval-v1.json` (or the root-managed `RFMON_QUALIFICATION_APPROVAL_FILE` path). RF Monitor only reads this file. It has no API, Settings action, or command that creates or edits it.

The schema binds all of these values exactly:

- release build, server build, browser build, source digest, package digest, and dependency-lock digest;
- configuration hash and catalog version;
- deployment ID and the hash of deployment ID plus site name;
- canonical receiver model (`RSPdx` or `RSPdx R2`) and receiver-serial hash;
- commissioning epoch and soak start;
- the immutable qualification-bundle hash and approval identity/time;
- installed-chain, 24-hour timing/baseline, hardware recovery, fault injection, and evidence-continuity gates through V7.

Every V0–V7 gate must be true, V5–V7 must bind live real-receiver evidence, approval must occur after the bounded V7 gate ends, and the record digest must match. A release, configuration, site, receiver, serial, or commissioning change makes the record inapplicable. Missing approval remains `Not qualified`; an invalid or mismatched record fails closed.

For one-release input compatibility, the v1 schema ignores the retired `clean72HourSoakQualified` and `controlledPilotQualified` metadata fields. They may be omitted or false and can never make development qualification pass or fail.

After the independent V0–V7 record is reviewed, the site administrator installs it as `root:rfmonitor`, mode `0640`. The `rfmonitor` service account must be able to read it but not write it. Restart RF Monitor to load a newly installed record, then run `sudo rf-monitor doctor`. Do not copy an approval from another receiver or site and do not edit a failed record into a pass.

The record's `recordDigest` is SHA-256 over the fixed-order record payload without the `recordDigest` field. The approval process must use the implementation contract in `src/server/productionQualification.ts` from the exact release being approved. A self-consistent digest detects accidental or post-review editing; root ownership and the external approval/custody process are the authority boundary.

This mechanism does not replace live V6/V7 evidence. Until the exact externally witnessed V0–V7 prerequisites and approval exist, traceability remains in progress and `productionReady` remains false.
