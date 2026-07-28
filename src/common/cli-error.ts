// An expected, operator-facing CLI failure (missing credentials, bad input, a
// source that declined access). The root command's catch prints a `CliError`'s
// message to stderr and exits 1 — no stack trace, because the message is already
// the actionable thing the user needs to read. Anything that is NOT a CliError
// is treated as a bug: its full stack is printed so it can be debugged.
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
