#!/bin/sh
# Tests for src/homehook/*.sh using fake folders, a fake luna-send and a fake clock.   Run: npm test
S="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; fail=0
export STATE_DIR="$T/state"
# busybox ash's builtin sleep returns early when a background child exits: use the real one
sleep () { /bin/sleep "$@"; }
check () { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', wanted '$3')"; fail=1; fi; }
mkdir -p "$T/hook" "$T/launcher"
echo '{}' > "$T/launcher/appinfo.json"
echo '#!/bin/sh' > "$T/hook/watch.sh"
cp "$S/lib.sh" "$T/hook/lib.sh"; cp "$S/apply.sh" "$T/hook/apply.sh"

# ---- apply.sh ----
runapply () { DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" PIDFILE="$T/pid" LOG="$T/log" sh "$S/apply.sh"; }
check "apply starts the watcher when everything is in place" "$(runapply)" "applied"
mv "$T/launcher/appinfo.json" "$T/launcher/x"
check "apply refuses when the launcher is not installed" "$(runapply)" "launcher-missing"
mv "$T/launcher/x" "$T/launcher/appinfo.json"
mv "$T/hook/watch.sh" "$T/hook/x"
check "apply refuses when watch.sh is missing" "$(runapply)" "files-missing"
mv "$T/hook/x" "$T/hook/watch.sh"
# a stand-in "watcher": a process whose command line names watch.sh
sh -c 'sleep 60' watch.sh & FAKEPID=$!
FAKESTART=$(. "$S/lib.sh"; pid_ident "$FAKEPID")
echo "$FAKEPID $FAKESTART" > "$T/pid"
check "apply recognises a watcher that is already running" "$(runapply)" "applied"
check "and says so in the log" "$(grep -c 'already running' "$T/log")" "1"
rm -f "$T/pid"
check "stock.sh reports itself done" "$(DRY_RUN=1 ALLOW="$T/allow" sh "$S/stock.sh")" "stock"
check "stock.sh asks the watcher to stand down" "$([ -f "$T/allow" ] && echo yes)" "yes"
rm -f "$T/allow"
for f in lib.sh watch.sh apply.sh stock.sh diagnose.sh; do check "$f is valid shell" "$(sh -n "$S/$f" && echo ok)" "ok"; done

# ---- watch.sh: when does it open the launcher? ----
cat > "$T/luna.sh" <<'LUNA'
#!/bin/sh
case "$*" in
  *getForegroundAppInfo*) [ -f "$FRONT_FILE" ] && cat "$FRONT_FILE" ;;
  *launch*) printf '%s\n' "$*" >> "$LAUNCH_LOG" ;;
esac
LUNA
chmod +x "$T/luna.sh"
rm -f "$T/launches" "$T/allow"
watch () { NO_VERIFY=1 WATCH_STDIN=1 LUNA_SEND="$T/luna.sh" LAUNCH_LOG="$T/launches" ALLOW="$T/allow" MARK="$T/mark" VLOCK="$T/vlock" VFIX="$T/vfix" LAUNCHER="$T/launcher" LOG="$T/log" sh "$S/watch.sh"; }
launches () { if [ -f "$T/launches" ]; then wc -l < "$T/launches" | tr -d ' '; else echo 0; fi; }
fresh () { rm -f "$T/launches"; }
HOME_REPORT='{"returnValue":true,"appId":"com.webos.app.home","processId":"","windowId":""}'
APP_REPORT='{"returnValue":true,"appId":"youtube.leanback.v4","processId":"123","windowId":"4"}'
LAUNCHER_REPORT='{"returnValue":true,"appId":"tld.my.customhome","processId":"","windowId":""}'
SUB_HOME='{"returnValue":true,"subscribed":true,"appId":"com.webos.app.home","processId":"","windowId":""}'

