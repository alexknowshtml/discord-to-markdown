// Shared output scaffolding for the `<svc> fetch` cursor-walk commands.
//
// Every fetch command does the same three things after pulling its delta: write
// the machine-readable payload to a `.cache/<svc>-*.json` file, print a short
// human summary, and — only when `--commit` is passed — advance the persisted
// cursor state. State is NOT advanced by default: the ingest pipeline owns the
// commit (it only moves the cursor after the agent has folded the material into
// the wiki), and leaving it untouched means the next run retries the same rows.
// `--commit` is the manual escape hatch for iterating on a single source.
import { mkdir, writeFile } from "node:fs/promises";

/** Write the fetched rows as pretty JSON to `path` (creating `.cache/` if new). */
export async function writeCachePayload(path: string, rows: unknown[]): Promise<void> {
  await mkdir(".cache", { recursive: true });
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n", "utf8");
}

/**
 * Print the trailing commit note and, when `commit` is set, run `advance` to
 * persist the new cursor state. `statePath` is shown in both branches so the
 * operator knows exactly which file is (or isn't) being moved.
 */
export async function finishFetch(opts: {
  commit: boolean;
  statePath: string;
  advance: () => Promise<void>;
}): Promise<void> {
  if (opts.commit) {
    await opts.advance();
    console.log(`State advanced in ${opts.statePath}.`);
  } else {
    console.log(
      `State NOT advanced (run with --commit, or let the ingest pipeline do it).`,
    );
  }
}
