#!/bin/sh
# Lets LG's own Home be shown: the watcher stands down until the user leaves LG Home again.
# The launcher runs this before opening LG Home from its "LG Home" tile.

APP_QML="${APP_QML:-/usr/palm/applications/com.webos.app.home/qml}"
ALLOW="${ALLOW:-/tmp/customhome-allow-stock-home}"

# NOTA (port a tv-home): se omite el umount heredado de Hearth. Este arbol NUNCA
# ha montado nada sobre el QML de LG Home; desmontar algo montado por otro
# instalador seria pisar trabajo ajeno. diagnose.sh lo comprueba en solo lectura.
date +%s > "$ALLOW"
echo stock
