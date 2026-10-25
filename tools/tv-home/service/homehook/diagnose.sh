#!/bin/sh
# Collects what is needed to see why the launcher does not open when LG Home comes to the front.
# Run it on the TV over SSH and paste the output:   sh /media/developer/customhome-homehook/diagnose.sh
# (the same text is saved in the private state directory, diagnose.txt there)

HOOK=/media/developer/customhome-homehook
APP_QML=/usr/palm/applications/com.webos.app.home/qml
HERE="$(cd "$(dirname "$0")" && pwd)"
L="${HOMEHOOK_LIB:-$HERE/lib.sh}"; [ -f "$L" ] || L="$HOOK/lib.sh"; . "$L" || exit 5
# Nothing is written to /tmp: the report and the self-test files go in the private state directory.
state_init || { echo "state directory is not safe (see message above): nothing written"; exit 5; }
OUT="$STATE_DIR/diagnose.txt"
SELF="$STATE_DIR/selftest"

{
echo "== time";                       date
echo "== files";                      ls -l "$HOOK" 2>&1
echo "== version";                    cat "$HOOK/version" 2>&1
echo "== startup links";              ls -l /var/lib/webosbrew/init.d/ 2>&1
echo "== watcher"
if watcher_running; then echo "running, pid $wpid"; else echo "NOT running (pid file: $(cat "$PIDFILE" 2>&1))"; fi
echo "-- every watch.sh / luna-send subscription process (more than one watch.sh is a problem):"
ps 2>&1 | grep -E "[w]atch.sh|[g]etForegroundAppInfo"
echo "== do the scripts parse on this TV's shell?"
for f in watch.sh apply.sh stock.sh lib.sh; do if sh -n "$HOOK/$f" 2>&1; then echo "$f: syntax OK"; else echo "$f: SYNTAX PROBLEM"; fi; done
echo "== does the watcher's decision logic work on this TV's shell? (should say WOULD OPEN, once)"
rm -rf "$SELF"; mkdir -m 700 "$SELF" || echo "(self-test skipped: cannot create $SELF)"
printf '#!/bin/sh\necho "WOULD OPEN: $*"\n' > "$SELF/luna.sh"; chmod +x "$SELF/luna.sh"
sed 's#>/dev/null 2>&1$##' "$HOOK/watch.sh" > "$SELF/watch.sh"
echo '{"returnValue":true,"appId":"com.webos.app.home","processId":"","windowId":""}' | NO_VERIFY=1 WATCH_STDIN=1 HOMEHOOK_LIB="$HOOK/lib.sh" LUNA_SEND="$SELF/luna.sh" LOG=/dev/null ALLOW="$SELF/allow" sh "$SELF/watch.sh" 2>&1 || echo "(self-test failed)"
rm -rf "$SELF"
echo "== has the launcher shown itself recently? (the launcher touches this file when it is on screen)"; ls -l "$HB_FILE" "$MARK" 2>&1
echo "== is a launcher process running? (pgrep -f)"; pgrep -f tld.my.customhome 2>&1 | head -5 || echo "none found"
echo "== files in the state directory"; ls -l "$STATE_DIR" 2>&1
echo "== stand-in still mounted over LG Home's QML? (should be 'no')"; grep " $APP_QML " /proc/mounts || echo "no"
echo "== user asked for LG's own Home? (file exists = yes)"; ls -l "$ALLOW" 2>&1
echo "== LG Home process(es)";        ps 2>&1 | grep -i "[c]om.webos.app.home"
echo "== launcher installed?";        ls /media/developer/apps/usr/palm/applications/tld.my.customhome 2>&1 | head -5
echo "== app in front right now";     luna-send -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>&1
echo "== log ($LOG)";  tail -n 60 "$LOG" 2>&1
echo "== end"
} 2>&1 | tee "$OUT"
