#!/usr/bin/env bash
set -Eeuo pipefail

# This helper is deliberately a oneshot invoked by a systemd timer. Operational
# failures are recorded as structured state and return success so a failed
# receiver cannot push the helper itself into systemd's start-limit state.
umask 027

REQUEST_DIR="${RFMON_REQUEST_RUNTIME_DIR:-/run/rf-monitor}"
STATE_DIR="${RFMON_RECOVERY_RUNTIME_DIR:-/run/rf-monitor-recovery}"
REQUEST_FILE="${REQUEST_DIR}/recover-sdrconnect"
STATUS_FILE="${RFMON_RECOVERY_STATUS_FILE:-${STATE_DIR}/status.json}"
STALE_COUNT_FILE="${STATE_DIR}/stale-count"
ATTEMPTS_FILE="${STATE_DIR}/recovery-attempts"
LAST_ATTEMPT_FILE="${STATE_DIR}/last-recovery-at"
LOCK_FILE="${STATE_DIR}/automatic-recovery-locked"
PORT="${RF_MONITOR_PORT:-8080}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
STALE_CHECKS_BEFORE_RECOVERY="${RFMON_STALE_CHECKS_BEFORE_RECOVERY:-2}"
AUTOMATIC_COOLDOWN_SECONDS="${RFMON_AUTOMATIC_RECOVERY_COOLDOWN_SECONDS:-300}"
MANUAL_COOLDOWN_SECONDS="${RFMON_MANUAL_RECOVERY_COOLDOWN_SECONDS:-120}"
RECOVERY_WINDOW_SECONDS="${RFMON_RECOVERY_WINDOW_SECONDS:-3600}"
# Keep the legacy variable as a compatibility fallback for one release.
MAX_RECOVERY_ATTEMPTS="${RFMON_MAX_RECOVERY_ATTEMPTS:-${RFMON_MAX_AUTOMATIC_RECOVERY_ATTEMPTS:-3}}"
CONFIRM_ATTEMPTS="${RFMON_RECOVERY_CONFIRM_ATTEMPTS:-10}"
CONFIRM_INTERVAL_SECONDS="${RFMON_RECOVERY_CONFIRM_INTERVAL_SECONDS:-1}"

for numeric_setting in \
  STALE_CHECKS_BEFORE_RECOVERY AUTOMATIC_COOLDOWN_SECONDS MANUAL_COOLDOWN_SECONDS \
  RECOVERY_WINDOW_SECONDS MAX_RECOVERY_ATTEMPTS CONFIRM_ATTEMPTS CONFIRM_INTERVAL_SECONDS; do
  numeric_value="${!numeric_setting}"
  if [[ ! "${numeric_value}" =~ ^[0-9]+$ ]]; then
    printf 'Invalid numeric recovery setting %s\n' "${numeric_setting}" >&2
    exit 2
  fi
done
(( MAX_RECOVERY_ATTEMPTS > 0 )) || { printf 'RFMON_MAX_RECOVERY_ATTEMPTS must be greater than zero\n' >&2; exit 2; }

install -d -m 0750 "${STATE_DIR}"
now="$(date +%s)"
manual=false
request_id=""
requested_at=""
stream_state="unknown"
transport_state="unknown"
monitoring_ready=false
attempts_in_window=0
invalid_request=false

if [[ -e "${REQUEST_FILE}" || -L "${REQUEST_FILE}" ]]; then
  manual=true
  request_size="$(stat -c '%s' "${REQUEST_FILE}" 2>/dev/null || printf '0')"
  if [[ ! -f "${REQUEST_FILE}" || -L "${REQUEST_FILE}" || ! "${request_size}" =~ ^[0-9]+$ || "${request_size}" -gt 16384 ]]; then
    invalid_request=true
  else
    request_id="$(jq -r 'select(.schemaVersion == 1 and .source == "operator") | .requestId // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
    requested_at="$(jq -r '.requestedAt // ""' "${REQUEST_FILE}" 2>/dev/null || true)"
    [[ "${request_id}" =~ ^[0-9a-f-]{36}$ && -n "${requested_at}" ]] || invalid_request=true
  fi