fresh; printf '%s\n' "TIME 1000" "$APP_REPORT" | watch
check "another app in front: nothing happens" "$(launches)" "0"
fresh; printf '%s\n' "TIME 1000" '{"returnValue":true,"subscribed":true}' | watch
check "a report without an app is ignored" "$(launches)" "0"
fresh; printf '%s\n' "TIME 1000" "$HOME_REPORT" | watch
check "LG Home in front: the launcher is opened" "$(launches)" "1"
check "and it is the launcher that is opened" "$(grep -c 'tld.my.customhome' "$T/launches")" "1"
check "and the log says so, after the launch" "$(grep -c 'opened the launcher' "$T/log")" "1"
fresh; printf '%s\n' "TIME 1000" "$HOME_REPORT" "$HOME_REPORT" "$HOME_REPORT" | watch
check "LG Home reported again at once: not opened again" "$(launches)" "1"
fresh; printf '%s\n' "TIME 1000" "$HOME_REPORT" "TIME 1010" "$HOME_REPORT" | watch
check "LG Home still reported 10 s later (the first hand-over was lost): opened again" "$(launches)" "2"
fresh; printf '%s\n' "TIME 1000" "$HOME_REPORT" "$APP_REPORT" "$HOME_REPORT" | watch
check "LG Home, another app, LG Home again: opened both times" "$(launches)" "2"
fresh; printf '%s\n' "TIME 1000" "$SUB_HOME" | watch
check "a subscription report with extra fields works too" "$(launches)" "1"
fresh; printf '%s\n' "TIME 1000" "$LAUNCHER_REPORT" | watch
check "the launcher reported in front: nothing is opened by that alone" "$(launches)" "0"

# the checks must not start each other (a loop of "asking again" took the screen back from apps being opened)
checks () { grep -c 'checking that it really showed itself' "$T/log"; }
: > "$T/log"; rm -f "$T/vfix" "$T/vlock"
printf '%s\n' "TIME 1000" "$HOME_REPORT" "TIME 1004" "$LAUNCHER_REPORT" | watch
check "the launcher reported in front just after the watcher opened it: no second check" "$(checks)" "0"
printf '%s\n' "TIME 1100" "$LAUNCHER_REPORT" | watch
check "the launcher reported in front on its own (e.g. a black screen at boot): it is checked" "$(checks)" "1"
echo 1200 > "$T/vfix"
printf '%s\n' "TIME 1205" "$LAUNCHER_REPORT" | watch
check "just after a check had to ask again: not checked again (no loop)" "$(checks)" "1"
printf '%s\n' "TIME 1300" "$LAUNCHER_REPORT" | watch
check "a while after that: checked again" "$(checks)" "2"
rm -f "$T/vfix"
# one check at a time (here the checks run for real, with the TV reporting nothing in front)
slowwatch () { WATCH_STDIN=1 VERIFY_WAIT=0 FRONT_FILE="$T/nofront" LUNA_SEND="$T/luna.sh" LAUNCH_LOG="$T/launches" ALLOW="$T/allow" MARK="$T/mark" ALIVE="$T/alive" VLOCK="$T/vlock" VFIX="$T/vfix" LAUNCHER="$T/launcher" LOG="$T/log" sh "$S/watch.sh"; }
echo 2000 > "$T/vlock"
printf '%s\n' "TIME 2010" "$LAUNCHER_REPORT" | slowwatch; sleep 1
check "a check started 10 s ago is still running: no second one" "$(cat "$T/vlock" 2>/dev/null)" "2000"
printf '%s\n' "TIME 2100" "$LAUNCHER_REPORT" | slowwatch; sleep 1
check "a lock left over from long ago is ignored" "$([ "$(cat "$T/vlock" 2>/dev/null)" != 2000 ] && echo replaced)" "replaced"
rm -f "$T/vlock"

# the user asked for LG's own Home (the LG Home tile)
fresh; echo 2000 > "$T/allow"
printf '%s\n' "TIME 2002" "$HOME_REPORT" | watch
check "while LG's own Home is wanted, the watcher stands down" "$(launches)" "0"
printf '%s\n' "TIME 2003" "$APP_REPORT" | watch
check "the request is kept for a few seconds after (the launcher is still in front)" "$([ -f "$T/allow" ] && echo kept)" "kept"
printf '%s\n' "TIME 2030" "$APP_REPORT" | watch
check "once LG Home has been left for a while, the request ends" "$([ -f "$T/allow" ] && echo kept || echo ended)" "ended"
printf '%s\n' "TIME 2040" "$HOME_REPORT" | watch
check "and the next time LG Home comes to the front it is taken over again" "$(launches)" "1"

