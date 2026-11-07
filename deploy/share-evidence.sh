#!/usr/bin/env bash
# Give normal users read access to incident images and reports without opening the evidence store.
#
# The service keeps writing evidence under its own protected folder. This command prepares a second
# folder that the service also writes incident images and reports into, readable by one dedicated group
# (rf-evidence-readers). It never adds anyone to the service group, which can also read the protected
# Settings secret. The service cannot write under /home (ProtectHome), so the folder lives outside it
# and a link to it is placed in the user's Documents folder.
set -Eeuo pipefail

STATE_FILE="${RFMON_STATE_FILE:-/etc/rf-monitor/install.conf}"
DEFAULT_FOLDER="/srv/rf-monitor-evidence"
READER_GROUP="rf-evidence-readers"
LINK_NAME="RF-Monitor-Evidence"
MARKER=".rf-monitor-evidence-share"

die() { echo "Error: $*" >&2; exit 1; }

usage() {
  cat <<EOT
Usage: sudo rf-monitor share-evidence [options]

Options:
  --folder /ABSOLUTE/PATH   Share folder to create (default: ${DEFAULT_FOLDER})
  --user NAME               Person who gets read access (default: the user who ran sudo)
  --source /ABSOLUTE/SOURCE Also run deploy-release from this built source, to apply the change
  --dry-run                 Show what would be done and change nothing
  --stop                    Stop sharing: remove the setting. Files already in the folder are kept.
  -h, --help                Show this help
EOT
}

FOLDER="${DEFAULT_FOLDER}"
TARGET_USER="${SUDO_USER:-}"
SOURCE=""
DRY_RUN=false
STOP=false
while (( $# > 0 )); do
  case "$1" in
    --folder) [[ -n "${2:-}" ]] || die "--folder needs a path"; FOLDER="$2"; shift 2 ;;
    --user) [[ -n "${2:-}" ]] || die "--user needs a name"; TARGET_USER="$2"; shift 2 ;;
    --source) [[ -n "${2:-}" ]] || die "--source needs a path"; SOURCE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --stop) STOP=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

[[ -r "${STATE_FILE}" ]] || die "RF Monitor installation state was not found: ${STATE_FILE}"
# Installation paths only; generated root-owned by the installer.
source "${STATE_FILE}"
SERVICE_USER="${SERVICE_USER:-rfmonitor}"
SERVICE_GROUP="${SERVICE_GROUP:-rfmonitor}"
CONFIG_FILE="${CONFIG_FILE:-/etc/rf-monitor.env}"

if [[ "${DRY_RUN}" != "true" && ${EUID} -ne 0 ]]; then
  die "Run this command with sudo: sudo rf-monitor share-evidence"
fi

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then printf 'would run:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

# The same rules as src/server/sharePath.ts and deploy/release-manager.mjs.
validate_folder() {
  local folder="$1" prefix protected
  [[ "${folder}" == /* ]] || die "The folder must be an absolute path."
  [[ "${folder}" =~ ^/[A-Za-z0-9._@/+-]+$ ]] || die "The folder may contain only letters, digits and . _ @ + - /"
  [[ "${folder}" != *"/../"* && "${folder}" != */.. && "${folder}" != *"//"* && "${folder}" != */ ]] || die "The folder must be a clean path."
  for prefix in /home /root /run/user /tmp /var/tmp /proc /sys /dev /etc /usr /boot /bin /sbin /lib /opt; do
    if [[ "${folder}" == "${prefix}" || "${folder}" == "${prefix}/"* ]]; then
      die "The folder cannot be inside ${prefix}. The service cannot write to home folders or system directories."
    fi
  done
  for protected in "${STORAGE_DIR:-}" "${DATA_ROOT:-}" "${RUNTIME_CONFIG_DIR:-}" "${INSTALL_ROOT:-}" "${CONFIG_DIR:-}"; do
    [[ -n "${protected}" ]] || continue
    if [[ "${folder}" == "${protected}" || "${folder}" == "${protected}/"* || "${protected}" == "${folder}/"* ]]; then
      die "The folder must be separate from the evidence store and RF Monitor's own folders (${protected})."
    fi
  done
}

