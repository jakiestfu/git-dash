// Tests for git convoy. Pure helpers are imported directly (main.ts only
// runs its entry point under import.meta.main); CLI behavior is exercised by
// spawning the script as a subprocess.
//
// Run with: deno task test

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  boxed,
  decodeKeys,
  extractCheckItems,
  formatBranchLine,
  formatCountdown,
  formatMetaLine,
  nextAutoRefresh,
  nextTab,
  normalizeRepoUrl,
  summarizeChecks,
  tailLines,
  truncateVisible,
  viewTop,
  visibleWidth,
} from "./main.ts";

// Strip ANSI SGR codes so box geometry can be asserted regardless of color.
// deno-lint-ignore no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── normalizeRepoUrl ─────────────────────────────────────────────────────────

Deno.test("normalizeRepoUrl strips ssh form", () => {
  assertEquals(
    normalizeRepoUrl("git@github.com:turo/web-schumacher-app.git"),
    "turo/web-schumacher-app",
  );
});

Deno.test("normalizeRepoUrl strips https form", () => {
  assertEquals(
    normalizeRepoUrl("https://github.com/jakiestfu/git-convoy.git"),
    "jakiestfu/git-convoy",
  );
});

Deno.test("normalizeRepoUrl leaves plain slugs and non-github hosts alone", () => {
  assertEquals(normalizeRepoUrl("owner/repo"), "owner/repo");
  assertEquals(
    normalizeRepoUrl("https://gitlab.com/owner/repo"),
    "https://gitlab.com/owner/repo",
  );
});

// ── summarizeChecks ──────────────────────────────────────────────────────────

Deno.test("summarizeChecks is empty with no rollup", () => {
  assertEquals(summarizeChecks([]), { checks: "", checksColor: "" });
});

Deno.test("summarizeChecks all passing is green", () => {
  assertEquals(
    summarizeChecks([
      { conclusion: "SUCCESS" },
      { conclusion: "SKIPPED" },
      { conclusion: "NEUTRAL" },
    ]),
    { checks: "3/3", checksColor: "green" },
  );
});

Deno.test("summarizeChecks pending without failures is yellow", () => {
  assertEquals(
    summarizeChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]),
    { checks: "1/2", checksColor: "yellow" },
  );
});

Deno.test("summarizeChecks any failure is red, even with pending checks", () => {
  assertEquals(
    summarizeChecks([
      { conclusion: "SUCCESS" },
      { conclusion: "FAILURE" },
      { status: "IN_PROGRESS" },
    ]),
    { checks: "1/3", checksColor: "red" },
  );
});

Deno.test("summarizeChecks reads state and lowercase verdicts", () => {
  assertEquals(
    summarizeChecks([{ state: "success" }, { state: "error" }]),
    { checks: "1/2", checksColor: "red" },
  );
});

// ── extractCheckItems ────────────────────────────────────────────────────────

Deno.test("extractCheckItems reads CheckRun shapes and sorts failures first", () => {
  assertEquals(
    extractCheckItems([
      { name: "build", conclusion: "SUCCESS", detailsUrl: "https://x/1" },
      { name: "lint", status: "IN_PROGRESS" },
      { name: "test", conclusion: "FAILURE", detailsUrl: "https://x/3" },
    ]),
    [
      { name: "test", state: "fail", url: "https://x/3" },
      { name: "lint", state: "pending", url: "" },
      { name: "build", state: "pass", url: "https://x/1" },
    ],
  );
});

Deno.test("extractCheckItems keeps original order within the same state", () => {
  assertEquals(
    extractCheckItems([
      { name: "a", conclusion: "FAILURE" },
      { name: "b", conclusion: "SUCCESS" },
      { name: "c", conclusion: "FAILURE" },
    ]).map((i) => i.name),
    ["a", "c", "b"],
  );
});

Deno.test("extractCheckItems reads StatusContext shapes", () => {
  assertEquals(
    extractCheckItems([
      { context: "ci/circleci", state: "SUCCESS", targetUrl: "https://ci/9" },
    ]),
    [{ name: "ci/circleci", state: "pass", url: "https://ci/9" }],
  );
});

Deno.test("extractCheckItems falls back on missing fields", () => {
  assertEquals(
    extractCheckItems([{}]),
    [{ name: "check", state: "pending", url: "" }],
  );
});

// ── auto refresh helpers ─────────────────────────────────────────────────────