# nothing to open
fresh; mv "$T/launcher/appinfo.json" "$T/launcher/x"
printf '%s\n' "TIME 3000" "$HOME_REPORT" | watch
check "launcher uninstalled: nothing is opened (LG Home stays)" "$(launches)" "0"
mv "$T/launcher/x" "$T/launcher/appinfo.json"

# ---- watch.sh: did the launcher really show itself? ----
verify () { VFIX="$T/vfix" VERIFY_WAIT=0 WATCH_VERIFY_ONLY=1 LUNA_SEND="$T/luna.sh" LAUNCH_LOG="$T/launches" FRONT_FILE="$T/front" ALLOW="$T/allow" ALIVE="$T/alive" MARK="$T/mark" LAUNCHER="$T/launcher" LOG="$T/log" sh "$S/watch.sh"; }
rm -f "$T/allow"
fresh; echo "$HOME_REPORT" > "$T/front"; touch -t 203012312359 "$T/alive"
verify
check "the launcher showed itself: no second attempt" "$(launches)" "0"
fresh; touch -t 200001010000 "$T/alive"
verify
check "LG Home still in front and the launcher never showed: asked again, three times, then it gives up" "$(launches)" "3"
fresh; echo "$LAUNCHER_REPORT" > "$T/front"
verify
check "the TV says the launcher is in front but it never showed (a black screen): asked again" "$(launches)" "3"
fresh; echo "$APP_REPORT" > "$T/front"
verify
check "another app is in front: left alone" "$(launches)" "0"
fresh; echo "$HOME_REPORT" > "$T/front"; echo 1 > "$T/allow"
verify
check "LG's own Home was asked for: left alone" "$(launches)" "0"
rm -f "$T/allow"

# ---- a second watcher refuses to start ----
cat > "$T/quiet.sh" <<'Q'
#!/bin/sh
exit 0
Q
chmod +x "$T/quiet.sh"
mkdir -p "$T/st2" && chmod 700 "$T/st2"
mkdir "$T/st2/watcher.lock"; echo "$FAKEPID $FAKESTART" > "$T/st2/watch.pid"
timeout 10 env STATE_DIR="$T/st2" LUNA_SEND="$T/quiet.sh" LAUNCHER="$T/launcher" sh "$S/watch.sh"
check "a second watcher exits at once when one is really running" "$(grep -c 'another watcher is already running' "$T/st2/homehook.log")" "1"
check "and leaves the first one's pid file alone" "$(cut -d' ' -f1 "$T/st2/watch.pid")" "$FAKEPID"

# ---- adversarial: the state directory ----
snap () { find "$T" -path "$T/state" -prune -o -path "$T/st2" -prune -o -type f -newer "$T/hook/lib.sh" -print | sort | md5sum; }
mkdir -p "$T/victim"; echo precious > "$T/victim/file"
ln -s "$T/victim" "$T/linkstate"
check "state dir that is a symlink: apply refuses" "$(STATE_DIR="$T/linkstate" DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" sh "$S/apply.sh" 2>/dev/null)" "state-unsafe"
check "and writes nothing through the link" "$(ls "$T/victim")" "file"
mkdir -m 755 "$T/open755"
check "state dir with mode 755: apply refuses" "$(STATE_DIR="$T/open755" DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" sh "$S/apply.sh" 2>/dev/null)" "state-unsafe"
mkdir -m 700 "$T/foreign"
check "state dir owned by someone else: apply refuses" "$(EXPECT_UID=99999 STATE_DIR="$T/foreign" DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" sh "$S/apply.sh" 2>/dev/null)" "state-unsafe"
check "and creates nothing inside it" "$(ls -A "$T/foreign" | wc -l | tr -d ' ')" "0"
mkdir -m 777 "$T/ww"
check "parent writable by everyone and not sticky: refuse" "$(STATE_DIR="$T/ww/s" DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" sh "$S/apply.sh" 2>/dev/null)" "state-unsafe"
check "and the directory is not even created" "$([ -e "$T/ww/s" ] && echo created || echo none)" "none"
mkdir -m 1777 "$T/sticky"
check "parent world-writable but sticky: allowed, dir created 0700" "$(STATE_DIR="$T/sticky/s" DRY_RUN=1 APP_QML="$T/qml" HOOK="$T/hook" LAUNCHER="$T/launcher" sh "$S/apply.sh" 2>/dev/null; ls -ld "$T/sticky/s" | cut -c1-10)" "applied
drwx------"
check "unsafe state: the stock request is refused too" "$(STATE_DIR="$T/linkstate" sh "$S/stock.sh" 2>/dev/null)" "state-unsafe"

