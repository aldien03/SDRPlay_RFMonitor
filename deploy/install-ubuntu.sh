#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${RFMON_INSTALL_ROOT:-/opt/rf-monitor}"
INSTALL_DIR="${RFMON_INSTALL_DIR:-${INSTALL_ROOT}/active}"
RELEASES_DIR="${RFMON_RELEASES_DIR:-${INSTALL_ROOT}/releases}"
DEPLOYMENT_RECORDS_DIR="${RFMON_DEPLOYMENT_RECORDS_DIR:-${INSTALL_ROOT}/deployment-records}"
DATA_ROOT="${RFMON_DATA_ROOT:-/var/lib/rf-monitor}"
STORAGE_DIR="${RFMON_STORAGE_DIR:-${DATA_ROOT}/evidence}"
RUNTIME_CONFIG_DIR="${RFMON_RUNTIME_CONFIG_DIR:-${DATA_ROOT}/config}"
CONFIG_DIR="${RFMON_CONFIG_DIR:-/etc/rf-monitor}"
CONFIG_FILE="${RFMON_CONFIG_FILE:-/etc/rf-monitor.env}"
STATE_FILE="${RFMON_STATE_FILE:-${CONFIG_DIR}/install.conf}"
CATALOG_FILE="${RFMON_CATALOG_FILE:-${CONFIG_DIR}/catalog.json}"
OPERATIONAL_FILE="${RFMON_OPERATIONAL_FILE:-${RUNTIME_CONFIG_DIR}/operational.json}"
ADMIN_FILE="${RFMON_ADMIN_FILE:-${CONFIG_DIR}/admin.json}"
OPS_CONFIG_FILE="/etc/rf-monitor/ops.conf"
OPS_RESTORE_STAGING_DIR="${RFMON_OPS_RESTORE_STAGING_DIR:-${DATA_ROOT}/restore-drills}"
SERVICE_USER="${RFMON_SERVICE_USER:-rfmonitor}"
SERVICE_GROUP="${RFMON_SERVICE_GROUP:-rfmonitor}"
SDRCONNECT_BIN="${RFMON_SDRCONNECT_BIN:-/opt/sdrconnect/SDRconnect_headless}"
SDR_STATE_DIR="${RFMON_SDR_STATE_DIR:-${DATA_ROOT}/sdrconnect}"
NODE_BIN="${RFMON_NODE_BIN:-/usr/bin/node}"
NPM_BIN="${RFMON_NPM_BIN:-/usr/bin/npm}"
NONINTERACTIVE="${RFMON_NONINTERACTIVE:-false}"
LEGACY_SNAPSHOT="${RFMON_LEGACY_SNAPSHOT:-}"
# Keep the migration bundle as installer-local state. Child processes (including
# the mandatory test suite) must not inherit a deployment-specific snapshot and
# accidentally change their own isolated legacy-install fixtures.
unset RFMON_LEGACY_SNAPSHOT
RELEASE_DIR=""
RELEASE_BUILD_ID=""
provisional_active=false
legacy_migration=false

if [[ ${EUID} -eq 0 ]]; then
  echo "Do not run the complete installer with sudo or from a root shell." >&2
  echo "Sign in as the normal Ubuntu user and run: bash deploy/install-ubuntu.sh" >&2
  exit 1
fi
command -v sudo >/dev/null || { echo "sudo is required." >&2; exit 1; }
SUDO=(sudo)