Deno.test("nextAutoRefresh cycles off -> 30s -> 1m -> 5m -> off", () => {
  assertEquals(nextAutoRefresh(0), 30);
  assertEquals(nextAutoRefresh(30), 60);
  assertEquals(nextAutoRefresh(60), 300);
  assertEquals(nextAutoRefresh(300), 0);
});

Deno.test("nextAutoRefresh recovers from unknown values", () => {
  assertEquals(nextAutoRefresh(42), 0);
});

// ── nextTab ──────────────────────────────────────────────────────────────────

Deno.test("nextTab cycles forward and wraps", () => {
  assertEquals(nextTab("stack", 1), "settings");
  assertEquals(nextTab("settings", 1), "stack");
});

Deno.test("nextTab cycles backward and wraps", () => {
  assertEquals(nextTab("settings", -1), "stack");
  assertEquals(nextTab("stack", -1), "settings");
});

// ── visibleWidth / boxed ─────────────────────────────────────────────────────

Deno.test("visibleWidth ignores ANSI color codes", () => {
  assertEquals(visibleWidth("abc"), 3);
  assertEquals(visibleWidth("\x1b[31mabc\x1b[0m"), 3);
  assertEquals(visibleWidth("\x1b[1m\x1b[36m●\x1b[0m\x1b[0m x"), 3);
});

Deno.test("boxed frames content with a titled border", () => {
  // inner=12 comfortably fits the " preview " title, so the span is inner+2.
  const lines = boxed("preview", ["hi"], 12, "").map(stripAnsi);
  assertEquals(lines, [
    "╭─ preview ────╮",
    "│ hi           │",
    "╰──────────────╯",
  ]);
  // Every row is the same width and the corners align.
  assertEquals(new Set(lines.map((l) => l.length)).size, 1);
});

Deno.test("truncateVisible leaves short strings alone", () => {
  assertEquals(truncateVisible("abc", 5), "abc");
  assertEquals(truncateVisible("abc", 3), "abc");
});

Deno.test("truncateVisible cuts to width with an ellipsis, ignoring ANSI", () => {
  assertEquals(truncateVisible("abcdef", 4), "abc…");
  // Color codes cost no width; the ellipsis still lands at the visible cut.
  const t = truncateVisible("\x1b[36mabcdef\x1b[0m", 4);
  assertEquals(visibleWidth(t), 4);
  assertEquals(stripAnsi(t), "abc…");
});

Deno.test("boxed truncates a content line that would overrun the border", () => {
  const lines = boxed("t", ["short", "this line is definitely too long"], 8, "")
    .map(stripAnsi);
  assertEquals(new Set(lines.map((l) => l.length)).size, 1);
  assert(lines[2].includes("…")); // the long line was cut
});

Deno.test("boxed widens the span when the title is longer than the content", () => {
  const lines = boxed("preview", ["x"], 2, "").map(stripAnsi);
  assertEquals(new Set(lines.map((l) => l.length)).size, 1);
  assert(lines[0].includes("preview"));
});

Deno.test("boxed keeps borders aligned across rows and ignores ANSI", () => {
  const lines = boxed("t", ["\x1b[36m●\x1b[0m ok", "longer line"], 11, "")
    .map(stripAnsi);
  // Every rendered row is the same visible width.
  const widths = new Set(lines.map((l) => l.length));
  assertEquals(widths.size, 1);
  // Content is padded to the inner width between the one-space border gaps.
  assert(lines[1].startsWith("│ ● ok"));
  assert(lines[1].endsWith(" │"));
});

Deno.test("formatCountdown renders seconds and minutes", () => {
  assertEquals(formatCountdown(0), "0s");
  assertEquals(formatCountdown(30), "30s");
  assertEquals(formatCountdown(60), "1m");
  assertEquals(formatCountdown(299), "4m59s");
  assertEquals(formatCountdown(300), "5m");
});

// ── PR line formatting ───────────────────────────────────────────────────────
// These run without a TTY, so color codes are disabled and output is plain.

const SAMPLE = {
  branch: "feat/set-phone-number",
  checks: "47/48",
  checksColor: "yellow",
  num: "14397",
  title: "feat(set-phone-number): generic set/verify mobile phone flow",
  adds: 881,
  dels: 0,
  ahead: "2",
};

Deno.test("formatBranchLine includes the checks badge when enabled", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: true,
      current: false,
    }),
    "feat/set-phone-number [47/48]",
  );
});

Deno.test("formatBranchLine omits the checks badge when disabled", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: false,
      showPr: true,
      current: false,
    }),
    "feat/set-phone-number",
  );
});

