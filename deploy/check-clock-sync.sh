#!/bin/sh
set -eu

if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && [ "${RF_MONITOR_WSL_TEST_MODE:-false}" = "true" ]; then
  echo "WSL software-test mode: Windows supplies the guest clock, but this host is not acceptable for production evidence."
  exit 0
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  synchronized="$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true)"
  if [ "$synchronized" = "yes" ]; then
    echo "Clock synchronization verified: $(date --utc --iso-8601=seconds)"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "RF Monitor refused to start because the Ubuntu clock is not synchronized." >&2
exit 1
