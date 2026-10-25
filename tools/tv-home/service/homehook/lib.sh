# Shared helpers for the homehook scripts (sourced, not run). These scripts may run as root, so
# NOTHING predictable in a shared directory (/tmp) may be written, truncated or removed by them:
# a pre-planted symlink there would turn that write into "overwrite any file as root".
#
#  * All private state (pid, log, locks, marks, the "show LG Home" request) lives in ONE directory,
#    STATE_DIR, that is created here with mode 0700 and checked on every start: it must be a real
#    directory (not a symlink), owned by the user running the script, not accessible to others,
#    inside a parent that others cannot rename/replace entries in (not world-writable, or sticky).
#    If any check fails the script REFUSES to start (message on stderr) and writes nothing.
#  * A process is "the watcher" only if its pid AND its start time (from /proc) match what was
#    recorded and its command line is watch.sh: a reused pid is never trusted.
#  * The only file the launcher side writes is the heartbeat (HB_FILE), in its own directory; the
#    root side only READS its modification time and ignores it if it is a symlink.

STATE_DIR="${STATE_DIR:-/var/run/customhome-homehook}"
HB_FILE="${HB_FILE:-/tmp/customhome-hb/alive}"

_perm_uid () { # prints "<perms> <uid>" of a path without following a trailing symlink
    set -- $(ls -ldn "$1" 2>/dev/null) || return 1
    [ -n "$1" ] && echo "$1 $3"
}

state_init () {
    d="$STATE_DIR"
    me="${EXPECT_UID:-$(id -u)}"
    parent="$(dirname "$d")"
    if [ -L "$d" ]; then echo "homehook: $d is a symlink: refusing" >&2; return 1; fi
    # the parent must not let other users rename or replace our directory
    set -- $(_perm_uid "$parent"); pperm="$1"; puid="$2"
    case "$pperm" in
        d*) ;; *) echo "homehook: $parent is not a directory: refusing" >&2; return 1 ;;
    esac
    if [ "$(echo "$pperm" | cut -c9)" = "w" ] && [ "$(echo "$pperm" | cut -c10)" != "t" ]; then
        echo "homehook: $parent is writable by everyone and not sticky: refusing" >&2; return 1
    fi
    [ -e "$d" ] || ( umask 077; mkdir -m 700 "$d" ) 2>/dev/null
    if [ -L "$d" ] || [ ! -d "$d" ]; then echo "homehook: $d is not a plain directory: refusing" >&2; return 1; fi
    set -- $(_perm_uid "$d"); dperm="$1"; duid="$2"
    if [ "$duid" != "$me" ]; then echo "homehook: $d belongs to uid $duid, not $me: refusing" >&2; return 1; fi
    if [ "$dperm" != "drwx------" ]; then echo "homehook: $d has mode $dperm, not drwx------: refusing" >&2; return 1; fi
    state_paths
    return 0
}

# Default file names inside STATE_DIR (tests pass their own paths through the environment).
state_paths () {
    PIDFILE="${PIDFILE:-$STATE_DIR/watch.pid}"
    LOG="${LOG:-$STATE_DIR/homehook.log}"
    ALLOW="${ALLOW:-$STATE_DIR/allow-stock-home}"
    MARK="${MARK:-$STATE_DIR/launch-mark}"
    VLOCK="${VLOCK:-$STATE_DIR/verify-lock}"
    VFIX="${VFIX:-$STATE_DIR/verify-fix}"
    WLOCK="${WLOCK:-$STATE_DIR/watcher.lock}"
    ALIVE="${ALIVE:-$HB_FILE}"
}

# "<pid> <starttime>" of a live process, from /proc (field 22 of stat; the command name may hold spaces).
pid_ident () {
    [ -r "/proc/$1/stat" ] || return 1
    read -r _ rest < "/proc/$1/stat" || return 1
    rest="${rest##*) }"
    set -- "$1" $rest
    [ "$#" -ge 21 ] || return 1
    shift 20
    echo "$1"
}

# True only if the pid file names a process with the SAME pid and start time whose command line is watch.sh.
watcher_running () {
    [ -f "$PIDFILE" ] && [ ! -L "$PIDFILE" ] || return 1
    read -r wpid wstart < "$PIDFILE" 2>/dev/null || return 1
    case "$wpid" in ''|*[!0-9]*) return 1 ;; esac
    [ -n "$wstart" ] || return 1
    now_start="$(pid_ident "$wpid")" || return 1
    [ "$now_start" = "$wstart" ] || return 1
    case "$(tr '\0' ' ' < "/proc/$wpid/cmdline" 2>/dev/null)" in *watch.sh*) return 0 ;; esac
    return 1
}

# The scripts run as root: refuse to use any of them if another user could have edited them.
files_trusted () { # dir file...
    dir="$1"; shift
    for f in "$@"; do
        set -- $(_perm_uid "$dir/$f") || return 1
        [ "$(echo "$1" | cut -c6)" = "-" ] && [ "$(echo "$1" | cut -c9)" = "-" ] || return 1
    done
    return 0
}
