#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this command with sudo: sudo rf-monitor support-bundle" >&2
  exit 1
fi

STATE_FILE="${RFMON_STATE_FILE:-/etc/rf-monitor/install.conf}"
[[ -r "${STATE_FILE}" ]] || { echo "Installation state not found: ${STATE_FILE}" >&2; exit 1; }
# This root-owned installer file contains paths, not Settings credentials.
source "${STATE_FILE}"

MAX_ENTRY_BYTES="${RFMON_SUPPORT_MAX_ENTRY_BYTES:-262144}"
MAX_BUNDLE_BYTES="${RFMON_SUPPORT_MAX_BUNDLE_BYTES:-8388608}"
MAX_OUTPUT_BYTES="${RFMON_SUPPORT_MAX_OUTPUT_BYTES:-12582912}"
CAPTURE_TIMEOUT_SECONDS="${RFMON_SUPPORT_CAPTURE_TIMEOUT_SECONDS:-30}"
for value in "${MAX_ENTRY_BYTES}" "${MAX_BUNDLE_BYTES}" "${MAX_OUTPUT_BYTES}" "${CAPTURE_TIMEOUT_SECONDS}"; do
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || { echo "Support bundle size limits must be positive integers." >&2; exit 1; }
done
(( MAX_ENTRY_BYTES <= 1048576 )) || { echo "Per-entry support bundle limit exceeds 1 MiB." >&2; exit 1; }
(( MAX_BUNDLE_BYTES >= 1048576 )) || { echo "Support bundle input limit must be at least 1 MiB." >&2; exit 1; }
(( MAX_BUNDLE_BYTES <= 33554432 )) || { echo "Support bundle input limit exceeds 32 MiB." >&2; exit 1; }
(( MAX_OUTPUT_BYTES <= 50331648 )) || { echo "Support bundle archive limit exceeds 48 MiB." >&2; exit 1; }
(( CAPTURE_TIMEOUT_SECONDS <= 60 )) || { echo "Support bundle capture timeout exceeds 60 seconds." >&2; exit 1; }