set_env_value() {
  # Replace or add KEY=VALUE, keeping the file's owner and mode. Removes the key when VALUE is empty.
  local file="$1" key="$2" value="$3" temporary mode owner group
  [[ -f "${file}" && ! -L "${file}" ]] || die "Configuration file is missing or not a regular file: ${file}"
  if [[ "${DRY_RUN}" == "true" ]]; then
    if [[ -n "${value}" ]]; then echo "would set ${key}=${value} in ${file}"; else echo "would remove ${key} from ${file}"; fi
    return
  fi
  mode="$(stat -c '%a' "${file}")"; owner="$(stat -c '%U' "${file}")"; group="$(stat -c '%G' "${file}")"
  temporary="$(mktemp "${file}.XXXXXX")"
  grep -v -E "^${key}=" "${file}" > "${temporary}" || true
  if [[ -n "${value}" ]]; then printf '%s=%s\n' "${key}" "${value}" >> "${temporary}"; fi
  chown "${owner}:${group}" "${temporary}"
  chmod "${mode}" "${temporary}"
  mv -f "${temporary}" "${file}"
}

apply_step() {
  if [[ -n "${SOURCE}" ]]; then
    [[ "${SOURCE}" == /* && -d "${SOURCE}" && ! -L "${SOURCE}" ]] || die "--source must be an absolute, built source directory."
    echo "Applying with deploy-release (the service restarts briefly)..."
    run /usr/local/sbin/rf-monitor deploy-release "${SOURCE}"
  else
    echo
    echo "One more step applies this and restarts RF Monitor briefly:"
    echo "  sudo rf-monitor deploy-release /ABSOLUTE/BUILT/SOURCE"
  fi
}

if [[ "${STOP}" == "true" ]]; then
  set_env_value "${CONFIG_FILE}" RF_MONITOR_SHARE_DIR ""
  echo "Sharing is switched off. Files already in the share folder are kept."
  apply_step
  exit 0
fi

validate_folder "${FOLDER}"
[[ -n "${TARGET_USER}" && "${TARGET_USER}" != "root" ]] || die "Say who should get access: --user NAME (or run this with sudo from your own account)."
[[ "${TARGET_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "Unusual user name: ${TARGET_USER}"
getent passwd "${TARGET_USER}" >/dev/null || die "No such user: ${TARGET_USER}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
[[ "${TARGET_HOME}" == /* && -d "${TARGET_HOME}" ]] || die "Cannot find the home folder of ${TARGET_USER}."
PARENT="$(dirname "${FOLDER}")"
[[ -d "${PARENT}" && ! -L "${PARENT}" ]] || die "The parent folder ${PARENT} must already exist (and not be a link)."
if [[ -e "${FOLDER}" || -L "${FOLDER}" ]]; then
  [[ -d "${FOLDER}" && ! -L "${FOLDER}" ]] || die "${FOLDER} exists and is not a normal folder."
  # Never take over a folder that someone else filled.
  if [[ ! -e "${FOLDER}/${MARKER}" && -n "$(ls -A "${FOLDER}")" ]]; then
    die "${FOLDER} already exists and is not empty. Choose an empty or new folder."
  fi
fi

echo "Evidence share"
echo "  Folder:          ${FOLDER}"
echo "  Read access:     ${TARGET_USER} (through the ${READER_GROUP} group only)"
echo "  Link for you:    ${TARGET_HOME}/Documents/${LINK_NAME}"
echo

if ! getent group "${READER_GROUP}" >/dev/null; then run groupadd --system "${READER_GROUP}"; fi
run usermod -aG "${READER_GROUP}" "${TARGET_USER}"
run install -d -m 2750 -o "${SERVICE_USER}" -g "${READER_GROUP}" "${FOLDER}"
# New files and folders inherit the reader group from this setgid folder.
run chmod 2750 "${FOLDER}"
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "would create ${FOLDER}/${MARKER} owned by ${SERVICE_USER}"
else
  install -m 0640 -o "${SERVICE_USER}" -g "${READER_GROUP}" /dev/null "${FOLDER}/${MARKER}"
fi
set_env_value "${CONFIG_FILE}" RF_MONITOR_SHARE_DIR "${FOLDER}"

LINK="${TARGET_HOME}/Documents/${LINK_NAME}"
if [[ -L "${LINK}" && "$(readlink "${LINK}")" == "${FOLDER}" ]]; then
  echo "Link already in place: ${LINK}"
elif [[ -e "${LINK}" || -L "${LINK}" ]]; then
  echo "Note: ${LINK} already exists and was left as it is. The folder is ${FOLDER}."
else
  # As the person, so the link belongs to them and nothing in their home is touched as root.
  run runuser -u "${TARGET_USER}" -- mkdir -p "${TARGET_HOME}/Documents"
  run runuser -u "${TARGET_USER}" -- ln -s "${FOLDER}" "${LINK}"
fi

echo
echo "${TARGET_USER} must log out and back in once before the new group applies."
echo "Until the service is restarted below, nothing is copied to the folder yet."
apply_step