say() { printf '\n==== %s ====\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
privileged() { "${SUDO[@]}" "$@"; }
read_protected_config_value() {
  local key="$1"
  privileged bash -c 'source "$1"; printf "%s" "${!2:-}"' _ "${CONFIG_FILE}" "${key}"
}
run_as_login_user() {
  "$@"
}
confirm() {
  local prompt="$1" default_yes="${2:-true}" answer=""
  if [[ "${NONINTERACTIVE}" == "true" ]]; then [[ "${default_yes}" == "true" ]]; return; fi
  if [[ "${default_yes}" == "true" ]]; then read -r -p "${prompt} [Y/n]: " answer; [[ ! "${answer:-Y}" =~ ^[Nn]$ ]];
  else read -r -p "${prompt} [y/N]: " answer; [[ "${answer}" =~ ^[Yy]$ ]]; fi
}
sed_value() { printf '%s' "$1" | sed -e 's/[&|]/\\&/g'; }

[[ "${INSTALL_ROOT}" = /* && "${INSTALL_DIR}" = /* && "${RELEASES_DIR}" = /* && "${DATA_ROOT}" = /* && "${RUNTIME_CONFIG_DIR}" = /* && "${CONFIG_DIR}" = /* && "${OPS_RESTORE_STAGING_DIR}" = /* ]] || die "Installation paths must be absolute."
[[ "${NODE_BIN}" = /* && "${NPM_BIN}" = /* ]] || die "Node.js and npm paths must be absolute."
if [[ -n "${LEGACY_SNAPSHOT}" ]]; then
  [[ "${LEGACY_SNAPSHOT}" = /* && "${LEGACY_SNAPSHOT}" != *[[:space:]]* ]] || die "RFMON_LEGACY_SNAPSHOT must be a specific absolute path without whitespace."
fi
[[ "${INSTALL_ROOT}${INSTALL_DIR}${DATA_ROOT}${STORAGE_DIR}${RUNTIME_CONFIG_DIR}${CONFIG_DIR}${CONFIG_FILE}${OPS_RESTORE_STAGING_DIR}" != *[[:space:]]* ]] || die "Installation paths cannot contain whitespace."
[[ "$(readlink -m -- "${OPS_RESTORE_STAGING_DIR}")" != "$(readlink -m -- "${STORAGE_DIR}")" \
  && "$(readlink -m -- "${OPS_RESTORE_STAGING_DIR}")" != "$(readlink -m -- "${STORAGE_DIR}")/"* ]] \
  || die "Restore-drill staging must remain outside evidence storage."
[[ "${INSTALL_DIR}" == "${INSTALL_ROOT}/active" && "${RELEASES_DIR}" == "${INSTALL_ROOT}/releases" ]] \
  || die "Immutable deployment requires INSTALL_DIR=${INSTALL_ROOT}/active and RELEASES_DIR=${INSTALL_ROOT}/releases."
resolved_install_root="$(readlink -m -- "${INSTALL_ROOT}")"
[[ "${SOURCE_DIR}" != "${resolved_install_root}" && "${SOURCE_DIR}" != "${resolved_install_root}/"* ]] \
  || die "Build source must remain outside the installation root: ${INSTALL_ROOT}"
if [[ -e "${INSTALL_DIR}" && ! -L "${INSTALL_DIR}" ]]; then
  echo "ERROR: Active release path is not an immutable symbolic link: ${INSTALL_DIR}" >&2
  echo "No installation changes were made. Preserve the current path and service for an approved migration." >&2
  exit 1
fi
if [[ -L "${INSTALL_DIR}" ]]; then
  existing_active_target="$(readlink -f -- "${INSTALL_DIR}" 2>/dev/null || true)"
  if [[ -z "${existing_active_target}" || "$(dirname -- "${existing_active_target}")" != "${RELEASES_DIR}" \
    || ! -f "${existing_active_target}/dist/release.json" \
    || ! -f "${existing_active_target}/deployment/release-manifest.json" ]]; then
    echo "ERROR: Active release link is broken, outside the release directory, or unverified: ${INSTALL_DIR}" >&2
    echo "No installation changes were made. Preserve the link and current service for review." >&2
    exit 1
  fi
fi
if [[ ! -e "${INSTALL_DIR}" && ! -L "${INSTALL_DIR}" && -d "${INSTALL_ROOT}" ]]; then
  if [[ -f "${INSTALL_ROOT}/package.json" || -d "${INSTALL_ROOT}/dist" || -f "${INSTALL_ROOT}/deploy/rf-monitor.service.template" ]]; then
    if [[ ! -f "${INSTALL_ROOT}/dist/release.json" || -L "${INSTALL_ROOT}/dist/release.json" ]]; then
      if [[ -z "${LEGACY_SNAPSHOT}" ]]; then
        echo "ERROR: Existing RF Monitor files have no verifiable release identity: ${INSTALL_ROOT}" >&2
        echo "No installation changes were made. Preserve this directory and the current service." >&2
        echo "Stop: capture and verify the exact installed package with deploy/legacy-install-snapshot.mjs, then rerun with RFMON_LEGACY_SNAPSHOT=/absolute/sealed/bundle. Do not delete the existing files to bypass this check." >&2
        exit 1
      fi
      legacy_migration=true
      echo "Legacy installation detected. Root verification of the sealed rollback snapshot is required before any system change."
    fi
  fi
fi

sudo -v

if [[ "${legacy_migration}" == "true" ]]; then
  legacy_preflight_output="$(privileged "${NODE_BIN}" "${SOURCE_DIR}/deploy/legacy-install-snapshot.mjs" verify-current \
    --bundle "${LEGACY_SNAPSHOT}" \
    --source "${INSTALL_ROOT}" \
    --unit /etc/systemd/system/rf-monitor.service \
    --config "${CONFIG_FILE}" \
    --candidate-root "${SOURCE_DIR}" \
    --health-url http://127.0.0.1:8080/api/health 2>&1)" \
    || { printf '%s\n' "${legacy_preflight_output:-Legacy migration preflight failed.}" >&2; die "No system changes were made; the sealed legacy state or live receiver did not match."; }
  printf '%s\n' "${legacy_preflight_output}"
fi

if [[ -n "${existing_active_target:-}" ]]; then
  [[ -x "${NODE_BIN}" ]] \
    || die "The existing immutable release cannot be verified before system changes because ${NODE_BIN} is unavailable. Preserve the installation and install the approved system runtime separately."
  existing_release_id="$(basename -- "${existing_active_target}")"
  existing_verification_output="$(privileged env \
    RFMON_INSTALL_ROOT="${INSTALL_ROOT}" \
    RFMON_RELEASES_DIR="${RELEASES_DIR}" \
    RFMON_ACTIVE_LINK="${INSTALL_DIR}" \
    RFMON_DEPLOYMENT_RECORDS_DIR="${DEPLOYMENT_RECORDS_DIR}" \
    RFMON_CONFIG_FILE="${CONFIG_FILE}" \
    RFMON_STORAGE_DIR="${STORAGE_DIR}" \
    RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
    RFMON_NODE_BIN="${NODE_BIN}" \
    RFMON_SERVICE_USER="${SERVICE_USER}" \
    RFMON_SERVICE_GROUP="${SERVICE_GROUP}" \
    "${NODE_BIN}" "${SOURCE_DIR}/deploy/release-cli.mjs" verify --release "${existing_release_id}" 2>&1)" \
    || { printf '%s\n' "${existing_verification_output}" >&2; die "The active release failed immutable verification before system changes. Preserve it and use the approved migration procedure."; }
fi

say "Checking Ubuntu"
[[ -r /etc/os-release ]] || die "This installer requires Ubuntu 24.04."
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || die "This installer supports Ubuntu 24.04 only. Found ${PRETTY_NAME:-unknown Linux}."
echo "Operating system: ${PRETTY_NAME}"
echo "Architecture: $(dpkg --print-architecture)"

say "Installing operating-system tools"
privileged apt-get update
privileged apt-get install -y ca-certificates curl jq netcat-openbsd nginx openssl python3 rsync ufw unzip usbutils

nginx_default_site="/etc/nginx/sites-enabled/default"
if privileged test -L "${nginx_default_site}" \
  && [[ "$(privileged readlink -f "${nginx_default_site}")" == "/etc/nginx/sites-available/default" ]]; then
  privileged rm -f "${nginx_default_site}"
fi
if ! privileged find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  privileged systemctl stop nginx.service
fi

node_supported=false
if [[ -x "${NODE_BIN}" ]]; then
  node_major="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 20 )) && node_supported=true
fi

if [[ "${node_supported}" != "true" ]]; then
  say "Installing system Node.js"
  [[ "${NODE_BIN}" == "/usr/bin/node" && "${NPM_BIN}" == "/usr/bin/npm" ]] \
    || die "The configured system Node.js runtime is missing or too old: ${NODE_BIN}. Install Node.js 20 or newer there, or remove the RFMON_NODE_BIN/RFMON_NPM_BIN overrides."
  node_candidate="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')"
  node_candidate_major="$(printf '%s' "${node_candidate}" | sed -n 's/^[0-9]*:\([0-9][0-9]*\).*/\1/p; t; s/^\([0-9][0-9]*\).*/\1/p')"
  if [[ ! "${node_candidate}" =~ ^[A-Za-z0-9.+:~_-]+$ || ! "${node_candidate_major}" =~ ^[0-9]+$ || "${node_candidate}" == "(none)" || "${node_candidate_major}" -lt 20 ]]; then
    die "No approved Node.js 20+ package is available from this host's configured signed APT repositories. Ask the site administrator to configure an approved signed repository, then rerun. RF Monitor will not execute a downloaded setup script."
  fi
  if confirm "Install the signed Node.js package ${node_candidate} from the already configured APT repository?" true; then
    privileged apt-get install -y "nodejs=${node_candidate}"
  else
    die "Node.js 20 or newer is required at /usr/bin/node. Install the approved system package and run this installer again."
  fi
fi
[[ -x "${NODE_BIN}" ]] || die "The system Node.js executable is missing: ${NODE_BIN}"
[[ -x "${NPM_BIN}" ]] || die "The system npm executable is missing: ${NPM_BIN}"
node_major="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 20 )) \
  || die "The system Node.js runtime at ${NODE_BIN} must be version 20 or newer."
echo "Node.js: $("${NODE_BIN}" --version) at ${NODE_BIN}"
echo "npm: $(env PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin" "${NPM_BIN}" --version) at ${NPM_BIN}"
active_node="$(command -v node 2>/dev/null || true)"
if [[ -n "${active_node}" && "${active_node}" != "${NODE_BIN}" ]]; then
  echo "Note: the current shell uses ${active_node}; RF Monitor services will use the system runtime ${NODE_BIN}."
fi

if [[ ! -x "${SDRCONNECT_BIN}" ]]; then
  say "SDRconnect required"
  echo "SDRconnect was not found at ${SDRCONNECT_BIN}."
  echo "Install a versioned SDRconnect release from site-approved media and verify its published signature or checksum before running it."
  echo "Stop: RF Monitor does not download or execute a mutable vendor installer. Rerun this installer after ${SDRCONNECT_BIN} exists."
fi
if [[ -x "${SDRCONNECT_BIN}" ]]; then
  echo "SDRconnect headless: ${SDRCONNECT_BIN}"
else
  echo "WARNING: SDRconnect is still missing. RF Monitor will install, but hardware monitoring cannot become ready until SDRconnect is installed."
fi

say "Building and testing RF Monitor"
cd "${SOURCE_DIR}"
env PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin" "${NPM_BIN}" ci
# Installation is a release gate, not an interactive development loop. Run
# test files with one worker so concurrent fsync/export fixtures cannot exhaust
# each other's bounded timeouts on a busy field host.
env PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin" "${NPM_BIN}" run check -- --maxWorkers=1
env PATH="$(dirname "${NODE_BIN}"):/usr/bin:/bin" "${NPM_BIN}" run build

say "Creating the protected service account and directories"
privileged groupadd --system --force "${SERVICE_GROUP}"
if ! getent passwd "${SERVICE_USER}" >/dev/null; then
  privileged useradd --system --gid "${SERVICE_GROUP}" --home-dir "${DATA_ROOT}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  privileged usermod --home "${DATA_ROOT}" --gid "${SERVICE_GROUP}" "${SERVICE_USER}"
fi
privileged groupadd --force plugdev
privileged usermod --append --groups plugdev "${SERVICE_USER}"
if ! privileged /usr/sbin/runuser -u "${SERVICE_USER}" -- "${NODE_BIN}" --version >/dev/null 2>&1; then
  die "The RF Monitor service account cannot execute ${NODE_BIN}. Use a system-wide Node.js installation such as /usr/bin/node; do not use an NVM path inside a user's home directory."
fi
privileged install -d -m 0755 -o root -g root "${INSTALL_ROOT}" "${RELEASES_DIR}"
privileged install -d -m 0750 -o root -g root "${DEPLOYMENT_RECORDS_DIR}"
privileged install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" "${DATA_ROOT}" "${STORAGE_DIR}" "${SDR_STATE_DIR}" "${RUNTIME_CONFIG_DIR}"
privileged install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${CONFIG_DIR}"
privileged install -d -m 0750 -o root -g "${SERVICE_GROUP}" "${OPS_RESTORE_STAGING_DIR}"

say "Installing application files"
if ! privileged test -e "${CONFIG_FILE}"; then
  # Staging verifies that configuration and evidence live outside releases.
  # The guided configuration replaces this empty protected placeholder before
  # activation.
  privileged install -m 0600 -o root -g root /dev/null "${CONFIG_FILE}"
fi
if privileged test -L "${INSTALL_DIR}" && ! privileged test -e "${INSTALL_DIR}"; then
  die "The active release link is broken: ${INSTALL_DIR}. Preserve it and inspect the prior deployment before retrying."
fi
if ! privileged test -e "${INSTALL_DIR}" && ! privileged test -L "${INSTALL_DIR}" \
  && { privileged test -f "${INSTALL_ROOT}/package.json" || privileged test -d "${INSTALL_ROOT}/dist"; }; then
  if [[ "${legacy_migration}" == "true" ]]; then
    echo "Preserved sealed legacy rollback snapshot: ${LEGACY_SNAPSHOT}"
  else
    [[ -f "${INSTALL_ROOT}/dist/release.json" && -f "${INSTALL_ROOT}/deploy/rf-monitor.service.template" ]] \
      || die "A legacy package exists in ${INSTALL_ROOT} but has no verifiable release identity/template. Preserve it and capture it with deploy/legacy-install-snapshot.mjs before migration."
    say "Importing the verified prior package for rollback"
    legacy_stage_output="$(privileged env \
      RFMON_INSTALL_ROOT="${INSTALL_ROOT}" \
      RFMON_RELEASES_DIR="${RELEASES_DIR}" \
      RFMON_ACTIVE_LINK="${INSTALL_DIR}" \
      RFMON_DEPLOYMENT_RECORDS_DIR="${DEPLOYMENT_RECORDS_DIR}" \
      RFMON_CONFIG_FILE="${CONFIG_FILE}" \
      RFMON_STORAGE_DIR="${STORAGE_DIR}" \
      RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
      RFMON_NODE_BIN="${NODE_BIN}" \
      RFMON_SERVICE_USER="${SERVICE_USER}" \
      RFMON_SERVICE_GROUP="${SERVICE_GROUP}" \
      "${NODE_BIN}" "${SOURCE_DIR}/deploy/release-cli.mjs" stage --source "${INSTALL_ROOT}")" \
      || { printf '%s\n' "${legacy_stage_output:-Prior-package import failed.}" >&2; die "The existing package could not be preserved as a verified rollback release."; }
    legacy_release_dir="$(printf '%s' "${legacy_stage_output}" | jq -r '.releaseDirectory')"
    legacy_release_id="$(printf '%s' "${legacy_stage_output}" | jq -r '.release.buildId')"
    [[ "${legacy_release_dir}" == "${RELEASES_DIR}/${legacy_release_id}" && -d "${legacy_release_dir}" ]] \
      || die "Prior-package import returned an unsafe release path."
    privileged ln -s "releases/${legacy_release_id}" "${INSTALL_DIR}"
    echo "Preserved rollback release: ${legacy_release_id}"
  fi
fi
stage_output="$(privileged env \
  RFMON_INSTALL_ROOT="${INSTALL_ROOT}" \
  RFMON_RELEASES_DIR="${RELEASES_DIR}" \
  RFMON_ACTIVE_LINK="${INSTALL_DIR}" \
  RFMON_DEPLOYMENT_RECORDS_DIR="${DEPLOYMENT_RECORDS_DIR}" \
  RFMON_CONFIG_FILE="${CONFIG_FILE}" \
  RFMON_STORAGE_DIR="${STORAGE_DIR}" \
  RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
  RFMON_NODE_BIN="${NODE_BIN}" \
  RFMON_SERVICE_USER="${SERVICE_USER}" \
  RFMON_SERVICE_GROUP="${SERVICE_GROUP}" \
  "${NODE_BIN}" "${SOURCE_DIR}/deploy/release-cli.mjs" stage --source "${SOURCE_DIR}")" \
  || { printf '%s\n' "${stage_output:-Release staging failed.}" >&2; die "Immutable release staging failed."; }
