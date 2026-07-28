import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordSource,
  DiscordThread,
} from "./client.ts";
import { fetchDiscordByIds, parseDiscordRef } from "./fetch.ts";
import { isFetchError } from "../common/by-ids.ts";

const msg = (id: string, authorId = "u1", extra: Partial<DiscordMessage> = {}): DiscordMessage => ({
  id,
  type: 0,
  content: `m${id}`,
  author: { id: authorId, username: `user-${authorId}` },
  timestamp: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const channel = (id: string, name: string): DiscordChannel => ({
  id,
  name,
  type: 0,
  parent_id: null,
  position: 0,
});

function fakeSource(opts: {
  channels: DiscordChannel[];
  threads?: DiscordThread[];
  messages: Record<string, DiscordMessage[]>;
  mattId?: string;
}): DiscordSource {
  return {
    async fetchChannels() {
      return opts.channels;
    },
    async fetchActiveThreads() {
      return [];
    },
    async fetchArchivedThreads() {
      return [];
    },
    async fetchMessagesAfter() {
      return [];
    },
    async getMessage(channelId, messageId) {
      const m = (opts.messages[channelId] ?? []).find((x) => x.id === messageId);
      if (!m) throw new Error(`Discord API error 404 on /channels/${channelId}/messages/${messageId}`);
      return m;
    },
    async getChannel(channelId) {
      const t = (opts.threads ?? []).find((x) => x.id === channelId);
      if (!t) throw new Error(`Discord API error 404 on /channels/${channelId}`);
      return { id: t.id, name: t.name, type: 11, parent_id: t.parent_id, position: 0 };
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

test("parseDiscordRef handles urls and composite ids", () => {
  assert.deepEqual(parseDiscordRef("https://discord.com/channels/1/22/333"), {
    channelId: "22",
    messageId: "333",
  });
  assert.deepEqual(parseDiscordRef("22:333"), { channelId: "22", messageId: "333" });
  assert.equal(parseDiscordRef("333"), null);
  assert.equal(parseDiscordRef("nope"), null);
});

test("resolves messages with channel names, preserves order, flags failures", async () => {
  const source = fakeSource({
    mattId: "matt",
    channels: [channel("1", "general")],
    messages: {
      "1": [
        msg("100", "matt"),
        msg("200", "u1", { mentions: [{ id: "matt", username: "mattpocockuk" }] }),
      ],
    },
  });

  const results = await fetchDiscordByIds({
    source,
    guildId: "G",
    ids: ["1:200", "1:999", "bad", "1:100"],
  });

  assert.equal(results.length, 4);
  const first = results[0] as { id: string; channel_name: string; thread_name: string | null; mentions_matt: boolean };
  assert.equal(first.id, "200");
  assert.equal(first.channel_name, "general");
  assert.equal(first.thread_name, null);
  assert.equal(first.mentions_matt, true);

  assert.equal(isFetchError(results[1]), true);
  assert.deepEqual(results[2], { id: "bad", error: "unrecognised discord id or url" });

  const last = results[3] as { id: string; is_matt: boolean };
  assert.equal(last.id, "100");
  assert.equal(last.is_matt, true);
});

test("names a threaded message from its parent channel", async () => {
  const source = fakeSource({
    channels: [channel("1", "general")],
    threads: [{ id: "55", name: "my-thread", parent_id: "1" }],
    messages: { "55": [msg("500", "u1")] },
  });

  const [row] = await fetchDiscordByIds({ source, guildId: "G", ids: ["55:500"] });
  assert.equal(isFetchError(row), false);
  const m = row as { channel_name: string; thread_name: string | null; url: string };
  assert.equal(m.channel_name, "general");
  assert.equal(m.thread_name, "my-thread");
  assert.equal(m.url, "https://discord.com/channels/G/55/500");
});
