#!/bin/sh
# Makes sure the watcher (watch.sh) is running, so that LG Home is replaced by the launcher.
# Safe to run again and again (the watcher itself allows only one instance). Prints one word:
# applied, launcher-missing, files-missing, state-unsafe or files-writable.
# Run at boot by a link in /var/lib/webosbrew/init.d, and by the launcher whenever it opens.

APP_QML="${APP_QML:-/usr/palm/applications/com.webos.app.home/qml}"
HOOK="${HOOK:-/media/developer/customhome-homehook}"
LAUNCHER="${LAUNCHER:-/media/developer/apps/usr/palm/applications/tld.my.customhome}"
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${HOMEHOOK_LIB:-$HERE/lib.sh}"; [ -f "$L" ] || L="/media/developer/customhome-homehook/lib.sh"; . "$L" || exit 5
# Private state directory (0700, checked): refuse to run, and write nothing, if it is not safe.
state_init || { echo state-unsafe; exit 5; }

log () { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

# NOTA (port a tv-home): se omite el umount heredado de Hearth. Este arbol NUNCA
# ha montado nada sobre el QML de LG Home; desmontar algo montado por otro
# instalador seria pisar trabajo ajeno. diagnose.sh lo comprueba en solo lectura.

# The launcher must be installed (if it was uninstalled, LG Home is left alone).
if [ ! -f "$LAUNCHER/appinfo.json" ]; then
    log "launcher not installed: not starting the watcher"
    echo launcher-missing
    exit 2
fi

if [ ! -f "$HOOK/watch.sh" ] || [ ! -f "$HOOK/lib.sh" ]; then
    log "watch.sh or lib.sh missing: not starting the watcher"
    echo files-missing
    exit 4
fi

# These scripts run as root: do not start code another user could have edited.
if ! files_trusted "$HOOK" watch.sh lib.sh apply.sh; then
    log "scripts in $HOOK are writable by group/others: not starting the watcher"
    echo files-writable
    exit 6
fi

# Already running? (pid AND start time must match, and the process must be watch.sh)
if watcher_running; then
    log "watcher already running (pid $wpid)"
    echo applied
    exit 0
fi

if [ -z "$DRY_RUN" ]; then
    ( nohup sh "$HOOK/watch.sh" >/dev/null 2>&1 </dev/null & )
fi
log "watcher started"
echo applied
