#!/bin/sh
# Makes sure the watcher (watch.sh) is running, so that LG Home is replaced by the launcher.
# Safe to run again and again. Prints one word: applied, launcher-missing or files-missing.
# Run at boot by a link in /var/lib/webosbrew/init.d, and by the launcher whenever it opens.

APP_QML="${APP_QML:-/usr/palm/applications/com.webos.app.home/qml}"
HOOK="${HOOK:-/media/developer/customhome-homehook}"
LAUNCHER="${LAUNCHER:-/media/developer/apps/usr/palm/applications/tld.my.customhome}"
PIDFILE="${PIDFILE:-/tmp/customhome-homehook-watch.pid}"
LOG="${LOG:-/tmp/customhome-homehook.log}"

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

if [ ! -f "$HOOK/watch.sh" ]; then
    log "watch.sh missing: not starting the watcher"
    echo files-missing
    exit 4
fi

# Already running?
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "watcher already running (pid $(cat "$PIDFILE"))"
    echo applied
    exit 0
fi

if [ -z "$DRY_RUN" ]; then
    ( nohup sh "$HOOK/watch.sh" >/dev/null 2>&1 </dev/null & )
fi
log "watcher started"
echo applied
