// Shared scaffolding for the per-service `<svc> get` commands — the by-id
// counterparts to the `<svc> fetch` cursor walks. Each service exposes a single
// subcommand (`wiki <svc> get <ids-or-urls…>`) that resolves individual items by
// id and prints them as a JSON array on stdout, so a local agent (or you) can
// look up a tweet / Slack message / Discord message / Gmail thread on demand.
//
// The shape contract: a successful row is the service's normal distilled ingest
// item (the same shape `<svc>:fetch` emits); a failed id is a {id, error} row.
// The two are distinguishable by the presence of `error`, since no distilled
// shape carries that field. Results preserve input order and ids are deduped to
// unique (first occurrence wins).

/** A single id that could not be resolved (unparseable, deleted, no access). */
export type FetchError = { id: string; error: string };

export function isFetchError(x: unknown): x is FetchError {
  return typeof x === "object" && x !== null && "error" in x;
}

/** Unique strings, preserving first-occurrence order. */
export function uniqueInOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Emit the results array as pretty JSON on **stdout** (the machine-readable
 * payload), a one-line summary on **stderr** (never pollutes stdout), and exit:
 * 0 if anything resolved, 1 only if every id failed.
 */
export function emitResults(results: unknown[]): never {
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  const failed = results.filter(isFetchError).length;
  const ok = results.length - failed;
  process.stderr.write(
    `Resolved ${ok}/${results.length} item(s)` +
      (failed > 0 ? ` — ${failed} failed.` : ".") +
      "\n",
  );
  process.exit(ok === 0 && results.length > 0 ? 1 : 0);
}
