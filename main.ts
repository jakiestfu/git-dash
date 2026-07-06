#!/usr/bin/env -S deno run --quiet --ext=ts --allow-run=git,gh,open,xdg-open,explorer --allow-read --allow-write --allow-env --allow-net
// git dash — interactive TUI for managing stacked GitHub pull requests.
// Installed as `git-dash`. Runs on Deno 2.x.

const PR_LIMIT = 100;

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  applyColorPreference,
  bold,
  cyan,
  die,
  dim,
  green,
  grey,
  red,
  yellow,
} from "./colors.ts";
import {
  killCurrentChild,
  repoSlug,
  requireDeps,
  run,
  StepError,
  tryOut,
  x,
} from "./subprocess.ts";
import {
  boxed,
  formatBranchLine,
  formatMetaLine,
  tailLines,
  viewTop,
  visibleWidth,
} from "./format.ts";
import { type CliOptions, type Mode, parseArgs } from "./cli.ts";

// ── Config ───────────────────────────────────────────────────────────────────
// Per-repo settings live in one JSON file in the user's home directory:
//   { "repos": { "owner/repo": { "showChecks": true,
//                                "showPr": true,
//                                "autoRefresh": 30,
//                                "actions": { "t": { "workflow": "x.yml",
//                                                    "name": "X" } } } } }

interface ActionBinding {
  workflow: string;
  name: string;
}

const CONFIG_FILE = Deno.env.get("GIT_DASH_CONFIG") ??
  `${Deno.env.get("HOME")}/.git-dash.json`;
let SHOW_CHECKS = true;
let SHOW_PR = true; // PR number/title line under each branch
let AUTO_REFRESH = 0; // seconds between auto-refreshes; 0 = off
let ACTIONS = new Map<string, ActionBinding>();

// Auto-refresh cycles through these intervals (seconds; 0 = off).
export const AUTO_REFRESH_STEPS = [0, 30, 60, 300];

export function nextAutoRefresh(cur: number): number {
  const i = AUTO_REFRESH_STEPS.indexOf(cur);
  return AUTO_REFRESH_STEPS[(i + 1) % AUTO_REFRESH_STEPS.length];
}

export function formatCountdown(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}
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
  SHOW_PR = true;
  AUTO_REFRESH = 0;
  if (!REPO_SLUG) return;
  const repo = readJsonFile(CONFIG_FILE)?.repos?.[REPO_SLUG];
  if (!repo) return;
  if (repo.showChecks === false) SHOW_CHECKS = false;
  if (repo.showPr === false) SHOW_PR = false;
  if (AUTO_REFRESH_STEPS.includes(repo.autoRefresh)) {
    AUTO_REFRESH = repo.autoRefresh;
  }
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
      [REPO_SLUG]: {
        showChecks: SHOW_CHECKS,
        showPr: SHOW_PR,
        autoRefresh: AUTO_REFRESH,
        actions,
      },
    },
  };
  const tmp = `${CONFIG_FILE}.tmp-${Deno.pid}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  Deno.renameSync(tmp, CONFIG_FILE);
}

// ── Stack cache ────────────────────────────────────────────────────────────
// The last-loaded stack is cached to disk per repo+mode so a relaunch paints
// the previous rows instantly (marked stale) while the live data reloads in
// place. The cache holds the rendered rows plus the current branch; PR fields
// live on the rows themselves, so no separate PR map is stored.

const CACHE_FILE = Deno.env.get("GIT_DASH_CACHE") ??
  `${Deno.env.get("HOME")}/.git-dash-cache.json`;

interface CachedStack {
  curBranch: string;
  rows: Row[];
}

function cacheKey(): string {
  return `${REPO_SLUG}#${MODE}`;
}

function saveStackCache(): void {
  if (!REPO_SLUG || ROWS.length === 0) return;
  const base = readJsonFile(CACHE_FILE) ?? {};
  // Drop transient per-run fields (spinner status, step notes) from the cache.
  const rows = ROWS.map((r) => ({ ...r, status: "idle", note: "" }));
  const next = {
    ...base,
    version: 1,
    stacks: {
      ...(base.stacks ?? {}),
      [cacheKey()]: { curBranch: CUR_BRANCH, rows },
    },
  };
  try {
    const tmp = `${CACHE_FILE}.tmp-${Deno.pid}`;
    Deno.writeTextFileSync(tmp, JSON.stringify(next));
    Deno.renameSync(tmp, CACHE_FILE);
  } catch {
    // cache is best-effort; ignore write failures
  }
}

function loadStackCache(): CachedStack | null {
  if (!REPO_SLUG) return null;
  const c = readJsonFile(CACHE_FILE)?.stacks?.[cacheKey()];
  if (!c || !Array.isArray(c.rows) || c.rows.length === 0) return null;
  return c as CachedStack;
}

// restoreRows: rebuild ROWS and its indexes (and the PRS base map that the
// chain math reads) from a set of rows — used for both the disk cache and the
// in-place refresh snapshot.
function restoreRows(rows: Row[]): void {
  PRS.clear();
  CHILDREN.clear();
  ROWS.length = 0;
  ROW_OF.clear();
  ROOT_ROW_OF.clear();
  ROOTS.length = 0;
  for (const r of rows) {
    const row: Row = { ...r, checkItems: r.checkItems ?? [], url: r.url ?? "" };
    ROW_OF.set(row.branch, ROWS.length);
    if (!row.parent) {
      ROOT_ROW_OF.set(row.branch, ROWS.length);
      ROOTS.push(row.branch);
    } else {
      // The chain walkers read PRS.get(branch).base; only base is needed here.
      PRS.set(row.branch, {
        base: row.parent,
        num: row.num,
        adds: row.adds,
        dels: row.dels,
        title: row.title,
        draft: row.draft,
        checks: row.checks,
        checksColor: row.checksColor,
        items: row.checkItems,
        url: row.url,
      });
    }
    ROWS.push(row);
  }
}

