#!/bin/sh
# Lets LG's own Home be shown: the watcher stands down until the user leaves LG Home again.
# The launcher runs this before opening LG Home from its "LG Home" tile.

APP_QML="${APP_QML:-/usr/palm/applications/com.webos.app.home/qml}"
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${HOMEHOOK_LIB:-$HERE/lib.sh}"; [ -f "$L" ] || L="/media/developer/customhome-homehook/lib.sh"; . "$L" || exit 5
state_init || { echo state-unsafe; exit 5; }

# NOTA (port a tv-home): se omite el umount heredado de Hearth. Este arbol NUNCA
# ha montado nada sobre el QML de LG Home; desmontar algo montado por otro
# instalador seria pisar trabajo ajeno. diagnose.sh lo comprueba en solo lectura.
date +%s > "$ALLOW"
echo stock
