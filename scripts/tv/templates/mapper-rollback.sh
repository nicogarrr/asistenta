#!/bin/sh
# Rollback de magic_mapper (generado desde scripts/tv/templates/mapper-rollback.sh).
# Garantiza SOLO lo que el codigo verifica: para el servicio, exige proceso
# no-vivo antes de tocar ficheros, restaura el backup con fallos visibles y
# rearranca. Si no puede parar el proceso, ABORTA sin tocar nada.
set -e
BK="__BK__"
if [ -x /var/lib/webosbrew/init.d/start_magic_mapper ]; then
  /var/lib/webosbrew/init.d/start_magic_mapper stop
fi
sleep 1
if pgrep -f magic_mapper.py >/dev/null 2>&1; then
  echo "ROLLBACK ABORTA: magic_mapper sigue vivo tras stop - no toco ficheros con el proceso corriendo" >&2
  exit 1
fi
rm -f /home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /var/lib/webosbrew/init.d/start_magic_mapper
for b in "$BK"/*; do
  [ -e "$b" ] || continue
  case "$b" in
    */start_magic_mapper) cp -a "$b" /var/lib/webosbrew/init.d/start_magic_mapper ;;
    *) cp -a "$b" "/home/root/$(basename "$b")" ;;
  esac
done
if [ -x /var/lib/webosbrew/init.d/start_magic_mapper ]; then /var/lib/webosbrew/init.d/start_magic_mapper start; fi
echo "rollback hecho"
