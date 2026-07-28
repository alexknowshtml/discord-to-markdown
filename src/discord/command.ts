// `wiki discord …` — the Discord source commands.
import { Command } from "commander";
import { DiscordClient } from "./client.ts";
import { discordConfig } from "./config.ts";
import { loadDiscordState, saveDiscordState } from "./storage.ts";
import { fetchDiscordBuffer, fetchDiscordByIds } from "./fetch.ts";
import { emitResults, uniqueInOrder } from "../common/by-ids.ts";
import { writeCachePayload, finishFetch } from "../common/fetch-output.ts";
import { CliError } from "../common/cli-error.ts";

const PAYLOAD_PATH = ".cache/discord-new.json";

function requireCreds(): { token: string; guildId: string } {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) {
    throw new CliError(
      "DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set (see .env.example).",
    );
  }
  return { token, guildId };
}

export function discordCommand(): Command {
  const discord = new Command("discord").description(
    "Discord (guild channels/threads) backfill and lookup",
  );

  discord
    .command("fetch")
    .description("Fetch the next slice of new Discord messages since the last cursors")
    .option("--commit", "advance state/discord.json after fetching (default: leave it)")
    .addHelpText(
      "after",
      `
Walks every readable, non-denylisted channel and thread forward from its cursor
(seeded to config.startDate on first run), filling up to config.target rows and
splitting the final page so the payload lands on the target. Writes the distilled
payload to ${PAYLOAD_PATH}. Overflow rolls forward over subsequent runs.

State (the cursors) is NOT advanced unless you pass --commit. The ingest pipeline
owns the commit; --commit is the manual escape hatch while iterating.

Examples:
  wiki discord fetch
  wiki discord fetch --commit
`,
    )
    .action(async (opts: { commit?: boolean }) => {
      const { token, guildId } = requireCreds();
      const state = await loadDiscordState();
      const { messages, nextState } = await fetchDiscordBuffer({
        source: new DiscordClient(token, guildId),
        guildId,
        state,
        config: discordConfig,
        budget: discordConfig.target,
      });

      await writeCachePayload(PAYLOAD_PATH, messages);

      console.log(
        `Fetched ${messages.length} new Discord message(s). Payload written to ${PAYLOAD_PATH}.`,
      );
      for (const m of messages.slice(0, 5)) {
        console.log(`  - [#${m.channel_name}] ${m.author}: ${m.content.slice(0, 80)}`);
      }
      if (messages.length > 5) console.log(`  ... and ${messages.length - 5} more`);

      await finishFetch({
        commit: Boolean(opts.commit),
        statePath: "state/discord.json",
        advance: () => saveDiscordState(nextState),
      });
    });

  discord
    .command("get")
    .description("Resolve individual Discord messages by URL or composite id")
    .argument("<ids...>", "Discord message URLs or <channelId>:<messageId> ids")
    .addHelpText(
      "after",
      `
Accepts message URLs (discord.com/channels/<guild>/<channel>/<message>) and the
composite form <channelId>:<messageId> — a bare message id is not enough, the API
needs the channel/thread id too. Ids are deduped (first occurrence wins) and
results come back in input order.

Output: a JSON array on stdout — each successful row is the distilled
DiscordIngestMessage shape the cursor walk emits; an unresolved id is
{ id, error }. Summary to stderr. Exit 0 if anything resolved, 1 if all failed.

Examples:
  wiki discord get 112233445566778899:998877665544332211
  wiki discord get https://discord.com/channels/111/222/333
`,
    )
    .action(async (ids: string[]) => {
      const { token, guildId } = requireCreds();
      const results = await fetchDiscordByIds({
        source: new DiscordClient(token, guildId),
        guildId,
        ids: uniqueInOrder(ids),
      });
      emitResults(results);
    });

  return discord;
}