// ── PR data ──────────────────────────────────────────────────────────────────
// Both loaders fetch PRs via `gh --json` and fold statusCheckRollup down to
// "passed/total" plus a GitHub-style color: red if any check failed, else
// yellow if any is still pending, else green.

export interface CheckItem {
  name: string;
  state: "pass" | "fail" | "pending";
  url: string;
}

interface PrInfo {
  base: string;
  num: string;
  adds: number;
  dels: number;
  title: string;
  draft: boolean;
  checks: string;
  checksColor: string;
  items: CheckItem[];
  // Direct PR URL — only needed in --all mode, where rows live in other repos
  // and can't be opened with `gh pr view <num>` against the current repo.
  url?: string;
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

// summarizeChecks: fold a statusCheckRollup down to "passed/total" plus a
// GitHub-style color — red if any check failed, else yellow if any is still
// pending, else green.
export function summarizeChecks(
  rollup: unknown[],
): { checks: string; checksColor: string } {
  if (rollup.length === 0) return { checks: "", checksColor: "" };
  const passed = rollup.filter((ch) => PASSING.has(verdict(ch)));
  const checks = `${passed.length}/${rollup.length}`;
  let checksColor;
  if (rollup.some((ch) => FAILING.has(verdict(ch)))) {
    checksColor = "red";
  } else if (passed.length < rollup.length) {
    checksColor = "yellow";
  } else {
    checksColor = "green";
  }
  return { checks, checksColor };
}

// extractCheckItems: keep each rollup entry's name, pass/fail/pending state,
// and details link so the expanded checks list can render and open them.
// Failed checks sort first (then pending, then passed) so the ones worth
// drilling into sit at the top of the expanded list.
const CHECK_ORDER = { fail: 0, pending: 1, pass: 2 } as const;

export function extractCheckItems(rollup: unknown[]): CheckItem[] {
  const items = rollup.map((raw) => {
    // deno-lint-ignore no-explicit-any
    const ch = raw as any;
    const v = verdict(ch);
    return {
      name: String(ch.name ?? ch.context ?? "check"),
      state: PASSING.has(v)
        ? "pass" as const
        : FAILING.has(v)
        ? "fail" as const
        : "pending" as const,
      url: String(ch.detailsUrl ?? ch.targetUrl ?? ""),
    };
  });
  return items.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
}

// prInfoOf: fold one raw `gh` PR object into the PrInfo we store.
// deno-lint-ignore no-explicit-any
function prInfoOf(pr: any): PrInfo {
  const rollup = pr.statusCheckRollup ?? [];
  const { checks, checksColor } = summarizeChecks(rollup);
  return {
    base: pr.baseRefName,
    num: String(pr.number),
    adds: pr.additions ?? 0,
    dels: pr.deletions ?? 0,
    title: pr.title ?? "",
    draft: pr.isDraft === true,
    checks,
    checksColor,
    items: extractCheckItems(rollup),
  };
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
  checkItems: CheckItem[];
  // Direct PR URL, set in --all mode; empty for same-repo rows.
  url: string;
  // Display name for the row's first line. Defaults to `branch`; --all sets it
  // to the PR title since those rows have no local branch to name.
  display?: string;
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
    checkItems: pr?.items ?? [],
    url: pr?.url ?? "",
  });
}

// resetStack: clear all stack state. Loaders call this at the moment they
// begin building rows (not before their slow network walk) so any previously
// shown rows — a cache or the last refresh — stay on screen until fresh data
// is ready to replace them in one burst.
function resetStack(): void {
  PRS.clear();
  CHILDREN.clear();
  ROWS.length = 0;
  ROW_OF.clear();
  ROOT_ROW_OF.clear();
  ROOTS.length = 0;
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
// onStep (if given) is called after each `gh` round-trip so the caller can
// keep the loading indicator live.
async function loadStackCurrent(onStep?: () => void): Promise<void> {
  CUR_BRANCH = (await tryOut("git", ["branch", "--show-current"])) ?? "";
  if (!CUR_BRANCH) throw new Error("detached HEAD; check out a branch first");
  onStep?.();

  // Walk the PRs into a scratch map first, so the current view (a cache or the
  // last data) stays on screen until we have a full replacement.
  const fields = prFields();
  const walked = new Map<string, PrInfo>();
  let b = CUR_BRANCH;
  const chain: string[] = [];
  while (chain.length < 50) {
    const raw = await tryOut("gh", ["pr", "view", b, "--json", fields]);
    onStep?.();
    if (raw === null) break;
    let pr;
    try {
      pr = JSON.parse(raw);
    } catch {
      break;
    }
    if (pr.state !== "OPEN") break;
    walked.set(pr.headRefName, prInfoOf(pr));
    chain.unshift(b);
    b = walked.get(b)!.base;
  }
  if (chain.length === 0) {
    throw new Error(`no open pull request found for branch '${CUR_BRANCH}'`);
  }

  resetStack();
  for (const [k, v] of walked) PRS.set(k, v);
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
    throw new Error(
      "failed to list your pull requests (is 'gh' authenticated for this repo?)",
    );
  }
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    throw new Error(
      "failed to list your pull requests (is 'gh' authenticated for this repo?)",
    );
  }

  // Fold into scratch first, then swap the stack state in one burst so any
  // currently shown rows (cache/last data) aren't cleared until we're ready.
  const walked = new Map<string, PrInfo>();
  const kids = new Map<string, string[]>();
  const heads: string[] = [];
  for (const pr of prs) {
    const head = pr.headRefName;
    walked.set(head, prInfoOf(pr));
    heads.push(head);
    const base = walked.get(head)!.base;
    kids.set(base, [...(kids.get(base) ?? []), head]);
  }
  if (heads.length === 0) {
    throw new Error("you have no open pull requests in this repo");
  }

  resetStack();
  for (const [k, v] of walked) PRS.set(k, v);
  for (const [k, v] of kids) CHILDREN.set(k, v);

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

