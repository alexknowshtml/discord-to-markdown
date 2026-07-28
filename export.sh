#!/usr/bin/env bash
# Export a Discord guild's channels and threads to per-channel markdown files.
# Pulls messages from startDate (set in src/discord/config.ts) to present,
# 150 at a time, advancing cursors after each batch.
#
# Usage:
#   ./export.sh                        (reads from .env)
#   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... ./export.sh
#
# Output: export/<channel-name>.md — one file per channel, threads as ## sections.
# Re-running resumes from where it left off (cursors in state/discord.json).
# To start fresh: rm state/discord.json
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

mkdir -p export state .cache

MAX_RETRIES=5
total=0
pass=0

fetch_with_backoff() {
  local attempt=1
  while true; do
    if bash run.sh fetch --commit 2>/dev/null; then
      return 0
    fi
    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      echo "Fetch failed after $MAX_RETRIES attempts. Aborting." >&2
      exit 1
    fi
    local wait=$((2 ** attempt))
    echo "Fetch failed (attempt $attempt/$MAX_RETRIES), retrying in ${wait}s..."
    sleep "$wait"
    attempt=$((attempt + 1))
  done
}

while true; do
  pass=$((pass + 1))

  fetch_with_backoff

  count=$(python3 -c "import json; print(len(json.load(open('.cache/discord-new.json'))))")

  if [ "$count" -eq 0 ]; then
    echo "Done. $total messages exported across $((pass - 1)) passes."
    echo "Output: export/"
    ls -lh export/*.md 2>/dev/null || true
    break
  fi

  total=$((total + count))
  echo "Pass $pass: +$count messages (total: $total)"

  python3 << 'PYEOF'
import json
from datetime import datetime, timezone
from pathlib import Path

Path("export").mkdir(exist_ok=True)

with open(".cache/discord-new.json") as f:
    messages = json.load(f)

by_channel = {}
for m in messages:
    ch = m["channel_name"]
    if ch not in by_channel:
        by_channel[ch] = []
    by_channel[ch].append(m)

for channel, msgs in by_channel.items():
    path = Path(f"export/{channel}.md")
    if not path.exists():
        path.write_text(f"# #{channel}\n\n")

    with open(path, "a") as f:
        current_thread = "__unset__"
        for m in msgs:
            thread = m.get("thread_name")
            if thread != current_thread:
                current_thread = thread
                if thread:
                    f.write(f"\n## Thread: {thread}\n\n")

            ts = datetime.fromisoformat(m["created_at"].replace("Z", "+00:00"))
            ts_str = ts.strftime("%b %-d, %Y %-I:%M %p UTC")

            ref = m.get("referenced")
            if ref:
                preview = ref["content"][:120].replace("\n", " ")
                f.write(f"> **@{ref['author']}:** {preview}\n\n")

            f.write(f"**@{m['author']}** — {ts_str}\n")
            f.write(f"{m['content']}\n\n")
PYEOF

done
