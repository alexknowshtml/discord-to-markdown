import {
  TOP_LEVEL_TYPES,
  THREAD_HOLDING_TYPES,
  type DiscordMessage,
  type DiscordSource,
  type DiscordThread,
} from "./client.ts";
import type { DiscordConfig } from "./config.ts";
import type { DiscordState, StreamState } from "./storage.ts";
import { type FetchError, uniqueInOrder } from "../common/by-ids.ts";

const MATT_USERNAME = "mattpocockuk";
const DISCORD_EPOCH = 1420070400000n;

/** Earliest snowflake for a date — the floor a new stream's cursor is seeded to. */
export function dateToSnowflake(date: Date): string {
  return ((BigInt(date.getTime()) - DISCORD_EPOCH) << 22n).toString();
}

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

/**
 * One Discord message as the ingest agent sees it. A distinct shape from X's
 * IngestMention (no metrics/verified/tweet-url); context is nearly free because
 * we pull a contiguous forward slice of a single stream, so the surrounding
 * conversation is already in the buffer.
 */
export type DiscordIngestMessage = {
  id: string;
  channel_name: string;
  /** Null when the message is a top-level channel post (not in a thread). */
  thread_name: string | null;
  author: string;
  content: string;
  created_at: string;
  url: string;
  /** The message this one explicitly replies to, if any. */
  referenced: { author: string; content: string } | null;
  /** Matt authored it — his own voice, not audience signal. */
  is_matt: boolean;
  /** Someone @-mentioned Matt or replied to his message — high audience signal. */
  mentions_matt: boolean;
};

export type DiscordFetchResult = {
  messages: DiscordIngestMessage[];
  /** State to persist *after* the ingest agent has committed the wiki. */
  nextState: DiscordState;
};

/**
 * Fill a buffer of up to `budget` Discord messages, depth-first across streams.
 *
 * Model: every channel and thread is a "stream" with its own forward cursor. We
 * walk channels in a fixed order (Discord `position`); within a channel its own
 * top-level posts first, then its threads. We drain the first stream that is
 * "behind" (cursor < newest known message) before moving on — so a busy channel
 * is exhausted before the next is touched. Archived-thread discovery (the only
 * expensive call) happens lazily, once per channel, as the backfill front
 * reaches it. The same machinery serves steady-state: once everything is
 * drained, only streams with genuinely new messages re-qualify as behind.
 *
 * The cursor is advanced in the returned state but must only be persisted after
 * the agent commits (same contract as src/x).
 */
