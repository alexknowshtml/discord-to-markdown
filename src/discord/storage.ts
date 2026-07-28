import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The Discord ingest cursors — committed to the repo alongside the wiki, like
 * state/x.json. The unifying idea: in Discord a thread *is* a channel, so every
 * ingestable message source ("stream") is keyed by the same kind of id whether
 * it is a top-level channel or a thread. Each stream carries its own forward
 * high-water cursor. The bot token + guild id are NOT stored here — they are
 * read from the environment (see DISCORD_BOT_TOKEN / DISCORD_GUILD_ID).
 */

export type StreamState = {
  /** Channel or thread name — for payload context + logging. */
  name: string;
  /** Parent text-channel id (equals this stream's id for a top-level stream). */
  channelId: string;
  /** Parent text-channel name (equals `name` for a top-level stream). */
  channelName: string;
  isThread: boolean;
  /** High-water message id already ingested; seeded to the start-date floor. */
  cursor: string;
  /**
   * Newest message id known to exist in this stream. A stream is "behind" (and
   * worth pulling) when cursor < lastKnown. Refreshed every run for channels and
   * active threads; frozen at discovery time for archived threads (archived ≈
   * static — if one is unarchived it reappears in the active list and refreshes).
   */
  lastKnown?: string;
};

export type ChannelDiscovery = {
  name: string;
  /** Archived threads enumerated once, depth-first, when the backfill reaches it. */
  archivedDiscovered?: boolean;
  /** Newest archive_timestamp seen — lets a cheap re-check skip old archives. */
  archiveCursor?: string;
};

export type DiscordState = {
  /** Matt's guild member id, resolved once and cached. */
  mattId?: string;
  /** Every ingestable stream, keyed by channel/thread id. */
  streams: Record<string, StreamState>;
  /** Per top-level channel, archived-thread discovery bookkeeping. */
  channels: Record<string, ChannelDiscovery>;
  /** Channel/thread ids that 403'd — unreadable; don't re-probe. */
  skipped: string[];
};

const STATE_PATH = "state/discord.json";

const emptyState = (): DiscordState => ({
  streams: {},
  channels: {},
  skipped: [],
});

export async function loadDiscordState(): Promise<DiscordState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as DiscordState;
    return { ...emptyState(), ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function saveDiscordState(state: DiscordState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
