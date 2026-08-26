#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${RFMON_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CONFIG_FILE="${RFMON_CONFIG_FILE:-/etc/rf-monitor.env}"
SERVICE_GROUP="${RFMON_SERVICE_GROUP:-rfmonitor}"
UNIT_DIR="${RFMON_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
STATUS_FILE="${RFMON_RECOVERY_STATUS_FILE:-/run/rf-monitor-recovery/status.json}"
EXPECTED_UNIT_OWNER="${RFMON_EXPECT_UNIT_OWNER:-root:root}"
WAIT_STATUS_SECONDS="${RFMON_WAIT_STATUS_SECONDS:-0}"
MINIMUM_STATUS_EPOCH="${RFMON_MINIMUM_STATUS_EPOCH:-0}"
STATUS_MAX_AGE_SECONDS="${RFMON_STATUS_MAX_AGE_SECONDS:-60}"
TIMER_UNIT="rf-monitor-sdr-recovery.timer"
SERVICE_UNIT="rf-monitor-sdr-recovery.service"
fail_count=0

usage() {
  cat <<'EOF'
Usage: verify-recovery-supervisor.sh [--wait-status SECONDS] [--minimum-status-epoch EPOCH]

Verifies the installed RF Monitor recovery units against the release, confirms
that systemd loaded them without drop-ins or a pending daemon reload, checks the
timer's active future trigger, and requires a fresh structured helper result.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait-status)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      WAIT_STATUS_SECONDS="$2"
      shift 2
      ;;
    --minimum-status-epoch)
      [[ -n "${2:-}" ]] || { usage >&2; exit 2; }
      MINIMUM_STATUS_EPOCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for numeric_setting in WAIT_STATUS_SECONDS MINIMUM_STATUS_EPOCH STATUS_MAX_AGE_SECONDS; do
  numeric_value="${!numeric_setting}"
  [[ "${numeric_value}" =~ ^[0-9]+$ ]] || { printf 'Invalid numeric verifier setting %s\n' "${numeric_setting}" >&2; exit 2; }
done

report_pass() { printf 'PASS  %s\n' "$*"; }
report_fail() { printf 'FAIL  %s\n' "$*"; fail_count=$((fail_count + 1)); }
sed_value() { printf '%s' "$1" | sed -e 's/[&|]/\\&/g'; }

release_timer="${INSTALL_DIR}/deploy/${TIMER_UNIT}"
release_service_template="${INSTALL_DIR}/deploy/${SERVICE_UNIT}.template"
installed_timer="${UNIT_DIR}/${TIMER_UNIT}"
installed_service="${UNIT_DIR}/${SERVICE_UNIT}"

if [[ -r "${release_timer}" ]]; then
  expected_timer_hash="$(sha256sum "${release_timer}" | awk '{print $1}')"
else
  expected_timer_hash=""
  report_fail "Recovery timer is missing from the installed release: ${release_timer}."
fi
if [[ -r "${release_service_template}" ]]; then
  expected_service_hash="$(sed \
    -e "s|@@INSTALL_DIR@@|$(sed_value "${INSTALL_DIR}")|g" \
    -e "s|@@CONFIG_FILE@@|$(sed_value "${CONFIG_FILE}")|g" \
    -e "s|@@SERVICE_GROUP@@|$(sed_value "${SERVICE_GROUP}")|g" \
    "${release_service_template}" | sha256sum | awk '{print $1}')"
else
  expected_service_hash=""
  report_fail "Recovery service template is missing from the installed release: ${release_service_template}."
fi

verify_installed_unit() {
  local label="$1" installed="$2" expected_hash="$3" actual_hash metadata
  if [[ ! -f "${installed}" || -L "${installed}" ]]; then
    report_fail "${label} is missing or is not a regular release-owned unit: ${installed}."
    return
  fi
  actual_hash="$(sha256sum "${installed}" | awk '{print $1}')"
  if [[ -n "${expected_hash}" && "${actual_hash}" == "${expected_hash}" ]]; then
    report_pass "${label} content matches this RF Monitor release."
  else
    report_fail "${label} content differs from this RF Monitor release. Re-run the installer."
  fi
  metadata="$(stat -c '%U:%G:%a' "${installed}" 2>/dev/null || true)"
  if [[ "${metadata}" == "${EXPECTED_UNIT_OWNER}:644" ]]; then
    report_pass "${label} ownership and mode are protected (${metadata})."
  else
    report_fail "${label} must be ${EXPECTED_UNIT_OWNER}:644; found ${metadata:-unreadable}."
  fi
}