// --all / --org: every open PR you authored, grouped by repo. Uses `gh search
// prs` (cross-repo), which exposes far fewer fields than `gh pr view` — no base
// branch, diff size, or checks — so this is a read-only overview: each repo is
// a root row, its PRs the children (opened with enter). Rebase/checkout don't
// apply since the PRs live outside the current repo. With --org the search is
// scoped to the current repo's organization (the owner in owner/repo).
async function loadStackAll(): Promise<void> {
  CUR_BRANCH = (await tryOut("git", ["branch", "--show-current"])) ?? "";

  const args = [
    "search",
    "prs",
    "--author",
    "@me",
    "--state",
    "open",
    "--limit",
    String(PR_LIMIT),
    "--json",
    "number,title,repository,url,isDraft",
  ];
  if (MODE === "org") {
    const owner = REPO_SLUG.split("/")[0];
    if (!owner) throw new Error("could not determine the current repo's org");
    args.push("--owner", owner);
  }
  const raw = await tryOut("gh", args);
  if (raw === null) throw new Error("failed to search your pull requests");
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch {
    throw new Error("failed to search your pull requests");
  }
  if (!Array.isArray(prs) || prs.length === 0) {
    throw new Error(
      MODE === "org"
        ? `you have no open pull requests in ${REPO_SLUG.split("/")[0]}`
        : "you have no open pull requests",
    );
  }

  // Group PRs by repo (owner/name), preserving first-seen order.
  const byRepo = new Map<string, PrInfo[]>();
  for (const pr of prs) {
    const repo = String(pr.repository?.nameWithOwner ?? "unknown");
    const info: PrInfo = {
      base: repo,
      num: String(pr.number),
      adds: 0,
      dels: 0,
      title: pr.title ?? "",
      draft: pr.isDraft === true,
      checks: "",
      checksColor: "",
      items: [],
      url: pr.url ?? "",
    };
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), info]);
  }

  resetStack();
  for (const [repo, list] of byRepo) {
    addRootRow(repo);
    for (const info of list) {
      // A synthetic per-repo key keeps rows unique even if PR branches collide;
      // the row's display name is the PR title (there's no branch to show).
      const key = `${repo}#${info.num}`;
      PRS.set(key, info);
      addRow(key, repo, 1);
      ROWS[ROWS.length - 1].display = info.title || `#${info.num}`;
    }
  }
}

// isOverview: --all / --org are read-only cross-repo overviews (PRs live
// outside the working dir), so rebase/checkout/checks/git-stats don't apply.
function isOverview(): boolean {
  return MODE === "all" || MODE === "org";
}

// loadStack: dispatch to the loader for the current MODE. onStep, if given, is
// forwarded to loaders that report per-round-trip progress.
function loadStack(onStep?: () => void): Promise<void> {
  if (MODE === "yours") return loadStackYours();
  if (isOverview()) return loadStackAll();
  return loadStackCurrent(onStep);
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

  if (!(await cascadeStep(chainRootRow, "updated", updateRoot))) {
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
  // rebased outside git dash; plain merge-base is the fallback.
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
        const ok = await cascadeStep(
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
        await cascadeStep(r, "up to date", () => Promise.resolve());
      }
      continue;
    }

    const note = push ? "rebased · pushed" : "rebased";
    if (!(await cascadeStep(r, note, () => rebaseBranch(b, p, old, push)))) {
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

// ── CLI state ──────────────────────────────────────────────────────────────
// Parsing lives in cli.ts; main() applies the parsed options into these.

let PUSH = true;
let BASE_DIR = "";
let MODE: Mode = "current";
let CONFIG_IMPORT = "";

// ── Terminal ─────────────────────────────────────────────────────────────────

const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
let SPIN_I = 0;
let SEL_LINE = 0;
let SEL = 1;
// Check-list selection: branches whose checks are expanded, and which check
// of the selected row the cursor sits on (-1 = the row itself).
const EXPANDED = new Set<string>();
let CHECK_SEL = -1;
let REFRESH_LEFT = 0;
let REFRESH_TIMER: number | undefined;
let REFRESHING = false;
let BUSY = false;
// True while the initial PR load is still in flight — the stack renders as
// rows arrive, so this only drives the header's loading indicator and the
// empty-stack skeleton.
let LOADING = false;
// Set once cached rows are showing but the live reload hasn't finished, so the
// header can flag the view as stale.
let STALE = false;
let SEL_CHAIN = new Set<number>();
let MESSAGE = "";
let INFO = "";
let STEP_LOG_TAIL = "";
let LINES: string[] = [];
// Lines pinned to the top of the window (the tab bar and repo slug); LINES
// scrolls in the space below them.
let HEADER: string[] = [];
// Lines pinned to the bottom of the window (key hints, countdown, messages);
// LINES scrolls in the space above them.
let FOOTER: string[] = [];

// The interactive session is a two-tab UI (Tab / Shift-Tab switches). The
// stack tab is the PR view; the settings tab is what --configure opens onto.
// Each tab owns its own selection cursor and build/keys functions, but both
// paint through the shared LINES/FOOTER machinery above.
export type Tab = "stack" | "settings";
let TAB: Tab = "stack";
export const TABS: Tab[] = ["stack", "settings"];
const TAB_LABEL: Record<Tab, string> = {
  stack: "Pull Requests",
  settings: "Settings",
};

// nextTab: the tab `step` positions away from `cur`, wrapping around. +1 is
// Tab, -1 is Shift-Tab.
export function nextTab(cur: Tab, step: number): Tab {
  const i = TABS.indexOf(cur);
  return TABS[(i + step + TABS.length) % TABS.length];
}

// tabBar: the left side of the header line, with the active tab highlighted.
function tabBar(): string {
  const cells = TABS.map((t) =>
    t === TAB ? bold(cyan(`● ${TAB_LABEL[t]}`)) : dim(`  ${TAB_LABEL[t]}`)
  );
  return `  ${cells.join(dim("  │  "))}${dim("   · tab/⇧tab switch")}`;
}

// headerStatus: the discreet indicator shown at the far right of the header.
// Always ends with "q quit"; on the stack tab the load/refresh state or
// auto-refresh countdown is prepended, separated by a middot.
function headerStatus(): string {
  let lead = "";
  if (TAB === "stack") {
    if (LOADING) lead = `${SPIN_FRAMES[SPIN_I % 10]} loading`;
    else if (REFRESHING) lead = `${SPIN_FRAMES[SPIN_I % 10]} refreshing`;
    else if (STALE) lead = "cached";
    else if (AUTO_REFRESH > 0) lead = `↻ ${formatCountdown(REFRESH_LEFT)}`;
  }
  return dim(lead ? `${lead} · q quit` : "q quit");
}

const INTERACTIVE = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
let RAW = false;
let ALT = false;

function write(s: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(s));
}

// The interactive views run on the terminal's alternate screen buffer, so
// they own the full window height and leave the scrollback untouched on exit.
function enterAltScreen(): void {
  if (!INTERACTIVE || ALT) return;
  write("\x1b[?1049h\x1b[?25l");
  ALT = true;
}

function exitAltScreen(): void {
  if (!ALT) return;
  write("\x1b[?25h\x1b[?1049l");
  ALT = false;
}

function setRaw(on: boolean): void {
  if (!INTERACTIVE || RAW === on) return;
  // cbreak keeps Ctrl-C delivering SIGINT so cleanup always runs.
  Deno.stdin.setRaw(on, on ? { cbreak: true } : undefined);
  RAW = on;
}

async function cleanup(): Promise<void> {
  if (REFRESH_TIMER !== undefined) clearInterval(REFRESH_TIMER);
  if (INTERACTIVE) {
    exitAltScreen();
    write("\x1b[?25h");
    setRaw(false);
  }
  killCurrentChild();
  await abortRebaseIfAny();
  await restoreBranch();
}

// paint: redraw the screen (shared by the main and configure views). HEADER is
// pinned to the top rows and FOOTER to the bottom; LINES scrolls in the space
// between them (viewTop, from format.ts, keeps SEL_LINE visible).
function paint(): void {
  const rows = termRows();
  // Header and footer eat into the window from the top and bottom; on tiny
  // windows the footer's trailing padding goes first and at least one content
  // row always stays visible. The header is pinned as-is (it's short).
  const padded = FOOTER.length > 0 ? [...FOOTER, ""] : FOOTER;
  const header = HEADER.slice(0, Math.max(rows - 1, 0));
  const footRoom = Math.max(rows - header.length - 1, 0);
  const footer = padded.slice(0, footRoom);
  const contentRows = Math.max(rows - header.length - footer.length, 1);
  const top = viewTop(LINES.length, contentRows, SEL_LINE);
  const view = [...header, ...LINES.slice(top, top + contentRows)];
  if (footer.length > 0) {
    while (view.length < header.length + contentRows) view.push("");
    view.push(...footer);
  }
  let out = "\x1b[H";
  for (let i = 0; i < view.length; i++) {
    out += `\x1b[2K${view[i]}`;
    if (i < view.length - 1) out += "\n";
  }
  out += "\x1b[0J";
  write(out);
}

function termCols(): number {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return 120;
  }
}