output_directory="${RFMON_SUPPORT_OUTPUT_DIR:-${PWD}}"
[[ "${output_directory}" = /* && -d "${output_directory}" && ! -L "${output_directory}" ]] \
  || { echo "Support bundle output must be an absolute, existing, non-symlink directory." >&2; exit 1; }
[[ "$(realpath -e "${output_directory}")" == "${output_directory}" ]] \
  || { echo "Support bundle output path must not contain symlinks or traversal." >&2; exit 1; }

timestamp="$(date --utc +%Y%m%dT%H%M%SZ)"
work_directory="$(mktemp -d)"
bundle_directory="${work_directory}/rf-monitor-support-${timestamp}"
output_name="rf-monitor-support-${timestamp}-${BASHPID}.tar.gz"
output_file="${output_directory}/${output_name}"
staged_archive="${work_directory}/${output_name}"
mkdir -p "${bundle_directory}"
trap 'rm -rf "${work_directory}"' EXIT

redact_stream() {
  # Drop multiline private-key material before line-oriented substitutions.
  # Certificates are intentionally left available for TLS diagnosis; only
  # PRIVATE KEY PEM blocks are secret.
  awk '
    /-----BEGIN ([A-Z0-9]+[[:space:]])*PRIVATE KEY-----/ {
      print "[PRIVATE KEY REDACTED]"
      private_key = 1
      next
    }
    private_key && /-----END ([A-Z0-9]+[[:space:]])*PRIVATE KEY-----/ {
      private_key = 0
      next
    }
    private_key { next }
    { print }
  ' | sed -E \
    -e 's/"(password|secret|token|credential|authorization|cookie|session|serial)"[[:space:]]*:[[:space:]]*"[^"]*"/"\1":"[REDACTED]"/gI' \
    -e 's/([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll])([_A-Za-z0-9.-]*)([[:space:]]*)(=|:)[[:space:]]*[^[:space:],;]+/\1\2\3\4[REDACTED]/g' \
    -e 's/([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn])([[:space:]]*)(=|:)[[:space:]]*(Bearer|Basic)[[:space:]]+[^[:space:],;]+/\1\2\3[REDACTED]/gI' \
    -e 's/([Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee])([[:space:]]*)(=|:)[[:space:]]*[^[:cntrl:]]*/\1\2\3[REDACTED]/g' \
    -e 's/([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn])([[:space:]]*)(=|:)[[:space:]]*[^[:space:],;]+/\1\2\3[REDACTED]/g' \
    -e 's/([Ss][Ee][Rr][Ii][Aa][Ll])([_A-Za-z0-9.-]*)([[:space:]]*)(=|:)[[:space:]]*[^[:space:],;]+/\1\2\3\4[REDACTED]/g' \
    -e 's/([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/[MAC REDACTED]/g' \
    -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/[IP REDACTED]/g' \
    -e 's/\[[0-9A-Fa-f:]+\]/[IP REDACTED]/g' \
    -e 's#(wss?|https?)://[^/@[:space:]]+@#\1://[CREDENTIAL REDACTED]@#g'
}

remaining_bytes() {
  local used payload_limit
  payload_limit=$((MAX_BUNDLE_BYTES - 65536))
  used="$(du -sb "${bundle_directory}" 2>/dev/null | awk '{print $1}')"
  [[ "${used}" =~ ^[0-9]+$ ]] || used=0
  if (( used >= payload_limit )); then printf '0'; else printf '%s' "$((payload_limit - used))"; fi
}

capture() {
  local output="$1" limit
  shift
  limit="$(remaining_bytes)"
  (( limit > 0 )) || return 0
  (( limit > MAX_ENTRY_BYTES )) && limit="${MAX_ENTRY_BYTES}"
  { { timeout --signal=TERM "${CAPTURE_TIMEOUT_SECONDS}s" "$@" 2>&1 || true; } | redact_stream | head -c "${limit}" > "${bundle_directory}/${output}"; } || true
}

capture_json() {
  local output="$1" source="$2" filter="$3" raw limit source_bytes
  [[ -r "${source}" && -f "${source}" && ! -L "${source}" ]] || return 0
  source_bytes="$(stat -c '%s' "${source}" 2>/dev/null || echo 0)"
  [[ "${source_bytes}" =~ ^[0-9]+$ ]] && (( source_bytes > 0 && source_bytes <= 2097152 )) || return 0
  limit="$(remaining_bytes)"
  (( limit > 0 )) || return 0
  (( limit > MAX_ENTRY_BYTES )) && limit="${MAX_ENTRY_BYTES}"
  raw="${work_directory}/json-$RANDOM-$RANDOM"
  jq "${filter}" "${source}" > "${raw}" 2>/dev/null || { rm -f "${raw}"; return 0; }
  { redact_stream < "${raw}" | head -c "${limit}" > "${bundle_directory}/${output}"; } || true
  rm -f "${raw}"
}

capture os-release.txt cat /etc/os-release
capture kernel.txt uname -srvmo
capture clock.txt timedatectl show --property=NTPSynchronized --property=Timezone --property=LocalRTC
capture disks.txt df -hT
capture memory.txt free -h
capture usb.txt lsusb -d 1df7:
capture listeners.txt ss -ltnH
capture firewall.txt ufw status

for unit in \
  rf-monitor.service sdrconnect-headless.service nginx.service \
  rf-monitor-sdr-recovery.timer rf-monitor-sdr-recovery.service \
  rf-monitor-application-recovery.timer rf-monitor-application-recovery.service \
  rf-monitor-ops-probe.timer rf-monitor-ops-daily.timer rf-monitor-ops-weekly.timer rf-monitor-ops-monthly.timer; do
  safe_name="${unit//[^A-Za-z0-9._-]/_}"
  capture "systemd-${safe_name}.txt" systemctl show "${unit}" \
    --property=Id --property=ActiveState --property=SubState --property=Result \
    --property=NRestarts --property=ActiveEnterTimestamp --property=NextElapseUSecRealtime
done

capture_json sdr-recovery-result.json "${RFMON_RECOVERY_STATUS_FILE:-/run/rf-monitor-recovery/status.json}" \
  '{schemaVersion,state,reasonCode,source,observedAt,streamState,transportState,monitoringReady,attemptsInWindow,maxAttempts,requestRetained,systemdResult,nextAttemptAt,lockoutUntil}'
capture_json application-recovery-result.json "${RFMON_APPLICATION_RECOVERY_STATUS_FILE:-/run/rf-monitor-application-recovery/status.json}" \
  '{schemaVersion,state,reasonCode,source,observedAt,attemptsInWindow,maxAttempts,requestRetained,systemdResult,nextAttemptAt,lockoutUntil}'
capture_json operations-status.json /var/lib/rf-monitor-ops/status.json \
  '{schemaVersion,kind,generatedAt,hashAlgorithm,payloadSha256,recordSha256,payload}'
capture_json operations-weekly-latest.json /var/lib/rf-monitor-ops/weekly-latest.json \
  '{schemaVersion,kind,generatedAt,hashAlgorithm,payloadSha256,recordSha256,payload}'
capture_json operations-monthly-latest.json /var/lib/rf-monitor-ops/monthly-latest.json \
  '{schemaVersion,kind,generatedAt,hashAlgorithm,payloadSha256,recordSha256,payload}'

capture nginx-test.txt nginx -t
capture journal-disk-usage.txt journalctl --disk-usage
capture journal.txt journalctl -u rf-monitor.service -u sdrconnect-headless.service -u nginx -n 500 --no-pager --output=short-iso
capture doctor.txt env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/doctor.sh"

if [[ -n "${JOURNAL_CONFIG_FILE:-}" ]]; then
  capture journald-rf-monitor.conf sed -n '1,200p' "${JOURNAL_CONFIG_FILE}"
fi

if [[ -r "${CONFIG_FILE}" && -f "${CONFIG_FILE}" && ! -L "${CONFIG_FILE}" ]]; then
  capture rf-monitor.env.redacted sed -E \
    -e 's/^([^#=]*(PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY)[^=]*)=.*/\1=[REDACTED]/I' \
    -e 's/^([^#=]*(SERIAL|HOST|URL|ADDRESS|IP)[^=]*)=.*/\1=[REDACTED]/I' \
    "${CONFIG_FILE}"
fi

catalog_file="$( { grep '^RF_MONITOR_CATALOG_FILE=' "${CONFIG_FILE}" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d '"')"
operational_file="$( { grep '^RF_MONITOR_OPERATIONAL_FILE=' "${CONFIG_FILE}" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d '"')"
json_redaction='walk(if type == "object" then with_entries(if (.key | test("password|secret|token|credential|private|serial|hostname|host|url|address|(^|_)ip$|latitude|longitude"; "i")) then .value = "[REDACTED]" else . end) else . end)'
capture_json catalog.redacted.json "${catalog_file}" "${json_redaction}"
capture_json operational.redacted.json "${operational_file}" "${json_redaction}"
audit_file="$(dirname "${operational_file:-/nonexistent}")/config-audit.jsonl"
if [[ -r "${audit_file}" && -f "${audit_file}" && ! -L "${audit_file}" ]]; then
  capture config-audit-last-100.redacted.jsonl tail -n 100 "${audit_file}"
fi

cat > "${bundle_directory}/README.txt" <<'EOF'
RF Monitor support bundle

This archive is bounded and automatically redacts password-, credential-,
secret-, token-, serial-, network-address-, and private-key-labelled values.
Credential files, evidence contents, private keys, full process command lines,
and unlimited logs are excluded. Automated redaction is not a sharing decision:
review the archive before sending it to another person.
EOF

bundle_bytes="$(du -sb "${bundle_directory}" | awk '{print $1}')"
if [[ ! "${bundle_bytes}" =~ ^[0-9]+$ ]] || (( bundle_bytes > MAX_BUNDLE_BYTES )); then
  echo "Support bundle input exceeded the configured bound; no archive was published." >&2
  exit 1
fi

(
  cd "${bundle_directory}"
  find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -printf '%f\0' \
    | sort -z \
    | xargs -0 -r sha256sum -- > SHA256SUMS.txt
)
bundle_bytes="$(du -sb "${bundle_directory}" | awk '{print $1}')"
if [[ ! "${bundle_bytes}" =~ ^[0-9]+$ ]] || (( bundle_bytes > MAX_BUNDLE_BYTES )); then
  echo "Support bundle hashes exceeded the configured bound; no archive was published." >&2
  exit 1
fi
/usr/bin/tar -C "${work_directory}" -czf "${staged_archive}" "$(basename "${bundle_directory}")"
output_bytes="$(stat -c '%s' "${staged_archive}")"
if [[ ! "${output_bytes}" =~ ^[0-9]+$ ]] || (( output_bytes > MAX_OUTPUT_BYTES )); then
  echo "Support bundle archive exceeded the configured bound; no archive was published." >&2
  exit 1
fi

# Build the archive only inside root's private temporary directory. Copy it to
# an exclusively created, no-follow staging inode in the output directory, then
# hard-link that complete inode to the final name without replacing anything.
# A crash can therefore leave a hidden partial or a complete archive, never a
# truncated archive under the final name.
# When sudo identifies an invoking user, that user performs the final write;
# failure therefore cannot affect paths outside that user's own authority.
publisher=(/usr/bin/node)
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  [[ "${SUDO_USER}" =~ ^[A-Za-z_][A-Za-z0-9_.-]*[$]?$ ]] \
    || { echo "Support bundle invoking user is invalid; no archive was published." >&2; exit 1; }
  /usr/bin/id -u -- "${SUDO_USER}" >/dev/null 2>&1 \
    || { echo "Support bundle invoking user does not exist; no archive was published." >&2; exit 1; }
  publisher=(/usr/sbin/runuser -u "${SUDO_USER}" -- /usr/bin/node)
fi
if ! (
  cd -P -- "${output_directory}"
  [[ "$(pwd -P)" == "${output_directory}" ]] || exit 73
  "${publisher[@]}" -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const destination = process.argv[1];
    const partial = `.${destination}.partial-${crypto.randomUUID()}`;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
    let descriptor;
    let created;
    let published = false;
    const matching = (file, identity) => {
      try {
        const current = fs.lstatSync(file);
        return current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino;
      } catch {
        return false;
      }
    };
    const unlinkIfOwned = (file, identity) => {
      if (identity && matching(file, identity)) {
        try { fs.unlinkSync(file); } catch { /* best effort */ }
      }
    };
    try {
      descriptor = fs.openSync(partial, flags, 0o600);
      created = fs.fstatSync(descriptor);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) offset += fs.writeSync(descriptor, buffer, offset, bytesRead - offset);
      }
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
      if (!matching(partial, created)) throw new Error("support-bundle-partial-ownership-lost");
      fs.linkSync(partial, destination);
      published = true;
      if (!matching(destination, created)) throw new Error("support-bundle-publication-ownership-lost");
      fs.unlinkSync(partial);
      const directory = fs.openSync(".", fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      fs.closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* best effort */ }
      }
      if (published) unlinkIfOwned(destination, created);
      unlinkIfOwned(partial, created);
      throw error;
    }
  ' "${output_name}" < "${staged_archive}"
); then
  echo "Support bundle target exists or could not be securely created; no archive was published." >&2
  exit 1
fi

echo "Support bundle created: ${output_file}"
echo "Size: ${output_bytes} bytes (maximum ${MAX_OUTPUT_BYTES})."
echo "Review its contents before sending it to another person."
