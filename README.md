# git dash

**Manage stacked GitHub pull requests from your terminal.** A stack is a line of
PRs following the lead — whether that's one branch against `main` or a
three-deep chain. `git dash` shows the whole stack at a glance and rebases the
entire chain with one keystroke.

<img src="./preview.svg" width="100%" />

## Features

- **See the whole stack** — PRs render as a tree under their root branch, with
  approvals, checks, diff size, and ahead-counts inline.
- **Rebase the chain with one key** — `r` updates the root from origin, then
  rebases and force-pushes every branch in order. Conflicts abort cleanly and
  leave your repo as it was.
- **Drill into checks** — expand a PR to see each check and open it in the
  browser.
- **Three scopes** — this repo, your org, or all your PRs on GitHub. Switch with
  `Tab`.
- **Dispatch GitHub Actions** — bind workflows to keys and share the bindings
  with your team.
- **Instant startup** — paints immediately from cache and refreshes in the
  background.

## Install

```sh
# Quick install (one-liner)
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-dash/main/install.sh | bash

# Or inspect first
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-dash/main/install.sh -o install.sh
less install.sh
bash install.sh
```

This installs `git-dash` to `~/.local/bin`. If that directory isn't on your
`PATH`, add it:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer downloads the prebuilt standalone binary for your platform from
the [latest release](https://github.com/jakiestfu/git-dash/releases) — no Deno
needed. Install elsewhere with `PREFIX=/usr/local/bin bash install.sh`.

Already installed? Update in place any time:

```sh
git dash upgrade | bash
```

### Requirements

- `git`
- [`gh`](https://cli.github.com), authenticated
- [Deno](https://deno.com) 2.x — only for [developing](#developing)

## Usage

```sh
git dash                     # your open PRs in this repo, current branch highlighted (default)
git dash --scope=org         # your open PRs across the current repo's org, grouped by repo
git dash --scope=all         # your open PRs across every repo, grouped by repo
git dash --configure         # settings: columns, auto-refresh, action keys
git dash --no-push           # rebase locally only; skip force-pushing
git dash --dir ./some-repo   # run against another directory's repository
git dash upgrade | bash      # update git-dash in place
```

The default scope shows the PRs you've authored in this repo, grouped into
stacks. `org` and `all` are read-only overviews of your PRs across repos —
`enter` opens the selected PR on GitHub.

## Keys

- `Tab` / `Shift-Tab` — switch scope (the top tabs: repo → owner → you)
- `s` — open Settings; `s` or `Esc` returns to the current scope
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

Refreshes never lock the UI — only rebase, checkout, and dispatch wait for one
to finish.

## Configure

Open Settings with `s` (or launch onto it with `git dash --configure`); `s` or
`Esc` returns to your PRs. A preview PR in a bordered box re-renders as you
change settings:

- **Config File** — the path to the settings file; `enter` opens it in your
  default editor.
- **Show Checks** — toggle the `[passed/total]` column.
- **Show Pull Request** — toggle the `#num title  +adds −dels · ahead` line
  under each branch. When hidden, the delta moves onto the branch line.
- **Show Approvals** — toggle the `[approved/total]` review badge on each PR.
- **Auto Refresh** — cycle `off → 30s → 1m → 5m`; the stack re-fetches on that
  interval with a countdown in the header, and `R` refreshes on demand.
- **Action Keys** — bind any active GitHub Actions workflow to a key (`a-z`,
  `0-9`) to dispatch it on the selected branch. `enter` renames a binding; `esc`
  unbinds. The letters `j k q r c v s` are reserved.

Display settings (checks, pull request, approvals, auto-refresh) are global and
apply to every repo; action-key bindings are saved per-repo. Both live in
`~/.git-dash.json`.

### Sharing team configurations

`git dash --configure <url>` downloads a JSON file (a URL or local path) and
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
in place. git dash:

- Refuses to start on a dirty tree, detached HEAD, an in-progress rebase, or
  when any branch in the chain has remote commits you don't have locally.
- Records each branch's fork point before anything moves, so rebases use
  `git rebase --onto` and never replay a parent's commits as duplicates.
- On conflict, aborts the rebase, stops the cascade, and checks your original
  branch back out. Already-completed branches were rebased _and_ pushed, so a
  partial run is safe to resume by pressing `r` again.

## Developing

```sh
git clone https://github.com/jakiestfu/git-dash.git
cd git-dash
deno task run        # run from source
deno task check      # type-check
deno task test       # run the test suite
deno task compile    # build a standalone binary into dist/git-dash
```

git dash is a handful of TypeScript modules run directly by Deno, with no
dependencies beyond the Deno standard library. Every merge to `main` cuts a
release: CI compiles standalone binaries for Linux and macOS and attaches them
to a GitHub release.
