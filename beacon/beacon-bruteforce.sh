#!/usr/bin/env bash
# Brute-force beacon broadcaster: cycle through many advertisement formats so a
# scanner can tell us WHICH one Chrome/Edge Web Bluetooth can actually read.
#
# One adapter + legacy advertising = ONE payload at a time, so we cycle (3s each)
# in a loop. Run the /admin "Hunt my UUID" scan on the phone while this runs.
#
# Raw hcitool advertising fights bluetoothd — stop it first:
#   sudo systemctl stop bluetooth
set -uo pipefail

UUID="E20A39F4-73F5-4BC4-A12F-17D1AD07A961"
MAJOR=1
MINOR=2
TXPOWER=-59
ADAPTER="hci0"
DWELL=3          # seconds per variant

# ---- derive hex pieces -------------------------------------------------------
u=$(echo "$UUID" | tr -d '-' | tr 'A-F' 'a-f')            # 32 hex chars
sp() { echo "$1" | sed 's/../& /g; s/ *$//'; }            # "aabb" -> "aa bb"
uuid_sp=$(sp "$u")                                        # 16 bytes, spaced
rev=$(echo "$u" | fold -w2 | tac | tr -d '\n')            # byte-reversed
uuid_rev_sp=$(sp "$rev")                                  # little-endian 128-bit
ns_sp=$(sp "${u:0:20}")                                   # Eddystone namespace (10B)
inst_sp=$(sp "${u:20:12}")                                # Eddystone instance (6B)
MAJ=$(printf '%02x %02x' $(((MAJOR>>8)&0xFF)) $((MAJOR&0xFF)))
MIN=$(printf '%02x %02x' $(((MINOR>>8)&0xFF)) $((MINOR&0xFF)))
TX=$(printf '%02x' $((TXPOWER&0xFF)))

# variant := "advtype;name;advdata(without padding)"
VARIANTS=(
  "00;iBeacon flags ADV_IND;02 01 06 1a ff 4c 00 02 15 $uuid_sp $MAJ $MIN $TX"
  "03;iBeacon flags ADV_NONCONN;02 01 06 1a ff 4c 00 02 15 $uuid_sp $MAJ $MIN $TX"
  "02;iBeacon flags ADV_SCAN;02 01 06 1a ff 4c 00 02 15 $uuid_sp $MAJ $MIN $TX"
  "00;iBeacon NOflags ADV_IND;1a ff 4c 00 02 15 $uuid_sp $MAJ $MIN $TX"
  "03;iBeacon NOflags ADV_NONCONN;1a ff 4c 00 02 15 $uuid_sp $MAJ $MIN $TX"
  "00;AltBeacon flags ADV_IND;02 01 06 1b ff ff ff be ac $uuid_sp $MAJ $MIN $TX 00"
  "00;Eddystone-UID ADV_IND;02 01 06 03 03 aa fe 17 16 aa fe 00 $TX $ns_sp $inst_sp 00 00"
  "00;128bit ServiceUUID flags ADV_IND;02 01 06 11 07 $uuid_rev_sp"
  "03;128bit ServiceUUID NOflags ADV_NONCONN;11 07 $uuid_rev_sp"
)

emit() {
  local vtype="$1" vname="$2" vdata="$3"
  local len; len=$(echo $vdata | wc -w)
  if [ "$len" -gt 31 ]; then printf '  [%-34s] SKIP (%s octets > 31)\n' "$vname" "$len"; return; fi
  local hexlen; hexlen=$(printf '%02X' "$len")
  local padded="$vdata" n="$len"
  while [ "$n" -lt 31 ]; do padded="$padded 00"; n=$((n+1)); done
  sudo hcitool -i "$ADAPTER" cmd 0x08 0x000a 00 >/dev/null 2>&1 || true   # adv off
  sudo hcitool -i "$ADAPTER" cmd 0x08 0x0006 A0 00 A0 00 "$vtype" 00 00 00 00 00 00 00 00 07 00 >/dev/null 2>&1
  sudo hcitool -i "$ADAPTER" cmd 0x08 0x0008 "$hexlen" $padded >/dev/null 2>&1
  sudo hcitool -i "$ADAPTER" cmd 0x08 0x000a 01 >/dev/null 2>&1           # adv on
  printf '  [%-34s] type=0x%s  %s octets\n' "$vname" "$vtype" "$len"
}

cleanup() { echo; echo "Stopping advertising."; sudo hcitool -i "$ADAPTER" cmd 0x08 0x000a 00 >/dev/null 2>&1 || true; exit 0; }
trap cleanup INT TERM

if command -v systemctl >/dev/null && systemctl is-active --quiet bluetooth 2>/dev/null; then
  echo "⚠ bluetoothd is RUNNING — it will fight raw advertising. Stop it first:"
  echo "    sudo systemctl stop bluetooth"
  echo "  (continuing anyway, but results may be unreliable)"
  echo
fi

sudo hciconfig "$ADAPTER" up
echo "Cycling ${#VARIANTS[@]} variants, ${DWELL}s each (one full loop ≈ $(( ${#VARIANTS[@]} * DWELL ))s)."
echo "Run the phone's '🔦 Hunt my UUID' scan now. Ctrl-C to stop."
echo
cycle=0
while true; do
  cycle=$((cycle+1)); echo "== cycle $cycle =="
  for v in "${VARIANTS[@]}"; do
    IFS=';' read -r vtype vname vdata <<< "$v"
    emit "$vtype" "$vname" "$vdata"
    sleep "$DWELL"
  done
done
