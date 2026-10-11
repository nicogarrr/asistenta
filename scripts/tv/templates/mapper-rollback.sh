#!/bin/sh
# Rollback de magic_mapper (R7, generado desde templates/mapper-rollback.sh).
# Garantiza SOLO lo verificable: valida el backup ANTES de mutar (MANIFEST),
# para el servicio, exige proceso no-vivo (pgrep tri-estado: 0=vivo, 1=muerto,
# otro=aborta) y restaura con fallos visibles. Si algo no cuadra, ABORTA sin tocar nada.
set -e
ROOT="${MM_ROOT:-/home/root}"
INITD="${MM_INITD:-/var/lib/webosbrew/init.d}"
BK="__BK__"
abort() { echo "ROLLBACK ABORTA: $1" >&2; exit 1; }
mm_alive() {
  rc=0; pgrep -f magic_mapper.py >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  if [ "$rc" -eq 1 ]; then return 1; fi
  abort "pgrep fallo con exit $rc - no puedo confirmar proceso muerto"
}
# 1) Backup validado ANTES de stop/rm (distingue sin-instalacion de backup-perdido)
[ -d "$BK" ] || abort "el backup $BK no existe - no toco los ficheros activos"
[ -f "$BK/MANIFEST" ] || abort "sin MANIFEST en $BK - backup perdido o rollback equivocado"
if [ "$(cat "$BK/MANIFEST")" != "EMPTY" ]; then
  while IFS= read -r f; do
    [ -e "$BK/$f" ] || abort "falta $f en el backup - restore incompleto, no muto"
  done < "$BK/MANIFEST"
fi
# 2) Stop obligatorio (sin ||true) + no-vivo confirmado
if [ -x "$INITD/start_magic_mapper" ]; then
  "$INITD/start_magic_mapper" stop
fi
sleep 1
if mm_alive; then abort "magic_mapper sigue vivo tras stop - no toco ficheros con el proceso corriendo"; fi
# 3) rm + restore desde el backup validado
rm -f "$ROOT/magic_mapper.py" "$ROOT/magic_mapper_config.json" "$ROOT/magic_mapper_config.json.dist" "$INITD/start_magic_mapper"
if [ "$(cat "$BK/MANIFEST")" != "EMPTY" ]; then
  while IFS= read -r f; do
    case "$f" in
      start_magic_mapper) cp -a "$BK/$f" "$INITD/start_magic_mapper" ;;
      *) cp -a "$BK/$f" "$ROOT/$f" ;;
    esac
  done < "$BK/MANIFEST"
fi
if [ -x "$INITD/start_magic_mapper" ]; then "$INITD/start_magic_mapper" start; fi
echo "rollback hecho"
