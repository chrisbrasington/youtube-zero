#!/usr/bin/env bash
# Stop broadcasting the iBeacon.
set -euo pipefail

ADAPTER="hci0"

sudo hcitool -i "$ADAPTER" cmd 0x08 0x000a 00 >/dev/null
echo "Beacon OFF ($ADAPTER)"