RELEASE_DIR="$(printf '%s' "${stage_output}" | jq -r '.releaseDirectory')"
RELEASE_BUILD_ID="$(printf '%s' "${stage_output}" | jq -r '.release.buildId')"
[[ "${RELEASE_DIR}" == "${RELEASES_DIR}/${RELEASE_BUILD_ID}" && -d "${RELEASE_DIR}" ]] \
  || die "Release staging returned an unsafe release path."
if [[ "${legacy_migration}" != "true" ]] && ! privileged test -e "${INSTALL_DIR}" && ! privileged test -L "${INSTALL_DIR}"; then
  privileged ln -s "releases/${RELEASE_BUILD_ID}" "${INSTALL_DIR}"
  provisional_active=true
fi
echo "Staged immutable release: ${RELEASE_BUILD_ID}"
if [[ ! -f "${CATALOG_FILE}" ]]; then
  privileged install -m 0640 -o root -g "${SERVICE_GROUP}" "${RELEASE_DIR}/config/band-catalog.example.json" "${CATALOG_FILE}"
else
  privileged install -m 0640 -o root -g "${SERVICE_GROUP}" "${RELEASE_DIR}/config/band-catalog.example.json" "${CONFIG_DIR}/catalog.vendor-$(date --utc +%Y%m%dT%H%M%SZ).json"
