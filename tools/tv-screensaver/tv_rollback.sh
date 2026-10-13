#!/bin/sh
# Deshace todo: desmonta, quita autoarranque. Las imagenes se quedan (borrar con: rm -rf /media/developer/art-kit /media/developer/art)
T=/usr/palm/applications/com.webos.app.screensaver/qml/main.qml
findmnt "$T" >/dev/null 2>&1 && umount "$T" && echo "[+] desmontado" || echo "no estaba montado"
rm -f /var/lib/webosbrew/init.d/50-art-screensaver && echo "[+] autoarranque quitado"
echo "Si algo raro: reiniciar la TV (el bind mount no sobrevive a un reinicio sin el init.d)."
