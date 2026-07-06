// Tests for the pure helpers in subprocess.ts.

import { assertEquals } from "jsr:@std/assert@1";
import { normalizeRepoUrl } from "./subprocess.ts";

// ── normalizeRepoUrl ─────────────────────────────────────────────────────────

Deno.test("normalizeRepoUrl strips ssh form", () => {
  assertEquals(
    normalizeRepoUrl("git@github.com:octocat/hello-world.git"),
    "octocat/hello-world",
  );
});

Deno.test("normalizeRepoUrl strips https form", () => {
  assertEquals(
    normalizeRepoUrl("https://github.com/jakiestfu/git-dash.git"),
    "jakiestfu/git-dash",
  );
});

Deno.test("normalizeRepoUrl leaves plain slugs and non-github hosts alone", () => {
  assertEquals(normalizeRepoUrl("owner/repo"), "owner/repo");
  assertEquals(
    normalizeRepoUrl("https://gitlab.com/owner/repo"),
    "https://gitlab.com/owner/repo",
  );
});