fi

say "Recording installation paths"
existing_public_url=""
existing_operator_cidr=""
existing_ca_certificate=""
existing_tls_certificate=""
existing_tls_private_key=""
existing_journal_max_mib="512"
existing_journal_keep_free_mib="1024"
existing_journal_retention_days="14"
if privileged test -r "${STATE_FILE}"; then
  existing_public_url="$(privileged bash -c 'source "$1"; printf "%s" "${PUBLIC_URL:-}"' _ "${STATE_FILE}")"
  existing_operator_cidr="$(privileged bash -c 'source "$1"; printf "%s" "${OPERATOR_CIDR:-}"' _ "${STATE_FILE}")"
  existing_ca_certificate="$(privileged bash -c 'source "$1"; printf "%s" "${CA_CERTIFICATE:-}"' _ "${STATE_FILE}")"
  existing_tls_certificate="$(privileged bash -c 'source "$1"; printf "%s" "${TLS_CERTIFICATE:-}"' _ "${STATE_FILE}")"
  existing_tls_private_key="$(privileged bash -c 'source "$1"; printf "%s" "${TLS_PRIVATE_KEY:-}"' _ "${STATE_FILE}")"
  existing_journal_max_mib="$(privileged bash -c 'source "$1"; printf "%s" "${JOURNAL_MAX_USE_MIB:-512}"' _ "${STATE_FILE}")"
  existing_journal_keep_free_mib="$(privileged bash -c 'source "$1"; printf "%s" "${JOURNAL_KEEP_FREE_MIB:-1024}"' _ "${STATE_FILE}")"
  existing_journal_retention_days="$(privileged bash -c 'source "$1"; printf "%s" "${JOURNAL_RETENTION_DAYS:-14}"' _ "${STATE_FILE}")"
