#!/usr/bin/env bash
# Start broadcasting an AltBeacon (verbose). Edit the values below.
#
# NOTE: this broadcasts ALTBEACON (company 0xFFFF), NOT Apple iBeacon. Android
# Chrome/Edge Web Bluetooth silently drops iBeacon (0x4C) advertisements but
# reads AltBeacon fine — proven by beacon-bruteforce.sh. Same UUID/Major/Minor
# scheme, so your /admin bindings are unchanged.
set -euo pipefail

# ---- Settings ----------------------------------------------------------
UUID="E20A39F4-73F5-4BC4-A12F-17D1AD07A961"   # run `uuidgen` to make your own
MAJOR=1                                       # 0..65535
MINOR=2                                       # 0..65535
TXPOWER=-59                                   # measured RSSI at 1 meter (dBm)
ADAPTER="hci0"
# Advertising type:
#   00 = ADV_IND          connectable + scannable. Chrome / Edge Web Bluetooth
#                         scanning sees this reliably. ← use this.
#   03 = ADV_NONCONN_IND  classic iBeacon, non-connectable. Native apps see it,
#                         but Chrome Web Bluetooth often ignores it.
ADV_TYPE="00"
# Include a Flags AD (02 01 06) at the front of the packet?
#   1 = standard iBeacon WITH flags. This is what native scanners reliably see.
#   0 = omit flags. (Tested: this made the beacon invisible to the native
#       scanner too, and did NOT help Chrome — so leave it at 1.)
INCLUDE_FLAGS=1
# ------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }

# run <description> <hcitool cmd args...> — echoes the command, suppresses the
# raw HCI response on success, prints it on failure.
run() {
  local desc="$1"; shift
  say "  → ${desc}"
  say "    sudo hcitool -i ${ADAPTER} $*"
  local out
  if out=$(sudo hcitool -i "$ADAPTER" "$@" 2>&1); then
    say "    ok"
  else
    say "    FAILED: ${out}"
    return 1
  fi
}

say "== Preflight =="
command -v hcitool   >/dev/null || { say "  hcitool not found — install bluez."; exit 1; }
command -v hciconfig >/dev/null || { say "  hciconfig not found — install bluez."; exit 1; }
say "  hcitool / hciconfig: present"

if command -v rfkill >/dev/null && rfkill list bluetooth 2>/dev/null | grep -qi "Soft blocked: yes"; then
  say "  Bluetooth is SOFT-BLOCKED → unblocking"
  sudo rfkill unblock bluetooth || true
fi

if command -v systemctl >/dev/null && systemctl is-active --quiet bluetooth 2>/dev/null; then
  say "  NOTE: bluetoothd is RUNNING — it can override or reset raw hcitool"
  say "        advertising. If the beacon is flaky or vanishes, stop it with:"
  say "          sudo systemctl stop bluetooth"
fi

say
say "== Payload =="
uuid_hex=$(echo "$UUID" | tr -d '-' | tr 'A-F' 'a-f' | sed 's/../& /g')
major_hex=$(printf '%02X %02X' $(( (MAJOR >> 8) & 0xFF )) $(( MAJOR & 0xFF )))
minor_hex=$(printf '%02X %02X' $(( (MINOR >> 8) & 0xFF )) $(( MINOR & 0xFF )))
tx_hex=$(printf '%02X' $(( TXPOWER & 0xFF )))   # signed -> two's complement

# AltBeacon Manufacturer-Specific Data AD (company 0xFFFF):
#   len(1B=27) FF  FF FF (company)  BE AC  <uuid16> <major2> <minor2> <refrssi1> <reserved1>
mfr="1B FF FF FF BE AC ${uuid_hex}${major_hex} ${minor_hex} ${tx_hex} 00"
if [ "$INCLUDE_FLAGS" = "1" ]; then
  # 02 01 06 (flags) + 28-byte AltBeacon AD = 31 significant octets, no padding.
  adlen="1F"; payload="02 01 06 ${mfr}"; flags_desc="with flags"
else
  # 28-byte AltBeacon AD only = 28 significant octets, pad 3 to reach 31.
  adlen="1C"; payload="${mfr} 00 00 00"; flags_desc="no flags"
fi
if [ "$ADV_TYPE" = "00" ]; then adv_desc="ADV_IND (connectable)"; else adv_desc="ADV_NONCONN_IND"; fi
say "  UUID    : ${UUID}"
say "  Major   : ${MAJOR}    Minor: ${MINOR}    TxPower: ${TXPOWER} dBm"
say "  Adv type: 0x${ADV_TYPE} (${adv_desc})"
say "  Flags   : ${flags_desc}"
say "  Format  : AltBeacon (company 0xFFFF) — readable by Android Web Bluetooth"
say "  Adv data: ${adlen} ${payload}"
say "  A scanner should show mfr[0xFFFF=beac${uuid_hex// /}...] — beac marks AltBeacon."

say
say "== Bring up adapter =="
say "  sudo hciconfig ${ADAPTER} up"
sudo hciconfig "$ADAPTER" up
say "  ok"

say
say "== Program advertisement =="
run "set advertising data (0x0008)"        cmd 0x08 0x0008 $adlen $payload
run "set advertising params (0x0006)"      cmd 0x08 0x0006 A0 00 A0 00 "$ADV_TYPE" 00 00 00 00 00 00 00 00 07 00
run "enable advertising (0x000a)"          cmd 0x08 0x000a 01

say
say "== Beacon ON (${ADAPTER}) =="
say "  Confirm from a SECOND device (phone). Look for:"
say "    UUID ${UUID}  Major ${MAJOR}  Minor ${MINOR}"
say "  Re-check: ./beacon-status.sh   Stop: ./beacon-down.sh"
