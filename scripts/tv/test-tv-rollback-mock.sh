#!/bin/dash
# test-tv-rollback-mock.sh (R7) - tests mock con FILESYSTEM FALSO REAL:
# todos los paths van a un sandbox temporal (MM_ROOT/INITD/MOUNTS_FILE),
# kill (builtin de dash) se intercepta definiendo una funcion antes de
# sourcear el template, y hay sentinelas que prueban que nada se toca
# fuera del sandbox ni antes de las validaciones.
set -eu
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0
ok() { PASS=$((PASS+1)); echo "ok $PASS - $1"; }
fail() { echo "FALLO - $1" >&2; exit 1; }
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
sandbox() {
  rm -rf "$T/root" "$T/initd" "$T/bk" "$T/bin" "$T/kill.log" "$T/stop.log"
  mkdir -p "$T/root" "$T/initd" "$T/bk" "$T/bin"
  echo SENTINEL > "$T/root/magic_mapper.py"
  printf '#!/bin/sh\necho "%s $1" >> "%s/stop.log"\n' init "$T" > "$T/initd/start_magic_mapper"; chmod +x "$T/initd/start_magic_mapper"
  echo "magic_mapper.py" > "$T/bk/MANIFEST"; echo BACKUP > "$T/bk/magic_mapper.py"
}
# Proceso INDEPENDIENTE (fidelidad real: sh rollback.sh) con PATH de stubs
runp() { PATH="$T/bin:/usr/bin:/bin" MM_ROOT="$T/root" INITD="$T/initd" dash "$1"; }
# Sourcing SOLO para interceptar el builtin kill de dash (caso multi-PID)
run() { ( kill() { echo "kill $*" >> "$T/kill.log"; }; export PATH="$T/bin:/usr/bin:/bin"; . "$1" ); }
MMRB="$T/mm-rollback.sh"

# 1) proceso VIVO (pgrep 0): aborta ANTES de rm - sentinel intacto
sandbox; stub pgrep 'exit 0'
sed "s|__BK__|$T/bk|g" "$DIR/templates/mapper-rollback.sh" > "$MMRB"
runp "$MMRB" 2>"$T/err" && fail "1: vivo debia abortar"
grep -q "sigue vivo" "$T/err" || fail "1: sin mensaje visible"
[ "$(cat "$T/root/magic_mapper.py")" = SENTINEL ] || fail "1: sentinel tocado"
ok "mapper: proceso vivo -> aborta antes de rm (sentinel intacto)"

# 2) pgrep ERROR (exit 2): tri-estado aborta visible, sentinel intacto
sandbox; stub pgrep 'exit 2'
runp "$MMRB" 2>"$T/err" && fail "2: pgrep roto debia abortar"
grep -q "pgrep fallo con exit 2" "$T/err" || fail "2: tri-estado no visible"
[ "$(cat "$T/root/magic_mapper.py")" = SENTINEL ] || fail "2: sentinel tocado"
ok "mapper: pgrep exit 2 (error) -> aborta, no lo trata como muerto"

# 3) backup perdido (sin MANIFEST): aborta ANTES de stop/rm
sandbox; stub pgrep 'exit 1'; rm "$T/bk/MANIFEST"
runp "$MMRB" 2>"$T/err" && fail "3: sin MANIFEST debia abortar"
grep -q "sin MANIFEST" "$T/err" || fail "3: sin mensaje de backup perdido"
[ "$(cat "$T/root/magic_mapper.py")" = SENTINEL ] || fail "3: sentinel tocado"
[ ! -e "$T/stop.log" ] || fail "3: stop invocado antes de validar backup"
ok "mapper: backup perdido -> aborta antes de stop/rm"

# 4) MANIFEST vacio (sin instalacion previa): rm sin restore, hecho
sandbox; stub pgrep 'exit 1'; echo EMPTY > "$T/bk/MANIFEST"
OUT=$(runp "$MMRB") || fail "4: EMPTY debia funcionar"
[ ! -e "$T/root/magic_mapper.py" ] || fail "4: no borro el activo"
echo "$OUT" | grep -q "rollback hecho" || fail "4: falta cierre"
ok "mapper: sin instalacion previa (EMPTY) -> rm limpio, distinto de backup perdido"

# 5) cp roto en restore: fallo visible, sin falso hecho
sandbox; stub pgrep 'exit 1'; stub cp 'echo "cp stub: permiso denegado" >&2; exit 1'
OUT=$(runp "$MMRB" 2>&1) && fail "5: cp roto debia fallar"
echo "$OUT" | grep -q "rollback hecho" && fail "5: falso hecho"
echo "$OUT" | grep -q "permiso denegado" || fail "5: fallo de cp no visible"
ok "mapper: cp roto -> fallo visible, sin falso 'rollback hecho'"

