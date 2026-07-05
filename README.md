# git convoy

**Manage stacked GitHub pull requests from your terminal.** A convoy is a line
of PRs following the lead — whether that's one branch against `main` or a
three-deep stack. `git convoy` shows the whole stack at a glance and rebases the
entire chain with one keystroke.

## Features

- **See the stack, not one PR at a time.** The root renders at the top; each PR
  sits one level below its parent. Checks (`[passed/total]`), diff size, and how
  far each branch is ahead all show inline.
- **Rebase the whole chain with `r`.** Fast-forwards the root from origin, then
  rebases every branch bottom-up and force-pushes each with `--force-with-lease`
  — recording fork points first so a parent's commits are never replayed as
  duplicates. Aborts cleanly on conflict and leaves your tree as it was.
- **Drill into checks.** Expand any PR to see each check with a ✓/✗/pending
  glyph (failures first) and open it in the browser.
- **Four views.** The current branch's stack, all your PRs in this repo, or a
  read-only overview of every PR you have open across a whole org or all of
  GitHub.
- **Bind keys to GitHub Actions.** Map a key to a workflow and dispatch it on
  the selected branch — share the bindings with your team as a JSON fragment.
- **Instant startup.** The window paints immediately from a per-repo cache while
  fresh data loads in the background.

```
  ● Stack  │    Settings   · tab/⇧tab switch                              ↻ 27s · q quit
  octocat/hello-world

    ● main · 2 behind origin
     ● feat/api-client [5/5] ▸
       #128 Add API client  +412 −18 · 2 ahead
      ● feat/user-profile [3/5] ▸
        #131 User profile page  +286 −40 · 5 ahead
     ❯ ● feat/profile-avatar* [2/3] ▸
         #134 Avatar upload  +190 −22 · 3 ahead

  → checks · r rebase · c checkout
  d deploy · e e2e tests
```

Filled radios (`●`) mark the branches your current selection would rebase — the
root plus every branch up to the selected row (whose radio is bold); empty
radios (`○`) are left untouched. The branch you're on is marked with `*`, and a
`▸` after the checks badge means you can drill in. Bound action keys (here `d`
and `e`) get their own footer line.

## Install

```sh
# Quick install (one-liner)
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-convoy/main/install.sh | bash

# Or inspect first
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-convoy/main/install.sh -o install.sh
less install.sh
bash install.sh
```

This installs two commands to `~/.local/bin`: `git-convoy` and its alias
`git-cv`. If that directory isn't on your `PATH`, add it:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Install elsewhere with `PREFIX=/usr/local/bin bash install.sh`. Prefer a
standalone binary with no Deno dependency? Grab a prebuilt one for your platform
from the [Releases page](https://github.com/jakiestfu/git-convoy/releases).

Already installed? Update in place any time:

```sh
git cv upgrade | bash
```

### Requirements

- `git`
- [`gh`](https://cli.github.com), authenticated
- [Deno](https://deno.com) 2.x (not needed for a prebuilt binary from Releases)

## Usage

```sh
git cv                       # current branch's PR and its ancestors (--current)
git cv --yours               # all of your open PRs in this repo, grouped into stacks
git cv --all                 # all of your open PRs across every repo, grouped by repo
git cv --org                 # like --all, limited to the current repo's organization
git cv --configure           # settings: checks column, auto-refresh, action keys
git cv --no-push             # rebase locally only; skip force-pushing
git cv --dir ./some-repo     # run against another directory's repository
git cv upgrade | bash        # update git-convoy in place
```

`git cv` is an alias for `git convoy`; both names work everywhere.

The default view (`--current`) boots fast: one `gh pr view` for the current
branch, then one per ancestor up to the root (the first base with no open PR,
e.g. `main`) — it never lists the whole repo's PRs. `--yours` lists all PRs you
authored and groups them into stacks. `--all` and `--org` widen that across
repos via `gh search prs`; since the cross-repo search exposes less detail (no
base branch, diff size, or checks), those are read-only overviews grouped by
repo — `enter` opens the selected PR on GitHub.

## Keys

- `Tab` / `Shift-Tab` — switch between the **Stack** and **Settings** tabs
- `↑`/`↓` or `k`/`j` — move the selection
- `enter` / `space` — open the current selection: the PR on GitHub, or (with a
  check selected) that check in the browser
- `r` — rebase the selected PR's chain; with the root selected, just pulls it
  from origin
- `c` — check out the selected branch
- `→` — expand the selected PR's checks; `↑`/`↓` onto a check and `enter`/`→`
  opens it. `←` collapses
- `R` — refresh now (when auto-refresh is enabled)
- any bound action key — dispatch that GitHub Actions workflow on the selected
  branch; press again once the run is up to open it
- `q` — quit

The footer lists only the actions distinctive to the current selection —
navigation, tab-switching, `enter` to open, and `q` are implicit.

## Configure

Open the Settings tab with `Tab` (or launch onto it with `git cv --configure`).
A preview PR in a bordered box re-renders as you change settings:

- **Show checks** — toggle the `[passed/total]` column.
- **Show pull request** — toggle the `#num title  +adds −dels · ahead` line
  under each branch. When hidden, the delta moves onto the branch line.
- **Auto refresh** — cycle `off → 30s → 1m → 5m`; the stack re-fetches on that
  interval with a countdown in the header, and `R` refreshes on demand.
- **Action keys** — bind any active GitHub Actions workflow to a key (`a-z`,
  `0-9`) to dispatch it on the selected branch. `enter` renames a binding; `esc`
  unbinds. The letters `j k q r c v` are reserved.

Settings are saved per-repo in `~/.git-convoy.json`.

### Sharing team configurations

`git cv --configure <url>` downloads a JSON file (a URL or local path) and
merges its action bindings into this repo's config. Check a fragment into your
repo or a gist and teammates pick it up with one command:

```json
{
  "actions": {
    "d": { "workflow": "deploy.yml", "name": "deploy" },
    "e": { "workflow": "e2e-tests.yml", "name": "e2e tests" }
  }
}
```

## Rebasing safety

Select a PR and press `r`. Every row animates `○ pending → ⠹ running → ✓ done`
in place. Convoy:

- Refuses to start on a dirty tree, detached HEAD, an in-progress rebase, or
  when any branch in the chain has remote commits you don't have locally.
- Records each branch's fork point before anything moves, so rebases use
  `git rebase --onto` and never replay a parent's commits as duplicates.
- On conflict, aborts the rebase, stops the cascade, and checks your original
  branch back out. Already-completed branches were rebased _and_ pushed, so a
  partial run is safe to resume by pressing `r` again.

## Developing

```sh
git clone https://github.com/jakiestfu/git-convoy.git
cd git-convoy
deno task run        # run from source
deno task check      # type-check
deno task test       # run the test suite
deno task compile    # build a standalone binary into dist/git-convoy
```

The tool is a small set of TypeScript modules run directly by Deno via `main.ts`
(the installer copies it into place). It has no third-party dependencies beyond
the Deno standard library. Tagging a release
(`git tag v1.x.y && git push
--tags`) makes CI compile binaries for Linux and
macOS and attach them to a GitHub release.