fi

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
    --arg streamState "${stream_state}" \
    --arg transportState "${transport_state}" \
    --arg nextAttemptAt "${next_attempt_at}" \
    --arg lockoutUntil "${lockout_until}" \
    --arg systemdResult "${systemd_result}" \
    --argjson monitoringReady "${monitoring_ready}" \
    --argjson attemptsInWindow "${attempts_in_window}" \
    --argjson maxAttempts "${MAX_RECOVERY_ATTEMPTS}" \
    --argjson requestRetained "${request_retained}" \
    '{
      schemaVersion: 1,
      state: $state,
      reasonCode: $reasonCode,
      source: $source,
      observedAt: $observedAt,
      streamState: $streamState,
      transportState: $transportState,
      monitoringReady: $monitoringReady,
      attemptsInWindow: $attemptsInWindow,
      maxAttempts: $maxAttempts,
      requestRetained: $requestRetained,
      systemdResult: $systemdResult
    }
    + (if $requestId == "" then {} else {requestId: $requestId} end)
    + (if $requestedAt == "" then {} else {requestedAt: $requestedAt} end)
    + (if $nextAttemptAt == "" then {} else {nextAttemptAt: $nextAttemptAt} end)
    + (if $lockoutUntil == "" then {} else {lockoutUntil: $lockoutUntil} end)' > "${temporary}"
  chmod 0644 "${temporary}"
  mv -f -- "${temporary}" "${STATUS_FILE}"
}

if [[ "${invalid_request}" == "true" ]]; then
  write_status failed invalid-request-file
  exit 0
fi

