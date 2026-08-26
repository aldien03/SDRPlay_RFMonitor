#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID} -eq 0 ]] || { echo "Run: sudo rf-monitor uninstall" >&2; exit 1; }
STATE_FILE="${RFMON_STATE_FILE:-/etc/rf-monitor/install.conf}"
[[ -r "${STATE_FILE}" ]] || { echo "Installation state not found: ${STATE_FILE}" >&2; exit 1; }
source "${STATE_FILE}"
for protected_path in "${INSTALL_DIR:-}" "${DATA_ROOT:-}" "${CONFIG_DIR:-}"; do
  [[ "${protected_path}" = /* && "${protected_path}" != "/" && "${protected_path}" != "/opt" && "${protected_path}" != "/var" && "${protected_path}" != "/var/lib" && "${protected_path}" != "/etc" ]] || { echo "Unsafe installation path in ${STATE_FILE}: ${protected_path:-empty}" >&2; exit 1; }
done
[[ "${CONFIG_FILE:-}" = /* && "${CONFIG_FILE}" != "/" && "${CONFIG_FILE}" != "/etc" ]] || { echo "Unsafe configuration-file path in ${STATE_FILE}." >&2; exit 1; }

purge=false
[[ "${1:-}" == "--purge-data" ]] && purge=true && shift
[[ $# -eq 0 ]] || { echo "Usage: sudo rf-monitor uninstall [--purge-data]" >&2; exit 1; }

echo "RF Monitor application services will be removed."
if [[ "${purge}" == "true" ]]; then
  echo "WARNING: --purge-data permanently removes configuration and recorded evidence."
  read -r -p "Type REMOVE to continue: " answer
  [[ "${answer}" == "REMOVE" ]] || { echo "Cancelled."; exit 0; }
fi

systemctl disable --now rf-monitor.service 2>/dev/null || true
systemctl disable --now rf-monitor-sdr-recovery.timer 2>/dev/null || true
systemctl stop rf-monitor-sdr-recovery.service 2>/dev/null || true
systemctl disable --now rf-monitor-application-recovery.timer 2>/dev/null || true
systemctl stop rf-monitor-application-recovery.service 2>/dev/null || true
systemctl disable --now sdrconnect-headless.service 2>/dev/null || true
rm -f /etc/systemd/system/rf-monitor.service /etc/systemd/system/sdrconnect-headless.service /etc/systemd/system/rf-monitor-sdr-recovery.service /etc/systemd/system/rf-monitor-sdr-recovery.timer /etc/systemd/system/rf-monitor-application-recovery.service /etc/systemd/system/rf-monitor-application-recovery.timer
rm -f /usr/local/sbin/rf-monitor
systemctl daemon-reload
rm -rf -- "${INSTALL_DIR}"

if [[ "${purge}" == "true" ]]; then
  rm -rf -- "${DATA_ROOT}" "${CONFIG_DIR}"
  rm -f -- "${CONFIG_FILE}"
  echo "Application, configuration, and evidence were removed and cannot be recovered unless separately backed up."
else
  echo "Application removed. Configuration and evidence were preserved:"
  echo "  ${CONFIG_DIR}"
  echo "  ${CONFIG_FILE}"
  echo "  ${DATA_ROOT}"
fi
