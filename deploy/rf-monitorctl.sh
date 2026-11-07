#!/usr/bin/env bash
set -Eeuo pipefail

STATE_FILE="${RFMON_STATE_FILE:-/etc/rf-monitor/install.conf}"

usage() {
  cat <<'EOF'
RF Monitor administration

Usage: sudo rf-monitor <command>

Commands:
  access              Show dashboard address, CA fingerprint, and connection steps
  access --export DIRECTORY
                      Create a transferable operator HTTPS setup kit
  configure           Run the safe configuration wizard
  configure --advanced
                      Change infrastructure ports, storage, and SDR endpoints
  configure-web       Configure HTTPS, Nginx, and the Ubuntu firewall
  share-evidence [--folder /ABSOLUTE/PATH] [--user NAME] [--source /ABSOLUTE/SOURCE] [--dry-run] [--stop]
                      Give a normal user read access to incident images and reports
                      through a separate folder (default /srv/rf-monitor-evidence)
  deploy-release /ABSOLUTE/SOURCE
                      Stage, verify, atomically activate, and health-gate a built release
  rollback-release BUILD_ID
                      Activate a prior verified immutable release
  releases            List installed immutable releases and the active build
  verify-release BUILD_ID
                      Verify one release identity, lock, SBOM, and audit binding
  backup COMMAND ...  Run the protected backup/verify/restore tool as the service account
  doctor [--spectrum] Check the complete installation and explain failures
  commission          Run the hardware and real-spectrum acceptance check
  uninstall           Remove the application; preserve configuration and evidence
  status              Show service status
  logs [lines]        Show recent service messages (default: 100 lines)
  restart             Restart SDRconnect and RF Monitor
  reset-admin-password
                      Set a new password for protected Settings changes
  start               Start SDRconnect and RF Monitor
  stop                Stop RF Monitor and SDRconnect
  support-bundle      Create a redacted troubleshooting archive
  verify-sdr          Verify the SDRconnect JSON WebSocket API
  verify-spectrum     Verify a real binary spectrum stream
  verify-evidence [--json] [--multipart] /ABSOLUTE/DIRECTORY [...]
                      Verify extracted manifest-v1/v2 evidence offline
  version             Show the installed RF Monitor version
  help                Show this help
EOF
}

[[ -r "${STATE_FILE}" ]] || {
  echo "RF Monitor installation state was not found: ${STATE_FILE}" >&2
  echo "Run the Ubuntu installer from the project source directory." >&2
  exit 1
}

# This file contains installation paths only and is generated root-owned by the installer.
source "${STATE_FILE}"

require_root() {
  if [[ ${EUID} -ne 0 ]]; then
    echo "Run this command with sudo: sudo rf-monitor $*" >&2
    exit 1
  fi
}

config_value() {
  local key="$1" fallback="${2:-}" line value
  line="$(grep -E "^${key}=" "${CONFIG_FILE}" 2>/dev/null | tail -n 1 || true)"
  [[ -n "${line}" ]] || { printf '%s' "${fallback}"; return; }
  value="${line#*=}"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
    value="${value//\\\"/\"}"
    value="${value//\\\\/\\}"
  fi
  printf '%s' "${value}"
}

service_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

start_services() {
  if service_exists sdrconnect-headless.service; then
    systemctl start sdrconnect-headless.service
  fi
  systemctl start rf-monitor.service
}

stop_services() {
  systemctl stop rf-monitor.service || true
  if service_exists sdrconnect-headless.service; then
    systemctl stop sdrconnect-headless.service || true
  fi
}

require_immutable_layout() {
  [[ -n "${INSTALL_ROOT:-}" && "${INSTALL_DIR}" == "${INSTALL_ROOT}/active" && -d "${INSTALL_ROOT}/releases" ]] || {
    echo "This installation predates immutable releases. Re-run the installer to migrate before deploying or rolling back." >&2
    exit 1
  }
}

