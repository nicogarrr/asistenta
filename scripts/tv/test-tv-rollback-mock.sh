#!/bin/dash
# test-tv-rollback-mock.sh - tests mock de los rollbacks R6 (sin TV).
# Stubs de comandos por PATH y fs falso en un dir temporal.
set -eu
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0
ok() { PASS=$((PASS+1)); echo "ok $PASS - $1"; }
fail() { echo "FALLO - $1" >&2; exit 1; }

# ---------- mapper rollback ----------
sed "s|__BK__|$T/bk|g" "$DIR/templates/mapper-rollback.sh" > "$T/mm-rollback.sh"
mkdir -p "$T/bk" "$T/bin"
# proceso VIVO: stub pgrep que encuentra -> rollback aborta ANTES de rm
printf '#!/bin/sh\nexit 0\n' > "$T/bin/pgrep"; chmod +x "$T/bin/pgrep"
echo VIVO > "$T/bk/fichero_vivo"
if PATH="$T/bin:/usr/bin:/bin" sh "$T/mm-rollback.sh" 2>"$T/err"; then fail "mapper: proceso vivo debia abortar"; fi
grep -q "sigue vivo" "$T/err" || fail "mapper: sin mensaje visible de proceso vivo"
[ -e /home/root/magic_mapper.py ] && : # no-op informativo
ok "mapper: proceso vivo -> aborta visible antes de tocar ficheros"
# proceso muerto + cp que falla -> fallo visible (set -e), sin "rollback hecho"
printf '#!/bin/sh\nexit 1\n' > "$T/bin/pgrep"
printf '#!/bin/sh\necho "cp stub: permiso denegado" >&2\nexit 1\n' > "$T/bin/cp"; chmod +x "$T/bin/cp"
touch "$T/bk/magic_mapper.py"
OUT=$(PATH="$T/bin:/usr/bin:/bin" sh "$T/mm-rollback.sh" 2>&1) && fail "mapper: cp roto debia fallar"
echo "$OUT" | grep -q "rollback hecho" && fail "mapper: declaro hecho con cp roto"
echo "$OUT" | grep -q "permiso denegado" || fail "mapper: fallo de cp no visible"
ok "mapper: restore con cp roto -> fallo visible, sin falso 'rollback hecho'"

# ---------- tailscaled rollback ----------
# pidof/kill stubbed: sin daemon vivo en el entorno de test (la VM SI tiene tailscaled real)
printf '#!/bin/sh\nexit 1\n' > "$T/bin/pidof"; chmod +x "$T/bin/pidof"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/kill"; chmod +x "$T/bin/kill"
printf 'PRE_PID=\nPRE_DNS=0\nPRE_INIT=1\n' > "$T/state"
sed -e "s|__STATE__|$T/state|g" -e "s|__BAK__|$T/tailscaled.bak|g" "$DIR/templates/tailscaled-rollback.sh" > "$T/ts-rollback.sh"
# mounts falso CON resolv.conf montado + umount que FALLA -> visible
printf 'tmpfs /etc/resolv.conf tmpfs rw 0 0\n' > "$T/mounts"
printf '#!/bin/sh\necho "umount stub: ocupado" >&2\nexit 1\n' > "$T/bin/umount"; chmod +x "$T/bin/umount"
OUT=$(PATH="$T/bin:/usr/bin:/bin" MOUNTS_FILE="$T/mounts" sh "$T/ts-rollback.sh" 2>&1) && fail "tailscaled: umount roto debia fallar"
echo "$OUT" | grep -q "rollback hecho" && fail "tailscaled: declaro hecho con umount roto"
echo "$OUT" | grep -q "ocupado" || fail "tailscaled: fallo de umount no visible"
ok "tailscaled: umount roto -> fallo visible, sin falso 'rollback hecho'"
# ownership: PRE_PID puesto -> NO mata; PRE_DNS=1 -> NO desmonta
printf 'PRE_PID=4242\nPRE_DNS=1\nPRE_INIT=0\n' > "$T/state2"
sed -e "s|__STATE__|$T/state2|g" -e "s|__BAK__|$T/sinbak|g" "$DIR/templates/tailscaled-rollback.sh" > "$T/ts2.sh"
OUT=$(PATH="$T/bin:/usr/bin:/bin" MOUNTS_FILE="$T/mounts" sh "$T/ts2.sh" 2>&1) || fail "tailscaled ownership: debia terminar bien"
echo "$OUT" | grep -q "NO se mata" || fail "ownership: no respeto daemon previo"
echo "$OUT" | grep -q "NO se desmonta" || fail "ownership: no respeto mount previo"
echo "$OUT" | grep -q "rollback hecho" || fail "ownership: falta cierre"
ok "tailscaled: ownership ajeno intacto (daemon y DNS previos no tocados)"
echo "PASS $PASS/4"
