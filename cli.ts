// Command-line parsing via @std/cli. Returns a plain options object; main.ts
// applies it to its runtime state.

import { parseArgs as parse } from "jsr:@std/cli@1/parse-args";
import { die } from "./colors.ts";

export type Mode =
  | "current"
  | "yours"
  | "all"
  | "org"
  | "configure"
  | "upgrade";

export interface CliOptions {
  push: boolean;
  baseDir: string;
  mode: Mode;
  configImport: string;
}

const HELP = `Usage: git dash [OPTIONS]

Interactive view of the PR stack containing the current branch. The root
branch renders at the top; each PR below it, indented one space per level.
Filled radios (●) mark the branches the current selection would rebase;
empty radios (○) are left untouched.

The session has two tabs — Pull Requests and Settings — switched with Tab /
Shift-Tab.

OPTIONS:
  --current       Show the current branch's PR and its ancestors (default)
  --yours         Show all of your open PRs in this repo, grouped into stacks
  --all           Show all of your open PRs across every repo, grouped by repo.
                  A read-only overview (no rebase/checkout/checks — those need a
                  local clone); press enter to open a PR on GitHub
  --org           Like --all, but limited to the current repo's organization
  --configure [URL]
                  Open the session onto the Settings tab: toggle the checks
                  column and the PR detail line, set the auto-refresh interval,
                  and bind keys to GitHub Actions workflows. Tab switches to the
                  Pull Requests tab from there. With a URL (or local path) to a
                  shared JSON file, its action bindings are downloaded and
                  merged into this repo's config first — handy for sharing team
                  configs
  --dir <path>    Run against the git repository at <path> instead of the
                  current directory
  --no-push       Rebase locally only; skip force-pushing
  -h, --help      Show this help message

COMMANDS:
  upgrade         Print the install command to update git-dash; pipe it to a
                  shell to run it:  git dash upgrade | bash

Keys are shown in-app: the footer lists the actions for the current selection,
and the header shows the Pull Requests / Settings tabs. Settings are saved
per-repo in
~/.git-dash.json.`;

// The mutually-exclusive view flags; the last one given wins (matching the old
// loop). --configure also switches to the settings tab.
const MODE_FLAGS: Mode[] = ["current", "yours", "all", "org", "configure"];

export function parseArgs(args: string[]): CliOptions {
  const flags = parse(args, {
    boolean: ["no-push", "help", "current", "yours", "all", "org"],
    string: ["dir", "configure"],
    alias: { help: "h" },
    unknown: (arg: string) => {
      // Positionals are allowed (e.g. `--configure some.json`); reject only
      // unknown option-like tokens, as the old parser did.
      if (arg.startsWith("-")) {
        console.log(`Unknown option: ${arg}`);
        console.log("Run 'git dash --help' for usage information");
        Deno.exit(1);
      }
      return true;
    },
  });

  if (flags.help) {
    console.log(HELP);
    Deno.exit(0);
  }

  // `upgrade` is a positional subcommand, not a view flag.
  if (flags._[0] === "upgrade") {
    return { push: true, baseDir: "", mode: "upgrade", configImport: "" };
  }

  // configure is both a mode and (optionally) a string value; presence of the
  // flag is what selects the mode.
  const configureGiven = flags.configure !== undefined;
  let mode: Mode = "current";
  for (const m of MODE_FLAGS) {
    if (m === "configure" ? configureGiven : flags[m]) mode = m;
  }

  // The import path may arrive as `--configure=x`, `--configure x` (a non-empty
  // string value), or as a trailing positional (`--configure x` when x wasn't
  // consumed). Prefer the option value, else the first positional.
  let configImport = "";
  if (configureGiven && flags.configure) configImport = flags.configure;
  else if (mode === "configure" && flags._.length > 0) {
    configImport = String(flags._[0]);
  }

  // `--dir` present but with no value (dir === "") is an error, as before;
  // absent leaves dir undefined.
  if (flags.dir === "") die("--dir requires a path");

  return {
    push: !flags["no-push"],
    baseDir: typeof flags.dir === "string" ? flags.dir : "",
    mode,
    configImport,
  };
}
