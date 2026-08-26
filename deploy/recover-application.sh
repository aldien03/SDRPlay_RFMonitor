#!/usr/bin/env bash
set -Eeuo pipefail

# External heartbeat watchdog and protected application-restart executor. It is
# deliberately independent of the Node event loop it supervises. Operational
# failures are recorded and return success so systemd never creates a restart
# loop around this helper.
umask 027

REQUEST_DIR="${RFMON_REQUEST_RUNTIME_DIR:-/run/rf-monitor}"
STATE_DIR="${RFMON_APPLICATION_RECOVERY_RUNTIME_DIR:-/run/rf-monitor-application-recovery}"
REQUEST_FILE="${REQUEST_DIR}/restart-application"
STATUS_FILE="${RFMON_APPLICATION_RECOVERY_STATUS_FILE:-${STATE_DIR}/status.json}"
AUDIT_FILE="${RFMON_CONFIG_AUDIT_FILE:-/etc/rf-monitor/config-audit.jsonl}"
PORT="${RF_MONITOR_PORT:-8080}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
STALE_COUNT_FILE="${STATE_DIR}/stale-count"
ATTEMPTS_FILE="${STATE_DIR}/recovery-attempts"
LAST_ATTEMPT_FILE="${STATE_DIR}/last-recovery-at"
LOCK_FILE="${STATE_DIR}/automatic-recovery-locked"
COORDINATION_LOCK="${RFMON_RECOVERY_COORDINATION_LOCK:-${REQUEST_DIR}/recovery.lock}"
INTERRUPTION_FILE="${RFMON_LAST_INTERRUPTION_FILE:-${REQUEST_DIR}/last-interruption.json}"
STALE_CHECKS_BEFORE_RECOVERY="${RFMON_APPLICATION_STALE_CHECKS_BEFORE_RECOVERY:-2}"
AUTOMATIC_COOLDOWN_SECONDS="${RFMON_APPLICATION_AUTOMATIC_COOLDOWN_SECONDS:-300}"
MANUAL_COOLDOWN_SECONDS="${RFMON_APPLICATION_MANUAL_COOLDOWN_SECONDS:-120}"
RECOVERY_WINDOW_SECONDS="${RFMON_APPLICATION_RECOVERY_WINDOW_SECONDS:-3600}"
MAX_RECOVERY_ATTEMPTS="${RFMON_APPLICATION_MAX_RECOVERY_ATTEMPTS:-3}"
CONFIRM_ATTEMPTS="${RFMON_APPLICATION_CONFIRM_ATTEMPTS:-30}"
CONFIRM_INTERVAL_SECONDS="${RFMON_APPLICATION_CONFIRM_INTERVAL_SECONDS:-1}"
STARTUP_GRACE_SECONDS="${RFMON_APPLICATION_STARTUP_GRACE_SECONDS:-60}"

for numeric_setting in \
  STALE_CHECKS_BEFORE_RECOVERY AUTOMATIC_COOLDOWN_SECONDS MANUAL_COOLDOWN_SECONDS \
  RECOVERY_WINDOW_SECONDS MAX_RECOVERY_ATTEMPTS CONFIRM_ATTEMPTS CONFIRM_INTERVAL_SECONDS STARTUP_GRACE_SECONDS; do
  numeric_value="${!numeric_setting}"
  [[ "${numeric_value}" =~ ^[0-9]+$ ]] || { printf 'Invalid numeric application recovery setting %s\n' "${numeric_setting}" >&2; exit 2; }
done
(( MAX_RECOVERY_ATTEMPTS > 0 )) || { printf 'Application recovery attempts must be greater than zero\n' >&2; exit 2; }

install -d -m 0750 "${STATE_DIR}"
now="$(date +%s)"
manual=false
request_id=""
requested_at=""
previous_boot_id=""
expected_revision=""
audit_entry_hash=""
observed_boot_id=""
attempts_in_window=0

iso_at() {
  date --utc --date="@$1" '+%Y-%m-%dT%H:%M:%SZ'
}

atomic_number() {
  local destination="$1" value="$2" temporary
  temporary="$(mktemp "${destination}.partial.XXXXXX")"
  printf '%s\n' "${value}" > "${temporary}"
  mv -f -- "${temporary}" "${destination}"
}

