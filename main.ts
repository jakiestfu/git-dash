#!/usr/bin/env -S deno run --quiet --ext=ts --allow-run=git,gh --allow-read --allow-write --allow-env --allow-net
// git convoy — interactive TUI for managing stacked GitHub pull requests.
// Installed as both `git-convoy` and `git-cv`. Runs on Deno 2.x.

const PR_LIMIT = 100;

// ── Colors ───────────────────────────────────────────────────────────────────

const USE_COLOR = Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");

function c(code: string, s: string): string {
  return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const cyan = (s: string) => c("36", s);
const grey = (s: string) => c("90", s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);

function die(msg: string): never {
  console.error(USE_COLOR ? `\x1b[31m${msg}\x1b[0m` : msg);
  Deno.exit(1);
}

// ── Subprocesses ─────────────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let curChild: Deno.ChildProcess | null = null;

async function run(cmd: string, args: string[]): Promise<RunResult> {
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

// out: stdout on success, or null on failure.
async function tryOut(cmd: string, args: string[]): Promise<string | null> {
  try {
    const r = await run(cmd, args);
    return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

class StepError extends Error {
  log: string;
  constructor(log: string) {
    super("step failed");
    this.log = log;
  }
}

// x: run a cascade step command; throws StepError with combined output on
// failure (the log tail is shown under the failed row).
async function x(cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new StepError(r.stdout + r.stderr);
}

async function requireDeps(): Promise<void> {
  for (const cmd of ["git", "gh"]) {
    if ((await tryOut(cmd, ["--version"])) === null) {
      die(`git convoy requires '${cmd}'`);
    }
  }
  if ((await tryOut("git", ["rev-parse", "--git-dir"])) === null) {
    die("not a git repository");
  }
}

async function repoSlug(): Promise<string> {
  let url = await tryOut("git", ["remote", "get-url", "origin"]);
  if (!url) return "";
  url = url.replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "");
  return url;
}

// ── Config ───────────────────────────────────────────────────────────────────
// Per-repo settings live in one JSON file in the user's home directory:
//   { "repos": { "owner/repo": { "showChecks": true,
//                                "actions": { "t": { "workflow": "x.yml",
//                                                    "name": "X" } } } } }

interface ActionBinding {
  workflow: string;
  name: string;
}

const CONFIG_FILE = Deno.env.get("GIT_CONVOY_CONFIG") ??
  `${Deno.env.get("HOME")}/.git-convoy.json`;
let SHOW_CHECKS = true;
let ACTIONS = new Map<string, ActionBinding>();
const ACTION_RUN_ID = new Map<string, string>();
let REPO_SLUG = "";

// deno-lint-ignore no-explicit-any
function readJsonFile(path: string): any | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path));
  } catch {
    return null;
  }
}

function configLoad(): void {
  ACTIONS = new Map();
  SHOW_CHECKS = true;
  if (!REPO_SLUG) return;
  const repo = readJsonFile(CONFIG_FILE)?.repos?.[REPO_SLUG];
  if (!repo) return;
  if (repo.showChecks === false) SHOW_CHECKS = false;
  for (const [key, val] of Object.entries(repo.actions ?? {})) {
    const v = val as Partial<ActionBinding>;
    if (!key || !v?.workflow) continue;
    ACTIONS.set(key, { workflow: v.workflow, name: v.name || v.workflow });
  }
}