verify_loaded_unit() {
  local unit="$1" expected_fragment="$2" label="$3"
  local load_state fragment need_reload drop_ins expected_real fragment_real
  load_state="$(systemctl show "${unit}" --property=LoadState --value 2>/dev/null || true)"
  fragment="$(systemctl show "${unit}" --property=FragmentPath --value 2>/dev/null || true)"
  need_reload="$(systemctl show "${unit}" --property=NeedDaemonReload --value 2>/dev/null || true)"
  drop_ins="$(systemctl show "${unit}" --property=DropInPaths --value 2>/dev/null || true)"
  expected_real="$(readlink -f "${expected_fragment}" 2>/dev/null || true)"
  fragment_real="$(readlink -f "${fragment}" 2>/dev/null || true)"
  if [[ "${load_state}" == "loaded" && -n "${expected_real}" && "${fragment_real}" == "${expected_real}" && "${need_reload}" == "no" && -z "${drop_ins}" ]]; then
    report_pass "systemd loaded the release ${label} with no pending reload or drop-ins."
  else
    report_fail "systemd did not load the exact release ${label} (load=${load_state:-unknown}, fragment=${fragment:-none}, reload=${need_reload:-unknown}, drop-ins=${drop_ins:-none})."
  fi
}

verify_installed_unit "Recovery timer" "${installed_timer}" "${expected_timer_hash}"
verify_installed_unit "Recovery service" "${installed_service}" "${expected_service_hash}"
verify_loaded_unit "${TIMER_UNIT}" "${installed_timer}" "recovery timer"
verify_loaded_unit "${SERVICE_UNIT}" "${installed_service}" "recovery service"

if systemctl is-enabled --quiet "${TIMER_UNIT}" >/dev/null 2>&1; then
  report_pass "Receiver recovery timer is enabled at boot."
else
  report_fail "Receiver recovery timer is not enabled."
fi
if systemctl is-active --quiet "${TIMER_UNIT}" >/dev/null 2>&1; then
  report_pass "Receiver recovery timer is active."
else
  report_fail "Receiver recovery timer is not active."
fi

next_run=""
next_epoch=""
for _next_attempt in 1 2 3; do
  next_run="$(systemctl show "${TIMER_UNIT}" --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
  next_epoch="$(date --date="${next_run}" +%s 2>/dev/null || true)"
  now_epoch="$(date +%s)"
  if [[ "${next_epoch}" =~ ^[0-9]+$ ]] && (( next_epoch > now_epoch )); then break; fi
  sleep 1
done
if [[ "${next_epoch}" =~ ^[0-9]+$ ]] && (( next_epoch > now_epoch )); then
  report_pass "Receiver recovery timer has a future run: ${next_run}."
else
  report_fail "Receiver recovery timer has no real future run."
fi

status_problem="no structured result"
status_deadline=$((SECONDS + WAIT_STATUS_SECONDS))
while true; do
  if [[ -f "${STATUS_FILE}" && ! -L "${STATUS_FILE}" ]] && jq -e '
    .schemaVersion == 1
    and (.state == "requested" or .state == "recovering" or .state == "live" or .state == "failed" or .state == "lockout")
    and (.reasonCode | type == "string")
    and (.observedAt | type == "string")
  ' "${STATUS_FILE}" >/dev/null 2>&1; then
    status_observed_at="$(jq -r '.observedAt' "${STATUS_FILE}")"
    status_observed_epoch="$(date --date="${status_observed_at}" +%s 2>/dev/null || true)"
    status_now_epoch="$(date +%s)"
    if [[ "${status_observed_epoch}" =~ ^[0-9]+$ ]] \
      && (( status_observed_epoch >= MINIMUM_STATUS_EPOCH )) \
      && (( status_observed_epoch <= status_now_epoch + 5 )) \
      && (( status_now_epoch - status_observed_epoch <= STATUS_MAX_AGE_SECONDS )); then
      status_problem=""
      break
    fi
    status_problem="stale or earlier than the required first trigger (${status_observed_at})"
  else
    status_problem="missing, invalid, or symlinked result at ${STATUS_FILE}"
  fi
  (( SECONDS < status_deadline )) || break
  sleep 1
done
if [[ -z "${status_problem}" ]]; then
  report_pass "Receiver recovery helper produced a fresh structured result."
else
  report_fail "Receiver recovery helper result is ${status_problem}."
fi

(( fail_count == 0 ))
