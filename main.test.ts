// Tests for the helpers defined in main.ts, plus end-to-end CLI behavior
// exercised by spawning the script as a subprocess. Pure rendering and
// subprocess helpers have their own test files (format.test.ts,
// subprocess.test.ts).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  decodeKeys,
  extractCheckItems,
  formatCountdown,
  nextAutoRefresh,
  nextTab,
  summarizeChecks,
} from "./main.ts";

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

Deno.test("formatCountdown renders seconds and minutes", () => {
  assertEquals(formatCountdown(0), "0s");
  assertEquals(formatCountdown(30), "30s");
  assertEquals(formatCountdown(60), "1m");
  assertEquals(formatCountdown(299), "4m59s");
  assertEquals(formatCountdown(300), "5m");
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
