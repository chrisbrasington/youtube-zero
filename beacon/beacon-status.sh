#!/usr/bin/env bash
# Report beacon adapter state and what it SHOULD be advertising.
# A radio can't hear its own ads — TRUE confirmation needs a 2nd device.
# Note: no `set -e` here — we want to report problems, not abort on the first.
set -uo pipefail

# Keep these matching beacon-up.sh
UUID="E20A39F4-73F5-4BC4-A12F-17D1AD07A961"
MAJOR=1
MINOR=2
ADAPTER="hci0"

say()  { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "== Tools =="
for t in hciconfig hcitool btmgmt bluetoothctl rfkill btmon; do
  if have "$t"; then say "  ${t}: yes"; else say "  ${t}: MISSING"; fi
done

say
say "== Radio block (rfkill) =="
if have rfkill; then
  rfkill list bluetooth 2>/dev/null | sed 's/^/  /' || say "  (could not read rfkill)"
else
  say "  (rfkill not installed)"
fi

say
say "== BlueZ daemon =="
if have systemctl; then
  state=$(systemctl is-active bluetooth 2>/dev/null || true)
  say "  bluetoothd: ${state:-unknown}"
  if [ "${state:-}" = "active" ]; then
    say "  ⚠ A running daemon can override/reset raw hcitool advertising."
    say "    If the beacon is flaky or a scanner can't see it, try:"
    say "      sudo systemctl stop bluetooth   # then re-run ./beacon-up.sh"
  fi
else
  say "  (systemctl not available)"
fi

say
say "== Adapter (${ADAPTER}) =="
if have hciconfig && hciconfig "$ADAPTER" >/dev/null 2>&1; then
  hciconfig -a "$ADAPTER" | sed 's/^/  /'
  if hciconfig "$ADAPTER" | grep -q "UP RUNNING"; then
    say "  state: UP RUNNING"
  else
    say "  state: DOWN — not broadcasting. Run ./beacon-up.sh"
  fi
else
  say "  ${ADAPTER} not found (bluez installed? adapter present?)"
fi

if have btmgmt; then
  say
  say "== mgmt current settings (sudo btmgmt info) =="
  sudo btmgmt info 2>/dev/null | sed 's/^/  /' || say "  (could not read btmgmt info)"
  say "  Look for 'advertising' in current settings. CAVEAT: raw hcitool"
  say "  advertising bypasses the mgmt layer, so it may NOT show here even"
  say "  when the beacon is live — this reflects bluetoothd's view, not hcitool's."
fi

say
say "== Expected iBeacon identity — match this on a scanning device =="
say "  UUID : ${UUID}"
say "  Major: ${MAJOR}"
say "  Minor: ${MINOR}"

say
say "== Live verify =="
say "  This machine cannot hear its own advertisement (one radio)."
if have btmon; then
  say "  To watch the controller live, in another terminal run:"
  say "    sudo btmon"
  say "  then re-run ./beacon-up.sh and look for 'LE Set Advertising Enable'."
fi
say "  Real confirmation: scan from a phone — nRF Connect or Beacon Simulator."
