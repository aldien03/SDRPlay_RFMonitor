#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 4 ]] || { echo "Usage: create-operator-kit.sh CA_CERTIFICATE PUBLIC_URL OPERATOR_CIDR OUTPUT_DIRECTORY" >&2; exit 2; }
ca_certificate="$1"
public_url="$2"
operator_cidr="$3"
output_parent="$4"

[[ -r "${ca_certificate}" ]] || { echo "ERROR: Local CA certificate is not readable: ${ca_certificate}" >&2; exit 1; }
[[ "${public_url}" == https://* ]] || { echo "ERROR: HTTPS is not configured." >&2; exit 1; }
[[ "${output_parent}" == /* ]] || { echo "ERROR: Use an absolute output directory, such as /home/USER/Downloads." >&2; exit 1; }
[[ -d "${output_parent}" ]] || { echo "ERROR: Output directory does not exist: ${output_parent}" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
kit_dir="${output_parent%/}/rf-monitor-operator-kit-${stamp}"
install -d -m 0755 "${kit_dir}"
install -m 0644 "${ca_certificate}" "${kit_dir}/rf-monitor-local-ca.crt"
fingerprint="$(openssl x509 -in "${ca_certificate}" -noout -fingerprint -sha256 | sed 's/^sha256 Fingerprint=//; s/^SHA256 Fingerprint=//')"

cat > "${kit_dir}/START-HERE.txt" <<EOF
RF MONITOR OPERATOR CONNECTION KIT

Dashboard address
  ${public_url}

Who can connect
  Computers whose IP address is inside ${operator_cidr}

Safety check
  This folder contains only the PUBLIC local CA certificate. It contains no
  private key or password. Before trusting it, compare this fingerprint with
  the value shown on the Ubuntu RF Monitor computer:

  SHA-256: ${fingerprint}

WINDOWS 10/11 + CHROME OR EDGE
1. Right-click rf-monitor-local-ca.crt and choose Install Certificate.
2. Choose Local Machine. Windows administrator approval is required.
3. Choose "Place all certificates in the following store".
4. Select "Trusted Root Certification Authorities" and finish.
5. Close every Chrome/Edge window, reopen the browser, and enter exactly:
   ${public_url}

MACOS + CHROME
1. Open Keychain Access and import rf-monitor-local-ca.crt into System.
2. Open the imported certificate, expand Trust, and set SSL to Always Trust.
3. Approve with a macOS administrator account.
4. Restart Chrome and enter exactly: ${public_url}

UBUNTU/DEBIAN + CHROME/CHROMIUM
1. Open a terminal in this folder.
2. Run:
   sudo install -m 0644 rf-monitor-local-ca.crt /usr/local/share/ca-certificates/rf-monitor-local-ca.crt
   sudo update-ca-certificates
3. Restart Chrome/Chromium and enter exactly: ${public_url}

IF IT STILL DOES NOT OPEN
- "Timed out" or "connection refused": the computer is outside ${operator_cidr},
  port 443 is blocked between the computers, or the Ubuntu address changed.
- "Your connection is not private": the CA is not trusted, the browser was not
  restarted, the computer clock is wrong, or a different URL was entered.
- Never bypass the browser warning. Ask the Ubuntu administrator to run:
  sudo rf-monitor doctor
  sudo rf-monitor access
EOF

cat > "${kit_dir}/connection-details.txt" <<EOF
Dashboard=${public_url}
AllowedOperatorNetwork=${operator_cidr}
CAFingerprintSHA256=${fingerprint}
GeneratedAtUTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
(
  cd "${kit_dir}"
  sha256sum rf-monitor-local-ca.crt START-HERE.txt connection-details.txt > SHA256SUMS
)
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  chown -R "${SUDO_USER}:${SUDO_USER}" "${kit_dir}"
fi
echo "Operator kit created: ${kit_dir}"
echo "Transfer this folder to the operator computer through an approved channel."
echo "It contains the public CA certificate only; no private key or password."
