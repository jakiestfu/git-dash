// Command-line parsing via @std/cli. Returns a plain options object; main.ts
// applies it to its runtime state.

import { parseArgs as parse } from "jsr:@std/cli@1/parse-args";
import { die } from "./colors.ts";

export type Mode =
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

Interactive view of your open PRs in this repo, grouped into stacks, with the
current branch's PR highlighted. The root branch renders at the top; each PR
below it, indented one space per level. Filled radios (●) mark the branches the
current selection would rebase; empty radios (○) are left untouched.

The tabs across the top are the scopes, named for what they cover — the repo,
its owner/org, and you — switched with Tab / Shift-Tab; press s to open Settings
and s or Esc to return.

OPTIONS:
  --scope=<scope> Which PRs to show (default: yours):
                    yours    all of your open PRs in this repo, grouped into
                             stacks, with the current branch highlighted
                    org      all of your open PRs across the current repo's
                             organization, grouped by repo (read-only overview)
                    all      all of your open PRs across every repo, grouped by
                             repo (read-only overview); enter opens a PR on
                             GitHub
  --configure [URL]
                  Open the session onto the Settings screen: toggle the checks
                  column and the PR detail line, set the auto-refresh interval,
                  and bind keys to GitHub Actions workflows. Press s or Esc to
                  return to your PRs. With a URL (or local path) to a shared
                  JSON file, its action bindings are downloaded and merged into
                  this repo's config first — handy for sharing team configs
  --dir <path>    Run against the git repository at <path> instead of the
                  current directory
  --no-push       Rebase locally only; skip force-pushing
  -h, --help      Show this help message

COMMANDS:
  upgrade         Print the install command to update git-dash; pipe it to a
                  shell to run it:  git dash upgrade | bash

Keys are shown in-app: the footer lists the actions for the current selection,
and the header shows the scope tabs. Display settings are global; action-key
bindings are per-repo. Both live in ~/.git-dash.json.`;

// --scope selects which PRs to show; each value maps 1:1 to an internal Mode.
// --configure is a separate mode (it opens the Settings tab).
const SCOPES = ["yours", "org", "all"] as const;

export function parseArgs(args: string[]): CliOptions {
  const flags = parse(args, {
    boolean: ["no-push", "help"],
    string: ["dir", "configure", "scope"],
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

  // configure takes precedence and (optionally) carries a string value; its
  // presence is what selects the mode.
  const configureGiven = flags.configure !== undefined;
  let mode: Mode = "yours";
  if (configureGiven) {
    mode = "configure";
  } else if (flags.scope !== undefined) {
    if (!SCOPES.includes(flags.scope as typeof SCOPES[number])) {
      die(`--scope must be one of: ${SCOPES.join(", ")}`);
    }
    mode = flags.scope as Mode;
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
