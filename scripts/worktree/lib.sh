# shellcheck shell=bash
# Shared helpers for setup, run, and teardown. Sourced, not executed.
#
# Nothing here reads a host's own variables (SUPERSET_*, SUPER_ENGINEERING_*, ...). Every
# orchestrator runs these scripts inside a git worktree, so the worktree and the main checkout
# are derived from git, and the scripts behave the same under any host or none.
WORKTREE_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$WORKTREE_SCRIPTS_DIR/../.." && pwd -P)"
# Per-worktree runtime state (gitignored).
STATE_DIR="$PROJECT_ROOT/.worktree"
DEV_PORT_FILE="$STATE_DIR/dev-port"
DEV_PID_FILE="$STATE_DIR/dev-server.pid"
# Superset labels a listening port from this file; other hosts ignore it.
SUPERSET_PORTS_JSON="$PROJECT_ROOT/.superset/ports.json"

export WORKTREE_PATH="$PROJECT_ROOT"

# The main checkout this worktree was created from (itself, when run there).
main_checkout() {
  local common
  common="$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
    return 1
  (cd "$common/.." && pwd -P)
}

copy_local_files() {
  local root_real
  if ! root_real="$(main_checkout)"; then
    echo "Not inside a git checkout; skipping copy of local files."
    return 0
  fi
  if [ "$root_real" = "$PROJECT_ROOT" ]; then
    echo "Worktree is the main checkout; nothing to copy."
    return 0
  fi

  local copied=0
  local path target
  while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    [ -f "$root_real/$path" ] || continue
    target="$PROJECT_ROOT/$path"
    [ -e "$target" ] && continue
    mkdir -p "$(dirname "$target")"
    cp -p "$root_real/$path" "$target"
    copied=$((copied + 1))
    echo "copied $path"
  done < <(git -C "$root_real" ls-files --others --exclude-standard -z)

  local source relative
  while IFS= read -r -d '' source; do
    relative="${source#"$root_real"/}"
    case "$relative" in
      .env.example | */.env.example) continue ;;
    esac
    target="$PROJECT_ROOT/$relative"
    [ -e "$target" ] && continue
    mkdir -p "$(dirname "$target")"
    cp -p "$source" "$target"
    copied=$((copied + 1))
    echo "copied $relative"
  done < <(
    find "$root_real" \
      \( -name node_modules -o -name .git -o -name dist -o -name .turbo -o -name .emulators \) -prune \
      -o -type f \( -name '.env' -o -name '.env.*' \) -print0
  )

  echo "Copied $copied local file(s) from $root_real"
}

write_port_files() {
  local port="$1"
  mkdir -p "$STATE_DIR" "$(dirname "$SUPERSET_PORTS_JSON")"
  printf '%s\n' "$port" >"$DEV_PORT_FILE"
  PORT_NUM="$port" PORTS_JSON="$SUPERSET_PORTS_JSON" python3 -c '
import json, os
port = int(os.environ["PORT_NUM"])
path = os.environ["PORTS_JSON"]
with open(path, "w") as handle:
    json.dump({"ports": [{"port": port, "label": "Docs"}]}, handle, indent=2)
    handle.write("\n")
'
}

reserve_docs_port() {
  python3 "$WORKTREE_SCRIPTS_DIR/port.py" reserve
}

release_docs_port() {
  python3 "$WORKTREE_SCRIPTS_DIR/port.py" release
}

# Stop the dev server this worktree started. Only the recorded pid is signaled,
# and only when that process is still running inside this checkout, so a reused
# pid is left alone.
stop_dev_server() {
  if [ ! -f "$DEV_PID_FILE" ]; then
    return 0
  fi
  local pid
  pid="$(tr -d '[:space:]' <"$DEV_PID_FILE")"
  if [ -z "$pid" ]; then
    rm -f "$DEV_PID_FILE"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$DEV_PID_FILE"
    return 0
  fi

  local cwd="" cwd_real=""
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
  if [ -n "$cwd" ] && [ -d "$cwd" ]; then
    cwd_real="$(cd "$cwd" && pwd -P)"
  fi
  case "$cwd_real" in
    "$PROJECT_ROOT" | "$PROJECT_ROOT"/*) ;;
    *)
      echo "dev server pid $pid is now '$cwd'; leaving it alone."
      rm -f "$DEV_PID_FILE"
      return 0
      ;;
  esac

  local pids=()
  collect_pids() {
    local current="$1"
    local child
    pids+=("$current")
    for child in $(pgrep -P "$current" || true); do
      collect_pids "$child"
    done
  }
  collect_pids "$pid"

  local index=$((${#pids[@]} - 1))
  # Children first, so they are not reparented out from under the walk.
  while [ "$index" -ge 0 ]; do
    kill -TERM "${pids[$index]}" 2>/dev/null || true
    index=$((index - 1))
  done

  local _try
  for _try in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  index=$((${#pids[@]} - 1))
  while [ "$index" -ge 0 ]; do
    kill -KILL "${pids[$index]}" 2>/dev/null || true
    index=$((index - 1))
  done
  rm -f "$DEV_PID_FILE"
  echo "Stopped docs dev server (pid $pid)."
}