function termRows(): number {
  try {
    return Deno.consoleSize().rows;
  } catch {
    return 40;
  }
}

// decodeKeys: split raw input into key names. Escape sequences arrive as one
// chunk in raw mode; a lone ESC byte is the escape key.
export function decodeKeys(s: string): string[] {
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

// readKeys: block for input, return decoded key names.
const keyBuf = new Uint8Array(64);
async function readKeys(): Promise<string[] | null> {
  const n = await Deno.stdin.read(keyBuf);
  if (n === null) return null;
  return decodeKeys(new TextDecoder().decode(keyBuf.subarray(0, n)));
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

interface Workflow {
  id: string;
  name: string;
}

// Settings-tab state. Workflows load lazily the first time the tab is opened
// (SETTINGS_LOADED guards the fetch); CSEL is the settings cursor, mirroring
// the stack tab's SEL. The first three rows are the toggles; rows 3.. map to
// WORKFLOWS[CSEL - 3].
const WORKFLOWS: Workflow[] = [];
let SETTINGS_LOADED = false;
let CSEL = 0;
let CMSG = "";

function keyOfWf(wfId: string): string {
  for (const [k, b] of ACTIONS) {
    if (b.workflow === wfId) return k;
  }
  return "";
}

// Sample PR rendered through the same formatters as the stack view, so
// toggling a setting shows exactly what it changes.
const SETTINGS_PREVIEW = {
  branch: "feat/api-client",
  checks: "47/48",
  checksColor: "yellow",
  num: "128",
  title: "feat(api-client): typed client with ret/verify request flow",
  adds: 412,
  dels: 18,
  ahead: "2",
};

// The settings cursor can land on the three toggles plus one row per workflow.
function settingsLast(): number {
  return WORKFLOWS.length + 2;
}

async function loadSettings(): Promise<void> {
  if (SETTINGS_LOADED) return;
  SETTINGS_LOADED = true;
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
        WORKFLOWS.push({ id, name: wf.name || wf.path });
      }
    } catch {
      // no workflows
    }
  }
}