fi
state_temporary="$(mktemp)"
{
  printf 'INSTALL_ROOT=%q\n' "${INSTALL_ROOT}"
  printf 'INSTALL_DIR=%q\n' "${INSTALL_DIR}"
  printf 'RELEASES_DIR=%q\n' "${RELEASES_DIR}"
  printf 'DEPLOYMENT_RECORDS_DIR=%q\n' "${DEPLOYMENT_RECORDS_DIR}"
  printf 'DATA_ROOT=%q\n' "${DATA_ROOT}"
  printf 'STORAGE_DIR=%q\n' "${STORAGE_DIR}"
  printf 'RUNTIME_CONFIG_DIR=%q\n' "${RUNTIME_CONFIG_DIR}"
  printf 'CONFIG_DIR=%q\n' "${CONFIG_DIR}"
  printf 'CONFIG_FILE=%q\n' "${CONFIG_FILE}"
  printf 'CATALOG_FILE=%q\n' "${CATALOG_FILE}"
  printf 'OPERATIONAL_FILE=%q\n' "${OPERATIONAL_FILE}"
  printf 'ADMIN_FILE=%q\n' "${ADMIN_FILE}"
  printf 'OPS_CONFIG_FILE=%q\n' "${OPS_CONFIG_FILE}"
  printf 'OPS_RESTORE_STAGING_DIR=%q\n' "${OPS_RESTORE_STAGING_DIR}"
  printf 'SERVICE_USER=%q\n' "${SERVICE_USER}"
  printf 'SERVICE_GROUP=%q\n' "${SERVICE_GROUP}"
  printf 'NODE_BIN=%q\n' "${NODE_BIN}"
  printf 'NPM_BIN=%q\n' "${NPM_BIN}"
  printf 'SDRCONNECT_BIN=%q\n' "${SDRCONNECT_BIN}"
  printf 'SDR_STATE_DIR=%q\n' "${SDR_STATE_DIR}"
  printf 'PUBLIC_URL=%q\n' "${existing_public_url:-http://127.0.0.1:8080/}"
  printf 'OPERATOR_CIDR=%q\n' "${existing_operator_cidr}"
  printf 'CA_CERTIFICATE=%q\n' "${existing_ca_certificate}"
  printf 'TLS_CERTIFICATE=%q\n' "${existing_tls_certificate}"
  printf 'TLS_PRIVATE_KEY=%q\n' "${existing_tls_private_key}"
  printf 'JOURNAL_CONFIG_FILE=%q\n' "/etc/systemd/journald.conf.d/rf-monitor.conf"
  printf 'JOURNAL_MAX_USE_MIB=%q\n' "${existing_journal_max_mib}"
  printf 'JOURNAL_KEEP_FREE_MIB=%q\n' "${existing_journal_keep_free_mib}"
  printf 'JOURNAL_RETENTION_DAYS=%q\n' "${existing_journal_retention_days}"
} > "${state_temporary}"
privileged install -m 0644 -o root -g root "${state_temporary}" "${STATE_FILE}"
rm -f "${state_temporary}"
if [[ "${legacy_migration}" == "true" ]] && ! privileged test -s "${ADMIN_FILE}"; then
  die "The protected legacy Settings credential is missing or empty; preserve the live service and repair the sealed migration inputs before cutover."