export async function fetchDiscordBuffer(opts: {
  source: DiscordSource;
  guildId: string;
  state: DiscordState;
  config: DiscordConfig;
  budget: number;
}): Promise<DiscordFetchResult> {
  const { source, guildId, config, budget } = opts;
  // Work on a clone so a thrown error leaves the caller's state untouched.
  const state: DiscordState = structuredClone(opts.state);
  const messages: DiscordIngestMessage[] = [];
  if (budget <= 0) return { messages, nextState: state };

  const floor = dateToSnowflake(new Date(config.startDate));
  const skipped = new Set(state.skipped);

  // Resolve Matt once (best-effort — without it we just can't flag his rows).
  if (!state.mattId) {
    try {
      state.mattId = await source.resolveMemberId(MATT_USERNAME);
    } catch {
      /* leave undefined; is_matt/mentions_matt fall back to false */
    }
  }

  // ── Cheap discovery: channels + live threads (2 calls) ──────────────────────
  const denied = new Set(config.denylist);
  const channels = (await source.fetchChannels())
    .filter(
      (c) =>
        THREAD_HOLDING_TYPES.has(c.type) &&
        !denied.has(c.name) &&
        !skipped.has(c.id),
    )
    .sort((a, b) => a.position - b.position);

  const activeByParent = new Map<string, DiscordThread[]>();
  for (const t of await source.fetchActiveThreads(channels.map((c) => c.id))) {
    if (skipped.has(t.id)) continue;
    const list = activeByParent.get(t.parent_id) ?? [];
    list.push(t);
    activeByParent.set(t.parent_id, list);
  }

  // Register/refresh the top-level stream + active threads for every channel.
  for (const c of channels) {
    state.channels[c.id] ??= { name: c.name };
    state.channels[c.id]!.name = c.name;
    if (TOP_LEVEL_TYPES.has(c.type)) {
      registerStream(state, c.id, c.id, c.name, c.name, false, floor, c.last_message_id);
    }
    for (const t of activeByParent.get(c.id) ?? []) {
      registerStream(state, t.id, c.id, t.name, c.name, true, floor, t.last_message_id);
    }
  }

  // ── Depth-first fill ────────────────────────────────────────────────────────
  for (const c of channels) {
    if (messages.length >= budget) break;

    // Lazily enumerate this channel's archived threads, once, as we reach it.
    const disc = state.channels[c.id]!;
    if (!disc.archivedDiscovered) {
      try {
        const archived = await source.fetchArchivedThreads(
          c.id,
          new Date(config.startDate).toISOString(),
        );
        for (const t of archived) {
          registerStream(state, t.id, c.id, t.name, c.name, true, floor, t.last_message_id);
          const ts = t.thread_metadata?.archive_timestamp;
          if (ts && (!disc.archiveCursor || new Date(ts) > new Date(disc.archiveCursor))) {
            disc.archiveCursor = ts;
          }
        }
        disc.archivedDiscovered = true;
      } catch (err) {
        if (isSkippable(err)) {
          skipped.add(c.id);
          continue;
        }
        throw err;
      }
    }

    // This channel's streams in fixed order: top-level first, then threads by id.
    for (const sid of orderedStreamIds(state, c.id)) {
      if (messages.length >= budget) break;
      if (skipped.has(sid)) continue;
      const s = state.streams[sid]!;

      while (messages.length < budget && s.lastKnown && newer(s.lastKnown, s.cursor)) {
        let page: DiscordMessage[];
        try {
          page = await source.fetchMessagesAfter(sid, s.cursor, budget - messages.length);
        } catch (err) {
          if (isSkippable(err)) {
            skipped.add(sid);
            break;
          }
          throw err;
        }
        if (page.length === 0) {
          // Caught up; pin the cursor so we stop probing this stream.
          s.cursor = s.lastKnown;
          break;
        }
        for (const m of page) {
          messages.push(await toIngest(m, s, guildId, sid, state.mattId, source));
        }
        s.cursor = page[page.length - 1]!.id;
      }
    }
  }

  state.skipped = [...skipped];
  return { messages, nextState: state };
}

/** Register a stream (or refresh its name + newest-known marker) without rewinding. */
function registerStream(
  state: DiscordState,
  id: string,
  channelId: string,
  name: string,
  channelName: string,
  isThread: boolean,
  floor: string,
  lastMessageId?: string | null,
): void {
  const existing = state.streams[id];
  const lastKnown =
    lastMessageId && lastMessageId.length > 0 ? lastMessageId : existing?.lastKnown;
  state.streams[id] = {
    name,
    channelId,
    channelName,
    isThread,
    cursor: existing?.cursor ?? floor,
    lastKnown,
  };
}

/** This channel's streams: top-level first (id === channelId), then threads by id asc. */
function orderedStreamIds(state: DiscordState, channelId: string): string[] {
  return Object.keys(state.streams)
    .filter((id) => state.streams[id]!.channelId === channelId)
    .sort((a, b) => {
      if (a === channelId) return -1;
      if (b === channelId) return 1;
      return BigInt(a) < BigInt(b) ? -1 : 1;
    });
}

async function toIngest(
  m: DiscordMessage,
  s: StreamState,
  guildId: string,
  channelId: string,
  mattId: string | undefined,
  source: DiscordSource,
): Promise<DiscordIngestMessage> {
  const ref = m.referenced_message ?? null;
  return {
    id: m.id,
    channel_name: s.channelName,
    thread_name: s.isThread ? s.name : null,
    author: m.author.username,
    content: await source.resolveAllMentions(m.content),
    created_at: m.timestamp,
    url: `https://discord.com/channels/${guildId}/${channelId}/${m.id}`,
    referenced: ref
      ? { author: ref.author.username, content: await source.resolveAllMentions(ref.content) }
      : null,
    is_matt: !!mattId && m.author.id === mattId,
    mentions_matt:
      !!mattId &&
      m.author.id !== mattId &&
      ((m.mentions?.some((u) => u.id === mattId) ?? false) ||
        ref?.author.id === mattId),
  };
}