function buildSettingsLines(): void {
  buildHeader();
  LINES = [];

  // The preview PR renders through the same formatters as the stack view,
  // inside a bordered box so it reads as a self-contained sample. boxed()
  // truncates any line that would overrun the border, so the inner width can
  // just be sized to the window (capped so it stays readable on wide screens).
  const previewInner = Math.max(Math.min(termCols() - 6, 84), 24);
  const preview: string[] = [
    `${cyan("●")} ${
      formatBranchLine(SETTINGS_PREVIEW, {
        showChecks: SHOW_CHECKS,
        showPr: SHOW_PR,
        current: false,
        expand: "closed",
      })
    }`,
  ];
  if (SHOW_PR) {
    preview.push(`  ${formatMetaLine(SETTINGS_PREVIEW, termCols(), 1)}`);
  }
  LINES.push(...boxed("preview", preview, previewInner));
  LINES.push("");

  let cur = " ";
  if (CSEL === 0) {
    cur = bold(cyan("❯"));
    SEL_LINE = LINES.length;
  }
  const state = SHOW_CHECKS ? green("[on]") : dim("[off]");
  LINES.push(
    `  ${cur} Show checks ${state} ${
      dim("· [passed/total] check status on each PR")
    }`,
  );

  cur = " ";
  if (CSEL === 1) {
    cur = bold(cyan("❯"));
    SEL_LINE = LINES.length;
  }
  const pr = SHOW_PR ? green("[on]") : dim("[off]");
  LINES.push(
    `  ${cur} Show pull request ${pr} ${
      dim("· PR number/title line under each branch")
    }`,
  );

  cur = " ";
  if (CSEL === 2) {
    cur = bold(cyan("❯"));
    SEL_LINE = LINES.length;
  }
  const refresh = AUTO_REFRESH > 0
    ? green(`[${formatCountdown(AUTO_REFRESH)}]`)
    : dim("[off]");
  LINES.push(
    `  ${cur} Auto refresh ${refresh} ${dim("· re-fetch PRs periodically")}`,
  );
  LINES.push("");

  LINES.push(`  ${dim("action keys")}`);
  if (WORKFLOWS.length === 0) {
    LINES.push(`      ${dim("no active workflows found in this repo")}`);
  }
  for (let i = 0; i < WORKFLOWS.length; i++) {
    cur = " ";
    if (CSEL === i + 3) {
      cur = bold(cyan("❯"));
      SEL_LINE = LINES.length;
    }
    const k = keyOfWf(WORKFLOWS[i].id);
    const disp = k ? bold(cyan(k)) : dim("—");
    LINES.push(
      `  ${cur} ${disp}  ${WORKFLOWS[i].name} ${dim(`· ${WORKFLOWS[i].id}`)}`,
    );
  }

  // The footer reflects what the selected settings row can do: the toggles
  // flip with space, and only a workflow row shows the bind/rename/unbind
  // hints (and rename/unbind only once a key is bound). Navigation, tab-switch,
  // and quit are implicit (quit lives in the header).
  FOOTER = [""];
  const parts: string[] = [];
  if (CSEL <= 2) {
    parts.push("space toggle");
  } else {
    parts.push("a-z 0-9 bind");
    if (keyOfWf(WORKFLOWS[CSEL - 3]?.id ?? "")) {
      parts.push("enter rename");
      parts.push("esc unbind");
    }
  }
  FOOTER.push(`  ${parts.length ? dim(parts.join(" · ")) : ""}`);
  if (CMSG) {
    FOOTER.push("");
    FOOTER.push(`  ${yellow(CMSG)}`);
  }
}

// Rename how a bound action is shown (in the footer and the list); the name is
// only stored in the local user's config. Reads one echoed line below the UI,
// which paint() then reclaims.
async function renameSelectedAction(): Promise<void> {
  const wf = WORKFLOWS[CSEL - 3];
  const k = keyOfWf(wf.id);
  if (!k) {
    CMSG = "bind a key before renaming";
    return;
  }
  const newName = await readLine(`  rename '${ACTIONS.get(k)!.name}' to: `);
  if (newName) {
    ACTIONS.get(k)!.name = newName;
    wf.name = newName;
    configSave();
  }
}