write_status() {
  local state="$1" reason_code="$2" next_attempt_at="${3:-}" lockout_until="${4:-}" systemd_result="${5:-not-run}"
  local temporary request_retained source observed_at
  observed_at="$(date --utc '+%Y-%m-%dT%H:%M:%SZ')"
  source="automatic"
  [[ "${manual}" == "true" ]] && source="manual"
  request_retained=false
  [[ -f "${REQUEST_FILE}" && ! -L "${REQUEST_FILE}" ]] && request_retained=true
  temporary="$(mktemp "${STATUS_FILE}.partial.XXXXXX")"
  jq -n \
    --arg state "${state}" \
    --arg reasonCode "${reason_code}" \
    --arg source "${source}" \
    --arg observedAt "${observed_at}" \
    --arg requestId "${request_id}" \
    --arg requestedAt "${requested_at}" \
    --arg observedBootId "${observed_boot_id}" \
    --arg nextAttemptAt "${next_attempt_at}" \
    --arg lockoutUntil "${lockout_until}" \
    --arg systemdResult "${systemd_result}" \
    --argjson attemptsInWindow "${attempts_in_window}" \
    --argjson maxAttempts "${MAX_RECOVERY_ATTEMPTS}" \
    --argjson requestRetained "${request_retained}" \
    '{
      schemaVersion: 1,
      state: $state,
      reasonCode: $reasonCode,
      source: $source,
      observedAt: $observedAt,
      attemptsInWindow: $attemptsInWindow,
      maxAttempts: $maxAttempts,
      requestRetained: $requestRetained,
      systemdResult: $systemdResult
    }
    + (if $requestId == "" then {} else {requestId: $requestId} end)
    + (if $requestedAt == "" then {} else {requestedAt: $requestedAt} end)
    + (if $observedBootId == "" then {} else {observedBootId: $observedBootId} end)
    + (if $nextAttemptAt == "" then {} else {nextAttemptAt: $nextAttemptAt} end)
    + (if $lockoutUntil == "" then {} else {lockoutUntil: $lockoutUntil} end)' > "${temporary}"
  chmod 0644 "${temporary}"
  mv -f -- "${temporary}" "${STATUS_FILE}"
}