// 403 = no permission (unreadable); 404 = deleted channel/thread. Either way the
// stream is gone for us — record it as skipped rather than crashing the run.
function isSkippable(err: unknown): boolean {
  return err instanceof Error && /\b(403|404)\b/.test(err.message);
}

/** A parsed Discord message reference: the channel/thread and the message id. */
export type DiscordRef = { channelId: string; messageId: string };

/**
 * Parse a Discord message reference — either a message URL
 * (`discord.com/channels/<guild>/<channel>/<message>`) or the composite
 * `channelId:messageId`. A bare message id is NOT enough: Discord's API requires
 * the containing channel/thread id. Returns null if unrecognisable.
 */
export function parseDiscordRef(raw: string): DiscordRef | null {
  const s = raw.trim();
  const urlMatch = s.match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (urlMatch) return { channelId: urlMatch[1]!, messageId: urlMatch[2]! };
  const parts = s.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
    return { channelId: parts[0]!, messageId: parts[1]! };
  }
  return null;
}

/**
 * Resolve individual Discord messages by url/composite-id and return them as
 * distilled DiscordIngestMessages (the same shape the cursor walk emits), in
 * input order, deduped. Unparseable / deleted / unreadable refs come back as
 * {id, error} rows.
 *
 * Full fidelity: Matt's member id is resolved once (so is_matt/mentions_matt
 * work), the channel list is fetched once for names, and a thread's name +
 * parent channel name are recovered via `getChannel` the first time a thread id
 * is seen. Mentions are resolved through the same `resolveAllMentions` path.
 */
export async function fetchDiscordByIds(opts: {
  source: DiscordSource;
  guildId: string;
  ids: string[];
}): Promise<Array<DiscordIngestMessage | FetchError>> {
  const { source, guildId } = opts;
  const refs = uniqueInOrder(opts.ids).map((raw) => ({
    raw,
    ref: parseDiscordRef(raw),
  }));

  let mattId: string | undefined;
  try {
    mattId = await source.resolveMemberId(MATT_USERNAME);
  } catch {
    /* leave undefined; is_matt/mentions_matt fall back to false */
  }

  // Top-level channel names, fetched once. Threads are resolved lazily + cached.
  const channelName = new Map<string, string>();
  try {
    for (const c of await source.fetchChannels()) channelName.set(c.id, c.name);
  } catch {
    /* best-effort; names fall back to ids */
  }
  const streamCache = new Map<string, StreamState>();

  const results: Array<DiscordIngestMessage | FetchError> = [];
  for (const { raw, ref } of refs) {
    if (!ref) {
      results.push({ id: raw, error: "unrecognised discord id or url" });
      continue;
    }
    try {
      const m = await source.getMessage(ref.channelId, ref.messageId);
      const stream = await resolveStream(source, ref.channelId, channelName, streamCache);
      results.push(await toIngest(m, stream, guildId, ref.channelId, mattId, source));
    } catch (err) {
      results.push({
        id: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** Build the StreamState a by-id message needs: its channel name, and — if it
 *  lives in a thread — the thread name + parent channel name. */
async function resolveStream(
  source: DiscordSource,
  channelId: string,
  channelName: Map<string, string>,
  cache: Map<string, StreamState>,
): Promise<StreamState> {
  const cached = cache.get(channelId);
  if (cached) return cached;

  const base = (name: string, channel: string, isThread: boolean): StreamState => ({
    name,
    channelId,
    channelName: channel,
    isThread,
    cursor: "0",
  });

  let stream: StreamState;
  const topLevel = channelName.get(channelId);
  if (topLevel) {
    stream = base(topLevel, topLevel, false);
  } else {
    // Not a known top-level channel → treat as a thread; recover its name + parent.
    try {
      const ch = await source.getChannel(channelId);
      const parent = ch.parent_id ? channelName.get(ch.parent_id) : undefined;
      stream = base(ch.name, parent ?? ch.parent_id ?? ch.name, true);
    } catch {
      stream = base(channelId, channelId, false);
    }
  }
  cache.set(channelId, stream);
  return stream;
}