function configSave(): void {
  if (!REPO_SLUG) return;
  const base = readJsonFile(CONFIG_FILE) ?? {};
  const actions: Record<string, ActionBinding> = {};
  for (const [k, v] of ACTIONS) actions[k] = v;
  const next = {
    ...base,
    version: 1,
    repos: {
      ...(base.repos ?? {}),
      [REPO_SLUG]: { showChecks: SHOW_CHECKS, actions },
    },
  };
  const tmp = `${CONFIG_FILE}.tmp-${Deno.pid}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  Deno.renameSync(tmp, CONFIG_FILE);
}

// ── PR data ──────────────────────────────────────────────────────────────────
// Both loaders fetch PRs via `gh --json` and fold statusCheckRollup down to
// "passed/total" plus a GitHub-style color: red if any check failed, else
// yellow if any is still pending, else green.

interface PrInfo {
  base: string;
  num: string;
  adds: number;
  dels: number;
  title: string;
  draft: boolean;
  checks: string;
  checksColor: string;
}

const PRS = new Map<string, PrInfo>();
const CHILDREN = new Map<string, string[]>();

// deno-lint-ignore no-explicit-any
function verdict(check: any): string {
  return String(check.conclusion || check.state || check.status || "")
    .toUpperCase();
}

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILING = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

// deno-lint-ignore no-explicit-any
function ingestPr(pr: any): string {
  let checks = "";
  let checksColor = "";
  const rollup = pr.statusCheckRollup ?? [];
  if (rollup.length > 0) {
    const passed = rollup.filter((ch: unknown) => PASSING.has(verdict(ch)));
    checks = `${passed.length}/${rollup.length}`;
    if (rollup.some((ch: unknown) => FAILING.has(verdict(ch)))) {
      checksColor = "red";
    } else if (passed.length < rollup.length) {
      checksColor = "yellow";
    } else {
      checksColor = "green";
    }
  }
  PRS.set(pr.headRefName, {
    base: pr.baseRefName,
    num: String(pr.number),
    adds: pr.additions ?? 0,
    dels: pr.deletions ?? 0,
    title: pr.title ?? "",
    draft: pr.isDraft === true,
    checks,
    checksColor,
  });
  return pr.headRefName;
}

function prFields(): string {
  let f =
    "number,title,headRefName,baseRefName,additions,deletions,isDraft,state";
  if (SHOW_CHECKS) f += ",statusCheckRollup";
  return f;
}

// ── Stack model ──────────────────────────────────────────────────────────────
// Rows indexed in render order. Each stack starts with its root row at depth 0
// (the branch with no open PR, e.g. main); row.root names the stack root every
// row belongs to, so multiple stacks can coexist (--yours).

type RowStatus = "idle" | "pending" | "running" | "ok" | "fail";

interface Row {
  branch: string;
  parent: string;
  depth: number;
  root: string;
  status: RowStatus;
  note: string;
  ahead: string;
  behind: string;
  num: string;
  title: string;
  adds: number;
  dels: number;
  draft: boolean;
  checks: string;
  checksColor: string;
}

const ROWS: Row[] = [];
const ROW_OF = new Map<string, number>();
const ROOT_ROW_OF = new Map<string, number>();
const ROOTS: string[] = [];
let CUR_BRANCH = "";
let currentRoot = "";

function addRow(branch: string, parent: string, depth: number): void {
  const pr = PRS.get(branch);
  ROW_OF.set(branch, ROWS.length);
  ROWS.push({
    branch,
    parent,
    depth,
    root: currentRoot,
    status: "idle",
    note: "",
    ahead: "?",
    behind: "?",
    num: pr?.num ?? "",
    title: pr?.title ?? "",
    adds: pr?.adds ?? 0,
    dels: pr?.dels ?? 0,
    draft: pr?.draft ?? false,
    checks: pr?.checks ?? "",
    checksColor: pr?.checksColor ?? "",
  });
}

function addRootRow(branch: string): void {
  currentRoot = branch;
  ROOT_ROW_OF.set(branch, ROWS.length);
  ROOTS.push(branch);
  addRow(branch, "", 0);
}

function addSubtree(branch: string, depth: number): void {
  addRow(branch, PRS.get(branch)!.base, depth);
  for (const kid of CHILDREN.get(branch) ?? []) {
    addSubtree(kid, depth + 1);
  }
}

// Default mode: one `gh pr view` for the current branch, then one per ancestor
// while walking up the bases — instead of listing every open PR in the repo.
async function loadStackCurrent(): Promise<void> {
  CUR_BRANCH = (await tryOut("git", ["branch", "--show-current"])) ?? "";
  if (!CUR_BRANCH) die("detached HEAD; check out a branch first");

  const fields = prFields();
  let b = CUR_BRANCH;
  const chain: string[] = [];
  while (chain.length < 50) {
    const raw = await tryOut("gh", ["pr", "view", b, "--json", fields]);
    if (raw === null) break;
    let pr;
    try {
      pr = JSON.parse(raw);
    } catch {
      break;
    }
    if (pr.state !== "OPEN") break;
    ingestPr(pr);
    chain.unshift(b);
    b = PRS.get(b)!.base;
  }
  if (chain.length === 0) {
    die(`no open pull request found for branch '${CUR_BRANCH}'`);
  }

  addRootRow(b);
  let depth = 1;
  for (const br of chain) {
    addRow(br, PRS.get(br)!.base, depth);
    depth += 1;
  }
}

// --yours: every open PR you authored, grouped into stacks. A base that isn't
// one of your PRs (main, or someone else's PR branch) becomes a stack root.
async function loadStackYours(): Promise<void> {
  CUR_BRANCH = (await tryOut("git", ["branch", "--show-current"])) ?? "";

  const raw = await tryOut("gh", [
    "pr",
    "list",
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    String(PR_LIMIT),
    "--json",
    prFields(),
  ]);
  if (raw === null) {
    die(
      "failed to list your pull requests (is 'gh' authenticated for this repo?)",
    );
  }
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    die(
      "failed to list your pull requests (is 'gh' authenticated for this repo?)",
    );
  }

  const heads: string[] = [];
  for (const pr of prs) {
    const head = ingestPr(pr);
    heads.push(head);
    const base = PRS.get(head)!.base;
    CHILDREN.set(base, [...(CHILDREN.get(base) ?? []), head]);
  }
  if (heads.length === 0) die("you have no open pull requests in this repo");

  const seenRoot = new Set<string>();
  for (const h of heads) {
    const base = PRS.get(h)!.base;
    if (PRS.has(base)) continue;
    if (seenRoot.has(base)) continue;
    seenRoot.add(base);
    addRootRow(base);
    for (const kid of CHILDREN.get(base) ?? []) {
      addSubtree(kid, 1);
    }
  }
}

async function refExists(ref: string): Promise<boolean> {
  return (await tryOut("git", ["rev-parse", "--verify", "--quiet", ref])) !==
    null;
}

// branch -> local ref, origin ref, or empty
async function refFor(branch: string): Promise<string> {
  if (await refExists(`refs/heads/${branch}`)) return branch;
  if (await refExists(`refs/remotes/origin/${branch}`)) {
    return `origin/${branch}`;
  }
  return "";
}

async function revListCount(range: string): Promise<string> {
  return (await tryOut("git", ["rev-list", "--count", range])) ?? "?";
}

async function loadGitStats(): Promise<void> {
  for (const row of ROWS) {
    const { branch: b, parent: p } = row;
    if (!p) {
      row.behind = await revListCount(`${b}..origin/${b}`);
      continue;
    }
    row.note = "";
    if (!(await refExists(`refs/heads/${b}`))) row.note = "no local branch";
    const bref = await refFor(b);
    const pref = await refFor(p);
    row.ahead = bref && pref ? await revListCount(`${pref}..${bref}`) : "?";
  }
}

// ── Rebase cascade ───────────────────────────────────────────────────────────

let CHAIN: number[] = [];
let chainRoot = "";
let chainRootRow = 0;
let CASCADE_ERR = "";
let ORIG_BRANCH = "";

// target row index -> CHAIN (bottom row first) within its stack
function computeChain(target: number): void {
  CHAIN = [];
  chainRoot = ROWS[target].root;
  chainRootRow = ROOT_ROW_OF.get(chainRoot)!;
  let b = ROWS[target].branch;
  while (b && b !== chainRoot) {
    CHAIN.unshift(ROW_OF.get(b)!);
    b = PRS.get(b)?.base ?? "";
  }
}

async function rebaseInProgress(): Promise<boolean> {
  const gd = await tryOut("git", ["rev-parse", "--git-dir"]);
  if (!gd) return false;
  for (const d of ["rebase-merge", "rebase-apply"]) {
    try {
      if (Deno.statSync(`${gd}/${d}`).isDirectory) return true;
    } catch {
      // not present
    }
  }
  return false;
}

async function abortRebaseIfAny(): Promise<void> {
  if (await rebaseInProgress()) {
    await tryOut("git", ["rebase", "--abort"]);
  }
}

async function checkPreconditions(): Promise<boolean> {
  if (!CUR_BRANCH) {
    CASCADE_ERR = "detached HEAD; check out a branch first";
    return false;
  }
  if (await rebaseInProgress()) {
    CASCADE_ERR = "a rebase is already in progress — finish or abort it first";
    return false;
  }
  const unstaged = await run("git", ["diff", "--quiet"]);
  const staged = await run("git", ["diff", "--cached", "--quiet"]);
  if (unstaged.code !== 0 || staged.code !== 0) {
    CASCADE_ERR = "working tree is dirty — commit or stash before rebasing";
    return false;
  }
  return true;
}

async function updateRoot(): Promise<void> {
  await x("git", ["fetch", "origin", "--prune"]);
  if (ORIG_BRANCH === chainRoot) {
    await x("git", ["merge", "--ff-only", `origin/${chainRoot}`]);
  } else {
    // Fast-forward-only by definition; fails loudly if local root diverged.
    await x("git", ["fetch", "origin", `${chainRoot}:${chainRoot}`]);
  }
}

async function rebaseBranch(
  b: string,
  p: string,
  old: string,
  push: boolean,
): Promise<void> {
  await x("git", ["rebase", "--onto", p, old, b]);
  if (push) {
    await x("git", ["push", "--force-with-lease", "origin", b]);
  }
}

async function restoreBranch(): Promise<void> {
  if (
    ORIG_BRANCH &&
    (await tryOut("git", ["branch", "--show-current"])) !== ORIG_BRANCH
  ) {
    await tryOut("git", ["checkout", "--quiet", ORIG_BRANCH]);
  }
}

async function cascade(target: number, push: boolean): Promise<boolean> {
  CASCADE_ERR = "";

  if (!(await checkPreconditions())) return false;
  computeChain(target);
  ORIG_BRANCH = CUR_BRANCH;

  // CHAIN is empty when the root itself is the target.
  ROWS[chainRootRow].status = "pending";
  for (const r of CHAIN) {
    ROWS[r].status = "pending";
    ROWS[r].note = "";
  }
  render();

  if (!(await convoyStep(chainRootRow, "updated", updateRoot))) {
    CASCADE_ERR =
      `could not update ${chainRoot} — local ${chainRoot} has diverged from origin/${chainRoot}`;
    return false;
  }

  // Root selected: pulling from origin is the whole job.
  if (CHAIN.length === 0) {
    await restoreBranch();
    return true;
  }

  // Create missing local branches, then fail early on any remote divergence
  // so we never leave the stack half-rebased for a foreseeable reason.
  for (const r of CHAIN) {
    const b = ROWS[r].branch;
    if (!(await refExists(`refs/heads/${b}`))) {
      if ((await tryOut("git", ["fetch", "origin", `${b}:${b}`])) === null) {
        ROWS[r].status = "fail";
        CASCADE_ERR =
          `branch '${b}' has no local copy and could not be fetched`;
        return false;
      }
      ROWS[r].note = "fetched";
    }
    if (await refExists(`refs/remotes/origin/${b}`)) {
      const n = parseInt(await revListCount(`${b}..origin/${b}`), 10) || 0;
      if (n > 0) {
        ROWS[r].status = "fail";
        CASCADE_ERR =
          `origin/${b} has ${n} commit(s) not in local '${b}' — reconcile before rebasing`;
        return false;
      }
    }
  }

  // Record every branch's fork point from its parent before any rebase runs;
  // once a parent is rebased, merge-base against it would land below the old
  // tip and replay the parent's own commits as duplicates. --fork-point
  // consults the parent's reflog, which also survives the parent having been
  // rebased outside convoy; plain merge-base is the fallback.
  const oldParentSha = new Map<number, string>();
  for (const r of CHAIN) {
    const { branch: b, parent: p } = ROWS[r];
    const fp = await tryOut("git", ["merge-base", "--fork-point", p, b]);
    const old = fp ?? (await tryOut("git", ["merge-base", p, b])) ?? "";
    oldParentSha.set(r, old);
  }

  for (const r of CHAIN) {
    const { branch: b, parent: p } = ROWS[r];
    const old = oldParentSha.get(r)!;
    const parentSha = await tryOut("git", ["rev-parse", p]);
    const isAncestor =
      (await run("git", ["merge-base", "--is-ancestor", p, b])).code === 0;
    if (parentSha === old && isAncestor) {
      const bSha = await tryOut("git", ["rev-parse", b]);
      const originSha = await tryOut("git", ["rev-parse", `origin/${b}`]);
      if (push && bSha !== originSha) {
        const ok = await convoyStep(
          r,
          "pushed",
          () => x("git", ["push", "--force-with-lease", "origin", b]),
        );
        if (!ok) {
          CASCADE_ERR = `push of '${b}' failed`;
          await restoreBranch();
          return false;
        }
      } else {
        await convoyStep(r, "up to date", () => Promise.resolve());
      }
      continue;
    }

    const note = push ? "rebased · pushed" : "rebased";
    if (!(await convoyStep(r, note, () => rebaseBranch(b, p, old, push)))) {
      await abortRebaseIfAny();
      CASCADE_ERR = `rebase of '${b}' failed — rebase aborted, repo left clean.
  Resolve manually: git rebase --onto ${p} ${old} ${b}`;
      await restoreBranch();
      return false;
    }
  }

  await restoreBranch();
  return true;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

let PUSH = true;
let BASE_DIR = "";
let MODE: "current" | "yours" | "configure" = "current";
let CONFIG_IMPORT = "";

const HELP = `Usage: git convoy [OPTIONS]     (also installed as: git cv)

Interactive view of the PR stack containing the current branch. The root
branch renders at the top; each PR below it, indented one space per level.
Filled radios (●) mark the branches the current selection would rebase;
empty radios (○) are left untouched.

OPTIONS:
  --current       Show the current branch's PR and its ancestors (default)
  --yours         Show all of your open PRs, grouped into stacks
  --configure [URL]
                  Open the settings UI: toggle the checks column and bind
                  keys to GitHub Actions workflows. With a URL (or local
                  path) to a shared JSON file, its action bindings are
                  downloaded and merged into this repo's config first —
                  handy for sharing team configurations
  --dir <path>    Run against the git repository at <path> instead of the
                  current directory
  --no-push       Rebase locally only; skip force-pushing
  -h, --help      Show this help message

KEYS:
  ↑/↓ or k/j      Move selection
  r               Rebase the selected PR's chain: the root is fast-forwarded
                  from origin, then every branch between the root and the
                  selection is rebased bottom-up and force-pushed (with lease).
                  With the root branch selected, this just pulls it from origin
  c               Check out the selected branch
  v               View the selected PR on GitHub
  <bound key>     Run the bound GitHub Actions workflow (a-z or 0-9, set up
                  via --configure) on the selected branch; press again to
                  open the dispatched run
  q               Quit

Settings are saved per-repo in ~/.git-convoy.json.`;

function parseArgs(args: string[]): void {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--no-push") {
      PUSH = false;
      i += 1;
    } else if (arg === "--dir") {
      if (i + 1 >= args.length) die("--dir requires a path");
      BASE_DIR = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--dir=")) {
      BASE_DIR = arg.slice("--dir=".length);
      i += 1;
    } else if (arg === "--current") {
      MODE = "current";
      i += 1;
    } else if (arg === "--yours") {
      MODE = "yours";
      i += 1;
    } else if (arg === "--configure") {
      MODE = "configure";
      i += 1;
      if (i < args.length && !args[i].startsWith("-")) {
        CONFIG_IMPORT = args[i];
        i += 1;
      }
    } else if (arg.startsWith("--configure=")) {
      MODE = "configure";
      CONFIG_IMPORT = arg.slice("--configure=".length);
      i += 1;
    } else if (arg === "-h" || arg === "--help" || arg === "help") {
      console.log(HELP);
      Deno.exit(0);
    } else {
      console.log(`Unknown option: ${arg}`);
      console.log("Run 'git convoy --help' for usage information");
      Deno.exit(1);
    }
  }
}

// ── Terminal ─────────────────────────────────────────────────────────────────

const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let SPIN_I = 0;
let DRAWN = 0;
let SEL = 1;
let BUSY = false;
let SEL_CHAIN = new Set<number>();
let MESSAGE = "";
let INFO = "";
let STEP_LOG_TAIL = "";
let LINES: string[] = [];

const INTERACTIVE = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
let RAW = false;

function write(s: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(s));
}

function setRaw(on: boolean): void {
  if (!INTERACTIVE || RAW === on) return;
  // cbreak keeps Ctrl-C delivering SIGINT so cleanup always runs.
  Deno.stdin.setRaw(on, on ? { cbreak: true } : undefined);
  RAW = on;
}

async function cleanup(): Promise<void> {
  if (INTERACTIVE) {
    write("\x1b[?25h");
    setRaw(false);
  }
  try {
    curChild?.kill();
  } catch {
    // already exited
  }
  await abortRebaseIfAny();
  await restoreBranch();
}

// paint: redraw LINES in place (shared by the main and configure views).
function paint(): void {
  let out = "";
  if (DRAWN > 0) out += `\x1b[${DRAWN}A\r`;
  for (const line of LINES) {
    out += `\x1b[2K${line}\n`;
  }
  out += "\x1b[0J";
  write(out);
  DRAWN = LINES.length;
}

function termCols(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 120;
  }
}

function tailLines(s: string, n: number): string {
  const lines = s.replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

// readKeys: block for input, return decoded key names. Escape sequences
// arrive as one chunk in raw mode; a lone ESC byte is the escape key.
const keyBuf = new Uint8Array(64);
async function readKeys(): Promise<string[] | null> {
  const n = await Deno.stdin.read(keyBuf);
  if (n === null) return null;
  const s = new TextDecoder().decode(keyBuf.subarray(0, n));
  const keys: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[" && i + 2 < s.length) {
      keys.push(s.slice(i, i + 3));
      i += 3;
    } else {
      keys.push(s[i]);
      i += 1;
    }
  }
  return keys;
}

// readLine: temporarily leave raw mode so the terminal handles line editing.
async function readLine(prompt: string): Promise<string> {
  write("\x1b[?25h");
  write(prompt);
  setRaw(false);
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  setRaw(true);
  write("\x1b[?25l");
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
}

// ── Configure view ───────────────────────────────────────────────────────────
// Letters the main view already uses; they can't be bound to workflows.
const RESERVED_KEYS = "jkqrcv";

// importActions: fetch a shared JSON file (URL or local path) and merge its
// action bindings into this repo's config. The file may be a full config
// (bindings read from .repos["owner/repo"].actions) or a bare fragment with a
// top-level "actions" object. Imported bindings win over local ones — both
// for the same key and for the same workflow — and reserved keys are skipped.
async function importActions(src: string): Promise<void> {
  let text: string;
  try {
    text = Deno.readTextFileSync(src);
  } catch {
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(String(resp.status));
      text = await resp.text();
    } catch {
      die(`could not download '${src}'`);
    }
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    die(`'${src}' is not valid JSON`);
  }

  const bindings = data?.repos?.[REPO_SLUG]?.actions ?? data?.actions ?? {};
  let imported = 0;
  let skipped = "";
  for (const [key, val] of Object.entries(bindings)) {
    const v = val as Partial<ActionBinding>;
    if (!key || !v?.workflow) continue;
    if (key.length !== 1 || RESERVED_KEYS.includes(key)) {
      skipped += ` ${key}`;
      continue;
    }
    // Same stealing semantics as the configure UI: one key per workflow.
    for (const [k, b] of ACTIONS) {
      if (b.workflow === v.workflow) ACTIONS.delete(k);
    }
    ACTIONS.set(key, { workflow: v.workflow, name: v.name || v.workflow });
    imported += 1;
  }

  if (imported === 0) die(`no usable action bindings found in '${src}'`);
  configSave();
  console.log(green(`imported ${imported} action binding(s) from ${src}`));
  if (skipped) {
    console.log(yellow(`skipped reserved/invalid key(s):${skipped}`));
  }
}

async function runConfigure(): Promise<void> {
  if (!INTERACTIVE) {
    die("--configure requires an interactive terminal (or a URL to import)");
  }

  interface Workflow {
    id: string;
    name: string;
  }
  const workflows: Workflow[] = [];
  const raw = await tryOut("gh", [
    "workflow",
    "list",
    "--json",
    "name,path,state",
  ]);
  if (raw !== null) {
    try {
      for (const wf of JSON.parse(raw)) {
        if (wf.state !== "ACTIVE" && wf.state !== "active") continue;
        const id = String(wf.path ?? "").split("/").pop() ?? "";
        if (!id) continue;
        workflows.push({ id, name: wf.name || wf.path });
      }
    } catch {
      // no workflows
    }
  }

  let CSEL = 0;
  let CMSG = "";
  const last = workflows.length;

  const keyOfWf = (wfId: string): string => {
    for (const [k, b] of ACTIONS) {
      if (b.workflow === wfId) return k;
    }
    return "";
  };

  const cbuild = () => {
    LINES = [];
    LINES.push("");
    LINES.push(
      `  ${bold("convoy settings")}${dim(` · ${REPO_SLUG || "local"}`)}`,
    );
    LINES.push("");

    let cur = " ";
    if (CSEL === 0) cur = bold(cyan("❯"));
    const state = SHOW_CHECKS ? green("[on]") : dim("[off]");
    LINES.push(
      `  ${cur} Show checks ${state} ${
        dim("· [passed/total] check status on each PR")
      }`,
    );
    LINES.push("");

    LINES.push(`  ${dim("action keys")}`);
    if (workflows.length === 0) {
      LINES.push(`      ${dim("no active workflows found in this repo")}`);
    }
    for (let i = 0; i < workflows.length; i++) {
      cur = " ";
      if (CSEL === i + 1) cur = bold(cyan("❯"));
      const k = keyOfWf(workflows[i].id);
      const disp = k ? bold(cyan(k)) : dim("—");
      LINES.push(
        `  ${cur} ${disp}  ${workflows[i].name} ${dim(`· ${workflows[i].id}`)}`,
      );
    }

    LINES.push("");
    LINES.push(
      `  ${
        dim(
          "↑↓ move · space toggle · a-z 0-9 bind · enter rename · esc unbind · q quit",
        )
      }`,
    );
    if (CMSG) {
      LINES.push("");
      LINES.push(`  ${yellow(CMSG)}`);
    }
  };

  const crender = () => {
    cbuild();
    paint();
  };

  // Rename how a bound action is shown (in the footer and this list); the
  // name is only stored in the local user's config. Reads one echoed line
  // below the UI, which paint() then reclaims.
  const renameSelected = async () => {
    const wf = workflows[CSEL - 1];
    const k = keyOfWf(wf.id);
    if (!k) {
      CMSG = "bind a key before renaming";
      return;
    }
    const newName = await readLine(`  rename '${ACTIONS.get(k)!.name}' to: `);
    DRAWN += 1;
    if (newName) {
      ACTIONS.get(k)!.name = newName;
      wf.name = newName;
      configSave();
    }
  };

  write("\x1b[?25l");
  crender();

  loop: while (true) {
    const keys = await readKeys();
    if (keys === null) break;
    for (const key of keys) {
      CMSG = "";
      if (key === "\x1b[A" || key === "k") {
        if (CSEL > 0) CSEL -= 1;
        crender();
      } else if (key === "\x1b[B" || key === "j") {
        if (CSEL < last) CSEL += 1;
        crender();
      } else if (key === " " || key === "\r" || key === "\n") {
        if (CSEL === 0) {
          SHOW_CHECKS = !SHOW_CHECKS;
          configSave();
        } else if (key !== " ") {
          await renameSelected();
        }
        crender();
      } else if (key === "\x1b") {
        if (CSEL > 0) {
          const k = keyOfWf(workflows[CSEL - 1].id);
          if (k) {
            ACTIONS.delete(k);
            configSave();
          }
        }
        crender();
      } else if (key === "q" || key === "\x03") {
        break loop;
      } else if (/^[a-z0-9]$/.test(key)) {
        if (CSEL > 0) {
          if (RESERVED_KEYS.includes(key)) {
            CMSG = `'${key}' is reserved (${RESERVED_KEYS})`;
          } else {
            const wf = workflows[CSEL - 1];
            const prev = keyOfWf(wf.id);
            if (prev) ACTIONS.delete(prev);
            // Assigning an already-used key steals it from the other workflow.
            ACTIONS.set(key, { workflow: wf.id, name: wf.name });
            configSave();
          }
        }
        crender();
      }
    }
  }
}

// ── Main view ────────────────────────────────────────────────────────────────

// Radio semantics: filled ● marks rows the current selection would rebase
// (the stack root plus the chain up to SEL), the selected row's radio is bold,
// and everything else is an empty ○. While a rebase runs, idle radios go grey.
function glyphFor(i: number): string {
  switch (ROWS[i].status) {
    case "running":
      return cyan(SPIN_FRAMES[SPIN_I % 10]);
    case "ok":
      return green("✓");
    case "fail":
      return red("✗");
    default:
      if (ROWS[i].status === "pending" || SEL_CHAIN.has(i)) {
        if (BUSY) return grey("●");
        if (i === SEL) return bold(cyan("●"));
        return cyan("●");
      }
      return BUSY ? grey("○") : dim("○");
  }
}

// Mark the rows a rebase of SEL would touch: the stack's root plus every
// branch between it and the selection.
function markSelChain(): void {
  SEL_CHAIN = new Set();
  const root = ROWS[SEL]?.root;
  if (!root) return;
  SEL_CHAIN.add(ROOT_ROW_OF.get(root)!);
  let b = ROWS[SEL]?.branch ?? "";
  while (b && b !== root) {
    SEL_CHAIN.add(ROW_OF.get(b)!);
    b = PRS.get(b)?.base ?? "";
  }
}

function actionHints(): string {
  if (ACTIONS.size === 0) return "";
  const parts: string[] = [];
  for (const k of [...ACTIONS.keys()].sort()) {
    if (ACTION_RUN_ID.has(k)) {
      parts.push(`${k} view`);
    } else {
      parts.push(`${k} ${ACTIONS.get(k)!.name.toLowerCase()}`);
    }
  }
  return parts.join(" · ");
}

function colorFn(name: string): (s: string) => string {
  switch (name) {
    case "green":
      return green;
    case "yellow":
      return yellow;
    case "red":
      return red;
    default:
      return (s) => s;
  }
}

function buildLines(): void {
  LINES = [];
  LINES.push("");
  LINES.push(`  ${bold("convoy")}${dim(` · ${REPO_SLUG || "local"}`)}`);
  LINES.push("");

  markSelChain();

  const cols = termCols();

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    let cursor = " ";
    if (INTERACTIVE && i === SEL) {
      cursor = BUSY ? grey("❯") : bold(cyan("❯"));
    }

    if (!row.parent) {
      if (i > 0) LINES.push("");
      let behind;
      if (row.behind === "?") {
        behind = dim("· origin unknown");
      } else if (parseInt(row.behind, 10) > 0) {
        behind = yellow(`· ${row.behind} behind origin`);
      } else {
        behind = dim("· up to date");
      }
      LINES.push(`  ${cursor} ${glyphFor(i)} ${bold(row.branch)} ${behind}`);
      continue;
    }

    // Every PR row sits one level below its parent: the root's children at
    // depth 1 get one space, theirs two, and so on.
    const ind = " ".repeat(row.depth);
    const g = glyphFor(i);

    let bname = cyan(row.branch);
    if (row.branch === CUR_BRANCH) bname = bold(cyan(row.branch));
    if (SHOW_CHECKS && row.checks) {
      bname += ` ${colorFn(row.checksColor)(`[${row.checks}]`)}`;
    }
    if (row.branch === CUR_BRANCH) bname += grey(" ← you are here");
    let note = "";
    if (row.draft) note = ` ${yellow("[draft]")}`;
    if (row.note) note += grey(` · ${row.note}`);
    LINES.push(`  ${ind}${cursor} ${g} ${bname}${note}`);

    let title = row.title;
    let max = cols - ind.length - 32;
    if (max < 12) max = 12;
    if (title.length > max) title = title.slice(0, max - 1) + "…";
    const meta = `${dim(`#${row.num}`)} ${title}  ${green(`+${row.adds}`)} ${
      red(`−${row.dels}`)
    }${dim(` · ${row.ahead} ahead`)}`;
    LINES.push(`  ${ind}    ${meta}`);
  }

  LINES.push("");
  if (INTERACTIVE) {
    LINES.push(
      `  ${dim("↑↓ move · r rebase · c checkout · v view on github · q quit")}`,
    );
    const hints = actionHints();
    if (hints) LINES.push(`  ${dim(hints)}`);
  }
  if (INFO) {
    LINES.push("");
    LINES.push(`  ${dim(INFO)}`);
  }
  if (MESSAGE) {
    LINES.push("");
    for (const line of MESSAGE.split("\n")) {
      LINES.push(`  ${red(line)}`);
    }
  }
  if (STEP_LOG_TAIL) {
    for (const line of STEP_LOG_TAIL.split("\n")) {
      LINES.push(`    ${grey(line)}`);
    }
  }
}

function render(): void {
  buildLines();
  paint();
}

// convoyStep: run one cascade step, animating the row's spinner until it
// settles. See the cascade section for the contract.
async function convoyStep(
  i: number,
  note: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  ROWS[i].status = "running";
  const timer = setInterval(() => {
    SPIN_I += 1;
    render();
  }, 80);

  let ok = true;
  let log = "";
  try {
    await fn();
  } catch (e) {
    ok = false;
    log = e instanceof StepError ? e.log : String(e);
  }
  clearInterval(timer);

  if (ok) {
    ROWS[i].status = "ok";
    if (note) ROWS[i].note = note;
  } else {
    ROWS[i].status = "fail";
    STEP_LOG_TAIL = tailLines(log, 6);
  }
  render();
  return ok;
}

async function startRebase(): Promise<void> {
  MESSAGE = "";
  INFO = "";
  STEP_LOG_TAIL = "";
  for (const row of ROWS) row.status = "idle";
  BUSY = true;
  render();
  if (!(await cascade(SEL, PUSH))) {
    MESSAGE = CASCADE_ERR;
  }
  BUSY = false;
  await loadGitStats();
  render();
}

async function checkoutSelected(): Promise<void> {
  MESSAGE = "";
  INFO = "";
  const b = ROWS[SEL].branch;
  const r = await run("git", ["checkout", "--quiet", b]);
  if (r.code === 0) {
    CUR_BRANCH = b;
    // The user chose this branch; don't restore the old one on exit.
    ORIG_BRANCH = "";
    ROWS[SEL].note = "";
  } else {
    MESSAGE = `checkout of '${b}' failed`;
    STEP_LOG_TAIL = tailLines(r.stdout + r.stderr, 6);
  }
  render();
}

async function openSelectedPr(): Promise<void> {
  const num = ROWS[SEL].num;
  if (!num) return;
  await tryOut("gh", ["pr", "view", num, "--web"]);
}

// First press dispatches the bound workflow on the selected row's branch;
// once a run id is known, the hint flips to "view" and pressing the key again
// opens that run in the browser.
async function runActionKey(key: string): Promise<void> {
  const { workflow: wf, name } = ACTIONS.get(key)!;
  const ref = ROWS[SEL].branch;

  const runId = ACTION_RUN_ID.get(key);
  if (runId) {
    await tryOut("gh", ["run", "view", runId, "--web"]);
    return;
  }

  MESSAGE = "";
  STEP_LOG_TAIL = "";
  INFO = `dispatching '${name}' on ${ref}…`;
  render();
  const r = await run("gh", ["workflow", "run", wf, "--ref", ref]);
  if (r.code !== 0) {
    INFO = "";
    MESSAGE = `failed to dispatch '${name}' on ${ref}`;
    STEP_LOG_TAIL = tailLines(r.stdout + r.stderr, 6);
    render();
    return;
  }

  // Dispatch is async; give the run a moment to appear so we can link to it.
  let id = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const raw = await tryOut("gh", [
      "run",
      "list",
      "--workflow",
      wf,
      "--branch",
      ref,
      "--limit",
      "1",
      "--json",
      "databaseId",
    ]);
    try {
      id = String(JSON.parse(raw ?? "[]")[0]?.databaseId ?? "");
    } catch {
      id = "";
    }
    if (id) break;
  }
  if (id) {
    ACTION_RUN_ID.set(key, id);
    INFO = `'${name}' running on ${ref} — press '${key}' again to view`;
  } else {
    INFO = `'${name}' dispatched on ${ref}`;
  }
  render();
}

async function inputLoop(): Promise<void> {
  const last = ROWS.length - 1;
  loop: while (true) {
    const keys = await readKeys();
    if (keys === null) break;
    for (const key of keys) {
      if (key === "\x1b[A" || key === "k") {
        if (SEL > 0) SEL -= 1;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        if (SEL < last) SEL += 1;
        render();
      } else if (key === "r") {
        await startRebase();
      } else if (key === "c") {
        await checkoutSelected();
      } else if (key === "v") {
        await openSelectedPr();
      } else if (key === "q" || key === "\x03") {
        break loop;
      } else if (key.length === 1 && ACTIONS.has(key)) {
        await runActionKey(key);
      }
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  parseArgs(Deno.args);

  if (BASE_DIR) {
    try {
      Deno.chdir(BASE_DIR);
    } catch {
      die(`cannot change to directory: ${BASE_DIR}`);
    }
  }

  await requireDeps();

  REPO_SLUG = await repoSlug();
  configLoad();

  if (MODE === "configure") {
    if (CONFIG_IMPORT) await importActions(CONFIG_IMPORT);
    if (INTERACTIVE || !CONFIG_IMPORT) {
      setRaw(true);
      await runConfigure();
    }
    return;
  }

  if (INTERACTIVE) write(dim("loading pull requests…"));
  if (MODE === "yours") {
    await loadStackYours();
  } else {
    await loadStackCurrent();
  }
  if (INTERACTIVE) write("\r\x1b[2K");
  if (INTERACTIVE) write(dim("fetching origin…"));
  for (const root of ROOTS) {
    await tryOut("git", ["fetch", "origin", root, "--quiet"]);
  }
  if (INTERACTIVE) write("\r\x1b[2K");
  await loadGitStats();
  SEL = ROW_OF.get(CUR_BRANCH) ?? 1;

  if (!INTERACTIVE) {
    buildLines();
    console.log(LINES.join("\n"));
    return;
  }

  write("\x1b[?25l");
  setRaw(true);
  render();
  await inputLoop();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(sig, async () => {
    await cleanup();
    Deno.exit(130);
  });
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  exitCode = 1;
} finally {
  await cleanup();
}
Deno.exit(exitCode);
