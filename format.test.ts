// Tests for the pure rendering helpers in format.ts. No TTY, so color is
// disabled and output is plain — the assertions check structure, not color.

import { assert, assertEquals } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import {
  boxed,
  formatApprovals,
  formatBranchLine,
  formatMetaLine,
  summarizeApprovals,
  tailLines,
  truncateVisible,
  viewTop,
  visibleWidth,
} from "./format.ts";

// @std/fmt/colors defaults to enabled; disable it so the formatters render
// plain (the app does the equivalent via applyColorPreference()).
setColorEnabled(false);

// Strip ANSI SGR codes so box geometry can be asserted regardless of color.
// deno-lint-ignore no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── visibleWidth ─────────────────────────────────────────────────────────────

Deno.test("visibleWidth ignores ANSI color codes", () => {
  assertEquals(visibleWidth("abc"), 3);
  assertEquals(visibleWidth("\x1b[31mabc\x1b[0m"), 3);
  assertEquals(visibleWidth("\x1b[1m\x1b[36m●\x1b[0m\x1b[0m x"), 3);
});

// ── truncateVisible ──────────────────────────────────────────────────────────

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

// ── boxed ────────────────────────────────────────────────────────────────────

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

// ── PR line formatting ───────────────────────────────────────────────────────

const SAMPLE = {
  branch: "feat/api-client",
  checks: "47/48",
  checksColor: "yellow",
  num: "128",
  title: "feat(api-client): typed client with retry/verify request flow",
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
    "feat/api-client [47/48]",
  );
});

Deno.test("formatBranchLine omits the checks badge when disabled", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: false,
      showPr: true,
      current: false,
    }),
    "feat/api-client",
  );
});

Deno.test("formatBranchLine absorbs the delta when the PR line is hidden", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: false,
      current: false,
    }),
    "feat/api-client [47/48] +881 −0 · 2 ahead",
  );
});

Deno.test("formatBranchLine marks the current branch with an asterisk", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: false,
      showPr: true,
      current: true,
    }),
    "feat/api-client*",
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
    "feat/api-client [47/48] ▸",
  );
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: true,
      current: false,
      expand: "open",
    }),
    "feat/api-client [47/48] ▾",
  );
});

Deno.test("formatBranchLine puts the draft tag before the chevron", () => {
  assertEquals(
    formatBranchLine(SAMPLE, {
      showChecks: true,
      showPr: true,
      current: false,
      draft: true,
      expand: "closed",
    }),
    "feat/api-client [47/48] [draft] ▸",
  );
});

Deno.test("summarizeApprovals counts approvals and pending reviewers", () => {
  assertEquals(
    summarizeApprovals(
      [{ state: "APPROVED" }, { state: "COMMENTED" }],
      [{ login: "a" }],
    ),
    { approved: 1, pending: 1, changesRequested: false },
  );
});

Deno.test("summarizeApprovals flags changes requested", () => {
  assertEquals(
    summarizeApprovals([{ state: "CHANGES_REQUESTED" }], []),
    { approved: 0, pending: 0, changesRequested: true },
  );
});

Deno.test("formatApprovals renders an approved/total badge", () => {
  // Color is disabled in tests, so only the text is asserted.
  assertEquals(
    formatApprovals({ approved: 1, pending: 2, changesRequested: false }),
    "[1/3]",
  );
  assertEquals(
    formatApprovals({ approved: 3, pending: 0, changesRequested: false }),
    "[3/3]",
  );
  assertEquals(
    formatApprovals({ approved: 0, pending: 3, changesRequested: false }),
    "[0/3]",
  );
});

Deno.test("formatApprovals counts approvals toward the total when changes requested", () => {
  assertEquals(
    formatApprovals({ approved: 1, pending: 1, changesRequested: true }),
    "[1/2]",
  );
});

Deno.test("formatApprovals is empty with no review activity", () => {
  assertEquals(
    formatApprovals({ approved: 0, pending: 0, changesRequested: false }),
    "",
  );
});

Deno.test("formatBranchLine puts the approvals badge before checks", () => {
  assertEquals(
    formatBranchLine(
      {
        ...SAMPLE,
        approvals: { approved: 1, pending: 1, changesRequested: false },
      },
      {
        showChecks: true,
        showApprovals: true,
        showPr: true,
        current: false,
      },
    ),
    "feat/api-client [1/2] [47/48]",
  );
});

Deno.test("formatBranchLine omits approvals when disabled", () => {
  assertEquals(
    formatBranchLine(
      {
        ...SAMPLE,
        approvals: { approved: 1, pending: 1, changesRequested: false },
      },
      {
        showChecks: true,
        showApprovals: false,
        showPr: true,
        current: false,
      },
    ),
    "feat/api-client [47/48]",
  );
});

Deno.test("formatMetaLine renders number, title, and stats", () => {
  assertEquals(
    formatMetaLine(SAMPLE, 120, 1),
    "#128 feat(api-client): typed client with retry/verify request flow  +881 −0 · 2 ahead",
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