elif ! privileged test -r "${ADMIN_FILE}"; then
  say "Creating the Settings password"
  if [[ "${NONINTERACTIVE}" == "true" ]]; then
    [[ -n "${RFMON_ADMIN_PASSWORD_FILE:-}" ]] || die "Unattended installation requires RFMON_ADMIN_PASSWORD_FILE pointing to a protected one-line password file."
    privileged env RFMON_STATE_FILE="${STATE_FILE}" bash "${RELEASE_DIR}/deploy/rf-monitorctl.sh" reset-admin-password --password-file "${RFMON_ADMIN_PASSWORD_FILE}"
  else
    echo "This password unlocks configuration changes. Normal monitoring and evidence downloads do not require it."
    privileged env RFMON_STATE_FILE="${STATE_FILE}" bash "${RELEASE_DIR}/deploy/rf-monitorctl.sh" reset-admin-password
  fi
fi

if [[ "${legacy_migration}" == "true" ]]; then
  say "Preserving existing site configuration"
  privileged test -s "${CONFIG_FILE}" || die "The protected legacy configuration is missing or empty."
  privileged test -s "${OPERATIONAL_FILE}" || die "The legacy operational profile is missing or empty."
  privileged test -s "${ADMIN_FILE}" || die "The protected Settings credential is missing or empty."
  echo "Existing protected configuration, operational profile, and Settings credential were not rewritten."
else
  say "Configuring site-specific values"
  privileged env \
    RFMON_STATE_FILE="${STATE_FILE}" \
    RFMON_CATALOG_FILE="${CATALOG_FILE}" \
    RFMON_OPERATIONAL_FILE="${OPERATIONAL_FILE}" \
    RFMON_ADMIN_FILE="${ADMIN_FILE}" \
    RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
    RFMON_INSTALL_DIR="${INSTALL_DIR}" \
    RFMON_RELEASE_DIR="${RELEASE_DIR}" \
    RFMON_DEFER_APPLICATION_ACTIVATION=true \
    RFMON_NONINTERACTIVE="${NONINTERACTIVE}" \
    bash "${RELEASE_DIR}/deploy/configure-ubuntu.sh"
fi

# Trust RF Monitor's generated local CA on the server itself so doctor, curl,
# and local browser checks use the same verified HTTPS path as operators.
configured_ca_certificate="$(privileged bash -c 'source "$1"; printf "%s" "${CA_CERTIFICATE:-}"' _ "${STATE_FILE}")"
if [[ -n "${configured_ca_certificate}" ]] && privileged test -r "${configured_ca_certificate}"; then
  privileged install -m 0644 -o root -g root "${configured_ca_certificate}" /usr/local/share/ca-certificates/rf-monitor-local-ca.crt
  privileged update-ca-certificates >/dev/null
fi