read_health() {
  local health
  health="$(curl --silent --show-error --fail --max-time 3 --max-filesize 65536 "${HEALTH_URL}" 2>/dev/null || true)"
  [[ -n "${health}" ]] || return 1
  (( ${#health} <= 65536 )) || return 1
  jq -e '.schemaVersion == 2 and (.identity.serviceBootId | type) == "string" and (.identity.configuration.configurationRevision | type) == "number"' <<<"${health}" >/dev/null 2>&1 || return 1
  observed_boot_id="$(jq -r '.identity.serviceBootId' <<<"${health}")"
  observed_revision="$(jq -r '.identity.configuration.configurationRevision' <<<"${health}")"
  return 0
}

host_memory_state() {
  if [[ -n "${RFMON_HOST_MEMORY_STATE_FILE:-}" ]]; then
    cat "${RFMON_HOST_MEMORY_STATE_FILE}" 2>/dev/null || printf 'unknown\n'
    return
  fi
  local mem_total mem_available swap_total swap_free psi_some psi_full
  mem_total="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  mem_available="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  swap_total="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  swap_free="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || true)"
  psi_some="$(awk '/^some / {for (i=1;i<=NF;i++) if ($i ~ /^avg10=/) {sub(/^avg10=/,"",$i); print $i}}' /proc/pressure/memory 2>/dev/null || true)"
  psi_full="$(awk '/^full / {for (i=1;i<=NF;i++) if ($i ~ /^avg10=/) {sub(/^avg10=/,"",$i); print $i}}' /proc/pressure/memory 2>/dev/null || true)"
  if [[ ! "${mem_total}" =~ ^[0-9]+$ || ! "${mem_available}" =~ ^[0-9]+$ || ! "${swap_total}" =~ ^[0-9]+$ || ! "${swap_free}" =~ ^[0-9]+$ || -z "${psi_some}" || -z "${psi_full}" ]]; then
    printf 'unknown\n'
    return
  fi
  awk -v mt="${mem_total}" -v ma="${mem_available}" -v st="${swap_total}" -v sf="${swap_free}" -v ps="${psi_some}" -v pf="${psi_full}" 'BEGIN {
    available = ma / mt; swap = st == 0 ? 1 : sf / st;
    if (available < 0.10 || swap < 0.10 || ps >= 25) print "critical";
    else if (available < 0.20 || swap < 0.25 || ps >= 10 || pf >= 1) print "pressure";
    else print "normal";
  }'
}

application_in_startup_grace() {
  (( STARTUP_GRACE_SECONDS > 0 )) || return 1
  local entered
  entered="$(systemctl show rf-monitor.service --property=ActiveEnterTimestamp --value 2>/dev/null || true)"
  [[ -n "${entered}" ]] || return 1
  local entered_epoch
  entered_epoch="$(date --date="${entered}" +%s 2>/dev/null || printf '0')"
  [[ "${entered_epoch}" =~ ^[0-9]+$ ]] || return 1
  (( now - entered_epoch < STARTUP_GRACE_SECONDS ))
}

prune_attempts() {
  local temporary
  touch "${ATTEMPTS_FILE}"
  temporary="$(mktemp "${ATTEMPTS_FILE}.partial.XXXXXX")"
  awk -v cutoff="$((now - RECOVERY_WINDOW_SECONDS))" '$1 >= cutoff' "${ATTEMPTS_FILE}" > "${temporary}"
  mv -f -- "${temporary}" "${ATTEMPTS_FILE}"
  attempts_in_window="$(awk 'NF && $1 ~ /^[0-9]+$/ { count += 1 } END { print count + 0 }' "${ATTEMPTS_FILE}")"
}

if [[ -e "${REQUEST_FILE}" || -L "${REQUEST_FILE}" ]]; then
  request_size="$(stat -c '%s' "${REQUEST_FILE}" 2>/dev/null || printf '0')"
  if [[ ! -f "${REQUEST_FILE}" || -L "${REQUEST_FILE}" || ! "${request_size}" =~ ^[0-9]+$ || "${request_size}" -gt 16384 ]]; then
    write_status failed invalid-request-file
    exit 0
  fi
  manual=true
  request_id="$(jq -r 'select(.schemaVersion == 1 and .source == "settings-admin") | .requestId // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
  requested_at="$(jq -r '.requestedAt // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
  previous_boot_id="$(jq -r '.previousBootId // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
  expected_revision="$(jq -r '.expectedConfigurationRevision // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
  audit_entry_hash="$(jq -r '.auditEntryHash // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
  if [[ ! "${request_id}" =~ ^[0-9a-f-]{36}$ || ! "${previous_boot_id}" =~ ^[A-Za-z0-9._-]{1,128}$ || ! "${expected_revision}" =~ ^[0-9]+$ || ! "${audit_entry_hash}" =~ ^[a-f0-9]{64}$ ]]; then
    write_status failed invalid-request
    exit 0
  fi
  if [[ ! -f "${AUDIT_FILE}" ]] || ! tail -n 64 "${AUDIT_FILE}" \
    | jq -s -e --arg hash "${audit_entry_hash}" 'any(.[]; .entryHash == $hash and .actor == "settings-admin" and .outcome == "applied" and (.changedFields | index("runtime.software-restart")))' >/dev/null 2>&1; then
    write_status failed audit-not-verified
    exit 0
  fi
fi

health_available=false
if read_health; then health_available=true; fi
prune_attempts

if [[ "${manual}" == "false" && "${health_available}" == "true" ]]; then
  atomic_number "${STALE_COUNT_FILE}" 0
  write_status live heartbeat-confirmed
  exit 0
fi

if [[ "${manual}" == "true" && "${health_available}" == "true" ]]; then
  if [[ "${observed_boot_id}" != "${previous_boot_id}" ]]; then
    rm -f -- "${REQUEST_FILE}"
    write_status live restart-already-observed "" "" success
    exit 0
  fi
  if [[ "${observed_revision}" != "${expected_revision}" ]]; then
    rm -f -- "${REQUEST_FILE}"
    write_status failed request-revision-mismatch
    exit 0
  fi
fi

if [[ "${manual}" == "false" ]]; then
  memory_state="$(host_memory_state)"
  if [[ "${memory_state}" == "pressure" || "${memory_state}" == "critical" ]]; then
    atomic_number "${STALE_COUNT_FILE}" 0
    write_status suppressed host-memory-pressure "$(iso_at "$((now + 120))")"
    exit 0
  fi
  if application_in_startup_grace; then
    atomic_number "${STALE_COUNT_FILE}" 0
    write_status suppressed application-startup-grace "$(iso_at "$((now + STARTUP_GRACE_SECONDS))")"
    exit 0
  fi
fi

exec 9>"${COORDINATION_LOCK}"
if ! flock --nonblock 9; then
  write_status suppressed recovery-busy "$(iso_at "$((now + 30))")"
  exit 0
fi

if [[ -e "${LOCK_FILE}" ]]; then
  locked_at="$(cat "${LOCK_FILE}" 2>/dev/null || printf '%s' "${now}")"
  [[ "${locked_at}" =~ ^[0-9]+$ ]] || locked_at="${now}"
  if (( now - locked_at < RECOVERY_WINDOW_SECONDS )); then
    write_status lockout attempt-limit "" "$(iso_at "$((locked_at + RECOVERY_WINDOW_SECONDS))")"
    exit 0
  fi
  rm -f -- "${LOCK_FILE}"
fi

if [[ "${manual}" == "false" ]]; then
  stale_count="$(cat "${STALE_COUNT_FILE}" 2>/dev/null || printf '0')"
  [[ "${stale_count}" =~ ^[0-9]+$ ]] || stale_count=0
  stale_count=$((stale_count + 1))
  atomic_number "${STALE_COUNT_FILE}" "${stale_count}"
  if (( stale_count < STALE_CHECKS_BEFORE_RECOVERY )); then
    write_status requested heartbeat-missed
    exit 0
  fi
fi

if (( attempts_in_window >= MAX_RECOVERY_ATTEMPTS )); then
  atomic_number "${LOCK_FILE}" "${now}"
  write_status lockout attempt-limit "" "$(iso_at "$((now + RECOVERY_WINDOW_SECONDS))")"
  logger --tag rf-monitor-application-recovery "RF Monitor restart locked after ${attempts_in_window} attempts."
  exit 0
fi

last_attempt="$(cat "${LAST_ATTEMPT_FILE}" 2>/dev/null || printf '0')"
[[ "${last_attempt}" =~ ^[0-9]+$ ]] || last_attempt=0
cooldown_seconds="${AUTOMATIC_COOLDOWN_SECONDS}"
[[ "${manual}" == "true" ]] && cooldown_seconds="${MANUAL_COOLDOWN_SECONDS}"
if (( now - last_attempt < cooldown_seconds )); then
  write_status failed recovery-cooldown "$(iso_at "$((last_attempt + cooldown_seconds))")"
  exit 0
fi

printf '%s\n' "${now}" >> "${ATTEMPTS_FILE}"
attempts_in_window=$((attempts_in_window + 1))
atomic_number "${LAST_ATTEMPT_FILE}" "${now}"
atomic_number "${STALE_COUNT_FILE}" 0
write_status recovering restart-requested "" "" pending

interruption_temporary="$(mktemp "${INTERRUPTION_FILE}.partial.XXXXXX")"
jq -n --arg at "$(date --utc '+%Y-%m-%dT%H:%M:%SZ')" --arg cause "$([[ "${manual}" == "true" ]] && printf 'manual-application-restart' || printf 'application-recovery')" --arg previousBootId "${observed_boot_id}" \
  '{schemaVersion:1, at:$at, cause:$cause} + (if $previousBootId == "" then {} else {previousBootId:$previousBootId} end)' > "${interruption_temporary}"
chmod 0640 "${interruption_temporary}"
mv -f -- "${interruption_temporary}" "${INTERRUPTION_FILE}"

if ! systemctl --no-block restart rf-monitor.service; then
  rm -f -- "${INTERRUPTION_FILE}"
  write_status failed systemd-restart-failed "$(iso_at "$((now + cooldown_seconds))")" "" failed
  exit 0
fi
write_status recovering restart-job-accepted "" "" accepted

for _attempt in $(seq 1 "${CONFIRM_ATTEMPTS}"); do
  if read_health && [[ "${manual}" != "true" || "${observed_boot_id}" != "${previous_boot_id}" ]]; then
    rm -f -- "${REQUEST_FILE}"
    write_status live restart-confirmed "" "" success
    logger --tag rf-monitor-application-recovery "RF Monitor application restart completed and a new heartbeat was confirmed."
    exit 0
  fi
  sleep "${CONFIRM_INTERVAL_SECONDS}"
done

write_status failed heartbeat-confirmation-timeout "$(iso_at "$((now + cooldown_seconds))")" "" accepted
exit 0
