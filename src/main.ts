import { Command } from "commander";
import { discordCommand } from "./discord/command.ts";

const program = new Command("wiki");
program.addCommand(discordCommand());
await program.parseAsync(process.argv);
