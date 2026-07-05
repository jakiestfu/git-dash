// Pure rendering helpers — no shared state, no I/O. Shared by the main and
// settings views (and exercised directly by the tests).

import { stripAnsiCode } from "jsr:@std/fmt@1/colors";
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";

// deno-lint-ignore no-control-regex
const ANSI_HEAD_RE = /^\x1b\[[0-9;]*m/;
// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// visibleWidth: printed column count of a string, ignoring ANSI SGR codes.
// Good enough for the ASCII/box content we render (no wide CJK).
export function visibleWidth(s: string): number {
  return stripAnsiCode(s).length;
}

// truncateVisible: cut a string to at most `width` printed columns, keeping
// ANSI SGR codes intact (they cost no width) and appending an ellipsis when
// something was dropped. Used to guarantee box content fits its border.
export function truncateVisible(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  if (width <= 0) return "";
  let out = "";
  let w = 0;
  let i = 0;
  const budget = width - 1; // leave a column for the ellipsis
  while (i < s.length && w < budget) {
    const m = s.slice(i).match(ANSI_HEAD_RE);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += s[i];
    i += 1;
    w += 1;
  }
  // Carry any trailing reset codes so color never leaks past the cut.
  const rest = s.slice(i).match(ANSI_RE);
  if (rest) out += rest.join("");
  return out + "…";
}

// boxed: wrap content lines in a rounded border with a title in the top edge:
//   ╭─ title ────────────╮
//   │ content            │
//   ╰────────────────────╯
// Each returned line is prefixed with `indent` spaces. `inner` is the content
// width between the one-space border padding; content lines are padded
// (accounting for ANSI codes) so the right border stays aligned. Every border
// glyph is dimmed. The span between the corners is `inner + 2` in every row.
export function boxed(
  title: string,
  content: string[],
  inner: number,
  indent = "  ",
): string[] {
  const b = (s: string) => dim(s);
  // Top edge: "─ title " then dashes filling the rest of the span. The span
  // (columns between the corners) grows to fit the title so every row lines up.
  const label = title ? `─ ${title} ` : "";
  const span = Math.max(inner + 2, visibleWidth(label) + 1);
  const bodyInner = span - 2; // content width once the title is accounted for
  const topFill = Math.max(span - visibleWidth(label), 0);
  const out: string[] = [];
  out.push(`${indent}${b("╭")}${b(label)}${b("─".repeat(topFill))}${b("╮")}`);
  for (const raw of content) {
    const line = truncateVisible(raw, bodyInner);
    const pad = Math.max(bodyInner - visibleWidth(line), 0);
    out.push(`${indent}${b("│")} ${line}${" ".repeat(pad)} ${b("│")}`);
  }
  out.push(`${indent}${b("╰")}${b("─".repeat(span))}${b("╯")}`);
  return out;
}

// viewTop: first visible line index — 0 while everything fits, otherwise
// centered on the selection and clamped to the ends of the content.
export function viewTop(total: number, rows: number, selLine: number): number {
  if (total <= rows) return 0;
  return Math.max(0, Math.min(selLine - Math.floor(rows / 2), total - rows));
}

export function tailLines(s: string, n: number): string {
  const lines = s.replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
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

// formatBranchLine / formatMetaLine: the two lines every PR row renders as.
// Shared by the main view and the configure preview so they can't drift.
// With showPr off there is no meta line, so the delta moves onto the branch
// line instead.
export function formatDelta(
  pr: { adds: number; dels: number; ahead: string },
): string {
  return `${green(`+${pr.adds}`)} ${red(`−${pr.dels}`)}${
    dim(` · ${pr.ahead} ahead`)
  }`;
}

// The current branch is marked with a trailing asterisk; rows whose checks
// can be drilled into get a ▸ (▾ once expanded) after the checks badge.
export function formatBranchLine(
  pr: {
    branch: string;
    checks: string;
    checksColor: string;
    adds: number;
    dels: number;
    ahead: string;
  },
  opts: {
    showChecks: boolean;
    showPr: boolean;
    current: boolean;
    expand?: "open" | "closed";
  },
): string {
  const name = opts.current ? `${pr.branch}*` : pr.branch;
  let bname = opts.current ? bold(cyan(name)) : cyan(name);
  if (opts.showChecks && pr.checks) {
    bname += ` ${colorFn(pr.checksColor)(`[${pr.checks}]`)}`;
    if (opts.expand) bname += ` ${dim(opts.expand === "open" ? "▾" : "▸")}`;
  }
  if (!opts.showPr) bname += ` ${formatDelta(pr)}`;
  return bname;
}

export function formatMetaLine(
  pr: { num: string; title: string; adds: number; dels: number; ahead: string },
  cols: number,
  indent: number,
): string {
  let title = pr.title;
  let max = cols - indent - 32;
  if (max < 12) max = 12;
  if (title.length > max) title = title.slice(0, max - 1) + "…";
  return `${dim(`#${pr.num}`)} ${title}  ${formatDelta(pr)}`;
}