read_health() {
  local health
  health="$(curl --silent --show-error --fail --max-time 3 --max-filesize 65536 "${HEALTH_URL}" 2>/dev/null || true)"
  [[ -n "${health}" ]] || return 1
  (( ${#health} <= 65536 )) || return 1
  jq -e '(.receivers | type) == "array"' <<<"${health}" >/dev/null 2>&1 || return 1
  stream_state="$(jq -r '.receivers[0].streamState // "stopped"' <<<"${health}" 2>/dev/null || printf 'stopped')"
  transport_state="$(jq -r '.receivers[0].transportState // "offline"' <<<"${health}" 2>/dev/null || printf 'offline')"
  monitoring_ready="$(jq -r '.monitoringReady // false' <<<"${health}" 2>/dev/null || printf 'false')"
  [[ "${monitoring_ready}" == "true" ]] || monitoring_ready=false
  return 0
}

prune_attempts() {
  local temporary
  touch "${ATTEMPTS_FILE}"
  temporary="$(mktemp "${ATTEMPTS_FILE}.partial.XXXXXX")"
  awk -v cutoff="$((now - RECOVERY_WINDOW_SECONDS))" '$1 >= cutoff' "${ATTEMPTS_FILE}" > "${temporary}"
  mv -f -- "${temporary}" "${ATTEMPTS_FILE}"
  attempts_in_window="$(awk 'NF && $1 ~ /^[0-9]+$/ { count += 1 } END { print count + 0 }' "${ATTEMPTS_FILE}")"
}

# Do not cycle SDRconnect while the SDRplay USB device is physically absent.
if ! lsusb -d 1df7: 2>/dev/null | grep -q .; then
  atomic_number "${STALE_COUNT_FILE}" 0
  write_status failed hardware-absent
  exit 0
fi

if ! read_health; then
  write_status failed health-unavailable
  exit 0
fi

# A live result clears the complete recovery episode, including any retained
# manual request that was preserved after a prior systemd start-limit failure.
if [[ "${monitoring_ready}" == "true" && "${stream_state}" == "live" ]]; then
  atomic_number "${STALE_COUNT_FILE}" 0
  prune_attempts
  rm -f -- "${REQUEST_FILE}"
  write_status live monitoring-ready
  exit 0
fi

prune_attempts

if [[ -e "${LOCK_FILE}" ]]; then
  locked_at="$(cat "${LOCK_FILE}" 2>/dev/null || printf '%s' "${now}")"
  [[ "${locked_at}" =~ ^[0-9]+$ ]] || locked_at="${now}"
  if (( now - locked_at < RECOVERY_WINDOW_SECONDS )); then
    write_status lockout attempt-limit "" "$(iso_at "$((locked_at + RECOVERY_WINDOW_SECONDS))")"
    exit 0
  fi
  rm -f -- "${LOCK_FILE}"
fi

stale_count="$(cat "${STALE_COUNT_FILE}" 2>/dev/null || printf '0')"
[[ "${stale_count}" =~ ^[0-9]+$ ]] || stale_count=0
stale_count=$((stale_count + 1))
atomic_number "${STALE_COUNT_FILE}" "${stale_count}"

# A dashboard request bypasses the observation delay. Automatic recovery waits
# for consecutive stale checks so normal tune and initialization gaps do not
# restart the vendor process.
if [[ "${manual}" != "true" && "${stale_count}" -lt "${STALE_CHECKS_BEFORE_RECOVERY}" ]]; then
  write_status requested observing-stale-stream
  exit 0
fi

# Restarting SDRconnect cannot repair an application-side readiness issue when
# the receiver stream and transport are already live.
if [[ "${stream_state}" == "live" && "${transport_state}" == "connected" ]]; then
  rm -f -- "${REQUEST_FILE}"
  write_status live receiver-stream-live
  exit 0
fi

last_attempt="$(cat "${LAST_ATTEMPT_FILE}" 2>/dev/null || printf '0')"
[[ "${last_attempt}" =~ ^[0-9]+$ ]] || last_attempt=0
cooldown_seconds="${AUTOMATIC_COOLDOWN_SECONDS}"
[[ "${manual}" == "true" ]] && cooldown_seconds="${MANUAL_COOLDOWN_SECONDS}"
if (( attempts_in_window >= MAX_RECOVERY_ATTEMPTS )); then
  atomic_number "${LOCK_FILE}" "${now}"
  write_status lockout attempt-limit "" "$(iso_at "$((now + RECOVERY_WINDOW_SECONDS))")"
  logger --tag rf-monitor-recovery "SDRconnect recovery locked after ${attempts_in_window} attempts in the bounded recovery window."
  exit 0
fi
if (( now - last_attempt < cooldown_seconds )); then
  write_status failed recovery-cooldown "$(iso_at "$((last_attempt + cooldown_seconds))")"
  exit 0
fi

printf '%s\n' "${now}" >> "${ATTEMPTS_FILE}"
attempts_in_window=$((attempts_in_window + 1))
atomic_number "${LAST_ATTEMPT_FILE}" "${now}"
atomic_number "${STALE_COUNT_FILE}" 0
write_status recovering restart-requested "" "" pending

# Keep REQUEST_FILE until live recovery is confirmed. In particular, a
# systemd start-limit rejection must not turn an accepted operator request into
# a silent no-op.
if ! systemctl restart sdrconnect-headless.service; then
  write_status failed systemd-restart-failed "$(iso_at "$((now + cooldown_seconds))")" "" failed
  logger --tag rf-monitor-recovery "SDRconnect restart was rejected; the recovery request was retained."
  exit 0
fi

for _attempt in $(seq 1 "${CONFIRM_ATTEMPTS}"); do
  if read_health && [[ "${monitoring_ready}" == "true" && "${stream_state}" == "live" ]]; then
    rm -f -- "${REQUEST_FILE}"
    write_status live recovery-confirmed "" "" success
    logger --tag rf-monitor-recovery "SDRconnect recovery completed and live RF frames resumed."
    exit 0
  fi
  sleep "${CONFIRM_INTERVAL_SECONDS}"
done

write_status failed live-confirmation-timeout "$(iso_at "$((now + cooldown_seconds))")" "" success
logger --tag rf-monitor-recovery "SDRconnect restarted, but live RF frames did not resume before the bounded confirmation timeout."
exit 0
