#!/usr/bin/env bash
# Fetch one batch of Discord messages (up to 150) and write to .cache/discord-new.json.
# Cursors advance only when --commit is passed.
#
# Usage:
#   ./run.sh fetch [--commit]          (reads from .env)
#   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... ./run.sh fetch [--commit]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN in .env or environment}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID in .env or environment}"

export DISCORD_BOT_TOKEN
export DISCORD_GUILD_ID

node --experimental-strip-types src/main.ts discord "$@"