if [[ -x "${SDRCONNECT_BIN}" && "${legacy_migration}" != "true" ]]; then
  sdr_url="$(read_protected_config_value SDRCONNECT_URL)"
  sdr_port="$("${NODE_BIN}" -e 'const u=new URL(process.argv[1]); console.log(u.port || (u.protocol === "wss:" ? "443" : "80"))' "${sdr_url}")"
  privileged sed \
    -e "s|@@SERVICE_USER@@|$(sed_value "${SERVICE_USER}")|g" \
    -e "s|@@SERVICE_GROUP@@|$(sed_value "${SERVICE_GROUP}")|g" \
    -e "s|@@SDR_STATE_DIR@@|$(sed_value "${SDR_STATE_DIR}")|g" \
    -e "s|@@SDRCONNECT_BIN@@|$(sed_value "${SDRCONNECT_BIN}")|g" \
    -e "s|@@SDRCONNECT_PORT@@|$(sed_value "${sdr_port}")|g" \
    "${RELEASE_DIR}/deploy/sdrconnect-headless.service.template" \
    | privileged tee /etc/systemd/system/sdrconnect-headless.service >/dev/null
  privileged chmod 0644 /etc/systemd/system/sdrconnect-headless.service
fi
configured_sdr_urls="$(read_protected_config_value SDRCONNECT_URLS)"
configured_sdr_urls="${configured_sdr_urls:-$(read_protected_config_value SDRCONNECT_URL)}"
mapfile -t local_sdr_ports < <("${NODE_BIN}" -e '
  for (const value of process.argv[1].split(",")) {
    const url = new URL(value.trim());
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      console.log(url.port || (url.protocol === "wss:" ? "443" : "80"));
    }
  }
' "${configured_sdr_urls}")
for sdr_port in "${local_sdr_ports[@]}"; do privileged ufw deny "${sdr_port}/tcp" >/dev/null || true; done
backend_port="$(read_protected_config_value RF_MONITOR_PORT)"
privileged ufw deny "${backend_port}/tcp" >/dev/null || true

say "Enabling UTC clock synchronization and services"
privileged timedatectl set-ntp true
privileged systemctl daemon-reload
if [[ -f /etc/systemd/system/sdrconnect-headless.service ]]; then
  privileged systemctl enable --now sdrconnect-headless.service
fi

if [[ "${legacy_migration}" == "true" ]]; then
  privileged test -L /etc/nginx/sites-enabled/rf-monitor || die "Existing RF Monitor HTTPS configuration is missing; stop migration before activation."
  privileged nginx -t >/dev/null || die "Existing Nginx configuration is invalid; stop migration before activation."
  echo "Existing RF Monitor HTTPS configuration was preserved."
elif [[ "${NONINTERACTIVE}" == "true" ]]; then
  if privileged test -L /etc/nginx/sites-enabled/rf-monitor; then
    echo "Existing RF Monitor HTTPS configuration was preserved."
  else
    die "HTTPS setup is required before release activation. Run the interactive installer once or preconfigure the approved Nginx/TLS/firewall state."
  fi
elif confirm "Configure secure HTTPS access for operator computers now?" true; then
  privileged env RFMON_STATE_FILE="${STATE_FILE}" RFMON_RELEASE_DIR="${RELEASE_DIR}" bash "${RELEASE_DIR}/deploy/configure-web.sh"
else
  die "Release activation requires verified TLS, Nginx, and firewall configuration."
fi

tls_certificate="$(privileged bash -c 'source "$1"; printf "%s" "${TLS_CERTIFICATE:-}"' _ "${STATE_FILE}")"
tls_private_key="$(privileged bash -c 'source "$1"; printf "%s" "${TLS_PRIVATE_KEY:-}"' _ "${STATE_FILE}")"
[[ -n "${tls_certificate}" && -n "${tls_private_key}" ]] \
  || die "TLS certificate paths are not recorded. Run: sudo rf-monitor configure-web"
[[ "${tls_certificate}${tls_private_key}" != *[[:space:]]* ]] \
  || die "TLS certificate paths cannot contain whitespace."

if privileged test -L "${OPS_CONFIG_FILE}"; then
  die "Operations configuration must not be a symbolic link: ${OPS_CONFIG_FILE}"
elif privileged test -e "${OPS_CONFIG_FILE}"; then
  privileged test -f "${OPS_CONFIG_FILE}" || die "Operations configuration is not a regular file: ${OPS_CONFIG_FILE}"
  privileged chown root:"${SERVICE_GROUP}" "${OPS_CONFIG_FILE}"
  privileged chmod 0640 "${OPS_CONFIG_FILE}"
  echo "Existing operations configuration was preserved: ${OPS_CONFIG_FILE}"
else
  ops_config_temporary="$(mktemp)"
  {
    printf 'RFMON_OPS_HEALTH_URL=http://127.0.0.1:%s/api/health\n' "${backend_port}"
    printf 'RFMON_OPS_STORAGE_DIR=%s\n' "${STORAGE_DIR}"
    printf 'RFMON_OPS_EVIDENCE_ROOTS=%s/field/evidence,%s/test/evidence\n' "${STORAGE_DIR}" "${STORAGE_DIR}"
    printf 'RFMON_OPS_RESTORE_STAGING_ROOT=%s\n' "${OPS_RESTORE_STAGING_DIR}"
    printf 'RFMON_OPS_TLS_CERTIFICATE=%s\n' "${tls_certificate}"
    printf 'RFMON_OPS_DISK_RESERVE_BYTES=5368709120\n'
  } > "${ops_config_temporary}"
  privileged install -m 0640 -o root -g "${SERVICE_GROUP}" "${ops_config_temporary}" "${OPS_CONFIG_FILE}"
  rm -f "${ops_config_temporary}"