// handleSettingsKey: one key for the settings tab. Returns false only for keys
// the shared loop owns (quit, tab-switch) so it can act on them.
async function handleSettingsKey(key: string): Promise<boolean> {
  CMSG = "";
  if (key === "\x1b[A" || key === "k") {
    if (CSEL > 0) CSEL -= 1;
  } else if (key === "\x1b[B" || key === "j") {
    if (CSEL < settingsLast()) CSEL += 1;
  } else if (key === " " || key === "\r" || key === "\n") {
    if (CSEL === 0) {
      SHOW_CHECKS = !SHOW_CHECKS;
      configSave();
    } else if (CSEL === 1) {
      SHOW_PR = !SHOW_PR;
      configSave();
    } else if (CSEL === 2) {
      AUTO_REFRESH = nextAutoRefresh(AUTO_REFRESH);
      configSave();
    } else if (key !== " ") {
      await renameSelectedAction();
    }
  } else if (key === "\x1b") {
    if (CSEL > 2) {
      const k = keyOfWf(WORKFLOWS[CSEL - 3].id);
      if (k) {
        ACTIONS.delete(k);
        configSave();
      }
    }
  } else if (/^[a-z0-9]$/.test(key)) {
    if (CSEL > 2) {
      if (RESERVED_KEYS.includes(key)) {
        CMSG = `'${key}' is reserved (${RESERVED_KEYS})`;
      } else {
        const wf = WORKFLOWS[CSEL - 3];
        const prev = keyOfWf(wf.id);
        if (prev) ACTIONS.delete(prev);
        // Assigning an already-used key steals it from the other workflow.
        ACTIONS.set(key, { workflow: wf.id, name: wf.name });
        configSave();
      }
    }
  } else {
    return false;
  }
  render();
  return true;
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

function rowChecks(i: number): CheckItem[] {
  return SHOW_CHECKS ? ROWS[i]?.checkItems ?? [] : [];
}

function isExpanded(i: number): boolean {
  return EXPANDED.has(ROWS[i]?.branch ?? "") && rowChecks(i).length > 0;
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

// buildHeader: the pinned top rows shared by both tabs — a blank spacer, the
// tab bar, the repo slug, and a blank separator. Non-interactive output has no
// tabs, so it keeps the old single-line "dash · slug" title in LINES instead.
function buildHeader(): void {
  if (!INTERACTIVE) {
    HEADER = [];
    return;
  }
  // Tab bar on the left, discreet status on the right of the same line.
  const left = tabBar();
  const status = headerStatus();
  let bar = left;
  if (status) {
    const gap = termCols() - 2 - visibleWidth(left) - visibleWidth(status);
    bar = `${left}${" ".repeat(Math.max(gap, 1))}${status}`;
  }
  HEADER = [
    "",
    bar,
    dim(`  ${REPO_SLUG || "local"}`),
    "",
  ];
}

function buildLines(): void {
  buildHeader();
  LINES = [];
  if (!INTERACTIVE) {
    LINES.push("");
    LINES.push(`  ${bold("dash")}${dim(` · ${REPO_SLUG || "local"}`)}`);
    LINES.push("");
  }

  markSelChain();

  const cols = termCols();

  // Nothing to draw yet: show a short skeleton so the window isn't blank while
  // the first PRs come back. The spinner in the header signals live progress.
  if (INTERACTIVE && ROWS.length === 0 && LOADING) {
    LINES.push("");
    LINES.push(`  ${dim("○")} ${dim("loading pull requests…")}`);
    LINES.push(`  ${dim("○")} ${grey("resolving stack")}`);
  }

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i];
    let cursor = " ";
    if (INTERACTIVE && i === SEL && CHECK_SEL < 0) {
      cursor = BUSY ? grey("❯") : bold(cyan("❯"));
      SEL_LINE = LINES.length;
    }

    if (!row.parent) {
      if (i > 0) LINES.push("");
      // In an overview the root is a repo name (owner/name), not a git branch —
      // no origin comparison applies, so just show the repo.
      if (isOverview()) {
        LINES.push(`  ${cursor} ${glyphFor(i)} ${bold(row.branch)}`);
        continue;
      }
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

    const bname = formatBranchLine(
      { ...row, branch: row.display ?? row.branch },
      {
        showChecks: SHOW_CHECKS,
        // showPr:false appends the diff delta to the branch line; overviews
        // have no delta data, so keep it true there to suppress it.
        showPr: isOverview() ? true : SHOW_PR,
        current: row.branch === CUR_BRANCH,
        expand: row.checkItems.length > 0
          ? (isExpanded(i) ? "open" : "closed")
          : undefined,
      },
    );
    let note = "";
    if (row.draft) note = ` ${yellow("[draft]")}`;
    if (row.note) note += grey(` · ${row.note}`);
    LINES.push(`  ${ind}${cursor} ${g} ${bname}${note}`);

    // Overview rows have only a number to show below the title; same-repo rows
    // get the full #num/title/delta meta line.
    if (isOverview()) {
      LINES.push(`  ${ind}    ${dim(`#${row.num}`)}`);
    } else if (SHOW_PR) {
      LINES.push(`  ${ind}    ${formatMetaLine(row, cols, ind.length)}`);
    }

    if (isExpanded(i)) {
      for (let ci = 0; ci < row.checkItems.length; ci++) {
        const chk = row.checkItems[ci];
        let ccur = " ";
        if (INTERACTIVE && i === SEL && ci === CHECK_SEL) {
          ccur = BUSY ? grey("❯") : bold(cyan("❯"));
          SEL_LINE = LINES.length;
        }
        const cg = chk.state === "pass"
          ? green("✓")
          : chk.state === "fail"
          ? red("✗")
          : yellow("●");
        LINES.push(`  ${ind}    ${ccur} ${cg} ${chk.name}`);
      }
    }
  }

  FOOTER = [];
  if (INTERACTIVE) {
    const selRow = ROWS[SEL];
    const onCheck = CHECK_SEL >= 0;
    const hasChecks = SHOW_CHECKS && rowChecks(SEL).length > 0;
    const expanded = isExpanded(SEL);
    const isRoot = selRow && !selRow.parent;

    // Only the distinctive actions for the current selection — enter/space is
    // the universal "open" (view PR, open check), so it isn't spelled out, and
    // navigation, tab-switch, and quit are implicit (quit lives in the header).
    const parts: string[] = [];

    if (ROWS.length === 0) {
      // nothing selectable
    } else if (onCheck) {
      // enter opens the check (universal action); ← returns to the PR row.
      parts.push("← collapse");
    } else {
      if (hasChecks) {
        parts.push(expanded ? "→ checks · ← collapse" : "→ checks");
      }
      // enter opens the selected PR/check — a universal action, not spelled out.
      // Overviews are cross-repo read-only: rebase/checkout don't apply.
      if (!isOverview()) {
        parts.push("r rebase");
        parts.push("c checkout");
      }
    }
    // The auto-refresh countdown/spinner lives in the header now; the footer
    // keeps just the manual-refresh key hint.
    if (ROWS.length > 0 && AUTO_REFRESH > 0) parts.push("R refresh");

    FOOTER.push("");
    FOOTER.push(`  ${parts.length ? dim(parts.join(" · ")) : ""}`);

    if (!onCheck && !isRoot) {
      const hints = actionHints();
      if (hints) FOOTER.push(`  ${dim(hints)}`);
    }
  }
  if (INFO) {
    FOOTER.push("");
    FOOTER.push(`  ${dim(INFO)}`);
  }
  if (MESSAGE) {
    FOOTER.push("");
    for (const line of MESSAGE.split("\n")) {
      FOOTER.push(`  ${red(line)}`);
    }
  }
  if (STEP_LOG_TAIL) {
    for (const line of STEP_LOG_TAIL.split("\n")) {
      FOOTER.push(`    ${grey(line)}`);
    }
  }
}

function render(): void {
  if (TAB === "settings") {
    buildSettingsLines();
  } else {
    buildLines();
  }
  paint();
}

// cascadeStep: run one cascade step, animating the row's spinner until it
// settles. See the cascade section for the contract.
async function cascadeStep(
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

// openUrl: hand a URL to the platform browser opener (used for check links and
// cross-repo PRs, which can't go through `gh pr view` against this repo).
async function openUrl(url: string): Promise<void> {
  if (!url) return;
  const opener = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  await tryOut(opener, [url]);
}

async function openSelectedPr(): Promise<void> {
  const row = ROWS[SEL];
  if (!row?.num) return;
  // --all rows live in other repos — open the stored URL directly.
  if (row.url) {
    await openUrl(row.url);
    return;
  }
  await tryOut("gh", ["pr", "view", row.num, "--web"]);
}

// Check detail links can point anywhere (GitHub, external CI), so use the
// platform opener rather than gh.
async function openSelectedCheck(): Promise<void> {
  await openUrl(rowChecks(SEL)[CHECK_SEL]?.url ?? "");
}

// refreshData: re-fetch PRs and git stats in place. On failure the previous
// data is restored, so a flaky network never blanks the view.
async function refreshData(): Promise<void> {
  if (BUSY) return;
  BUSY = true;
  REFRESHING = true;
  render();

  const selBranch = ROWS[SEL]?.branch ?? "";
  // The loaders build into scratch and swap in one burst, so the current rows
  // stay visible during the refetch; keep a snapshot only to restore on error.
  const snapshot = ROWS.map((r) => ({ ...r }));

  try {
    await loadStack();
    await loadGitStats();
    for (const b of [...EXPANDED]) {
      if (!ROW_OF.has(b)) EXPANDED.delete(b);
    }
    STALE = false;
    INFO = "";
    saveStackCache();
  } catch {
    restoreRows(snapshot);
    INFO = "refresh failed — showing previous data";
  }

  SEL = ROW_OF.get(selBranch) ?? ROW_OF.get(CUR_BRANCH) ?? 1;
  CHECK_SEL = isExpanded(SEL)
    ? Math.min(CHECK_SEL, rowChecks(SEL).length - 1)
    : -1;
  REFRESHING = false;
  BUSY = false;
  render();
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
  INFO = "";

  // While the dispatch runs, the selected row shows a spinner and the rest of
  // the view is greyed out (BUSY); the sequential input loop blocks keys.
  ROWS[SEL].status = "running";
  BUSY = true;
  const timer = setInterval(() => {
    SPIN_I += 1;
    render();
  }, 80);

  const finish = (status: RowStatus) => {
    clearInterval(timer);
    BUSY = false;
    ROWS[SEL].status = status;
  };

  const r = await run("gh", ["workflow", "run", wf, "--ref", ref]);
  if (r.code !== 0) {
    finish("fail");
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
  finish("idle");
  if (id) {
    ACTION_RUN_ID.set(key, id);
    INFO = `'${name}' running on ${ref} — press '${key}' again to view`;
  } else {
    INFO = `'${name}' dispatched on ${ref}`;
  }
  render();
}

// switchTab: move to another tab, lazily loading the settings tab's workflow
// list the first time it's opened (with a spinner, since it shells out to gh).
async function switchTab(to: Tab): Promise<void> {
  if (TAB === to) return;
  TAB = to;
  if (to === "settings" && !SETTINGS_LOADED) {
    CMSG = "";
    buildHeader();
    LINES = ["", dim("  loading workflows…")];
    FOOTER = [];
    paint();
    await loadSettings();
    CSEL = Math.min(CSEL, settingsLast());
  }
  render();
}

async function inputLoop(): Promise<void> {
  loop: while (true) {
    const keys = await readKeys();
    if (keys === null) break;
    for (const key of keys) {
      if (key === "q" || key === "\x03") break loop;
      // A timer-driven refresh may be running while we sit in readKeys; drop
      // action keys instead of interleaving with it.
      if (BUSY) continue;
      // Tab / Shift-Tab cycle tabs from either view.
      if (key === "\t") {
        await switchTab(nextTab(TAB, 1));
        continue;
      }
      if (key === "\x1b[Z") {
        await switchTab(nextTab(TAB, -1));
        continue;
      }
      if (TAB === "settings") {
        await handleSettingsKey(key);
        continue;
      }
      // The stack can be empty if it failed to load (e.g. --configure on a
      // detached HEAD); only tab-switch and quit apply until there are rows.
      if (ROWS.length === 0) continue;
      const last = ROWS.length - 1;
      if (key === "\x1b[A" || key === "k") {
        if (CHECK_SEL >= 0) {
          CHECK_SEL -= 1;
        } else if (SEL > 0) {
          SEL -= 1;
          CHECK_SEL = isExpanded(SEL) ? rowChecks(SEL).length - 1 : -1;
        }
        render();
      } else if (key === "\x1b[B" || key === "j") {
        if (isExpanded(SEL) && CHECK_SEL < rowChecks(SEL).length - 1) {
          CHECK_SEL += 1;
        } else if (SEL < last) {
          SEL += 1;
          CHECK_SEL = -1;
        }
        render();
      } else if (key === "\r" || key === "\n" || key === " ") {
        // enter/space is the universal "open": a check on a check row, else
        // the PR on GitHub.
        if (CHECK_SEL >= 0) {
          await openSelectedCheck();
        } else {
          await openSelectedPr();
        }
      } else if (key === "\x1b[C") {
        // On a PR row: expand/collapse its checks. On a check: open it.
        if (CHECK_SEL >= 0) {
          await openSelectedCheck();
        } else if (rowChecks(SEL).length > 0) {
          const b = ROWS[SEL].branch;
          if (!EXPANDED.delete(b)) EXPANDED.add(b);
          render();
        }
      } else if (key === "\x1b[D") {
        if (isExpanded(SEL)) {
          EXPANDED.delete(ROWS[SEL].branch);
          CHECK_SEL = -1;
          render();
        }
      } else if (key === "r") {
        if (!isOverview()) await startRebase();
      } else if (key === "c") {
        if (!isOverview()) await checkoutSelected();
      } else if (key === "v") {
        await openSelectedPr();
      } else if (key === "R" && AUTO_REFRESH > 0) {
        REFRESH_LEFT = AUTO_REFRESH;
        await refreshData();
      } else if (key.length === 1 && ACTIONS.has(key)) {
        await runActionKey(key);
      }
    }
  }
}

// ── Upgrade ──────────────────────────────────────────────────────────────────

// runUpgrade: emit the install one-liner so it can be piped to a shell
// (`git dash upgrade | bash`). Printing rather than spawning a shell keeps the
// tool from needing run permission for bash. When stdout is a terminal we add
// a short instruction; when piped, only the bare command is written.
function runUpgrade(): never {
  const repo = Deno.env.get("GIT_DASH_REPO") ?? "jakiestfu/git-dash";
  const ref = Deno.env.get("GIT_DASH_REF") ?? "main";
  const oneLiner =
    `curl -fsSL https://raw.githubusercontent.com/${repo}/${ref}/install.sh | bash`;
  if (Deno.stdout.isTerminal()) {
    console.log(dim("Update git-dash by running:\n"));
    console.log(`  ${oneLiner}\n`);
    console.log(dim("Or in one step:  git dash upgrade | bash"));
  } else {
    // Piped (`git dash upgrade | bash`): emit only the command to execute.
    console.log(oneLiner);
  }
  Deno.exit(0);
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Gate color on TTY/NO_COLOR before any output (incl. parse-time errors).
  applyColorPreference();
  const opts: CliOptions = parseArgs(Deno.args);
  PUSH = opts.push;
  BASE_DIR = opts.baseDir;
  MODE = opts.mode;
  CONFIG_IMPORT = opts.configImport;

  // `upgrade` is a standalone command — it doesn't need a git repo or gh.
  if (MODE === "upgrade") runUpgrade();

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

  // --configure opens the session onto the Settings tab; Tab switches back to
  // the stack. A shared JSON import still runs first and, without a terminal,
  // is the whole job (no TUI to show).
  const startOnSettings = MODE === "configure";
  if (CONFIG_IMPORT) await importActions(CONFIG_IMPORT);
  if (startOnSettings && !INTERACTIVE) {
    if (!CONFIG_IMPORT) {
      die("--configure requires an interactive terminal (or a URL to import)");
    }
    return;
  }

  // ── Non-interactive: block, load everything, print once. ──────────────────
  if (!INTERACTIVE) {
    try {
      await loadStack();
      // Overviews are cross-repo: no local branches to fetch or diff against.
      if (!isOverview()) {
        for (const root of ROOTS) {
          await tryOut("git", ["fetch", "origin", root, "--quiet"]);
        }
        await loadGitStats();
      }
    } catch (e) {
      if (!startOnSettings) throw e;
      INFO = e instanceof Error ? e.message : String(e);
    }
    SEL = ROW_OF.get(CUR_BRANCH) ?? 1;
    buildLines();
    console.log([...HEADER, ...LINES, ...FOOTER].join("\n"));
    return;
  }

  // ── Interactive: paint the shell instantly, then fill it in place. ────────
  enterAltScreen();
  setRaw(true);

  // 1. If a cached stack exists, show it immediately (marked stale) so the
  //    window is populated before any network call returns.
  const cached = loadStackCache();
  if (cached && !startOnSettings) {
    restoreRows(cached.rows);
    CUR_BRANCH = cached.curBranch;
    SEL = ROW_OF.get(CUR_BRANCH) ?? 1;
    STALE = true;
  }
  if (startOnSettings) {
    TAB = "settings";
    await loadSettings();
  }
  render();

  // 2. Load PRs, animating the header spinner. The loaders build into scratch
  //    and swap the stack in one burst, so cached rows (if any) stay on screen
  //    the whole time and are replaced only once fresh data is ready. On
  //    failure the cache remains untouched.
  LOADING = true;
  const spin = setInterval(() => {
    SPIN_I += 1;
    render();
  }, 80);
  const selBranch = ROWS[SEL]?.branch ?? "";
  const hadCache = ROWS.length > 0;
  let loadErr = "";
  try {
    await loadStack(() => render());
    STALE = false;
    INFO = "";
  } catch (e) {
    loadErr = e instanceof Error ? e.message : String(e);
    if (hadCache) INFO = "showing cached data — reload failed";
  }
  clearInterval(spin);
  LOADING = false;
  render();

  if (ROWS.length === 0 && loadErr) {
    // Nothing to show and no cache to fall back on.
    if (!startOnSettings) throw new Error(loadErr);
    INFO = loadErr;
  }
  SEL = ROW_OF.get(selBranch) ?? ROW_OF.get(CUR_BRANCH) ?? 1;

  // Overviews are cross-repo: skip the git stats and origin fetch (they only
  // make sense for branches in the current repo) but still cache the rows.
  const localStack = !isOverview();

  // 3. Local git stats are cheap (no network) — compute and paint them now.
  if (ROWS.length > 0 && localStack) {
    await loadGitStats();
    saveStackCache();
    render();
  } else if (ROWS.length > 0) {
    saveStackCache();
  }

  // 4. Fetch origin in the background and refresh behind/ahead counts in
  //    place; the UI is already fully usable while this runs.
  if (ROWS.length > 0 && ROOTS.length > 0 && localStack) {
    (async () => {
      for (const root of ROOTS) {
        await tryOut("git", ["fetch", "origin", root, "--quiet"]);
      }
      if (!BUSY) {
        await loadGitStats();
        saveStackCache();
        render();
      }
    })();
  }

  if (AUTO_REFRESH > 0) {
    REFRESH_LEFT = AUTO_REFRESH;
    REFRESH_TIMER = setInterval(() => {
      if (BUSY) return; // pause the countdown while an operation runs
      REFRESH_LEFT -= 1;
      if (REFRESH_LEFT <= 0) {
        REFRESH_LEFT = AUTO_REFRESH;
        refreshData();
      } else {
        render();
      }
    }, 1000);
  }
  render();
  await inputLoop();
}

if (import.meta.main) {
  if (INTERACTIVE && Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGWINCH", () => {
      if (ALT) paint();
    });
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(sig, async () => {
      await cleanup();
      Deno.exit(130);
    });
  }

  let exitCode = 0;
  let fatal = "";
  try {
    await main();
  } catch (e) {
    // Printed after cleanup(), so leaving the alternate screen can't erase it.
    fatal = e instanceof Error ? e.message : String(e);
    exitCode = 1;
  } finally {
    await cleanup();
  }
  if (fatal) console.error(red(fatal));
  Deno.exit(exitCode);
}
