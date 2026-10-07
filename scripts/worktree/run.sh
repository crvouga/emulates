#!/usr/bin/env bash
# Install dependencies, then serve the docs site on this worktree's reserved
# port. Each host's Run action executes this script.
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PROJECT_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to reserve a dev-server port." >&2
  exit 1
fi

# Record the shell before exec. exec keeps this pid, so teardown can stop the
# server (and the dependency build, if delete happens mid-start).
mkdir -p "$STATE_DIR"
echo $$ >"$DEV_PID_FILE"

port="$(reserve_docs_port)"
write_port_files "$port"
export MOCKINGBIRD_DOCS_PORT="$port"
if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=4096"
fi

# Always install, and let bun rewrite bun.lock in this worktree when it must.
# A frozen install exits when the lockfile would change (a newer bun than the
# one that wrote it, or a dependency the checkout was created before), which
# stops the docs server from ever starting. A no-op install is fast.
bun install

echo "Docs dev server: http://127.0.0.1:$port"
exec bun docs
