#!/bin/sh
# SOLO LECTURA. Ejecutar en la TV por SSH. No cambia nada ni muestra nada en pantalla.
echo "== modelo/webOS"; cat /var/run/nyx/os_info.json 2>/dev/null | head -20
echo "== salvapantallas stock"; ls -la /usr/palm/applications/com.webos.app.screensaver/qml/ 2>&1
echo "== ya montado?"; findmnt /usr/palm/applications/com.webos.app.screensaver/qml/main.qml 2>&1 || echo "no"
echo "== Gallery+ (lifeonscreen)"; ls /usr/palm/applications | grep -i -E 'life|gallery|screensaver'
echo "== disco libre"; df -h /media/developer
echo "== init.d homebrew"; ls -la /var/lib/webosbrew/init.d 2>&1
echo "== RAM"; free -m