# 6) tailscaled: kill PID a PID (multi-pid) interceptando el builtin
sandbox
# pidof stateful: vivo en las 2 primeras llamadas, muerto tras los kill
cat > "$T/bin/pidof" <<'SH'
#!/bin/sh
c=0; [ -f "$T_PIDOF_N" ] && c=$(cat "$T_PIDOF_N")
c=$((c+1)); echo "$c" > "$T_PIDOF_N"
[ "$c" -le 2 ] && echo "111 222" || exit 1
SH
chmod +x "$T/bin/pidof"; export T_PIDOF_N="$T/pidof_n"; rm -f "$T_PIDOF_N"
printf 'PRE_PID=""\nPRE_DNS=1\nPRE_INIT=0\n' > "$T/state"
sed -e "s|__STATE__|$T/state|g" -e "s|__BAK__|$T/sinbak|g" "$DIR/templates/tailscaled-rollback.sh" > "$T/ts.sh"
OUT=$(export INITD="$T/initd" MOUNTS_FILE="$T/mounts"; run "$T/ts.sh") || fail "6: debia terminar"
grep -qx "kill 111" "$T/kill.log" || fail "6: falta kill 111"
grep -qx "kill 222" "$T/kill.log" || fail "6: falta kill 222"
[ "$(wc -l < "$T/kill.log")" = "2" ] || fail "6: kills distintos de 2"
ok "tailscaled: multi-PID matado PID a PID (quoting del state correcto)"

# 7) tailscaled: ownership ajeno intacto + umount roto visible
sandbox; stub pidof 'exit 1'; stub umount 'echo "umount stub: ocupado" >&2; exit 1'
printf 'tmpfs /etc/resolv.conf tmpfs rw 0 0\n' > "$T/mounts"
printf 'PRE_PID="4242 4243"\nPRE_DNS=1\nPRE_INIT=0\n' > "$T/state2"
sed -e "s|__STATE__|$T/state2|g" -e "s|__BAK__|$T/sinbak|g" "$DIR/templates/tailscaled-rollback.sh" > "$T/ts2.sh"
OUT=$(PATH="$T/bin:/usr/bin:/bin" INITD="$T/initd" MOUNTS_FILE="$T/mounts" dash "$T/ts2.sh") || fail "7: ownership debia terminar"
echo "$OUT" | grep -q "NO se mata" || fail "7: no respeto daemon previo"
echo "$OUT" | grep -q "NO se desmonta" || fail "7: no respeto mount previo"
[ ! -e "$T/kill.log" ] || fail "7: kill invocado con daemon ajeno"
printf 'PRE_PID=""\nPRE_DNS=0\nPRE_INIT=0\n' > "$T/state3"
sed -e "s|__STATE__|$T/state3|g" -e "s|__BAK__|$T/sinbak|g" "$DIR/templates/tailscaled-rollback.sh" > "$T/ts3.sh"
OUT=$(PATH="$T/bin:/usr/bin:/bin" INITD="$T/initd" MOUNTS_FILE="$T/mounts" dash "$T/ts3.sh" 2>&1) && fail "7b: umount roto debia fallar"
echo "$OUT" | grep -q "rollback hecho" && fail "7b: falso hecho"
echo "$OUT" | grep -q "ocupado" || fail "7b: fallo de umount no visible"
ok "tailscaled: ownership ajeno intacto + umount roto falla visible"

# 8) nada se escribe fuera del sandbox: las rutas reales no existen tras los tests
[ ! -e /home/root/magic_mapper.py ] && [ ! -e /var/lib/webosbrew/init.d/tailscaled ] \
  || fail "8: rutas reales tocadas"
ok "sentinelas: rutas reales intactas"
# 9) INSTALADOR: cp de backup roto -> aborta ANTES de stop/rename (bloque real)
sandbox; stub cp 'echo "cp stub: disco lleno" >&2; exit 1'
sed -n "/# BACKUP_BLOCK_START/,/# BACKUP_BLOCK_END/p" "$DIR/install-magic-mapper.sh" | sed "1d;\$d" > "$T/backup-block.sh"
FILES="$T/root/magic_mapper.py $T/root/magic_mapper_config.json"; BK="$T/bk2"; mkdir -p "$BK"
OUT=$(PATH="$T/bin:/usr/bin:/bin" FILES="$FILES" BK="$BK" dash -e "$T/backup-block.sh" 2>&1) && fail "9: cp roto debia abortar"
echo "$OUT" | grep -q "backup fallo" || fail "9: abort no visible"
echo "$OUT" | grep -q "disco lleno" || fail "9: fallo de cp no visible"
[ ! -e "$BK/MANIFEST" ] && [ ! -e "$BK/.mlist" ] || fail "9: MANIFEST/.mlist inconsistente tras cp roto"
ok "instalador: cp de backup obligatorio - fallo aborta antes de mutar"
echo "PASS $PASS/9"
