// Subprocess helpers around Deno.Command, plus the git/gh dependency check and
// repo-slug lookup. The one shared bit of state, the current child process, is
// tracked here so cleanup can kill it (killCurrentChild).

import { die } from "./colors.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let curChild: Deno.ChildProcess | null = null;

export async function run(cmd: string, args: string[]): Promise<RunResult> {
  const child = new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  curChild = child;
  try {
    const out = await child.output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    curChild = null;
  }
}

// killCurrentChild: terminate the in-flight subprocess (used during cleanup).
export function killCurrentChild(): void {
  try {
    curChild?.kill();
  } catch {
    // already exited
  }
}

// tryOut: stdout on success, or null on failure.
export async function tryOut(
  cmd: string,
  args: string[],
): Promise<string | null> {
  try {
    const r = await run(cmd, args);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

export class StepError extends Error {
  log: string;
  constructor(log: string) {
    super("step failed");
    this.log = log;
  }
}

// x: run a cascade step command; throws StepError with combined output on
// failure (the log tail is shown under the failed row).
export async function x(cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new StepError(r.stdout + r.stderr);
}

export async function requireDeps(): Promise<void> {
  for (const cmd of ["git", "gh"]) {
    if ((await tryOut(cmd, ["--version"])) === null) {
      die(`git convoy requires '${cmd}'`);
    }
  }
  if ((await tryOut("git", ["rev-parse", "--git-dir"])) === null) {
    die("not a git repository");
  }
}

export function normalizeRepoUrl(url: string): string {
  return url.replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "");
}

export async function repoSlug(): Promise<string> {
  const url = await tryOut("git", ["remote", "get-url", "origin"]);
  return url ? normalizeRepoUrl(url) : "";
}
