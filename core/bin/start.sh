#!/bin/zsh
# Start gnome-core with env from infra/.env (used by the com.gnome.core LaunchAgent)
set -eu
ROOT="${0:A:h:h:h}"           # .../gnome
ENV_FILE="$ROOT/infra/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
else
  echo "warning: $ENV_FILE not found, using defaults" >&2
fi
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
cd "$ROOT/core"
exec "$NODE_BIN" dist/index.js
