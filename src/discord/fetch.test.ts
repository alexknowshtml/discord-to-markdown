import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordSource,
  DiscordThread,
} from "./client.ts";
import type { DiscordConfig } from "./config.ts";
import { fetchDiscordBuffer } from "./fetch.ts";
import type { DiscordState } from "./storage.ts";

// startDate at the Discord epoch → floor snowflake "0", so any positive id is
// "newer than the floor" and tests can use simple small ids.
const config: DiscordConfig = {
  startDate: "2015-01-01",
  denylist: [],
  target: 150,
};

const emptyState = (): DiscordState => ({ streams: {}, channels: {}, skipped: [] });

const msg = (id: string, authorId = "u1", extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id,
  type: 0,
  content: `m${id}`,
  author: { id: authorId, username: `user-${authorId}` },
  timestamp: "2026-01-01T00:00:00.000Z",
  ...extra,
});

/** A fake guild: channels (with position + last_message_id), threads, and a
 *  per-stream message store keyed by channel/thread id. */
function fakeSource(opts: {
  channels: DiscordChannel[];
  activeThreads?: DiscordThread[];
  archivedThreads?: Record<string, DiscordThread[]>;
  messages: Record<string, DiscordMessage[]>;
  mattId?: string;
}): DiscordSource {
  return {
    async fetchChannels() {
      return opts.channels;
    },
    async fetchActiveThreads(ids) {
      const set = new Set(ids);
      return (opts.activeThreads ?? []).filter((t) => set.has(t.parent_id));
    },
    async fetchArchivedThreads(channelId) {
      return opts.archivedThreads?.[channelId] ?? [];
    },
    async fetchMessagesAfter(channelId, after, limit) {
      const all = opts.messages[channelId] ?? [];
      return all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
    },
    async getMessage(channelId, messageId) {
      const m = (opts.messages[channelId] ?? []).find((x) => x.id === messageId);
      if (!m) throw new Error(`Discord API error 404 on /channels/${channelId}/messages/${messageId}`);
      return m;
    },
    async getChannel(channelId) {
      const all = [
        ...opts.channels,
        ...(opts.activeThreads ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          type: 11,
          parent_id: t.parent_id,
          position: 0,
        })),
      ];
      const c = all.find((x) => x.id === channelId);
      if (!c) throw new Error(`Discord API error 404 on /channels/${channelId}`);
      return c;
    },
    async resolveMemberId() {
      if (!opts.mattId) throw new Error("no matt");
      return opts.mattId;
    },
    async resolveAllMentions(content) {
      return content;
    },
  };
}

const channel = (id: string, position: number, lastId: string): DiscordChannel => ({
  id,
  name: `chan-${id}`,
  type: 0,
  parent_id: null,
  position,
  last_message_id: lastId,
});

test("seeds a new stream at the floor and pulls forward, capped by budget", async () => {
  const source = fakeSource({
    channels: [channel("A", 0, "5")],
    messages: { A: [msg("1"), msg("2"), msg("3"), msg("4"), msg("5")] },
  });

  const first = await fetchDiscordBuffer({ source, guildId: "G", state: emptyState(), config, budget: 3 });
  assert.deepEqual(first.messages.map((m) => m.id), ["1", "2", "3"]);
  assert.equal(first.nextState.streams.A!.cursor, "3");

  // Resuming from the advanced cursor yields the next slice.
  const second = await fetchDiscordBuffer({ source, guildId: "G", state: first.nextState, config, budget: 3 });
  assert.deepEqual(second.messages.map((m) => m.id), ["4", "5"]);
  assert.equal(second.nextState.streams.A!.cursor, "5");
});

test("drains depth-first: a channel's top-level, then its threads, then the next channel", async () => {
  const source = fakeSource({
    channels: [channel("A", 0, "2"), channel("B", 1, "12")],
    activeThreads: [
      { id: "7", name: "thread-7", parent_id: "A", last_message_id: "8" },
    ],
    messages: {
      A: [msg("1"), msg("2")],
      "7": [msg("7"), msg("8")],
      B: [msg("11"), msg("12")],
    },
  });

  const res = await fetchDiscordBuffer({ source, guildId: "G", state: emptyState(), config, budget: 100 });
  assert.deepEqual(
    res.messages.map((m) => [m.channel_name, m.thread_name, m.id]),
    [
      ["chan-A", null, "1"],
      ["chan-A", null, "2"],
      ["chan-A", "thread-7", "7"],
      ["chan-A", "thread-7", "8"],
      ["chan-B", null, "11"],
      ["chan-B", null, "12"],
    ],
  );
});

test("splits across streams to fill the budget exactly (no overshoot)", async () => {
  const source = fakeSource({
    channels: [channel("A", 0, "2"), channel("B", 1, "105")],
    messages: {
      A: [msg("1"), msg("2")],
      B: [msg("101"), msg("102"), msg("103"), msg("104"), msg("105")],
    },
  });

  const res = await fetchDiscordBuffer({ source, guildId: "G", state: emptyState(), config, budget: 4 });
  assert.equal(res.messages.length, 4);
  assert.deepEqual(res.messages.map((m) => m.id), ["1", "2", "101", "102"]);
  // B is partially drained; its cursor sits on the last pulled message.
  assert.equal(res.nextState.streams.B!.cursor, "102");
});

test("pulls nothing when every stream is already caught up", async () => {
  const source = fakeSource({
    channels: [channel("A", 0, "2")],
    messages: { A: [msg("1"), msg("2")] },
  });
  const drained = await fetchDiscordBuffer({ source, guildId: "G", state: emptyState(), config, budget: 100 });
  const again = await fetchDiscordBuffer({ source, guildId: "G", state: drained.nextState, config, budget: 100 });
  assert.deepEqual(again.messages, []);
});

test("flags Matt's own messages and messages aimed at him", async () => {
  const source = fakeSource({
    mattId: "matt",
    channels: [channel("A", 0, "3")],
    messages: {
      A: [
        msg("1", "matt"), // authored by Matt
        msg("2", "u1", { mentions: [{ id: "matt", username: "mattpocockuk" }] }),
        msg("3", "u1"), // ordinary audience message
      ],
    },
  });

  const res = await fetchDiscordBuffer({ source, guildId: "G", state: emptyState(), config, budget: 100 });
  const byId = Object.fromEntries(res.messages.map((m) => [m.id, m]));
  assert.equal(byId["1"]!.is_matt, true);
  assert.equal(byId["1"]!.mentions_matt, false);
  assert.equal(byId["2"]!.is_matt, false);
  assert.equal(byId["2"]!.mentions_matt, true);
  assert.equal(byId["3"]!.is_matt, false);
  assert.equal(byId["3"]!.mentions_matt, false);
  assert.equal(res.nextState.mattId, "matt");
});