run_release_command() {
  local backend_port sdr_urls sdr_ports
  require_immutable_layout
  [[ "${NODE_BIN}" == "/usr/bin/node" && -x "${NODE_BIN}" ]] || { echo "Immutable deployment requires /usr/bin/node." >&2; exit 1; }
  if [[ "${1:-}" != "verify" ]]; then
    [[ -n "${TLS_CERTIFICATE:-}" && -n "${TLS_PRIVATE_KEY:-}" ]] || { echo "TLS paths are missing. Run: sudo rf-monitor configure-web" >&2; exit 1; }
  fi
  backend_port="$(config_value RF_MONITOR_PORT 8080)"
  sdr_urls="$(config_value SDRCONNECT_URLS "$(config_value SDRCONNECT_URL ws://127.0.0.1:5454/)")"
  sdr_ports="$("${NODE_BIN}" -e 'for(const value of process.argv[1].split(",")){const u=new URL(value.trim());if(["127.0.0.1","localhost","[::1]","::1"].includes(u.hostname.toLowerCase()))console.log(u.port||(u.protocol==="wss:"?"443":"80"))}' "${sdr_urls}" | paste -sd, -)"
  env \
    RFMON_INSTALL_ROOT="${INSTALL_ROOT}" \
    RFMON_RELEASES_DIR="${RELEASES_DIR:-${INSTALL_ROOT}/releases}" \
    RFMON_ACTIVE_LINK="${INSTALL_DIR}" \
    RFMON_DEPLOYMENT_RECORDS_DIR="${DEPLOYMENT_RECORDS_DIR:-${INSTALL_ROOT}/deployment-records}" \
    RFMON_CONFIG_FILE="${CONFIG_FILE}" \
    RFMON_STORAGE_DIR="${STORAGE_DIR}" \
    RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
    RFMON_NODE_BIN="${NODE_BIN}" \
    RFMON_SERVICE_USER="${SERVICE_USER}" \
    RFMON_SERVICE_GROUP="${SERVICE_GROUP}" \
    RFMON_OPS_RESTORE_STAGING_ROOT="${OPS_RESTORE_STAGING_DIR:-/var/lib/rf-monitor/restore-drills}" \
    RFMON_TLS_CERTIFICATE="${TLS_CERTIFICATE}" \
    RFMON_TLS_PRIVATE_KEY="${TLS_PRIVATE_KEY}" \
    RFMON_BACKEND_PORT="${backend_port}" \
    RFMON_SHARE_DIR="$(config_value RF_MONITOR_SHARE_DIR "")" \
    RFMON_SDRCONNECT_PORTS="${sdr_ports}" \
    RFMON_LOCAL_HEALTH_URL="http://127.0.0.1:${backend_port}/api/health" \
    "${NODE_BIN}" "${INSTALL_DIR}/deploy/release-cli.mjs" "$@"
}

command_name="${1:-help}"
shift || true

case "${command_name}" in
  help|-h|--help)
    usage
    ;;
  access)
    require_root access
    backend_port="$(config_value RF_MONITOR_PORT 8080)"
    public_url="${PUBLIC_URL:-http://127.0.0.1:${backend_port}/}"
    if [[ "${1:-}" == "--export" ]]; then
      [[ -n "${2:-}" && -z "${3:-}" ]] || { echo "Usage: sudo rf-monitor access --export /absolute/output/directory" >&2; exit 2; }
      [[ -n "${CA_CERTIFICATE:-}" ]] || { echo "A generated local CA is not configured. Organization-managed certificates do not need an RF Monitor CA kit." >&2; exit 1; }
      exec bash "${INSTALL_DIR}/deploy/create-operator-kit.sh" "${CA_CERTIFICATE}" "${public_url}" "${OPERATOR_CIDR:-not configured}" "$2"
    fi
    [[ $# -eq 0 ]] || { echo "Usage: sudo rf-monitor access [--export /absolute/output/directory]" >&2; exit 2; }
    echo "Dashboard: ${public_url}"
    if [[ -n "${CA_CERTIFICATE:-}" ]]; then
      echo "Local CA certificate: ${CA_CERTIFICATE}"
      echo "CA SHA-256 fingerprint:"
      openssl x509 -in "${CA_CERTIFICATE}" -noout -fingerprint -sha256 | sed 's/^/  /'
    fi
    echo "Allowed operator network: ${OPERATOR_CIDR:-not configured}"
    echo
    if [[ "${public_url}" == http://127.0.0.1* ]]; then
      echo "LAN HTTPS is not configured yet. Run: sudo rf-monitor configure-web"
    elif [[ -n "${CA_CERTIFICATE:-}" ]]; then
      echo "Create the beginner connection kit:"
      echo "  sudo rf-monitor access --export /home/USER/Downloads"
    else
      echo "Open the dashboard from a computer in the configured operator network."
    fi
    ;;
  configure)
    require_root configure
    advanced=false
    if [[ "${1:-}" == "--advanced" ]]; then advanced=true; shift; fi
    [[ $# -eq 0 ]] || { echo "Unknown configure option: $1" >&2; exit 1; }
    exec env RFMON_STATE_FILE="${STATE_FILE}" RFMON_ADVANCED="${advanced}" bash "${INSTALL_DIR}/deploy/configure-ubuntu.sh"
    ;;
  configure-web)
    require_root configure-web
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/configure-web.sh" "$@"
    ;;
  share-evidence)
    # The script checks for root itself, so --dry-run and --help can be tried without sudo.
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/share-evidence.sh" "$@"
    ;;
  deploy-release)
    require_root deploy-release
    [[ -n "${1:-}" && -z "${2:-}" && "${1}" = /* && -d "${1}" && ! -L "${1}" ]] \
      || { echo "Usage: sudo rf-monitor deploy-release /absolute/built/source" >&2; exit 2; }
    run_release_command deploy --source "${1}"
    install -m 0755 -o root -g root "${INSTALL_DIR}/deploy/rf-monitorctl.sh" /usr/local/sbin/rf-monitor
    ;;
  rollback-release)
    require_root rollback-release
    [[ -n "${1:-}" && -z "${2:-}" && "${1}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$ ]] \
      || { echo "Usage: sudo rf-monitor rollback-release BUILD_ID" >&2; exit 2; }
    run_release_command rollback --release "${1}"
    install -m 0755 -o root -g root "${INSTALL_DIR}/deploy/rf-monitorctl.sh" /usr/local/sbin/rf-monitor
    ;;
  releases)
    require_root releases
    require_immutable_layout
    active_target="$(readlink -f "${INSTALL_DIR}" 2>/dev/null || true)"
    for release_path in "${RELEASES_DIR:-${INSTALL_ROOT}/releases}"/*; do
      [[ -d "${release_path}" && ! -L "${release_path}" ]] || continue
      release_name="${release_path##*/}"
      if ! run_release_command verify --release "${release_name}" >/dev/null 2>&1; then
        printf 'INVALID %s\n' "${release_name}"
      elif [[ "${release_path}" == "${active_target}" ]]; then
        printf 'ACTIVE  %s\n' "${release_name}"
      else
        printf 'READY   %s\n' "${release_name}"
      fi
    done
    ;;
  verify-release)
    require_root verify-release
    [[ -n "${1:-}" && -z "${2:-}" && "${1}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$ ]] \
      || { echo "Usage: sudo rf-monitor verify-release BUILD_ID" >&2; exit 2; }
    run_release_command verify --release "${1}" >/dev/null
    echo "Release verified: ${1}"
    ;;
  backup)
    require_root backup
    [[ $# -ge 1 ]] || { echo "Usage: sudo rf-monitor backup {create|verify|restore|status} [options]" >&2; exit 2; }
    [[ -x /usr/sbin/runuser ]] || { echo "The system privilege-drop tool is missing: /usr/sbin/runuser" >&2; exit 1; }
    backup_entry="${INSTALL_DIR}/deploy/rf-monitor-backup.sh"
    [[ -f "${backup_entry}" && ! -L "${backup_entry}" ]] \
      || { echo "RF Monitor backup entry point is missing or unsafe. Verify the active release." >&2; exit 1; }
    exec /usr/sbin/runuser -u "${SERVICE_USER}" -- env \
      RFMON_INSTALL_DIR="${INSTALL_DIR}" \
      /bin/bash "${backup_entry}" "$@"
    ;;
  commission)
    require_root commission
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/doctor.sh" --spectrum
    ;;
  uninstall)
    require_root uninstall
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/uninstall-ubuntu.sh" "$@"
    ;;
  doctor)
    require_root doctor
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/doctor.sh" "$@"
    ;;
  status)
    systemctl --no-pager --full status rf-monitor.service || true
    if service_exists sdrconnect-headless.service; then
      systemctl --no-pager --full status sdrconnect-headless.service || true
    fi
    ;;
  logs)
    lines="${1:-100}"
    [[ "${lines}" =~ ^[0-9]+$ ]] || { echo "The line count must be a whole number." >&2; exit 1; }
    journalctl -u rf-monitor.service -u sdrconnect-headless.service -n "${lines}" --no-pager
    ;;
  restart)
    require_root restart
    stop_services
    start_services
    echo "Services restarted. Run: sudo rf-monitor doctor"
    ;;
  reset-admin-password)
    require_root reset-admin-password
    credential_file="${ADMIN_FILE:-${CONFIG_DIR}/admin.json}"
    credential_cli="${INSTALL_DIR}/dist/server-node/admin-credential.js"
    [[ -x "${NODE_BIN}" && -f "${credential_cli}" ]] || { echo "RF Monitor credential tool is missing. Re-run the installer." >&2; exit 1; }
    password_file=""
    if [[ "${1:-}" == "--password-file" ]]; then
      password_file="${2:-}"
      [[ -n "${password_file}" && "${password_file}" = /* && -f "${password_file}" && ! -L "${password_file}" ]] \
        || { echo "--password-file must name an absolute, regular, non-symlink file." >&2; exit 1; }
    elif [[ -n "${1:-}" ]]; then
      echo "Unknown reset-admin-password option: ${1}" >&2
      exit 1
    fi
    umask 077
    temporary_credential="$(mktemp)"
    trap 'rm -f "${temporary_credential}"' EXIT
    if [[ -n "${password_file}" ]]; then
      "${NODE_BIN}" "${credential_cli}" < "${password_file}" > "${temporary_credential}"
    else
      read -r -s -p "New Settings password (12-128 characters): " settings_password
      printf '\n'
      read -r -s -p "Repeat the Settings password: " settings_password_repeat
      printf '\n'
      [[ "${settings_password}" == "${settings_password_repeat}" ]] || { unset settings_password settings_password_repeat; echo "Passwords did not match." >&2; exit 1; }
      printf '%s' "${settings_password}" | "${NODE_BIN}" "${credential_cli}" > "${temporary_credential}"
      unset settings_password settings_password_repeat
    fi
    install -d -m 0750 -o root -g "${SERVICE_GROUP}" "$(dirname "${credential_file}")"
    if [[ -f "${credential_file}" ]]; then
      cp -a "${credential_file}" "${credential_file}.backup-$(date --utc +%Y%m%dT%H%M%SZ)"
    fi
    install -m 0640 -o root -g "${SERVICE_GROUP}" "${temporary_credential}" "${credential_file}"
    rm -f "${temporary_credential}"
    trap - EXIT
    if systemctl is-active --quiet rf-monitor.service 2>/dev/null; then systemctl restart rf-monitor.service; fi
    echo "Settings password updated. Existing browser Settings sessions were invalidated."
    ;;
  start)
    require_root start
    start_services
    ;;
  stop)
    require_root stop
    stop_services
    ;;
  support-bundle)
    require_root support-bundle
    exec env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/support-bundle.sh"
    ;;
  verify-sdr|verify-spectrum)
    require_root "${command_name}"
    [[ -x /usr/sbin/runuser ]] || { echo "The system privilege-drop tool is missing: /usr/sbin/runuser" >&2; exit 1; }
    sdr_url="$(config_value SDRCONNECT_URL ws://127.0.0.1:5454/)"
    device_index="$(config_value SDRCONNECT_DEVICE_INDEX 0)"
    verify_arguments=()
    if [[ "${command_name}" == "verify-spectrum" ]]; then
      if [[ "${1:-}" != "--yes" ]]; then
        read -r -p "This test starts the selected SDR stream for up to 10 seconds. Continue? [y/N]: " answer
        [[ "${answer}" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 0; }
      fi
      verify_arguments+=(--spectrum)
    fi
    /usr/sbin/runuser -u "${SERVICE_USER}" -- env \
      SDRCONNECT_URL="${sdr_url}" \
      SDRCONNECT_DEVICE_INDEX="${device_index}" \
      "${NODE_BIN}" "${INSTALL_DIR}/scripts/verify-sdrconnect.mjs" "${verify_arguments[@]}"
    ;;
  verify-evidence)
    [[ $# -ge 1 ]] || { echo "Usage: sudo rf-monitor verify-evidence [--json] [--multipart] /ABSOLUTE/DIRECTORY [...]" >&2; exit 2; }
    verifier_cli="${INSTALL_DIR}/dist/server-node/evidence-verifier.js"
    [[ -x "${NODE_BIN}" && -f "${verifier_cli}" ]] || { echo "RF Monitor evidence verifier is missing. Re-run the installer." >&2; exit 1; }
    verifier_arguments=()
    evidence_target_count=0
    for argument in "$@"; do
      case "${argument}" in
        --json|--multipart)
          verifier_arguments+=("${argument}")
          ;;
        -*)
          echo "Unknown verify-evidence option: ${argument}" >&2
          exit 2
          ;;
        *)
          [[ "${argument}" = /* && -d "${argument}" && ! -L "${argument}" ]] || {
            echo "Evidence targets must be existing absolute, non-symlink directories: ${argument}" >&2
            exit 2
          }
          verifier_arguments+=("${argument}")
          evidence_target_count=$((evidence_target_count + 1))
          ;;
      esac
    done
    (( evidence_target_count > 0 )) || { echo "At least one evidence directory is required." >&2; exit 2; }
    exec "${NODE_BIN}" "${verifier_cli}" "${verifier_arguments[@]}"
    ;;
  version)
    "${NODE_BIN}" -p "require('${INSTALL_DIR}/package.json').version"
    ;;
  *)
    echo "Unknown command: ${command_name}" >&2
    usage >&2
    exit 1
    ;;
esac