Deno.test("formatBranchLine absorbs the delta when the PR line is hidden", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: false,
      current: false,
    }),
    "feat/set-phone-number [47/48] +881 −0 · 2 ahead",
  );
});

Deno.test("formatBranchLine marks the current branch with an asterisk", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: false,
      showPr: true,
      current: true,
    }),
    "feat/set-phone-number*",
  );
});

Deno.test("formatBranchLine shows a drill-down chevron next to the badge", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: true,
      current: false,
      expand: "closed",
    }),
    "feat/set-phone-number [47/48] ▸",
  );
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: true,
      current: false,
      expand: "open",
    }),
    "feat/set-phone-number [47/48] ▾",
  );
});

Deno.test("formatMetaLine renders number, title, and stats", () => {
  assertEquals(
    formatMetaLine(SAMPLE, 120, 1),
    "#14397 feat(set-phone-number): generic set/verify mobile phone flow  +881 −0 · 2 ahead",
  );
});

Deno.test("formatMetaLine truncates long titles to the terminal width", () => {
  const line = formatMetaLine(SAMPLE, 60, 1);
  assert(line.includes("…"), `expected truncation in: ${line}`);
  assert(line.includes("+881"));
});

// ── tailLines ────────────────────────────────────────────────────────────────

Deno.test("tailLines keeps the last n lines", () => {
  assertEquals(tailLines("a\nb\nc\nd\n", 2), "c\nd");
});

Deno.test("tailLines returns short input unchanged", () => {
  assertEquals(tailLines("a\nb", 6), "a\nb");
});

// ── viewTop ──────────────────────────────────────────────────────────────────

Deno.test("viewTop is 0 when everything fits", () => {
  assertEquals(viewTop(10, 40, 5), 0);
  assertEquals(viewTop(40, 40, 39), 0);
});

Deno.test("viewTop centers the selection when content overflows", () => {
  assertEquals(viewTop(100, 20, 50), 40);
});

Deno.test("viewTop clamps at the top and bottom of the content", () => {
  assertEquals(viewTop(100, 20, 0), 0);
  assertEquals(viewTop(100, 20, 99), 80);
});

Deno.test("viewTop keeps the selection inside the window everywhere", () => {
  for (let sel = 0; sel < 100; sel++) {
    const top = viewTop(100, 20, sel);
    assert(top >= 0 && top + 20 <= 100, `top ${top} out of range at ${sel}`);
    assert(sel >= top && sel < top + 20, `sel ${sel} outside [${top}, +20)`);
  }
});

// ── decodeKeys ───────────────────────────────────────────────────────────────

Deno.test("decodeKeys splits plain characters", () => {
  assertEquals(decodeKeys("jkq"), ["j", "k", "q"]);
});

Deno.test("decodeKeys keeps arrow-key escape sequences intact", () => {
  assertEquals(decodeKeys("\x1b[A\x1b[Bj"), ["\x1b[A", "\x1b[B", "j"]);
});

Deno.test("decodeKeys keeps Tab and Shift-Tab distinct", () => {
  // Tab is a plain byte; Shift-Tab is a CSI sequence kept whole.
  assertEquals(decodeKeys("\t\x1b[Z"), ["\t", "\x1b[Z"]);
});

Deno.test("decodeKeys treats a lone ESC as the escape key", () => {
  assertEquals(decodeKeys("\x1b"), ["\x1b"]);
});

// ── CLI subprocess tests ─────────────────────────────────────────────────────

async function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--allow-all", "main.ts", ...args],
    cwd: opts.cwd ?? import.meta.dirname!,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("cli --help prints usage and exits 0", async () => {
  const r = await runCli(["--help"]);
  assertEquals(r.code, 0);
  assert(r.stdout.includes("Usage: git convoy"));
  assert(r.stdout.includes("--configure"));
});

Deno.test("cli rejects unknown options", async () => {
  const r = await runCli(["--bogus"]);
  assertEquals(r.code, 1);
  assert(r.stdout.includes("Unknown option: --bogus"));
});

Deno.test("cli --dir with a missing path fails cleanly", async () => {
  const r = await runCli(["--dir", "/nonexistent/path"]);
  assertEquals(r.code, 1);
  assert(r.stderr.includes("cannot change to directory"));
});

Deno.test("cli fails outside a git repository", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const r = await runCli(["--dir", dir]);
    assertEquals(r.code, 1);
    assert(r.stderr.includes("not a git repository"));
  } finally {
    await Deno.remove(dir);
  }
});
