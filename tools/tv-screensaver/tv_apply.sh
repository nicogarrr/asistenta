#!/bin/sh
# Ejecutar EN LA TV (por SSH) con los ficheros ya subidos a /media/developer/art-kit/. Reversible con tv_rollback.sh
# NO ejecutar si Nico esta viendo la TV: el salvapantallas solo se ve al ir a reposo, pero el test (turnOnScreenSaver) es visible.
set -e
DIR=/media/developer/art-kit
T=/usr/palm/applications/com.webos.app.screensaver/qml/main.qml
[ -f "$T" ] || { echo "No existe $T: webOS distinto, PARAR y reportar"; exit 1; }
[ -f "$DIR/screensaver-main.qml" ] || { echo "falta $DIR/screensaver-main.qml"; exit 1; }
if findmnt "$T" >/dev/null 2>&1; then echo "ya montado, desmonto antes"; umount "$T"; fi
mount --bind "$DIR/screensaver-main.qml" "$T"
echo "[+] bind mount hecho"
# Persistencia tras reinicio (Homebrew Channel ejecuta /var/lib/webosbrew/init.d/*)
mkdir -p /var/lib/webosbrew/init.d
cat > /var/lib/webosbrew/init.d/50-art-screensaver <<'INIT'
#!/bin/sh
T=/usr/palm/applications/com.webos.app.screensaver/qml/main.qml
findmnt "$T" >/dev/null 2>&1 || mount --bind /media/developer/art-kit/screensaver-main.qml "$T"
INIT
chmod +x /var/lib/webosbrew/init.d/50-art-screensaver
echo "[+] autoarranque instalado. Para probar (VISIBLE): luna-send -n 1 'luna://com.webos.service.tvpower/power/turnOnScreenSaver' '{}'"
