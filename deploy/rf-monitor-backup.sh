#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -eq 0 ]]; then
  echo "Run RF Monitor backup as the RF Monitor service account, not root." >&2
  exit 1
fi

install_dir="${RFMON_INSTALL_DIR:-/opt/rf-monitor/active}"
cli_path="${install_dir}/dist/server-node/evidence-backup.js"

if [[ ! -x /usr/bin/node ]]; then
  echo "RF Monitor backup refused: /usr/bin/node is not available." >&2
  exit 1
fi
if [[ ! -f "${cli_path}" || -L "${cli_path}" ]]; then
  echo "RF Monitor backup refused: built backup tool is missing or symlinked: ${cli_path}" >&2
  exit 1
fi

exec /usr/bin/node "${cli_path}" "$@"
