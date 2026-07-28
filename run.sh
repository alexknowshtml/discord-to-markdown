#!/usr/bin/env bash
# Fetch one batch of Discord messages (up to 150) and write to .cache/discord-new.json.
# Cursors advance only when --commit is passed.
#
# Usage:
#   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... ./run.sh fetch [--commit]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN before running}"
: "${DISCORD_GUILD_ID:?Set DISCORD_GUILD_ID before running}"

export DISCORD_BOT_TOKEN
export DISCORD_GUILD_ID

node --experimental-strip-types src/main.ts discord "$@"
