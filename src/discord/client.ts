// Minimal Discord API client. Ported from ~/repos/ai/cohort-discord-scraper,
// trimmed to what the wiki ingest needs: discover channels/threads and pull
// messages forward from a cursor. The scraper's Archive, triage commands, and
// the (write) post path are deliberately left behind — this adapter is
// read-only and persists no raw messages (only distilled insight lands in the
// wiki, per wiki/CLAUDE.md §2).

const DISCORD_API_BASE = "https://discord.com/api/v10";

// Channel types we care about. Text + announcement hold top-level messages AND
// threads; forum + media hold threads only. Everything else (voice, category,
// stage) has no text to ingest.
export const TOP_LEVEL_TYPES = new Set([0, 5]);
export const THREAD_HOLDING_TYPES = new Set([0, 5, 15, 16]);

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  position: number;
  last_message_id?: string | null;
}

export interface DiscordMessage {
  id: string;
  type: number;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  timestamp: string;
  mentions?: { id: string; username: string }[];
  referenced_message?: DiscordMessage | null;
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id: string;
  last_message_id?: string | null;
  thread_metadata?: {
    archived: boolean;
    locked: boolean;
    archive_timestamp?: string;
  };
}

interface DiscordUser {
  id: string;
  username: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The surface fetchDiscordBuffer depends on. Defining it as an interface lets
 * tests inject a fake without hitting the network (mirrors src/x/api.ts XApi).
 */
export interface DiscordSource {
  fetchChannels(): Promise<DiscordChannel[]>;
  fetchActiveThreads(channelIds: string[]): Promise<DiscordThread[]>;
  fetchArchivedThreads(
    channelId: string,
    stopBefore?: string,
  ): Promise<DiscordThread[]>;
  /** Pull at most `limit` messages strictly newer than `after`, chronological. */
  fetchMessagesAfter(
    channelId: string,
    after: string,
    limit: number,
  ): Promise<DiscordMessage[]>;
  /** A single message by id within a channel/thread (for the by-id `get` path). */
  getMessage(channelId: string, messageId: string): Promise<DiscordMessage>;
  /** A single channel or thread object by id — used to name threads on the by-id path. */
  getChannel(channelId: string): Promise<DiscordChannel>;
  resolveMemberId(username: string): Promise<string>;
  resolveAllMentions(content: string): Promise<string>;
}

export class DiscordClient implements DiscordSource {
  private token: string;
  private guildId: string;
  private userCache = new Map<string, string>();

  constructor(token: string, guildId: string) {
    this.token = token;
    this.guildId = guildId;
  }

  /** Rate-limit-aware request: honours 429 Retry-After and preemptive resets. */
  async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${DISCORD_API_BASE}${path}`;
    while (true) {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseFloat(retryAfter) * 1000 : 1000;
        console.log(`  Rate limited, waiting ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Discord API error ${response.status} on ${path}: ${body}`,
        );
      }

      const remaining = response.headers.get("X-RateLimit-Remaining");
      const resetAfter = response.headers.get("X-RateLimit-Reset-After");
      if (remaining === "0" && resetAfter) {
        await sleep(parseFloat(resetAfter) * 1000);
      }
      return response;
    }
  }

  async fetchChannels(): Promise<DiscordChannel[]> {
    const response = await this.request(`/guilds/${this.guildId}/channels`);
    return (await response.json()) as DiscordChannel[];
  }

  async fetchActiveThreads(channelIds: string[]): Promise<DiscordThread[]> {
    const response = await this.request(
      `/guilds/${this.guildId}/threads/active`,
    );
    const data = (await response.json()) as { threads: DiscordThread[] };
    const set = new Set(channelIds);
    return data.threads.filter((t) => set.has(t.parent_id));
  }

  /**
   * Archived threads, newest-archived-first. Stops paginating once a page
   * reaches threads archived before `stopBefore` (the start-date floor) — those
   * predate the cursor, so every later page does too.
   */
  async fetchArchivedThreads(
    channelId: string,
    stopBefore?: string,
  ): Promise<DiscordThread[]> {
    const all: DiscordThread[] = [];
    let before: string | undefined;
    while (true) {
      const params = new URLSearchParams({ limit: "100" });
      if (before) params.set("before", before);
      const response = await this.request(
        `/channels/${channelId}/threads/archived/public?${params.toString()}`,
      );
      const data = (await response.json()) as {
        threads: DiscordThread[];
        has_more: boolean;
      };
      all.push(...data.threads);
      if (!data.has_more || data.threads.length === 0) break;

      const oldest =
        data.threads[data.threads.length - 1]!.thread_metadata
          ?.archive_timestamp;
      if (stopBefore && oldest && new Date(oldest) < new Date(stopBefore)) break;

      const last = data.threads[data.threads.length - 1]!;
      before = last.thread_metadata?.archive_timestamp ?? last.id;
    }
    return all;
  }

  async fetchMessagesAfter(
    channelId: string,
    after: string,
    limit: number,
  ): Promise<DiscordMessage[]> {
    const collected: DiscordMessage[] = [];
    let cursor = after;
    while (collected.length < limit) {
      const want = Math.min(100, limit - collected.length);
      const params = new URLSearchParams({
        limit: String(want),
        after: cursor,
      });
      const response = await this.request(
        `/channels/${channelId}/messages?${params.toString()}`,
      );
      const page = (await response.json()) as DiscordMessage[];
      if (page.length === 0) break;
      // `after` returns the chunk closest to the cursor, newest-first in-page;
      // sort ascending so we append in chronological order.
      page.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      collected.push(...page);
      cursor = page[page.length - 1]!.id;
      if (page.length < want) break;
    }
    return collected.slice(0, limit);
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage> {
    const response = await this.request(
      `/channels/${channelId}/messages/${messageId}`,
    );
    return (await response.json()) as DiscordMessage;
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    const response = await this.request(`/channels/${channelId}`);
    return (await response.json()) as DiscordChannel;
  }

  async resolveMemberId(username: string): Promise<string> {
    const params = new URLSearchParams({ query: username, limit: "10" });
    const response = await this.request(
      `/guilds/${this.guildId}/members/search?${params.toString()}`,
    );
    const members = (await response.json()) as { user: DiscordUser }[];
    const match = members.find(
      (m) => m.user.username.toLowerCase() === username.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Could not resolve username "${username}" to a member`);
    }
    return match.user.id;
  }

  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    try {
      const response = await this.request(`/users/${userId}`);
      const user = (await response.json()) as DiscordUser;
      this.userCache.set(userId, user.username);
      return user.username;
    } catch {
      const fallback = `unknown-user-${userId}`;
      this.userCache.set(userId, fallback);
      return fallback;
    }
  }

  /** Replace `<@id>` raw mentions with `@username` for readability. */
  async resolveAllMentions(content: string): Promise<string> {
    const pattern = /<@!?(\d+)>/g;
    const matches = [...content.matchAll(pattern)];
    if (matches.length === 0) return content;
    const resolved = new Map<string, string>();
    for (const id of new Set(matches.map((m) => m[1]!))) {
      resolved.set(id, await this.resolveUsername(id));
    }
    return content.replace(pattern, (_m, id: string) => `@${resolved.get(id) ?? id}`);
  }
}