fi

say "Activating the immutable release"
if [[ "${provisional_active}" == "true" ]]; then
  privileged systemctl stop rf-monitor.service 2>/dev/null || true
  privileged rm -f -- "${INSTALL_DIR}"
fi
activation_arguments=(activate --release "${RELEASE_BUILD_ID}")
if [[ "${legacy_migration}" == "true" ]]; then
  activation_arguments+=(--legacy-snapshot "${LEGACY_SNAPSHOT}")
fi
activation_output="$(privileged env \
  RFMON_INSTALL_ROOT="${INSTALL_ROOT}" \
  RFMON_RELEASES_DIR="${RELEASES_DIR}" \
  RFMON_ACTIVE_LINK="${INSTALL_DIR}" \
  RFMON_DEPLOYMENT_RECORDS_DIR="${DEPLOYMENT_RECORDS_DIR}" \
  RFMON_CONFIG_FILE="${CONFIG_FILE}" \
  RFMON_STORAGE_DIR="${STORAGE_DIR}" \
  RFMON_RUNTIME_CONFIG_DIR="${RUNTIME_CONFIG_DIR}" \
  RFMON_NODE_BIN="${NODE_BIN}" \
  RFMON_SERVICE_USER="${SERVICE_USER}" \
  RFMON_SERVICE_GROUP="${SERVICE_GROUP}" \
  RFMON_OPS_RESTORE_STAGING_ROOT="${OPS_RESTORE_STAGING_DIR}" \
  RFMON_TLS_CERTIFICATE="${tls_certificate}" \
  RFMON_TLS_PRIVATE_KEY="${tls_private_key}" \
  RFMON_BACKEND_PORT="${backend_port}" \
  RFMON_SHARE_DIR="$(read_protected_config_value RF_MONITOR_SHARE_DIR || true)" \
  RFMON_SDRCONNECT_PORTS="$(IFS=,; echo "${local_sdr_ports[*]}")" \
  RFMON_LOCAL_HEALTH_URL="http://127.0.0.1:${backend_port}/api/health" \
  "${NODE_BIN}" "${RELEASE_DIR}/deploy/release-cli.mjs" "${activation_arguments[@]}")" \
  || { printf '%s\n' "${activation_output:-Release activation failed.}" >&2; die "Release health/build-identity gate failed; the prior release was restored when available."; }
printf '%s\n' "${activation_output}" | jq '{state,release:.release.buildId,previousRelease:(.previousRelease.buildId // null),health}'
if ! privileged grep -qE '^RFMON_OPS_BACKUP_ROOT=/[^[:space:]]+$' "${OPS_CONFIG_FILE}"; then
  echo "Attention: off-host backup is not configured; production qualification remains blocked."
  echo "Set RFMON_OPS_BACKUP_ROOT in ${OPS_CONFIG_FILE}, create and verify a backup, then run the weekly check."
fi
privileged install -m 0755 -o root -g root "${INSTALL_DIR}/deploy/rf-monitorctl.sh" /usr/local/sbin/rf-monitor
privileged systemctl enable rf-monitor.service

privileged systemctl enable --now rf-monitor-application-recovery.timer
privileged systemctl restart rf-monitor-application-recovery.timer
privileged systemctl start rf-monitor-application-recovery.service
if [[ -f /etc/systemd/system/sdrconnect-headless.service ]]; then
  privileged systemctl enable --now rf-monitor-sdr-recovery.timer
  privileged systemctl restart rf-monitor-sdr-recovery.timer
  recovery_first_trigger_epoch="$(date +%s)"
  privileged systemctl start rf-monitor-sdr-recovery.service
  recovery_verification_output="$(privileged env \
    RFMON_INSTALL_DIR="${INSTALL_DIR}" \
    RFMON_CONFIG_FILE="${CONFIG_FILE}" \
    RFMON_RECOVERY_STATUS_FILE=/run/rf-monitor-recovery/status.json \
    bash "${INSTALL_DIR}/deploy/verify-recovery-supervisor.sh" \
      --minimum-status-epoch "${recovery_first_trigger_epoch}" \
      --wait-status 30 2>&1)" \
    || { printf '%s\n' "${recovery_verification_output}" >&2; die "Receiver recovery supervision did not load or produce a fresh result."; }
  printf '%s\n' "${recovery_verification_output}"
fi

say "Installation complete"
echo "Administrative commands:"
echo "  sudo rf-monitor access"
echo "  sudo rf-monitor doctor"
echo "  sudo rf-monitor status"
echo "  sudo rf-monitor logs 200"
echo "  sudo rf-monitor configure"
echo "  sudo rf-monitor reset-admin-password"
echo
echo "Running the installation check now:"
privileged env RFMON_STATE_FILE="${STATE_FILE}" bash "${INSTALL_DIR}/deploy/doctor.sh" || true