# ---- adversarial: planted links inside the state dir cannot redirect writes ----
mkdir -m 700 "$T/st3"; ln -s "$T/victim/file" "$T/st3/watch.pid"
timeout 5 env STATE_DIR="$T/st3" LUNA_SEND="$T/quiet.sh" LAUNCHER="$T/launcher" sh "$S/watch.sh" >/dev/null 2>&1
check "a pid file pre-planted as a symlink is replaced, never written through" "$(cat "$T/victim/file")" "precious"

# ---- pid identity: a reused pid is not trusted ----
( . "$S/lib.sh"; PIDFILE="$T/pid"
  echo "$FAKEPID 1" > "$PIDFILE"; watcher_running && echo yes || echo no ) > "$T/out1"
check "same pid, different start time (pid reuse): not the watcher" "$(cat "$T/out1")" "no"
( . "$S/lib.sh"; PIDFILE="$T/pid"
  echo "$$ $(pid_ident $$)" > "$PIDFILE"; watcher_running && echo yes || echo no ) > "$T/out2"
check "right pid and start time but the process is not watch.sh: not the watcher" "$(cat "$T/out2")" "no"
( . "$S/lib.sh"; PIDFILE="$T/pid"
  echo "$FAKEPID $FAKESTART" > "$PIDFILE"; watcher_running && echo yes || echo no ) > "$T/out3"
check "right pid, start time and command line: the watcher" "$(cat "$T/out3")" "yes"
( . "$S/lib.sh"; PIDFILE="$T/pid"; echo "abc; rm -rf /" > "$PIDFILE"; watcher_running && echo yes || echo no ) > "$T/out4"
check "a garbage pid file is not trusted (and never executed)" "$(cat "$T/out4")" "no"
kill "$FAKEPID" 2>/dev/null

# ---- concurrency: six watchers started together, one wins ----
mkdir -p "$T/w"; cp "$S/watch.sh" "$S/lib.sh" "$T/w/"
printf '#!/bin/sh\nsleep 30\n' > "$T/sleeper.sh"; chmod +x "$T/sleeper.sh"
mkdir -m 700 "$T/st4"
for i in 1 2 3 4 5 6; do STATE_DIR="$T/st4" LUNA_SEND="$T/sleeper.sh" LAUNCHER="$T/launcher" sh "$T/w/watch.sh" >/dev/null 2>&1 & done
sleep 2
check "six watchers started at once: exactly one starts" "$(grep -c 'started (pid' "$T/st4/homehook.log")" "1"
WP=$(cut -d' ' -f1 "$T/st4/watch.pid")
kill -9 "$WP" 2>/dev/null; sleep 1; pkill -f "$T/sleeper.sh" 2>/dev/null
check "after kill -9 the leftover lock is stale: a new watcher recovers it and starts" "$(STATE_DIR="$T/st4" LUNA_SEND="$T/sleeper.sh" LAUNCHER="$T/launcher" timeout 3 sh "$T/w/watch.sh" >/dev/null 2>&1; grep -c 'started (pid' "$T/st4/homehook.log")" "2"
pkill -f "$T/sleeper.sh" 2>/dev/null

