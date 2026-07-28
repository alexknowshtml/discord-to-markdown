# discord-to-markdown

Export a Discord server's channels and threads to readable markdown files —
one file per channel, threads as sections, messages in chronological order.

Built on top of [@mattpocock](https://github.com/mattpocock)'s Discord ingest
adapter, which handles rate-limit-aware fetching and per-stream cursor state.

## Requirements

- Node.js 22+ (uses `--experimental-strip-types` to run TypeScript directly)
- A Discord bot token with read access to the server you want to export

## Setup

### 1. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application → Bot → Reset Token → copy the token
3. Under OAuth2 → URL Generator: select `bot` scope + `Read Messages/View Channels` permission
4. Open the generated URL and invite the bot to your server

### 2. Get your guild (server) ID

Enable Developer Mode in Discord (Settings → Advanced), then right-click your
server name → Copy Server ID.

### 3. Configure the date floor (optional)

Edit `src/discord/config.ts` to set `startDate` — no messages before this date
will be fetched. Defaults to `2026-06-01`.

Add channel names to `denylist` to skip them entirely.

### 4. Install dependencies

```bash
npm install
```

### 5. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_GUILD_ID=your-guild-id-here
```

### 6. Run the export

```bash
./export.sh
```

Output lands in `export/` — one `.md` file per channel the bot can read.

## Output format

```markdown
# #channel-name

**@username** — Jun 1, 2026 4:42 PM UTC
Message content here

> **@other-user:** The message they were replying to

**@username** — Jun 1, 2026 4:45 PM UTC
Reply content here

## Thread: thread-name

**@username** — Jun 2, 2026 10:00 AM UTC
Thread message here
```

## Resuming

Cursor state is saved in `state/discord.json` after each batch. Re-running
`export.sh` picks up where it left off. To start fresh, delete that file.

## How it works

The adapter walks channels in position order, draining one stream at a time
before moving to the next. Each channel and thread gets its own snowflake
cursor — no message is fetched twice. Unreadable channels (403) are skipped
automatically based on the bot's permissions.

Fetches up to 150 messages per pass. A full server export runs as many passes
as needed until all streams return 0 new messages.

## Credits

Fetch layer adapted from [@mattpocock](https://github.com/mattpocock)'s
Discord ingest adapter. The export-to-markdown layer and this README were added on top.
