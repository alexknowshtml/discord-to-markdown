#!/usr/bin/env bash
# Export a Discord guild's channels and threads to per-channel markdown files.
# Pulls messages from startDate (set in src/discord/config.ts) to present,
# 150 at a time, advancing cursors after each batch. All messages are
# accumulated across passes and written once at the end, sorted by timestamp,
# so threads appear inline at their chronological position rather than at bottom.
#
# Usage:
#   ./export.sh                        (reads from .env)
#   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... ./export.sh
#
# Output: export/<channel-name>.md — one file per channel, threads as ## sections.
# Re-running resumes from where it left off (cursors in state/discord.json).
# To start fresh: rm state/discord.json export/.all_messages.json
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

ACCUM="export/.all_messages.json"

# Reset accumulator on a fresh export (no prior cursor state), or if the
# accumulator was deleted while state still exists (treat as resume).
if [ ! -f state/discord.json ] || [ ! -f "$ACCUM" ]; then
  echo "[]" > "$ACCUM"
fi

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
    echo "All passes complete ($total messages). Writing channel files..."

    python3 << 'PYEOF'
import json
from datetime import datetime
from pathlib import Path

Path("export").mkdir(exist_ok=True)

with open("export/.all_messages.json") as f:
    messages = json.load(f)

# Sort everything chronologically before grouping
messages.sort(key=lambda m: m["created_at"])

# Group by channel
by_channel = {}
for m in messages:
    ch = m["channel_name"]
    if ch not in by_channel:
        by_channel[ch] = []
    by_channel[ch].append(m)

def fmt_ts(iso):
    ts = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return ts.strftime("%b %-d, %Y %-I:%M %p UTC")

def write_message(f, m):
    ref = m.get("referenced")
    if ref:
        preview = ref["content"][:120].replace("\n", " ")
        f.write(f"> **@{ref['author']}:** {preview}\n\n")
    f.write(f"**@{m['author']}** — {fmt_ts(m['created_at'])}\n")
    f.write(f"{m['content']}\n\n")

written = 0
for channel, msgs in by_channel.items():
    # Separate main channel messages from thread messages.
    # Group thread messages by thread name; record each thread's first timestamp
    # so we can position the thread section inline chronologically.
    main_msgs = []
    thread_groups = {}   # thread_name -> [messages]
    thread_first_ts = {} # thread_name -> first created_at

    for m in msgs:
        if not m.get("content", "").strip():
            continue  # skip empty stubs (thread channel objects, not messages)
        thread = m.get("thread_name")
        if thread is None:
            main_msgs.append(m)
        else:
            if thread not in thread_groups:
                thread_groups[thread] = []
                thread_first_ts[thread] = m["created_at"]
            thread_groups[thread].append(m)

    # Build an ordered event list: main messages + thread sections,
    # both sorted by their first timestamp so threads appear inline.
    output = []
    for m in main_msgs:
        output.append((m["created_at"], "message", m))
    for thread_name, thread_msgs in thread_groups.items():
        output.append((thread_first_ts[thread_name], "thread", (thread_name, thread_msgs)))
    output.sort(key=lambda x: x[0])

    path = Path(f"export/{channel}.md")
    with open(path, "w") as f:
        f.write(f"# #{channel}\n\n")
        for _, event_type, data in output:
            if event_type == "message":
                write_message(f, data)
            else:
                thread_name, thread_msgs = data
                f.write(f"\n## Thread: {thread_name}\n\n")
                for m in thread_msgs:
                    write_message(f, m)
    written += 1

print(f"Wrote {written} channel files.")
PYEOF

    echo "Done. $total messages exported across $((pass - 1)) passes."
    echo "Output: export/"
    ls -lh export/*.md 2>/dev/null || true
    break
  fi

  # Accumulate new messages into the persistent buffer
  python3 - << 'PYEOF'
import json
new = json.load(open(".cache/discord-new.json"))
existing = json.load(open("export/.all_messages.json"))
existing.extend(new)
json.dump(existing, open("export/.all_messages.json", "w"))
PYEOF

  total=$((total + count))
  echo "Pass $pass: +$count messages (total: $total)"

done
