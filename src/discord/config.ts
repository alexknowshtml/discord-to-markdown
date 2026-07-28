// Non-secret, version-controlled operating config for the Discord adapter.
// (The bot token + guild id are secrets and live in the environment — see
// src/discord/storage.ts and .env.example.)

export type DiscordConfig = {
  /**
   * The floor on history. No message older than this is ever ingested: a
   * stream's cursor is seeded to the snowflake for this date, so the first pull
   * starts here and walks forward. Edit to push the backfill further back.
   */
  startDate: string;
  /**
   * Channel names to exclude. We ingest every *readable* channel (the bot's
   * permissions decide that — unreadable ones 403 and are skipped) MINUS these.
   * Matched by name so it's easy to maintain; a renamed channel re-enters the
   * backfill until you re-add it here.
   */
  denylist: string[];
  /**
   * Combined per-run payload ceiling, shared with X (the gate counts X + Discord
   * together). X takes its full forward delta first; Discord fills the remainder
   * up to this number, splitting its final page so the payload lands on target.
   * 150 is the most the ingest agent can fold well in one pass — do not raise it.
   */
  target: number;
};

export const discordConfig: DiscordConfig = {
  startDate: "2015-01-01",
  denylist: [],
  target: 150,
};
