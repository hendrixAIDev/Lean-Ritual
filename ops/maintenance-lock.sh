#!/usr/bin/env bash
# Root-installed as /usr/local/sbin/bojin-maintenance-lock (or invoked via sudo as
# ops/maintenance-lock.sh from a reviewed checkout). Acquires /run/bojin/maintenance.lock
# first and /run/lock/bojin-maintenance.lock second for the one-release transition,
# then executes the given command while holding both kernel flocks (O_CLOEXEC).
set -euo pipefail

LOCK_FILE=${BOJIN_MAINTENANCE_LOCK_FILE:-/run/bojin/maintenance.lock}
LEGACY_LOCK_FILE=${BOJIN_MAINTENANCE_LEGACY_LOCK_FILE:-/run/lock/bojin-maintenance.lock}
TEST_MODE=${BOJIN_LOCK_TEST_MODE:-0}

if [[ "$EUID" -ne 0 ]] && ! [[ "$TEST_MODE" == 1 && "$LOCK_FILE" == /* && "$LOCK_FILE" != /run/* ]]; then
  echo "Run with sudo (root required)" >&2
  exit 1
fi

nonblock=0
while (( $# > 0 )); do
  case "$1" in
    -n|--nonblock)
      nonblock=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Usage: bojin-maintenance-lock [-n|--nonblock] [--] <command> [args...]" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if (( $# == 0 )); then
  echo "Usage: bojin-maintenance-lock [-n|--nonblock] [--] <command> [args...]" >&2
  exit 2
fi

path_uid() {
  if stat -c '%u' / >/dev/null 2>&1; then
    stat -c '%u' -- "$1"
  else
    stat -f '%u' "$1"
  fi
}

LOCK_DIR=$(dirname -- "$LOCK_FILE")
[[ ! -L "$LOCK_DIR" ]] || { echo "Refusing symlink maintenance lock directory: $LOCK_DIR" >&2; exit 1; }
if [[ ! -e "$LOCK_DIR" ]]; then
  install -d -o root -g root -m 0755 "$LOCK_DIR"
fi
[[ ! -L "$LOCK_DIR" && -d "$LOCK_DIR" && "$(path_uid "$LOCK_DIR")" == 0 ]] || {
  echo "Refusing non-root or invalid maintenance lock directory: $LOCK_DIR" >&2
  exit 1
}
[[ ! -L "$LOCK_FILE" ]] || { echo "Refusing symlink maintenance lock: $LOCK_FILE" >&2; exit 1; }
if [[ -e "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && "$(path_uid "$LOCK_FILE")" == 0 ]] || {
    echo "Refusing non-root or non-regular maintenance lock: $LOCK_FILE" >&2
    exit 1
  }
fi

exec python3 -c '
import errno, fcntl, os, signal, stat, subprocess, sys, syslog

lock_path, legacy_path = sys.argv[1], sys.argv[2]
nonblock = sys.argv[3] == "1"
test_mode = sys.argv[4] == "1"
cmd = sys.argv[5:]

nofollow = getattr(os, "O_NOFOLLOW", 0)
open_flags = os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC | nofollow
flock_op = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblock else 0)

try:
    new_fd = os.open(lock_path, open_flags, 0o600)
except OSError as exc:
    sys.stderr.write(f"Failed to open maintenance lock {lock_path}: {exc}\n")
    sys.exit(1)

legacy_fd = None
try:
    new_st = os.fstat(new_fd)
    if not stat.S_ISREG(new_st.st_mode) or (not test_mode and new_st.st_uid != 0):
        sys.stderr.write(f"Refusing unsafe maintenance lock: {lock_path}\n")
        sys.exit(1)
    try:
        fcntl.flock(new_fd, flock_op)
    except BlockingIOError:
        sys.exit(1)

    try:
        legacy_fd = os.open(legacy_path, open_flags, 0o600)
    except OSError as exc:
        if exc.errno != errno.EACCES:
            sys.stderr.write(f"Failed to open legacy maintenance lock {legacy_path}: {exc}\n")
            sys.exit(1)
        retry_flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | nofollow
        try:
            legacy_fd = os.open(legacy_path, retry_flags)
        except OSError as retry_exc:
            sys.stderr.write(f"Failed to open existing legacy maintenance lock {legacy_path}: {retry_exc}\n")
            sys.exit(1)
        warn = (
            f"bojin-maintenance-lock: O_CREAT on legacy lock {legacy_path} failed with EACCES "
            f"(fs.protected_regular); opened existing file without O_CREAT for flock"
        )
        syslog.syslog(syslog.LOG_WARNING, warn)
        sys.stderr.write("Warning: " + warn + "\n")

    leg_st = os.fstat(legacy_fd)
    if not stat.S_ISREG(leg_st.st_mode):
        sys.stderr.write(f"Refusing non-regular legacy maintenance lock: {legacy_path}\n")
        sys.exit(1)
    try:
        fcntl.flock(legacy_fd, flock_op)
    except BlockingIOError:
        sys.exit(1)

    child = subprocess.Popen(cmd)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda signum, _frame: child.send_signal(signum))
    rc = child.wait()
    sys.exit(rc if rc >= 0 else 128 - rc)
finally:
    if legacy_fd is not None:
        os.close(legacy_fd)
    os.close(new_fd)
' "$LOCK_FILE" "$LEGACY_LOCK_FILE" "$nonblock" "$TEST_MODE" "$@"