# ---- stress: stale lock + many contenders, repeated; never two watchers ----
bad=0
for round in 1 2 3 4 5 6 7 8 9 10 11 12; do
    d="$T/stress$round"; mkdir -m 700 "$d"; mkdir "$d/watcher.lock"          # leftover lock, no live owner
    [ $((round % 2)) -eq 0 ] && echo "999999 1" > "$d/watch.pid"              # even rounds: pid file of a dead process
    for i in 1 2 3 4 5 6; do STATE_DIR="$d" LUNA_SEND="$T/sleeper.sh" LAUNCHER="$T/launcher" sh "$T/w/watch.sh" >/dev/null 2>&1 & done
    i=0; while [ $i -lt 40 ]; do [ -s "$d/watch.pid" ] && [ ! -e "$d/watcher.lock.rec" ] && break; sleep 0.1; i=$((i+1)); done; sleep 0.5
    n=$(grep -c 'started (pid' "$d/homehook.log" 2>/dev/null); [ "$n" = "1" ] || bad=$((bad+1))
    live=$(for p in $(pgrep -f "$T/w/watch.sh"); do echo "$p"; done | wc -l | tr -d ' ')
    pkill -9 -f "$T/w/watch.sh" 2>/dev/null; pkill -f "$T/sleeper.sh" 2>/dev/null; sleep 0.2
done
check "stress: 12 rounds x 6 contenders on a stale lock: exactly one watcher every round (stale lock, dead pid file)" "$bad" "0"

# ---- fail closed when /proc identity is unavailable ----
mkdir -m 700 "$T/np"
sleep 0.2
check "no /proc identity for ourselves: refuse to start (exit 5), nothing written" "$(PROC_DIR=/nonexistent STATE_DIR="$T/np" LUNA_SEND="$T/quiet.sh" LAUNCHER="$T/launcher" sh "$S/watch.sh" >/dev/null 2>&1; echo "$? $(ls -A "$T/np" | tr '\n' ' ')")" "5 "
# a live owner whose /proc entry cannot be read is NOT stolen from
mkdir -m 700 "$T/unk" "$T/fakeproc" "$T/fakeproc/4242"
mkdir "$T/unk/watcher.lock"; echo "4242 777" > "$T/unk/watch.pid"
SELF=$$
mkdir -p "$T/fakeproc/$SELF"
# every process we spawn needs a stat in the fake tree: use a wrapper that copies the real one for its own pid
cat > "$T/unk.sh" <<U
#!/bin/sh
mkdir -p "$T/fakeproc/\$\$"; cp /proc/\$\$/stat "$T/fakeproc/\$\$/stat"
exec env PROC_DIR="$T/fakeproc" STATE_DIR="$T/unk" LUNA_SEND="$T/quiet.sh" LAUNCHER="$T/launcher" sh "$S/watch.sh"
U
timeout 10 sh "$T/unk.sh" >/dev/null 2>&1
check "owner entry exists but its stat is unreadable: lock is not taken over" "$(grep -c 'cannot tell whether the lock owner is alive' "$T/unk/homehook.log")" "1"
check "and the owner's pid file is untouched" "$(cat "$T/unk/watch.pid")" "4242 777"

# ---- script owner is checked, not only the mode ----
cp "$S/watch.sh" "$T/hook/watch.sh"; chmod 755 "$T/hook/watch.sh"
check "scripts owned by another uid: apply refuses" "$(FILES_UID=99999 runapply)" "files-writable"
check "scripts owned by the running uid and mode 755: apply proceeds" "$(runapply)" "applied"

# ---- scripts that another user could edit are not started ----
cp "$S/watch.sh" "$T/hook/watch.sh"; chmod 666 "$T/hook/watch.sh"
check "a group/other-writable watch.sh: apply refuses to start it" "$(runapply)" "files-writable"
chmod 644 "$T/hook/watch.sh"

# ---- diagnose never writes into /tmp ----
before=$(ls /tmp/customhome-* 2>/dev/null | wc -l | tr -d ' ')
STATE_DIR="$T/diag" sh "$S/diagnose.sh" >/dev/null 2>&1
after=$(ls /tmp/customhome-* 2>/dev/null | wc -l | tr -d ' ')
check "diagnose leaves nothing in /tmp" "$after" "$before"
check "diagnose writes its report into the private state dir" "$([ -s "$T/diag/diagnose.txt" ] && echo yes)" "yes"
check "diagnose on an unsafe state dir writes nothing" "$(STATE_DIR="$T/linkstate" sh "$S/diagnose.sh" 2>&1 | grep -c 'nothing written')" "1"
check "and the symlink target is untouched" "$(ls "$T/victim")" "file"

rm -rf "$T"
exit $fail
