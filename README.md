# git convoy

Interactive terminal tool for managing stacked GitHub pull requests — a line
of PRs following the lead, whether that's one branch against `main` or a
three-deep stack.

## Install

```sh
# Quick install (one-liner)
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-convoy/main/install.sh | bash

# Or inspect first
curl -fsSL https://raw.githubusercontent.com/jakiestfu/git-convoy/main/install.sh -o install.sh
less install.sh
bash install.sh
```

By default, files are installed to `~/.local/bin`:

- `~/.local/bin/git-convoy` — the tool (a single self-contained script)
- `~/.local/bin/git-cv` — alias symlink

To install somewhere else:

```sh
PREFIX=/usr/local/bin ./install.sh
```

If `~/.local/bin` is not on your `PATH`, add this to `~/.zshrc` or
`~/.bashrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Re-running `./install.sh` is safe — it overwrites in place.

## Requirements

- `git`
- [`gh`](https://cli.github.com), authenticated
- `jq`
- Bash 4+ (macOS ships bash 3.2; `brew install bash`)

## Developing

```sh
git clone https://github.com/jakiestfu/git-convoy.git
cd git-convoy
./install.sh
```

## Usage

```bash
git cv                       # current branch's PR and its ancestors (--current)
git cv --yours               # all of your open PRs, grouped into stacks
git cv --configure           # settings UI: checks column, action key bindings
git cv --no-push             # rebase locally only; skip force-pushing
git cv --dir ./some-repo     # run against another directory's repository
```

`git cv` is an alias for `git convoy`; both names work everywhere. The TUI is
the whole tool — there are no subcommands.

The default view (`--current`) boots fast: one `gh pr view` for the current
branch, then one per ancestor while walking the PR bases up to the root (the
first base with no open PR, e.g. `main`) — it never lists the whole repo's
PRs. `--yours` instead lists all PRs you authored and groups them into
stacks; a base that isn't one of your PRs (like `main`, or a teammate's
branch you stacked on) renders as that stack's root.

The root renders at the top; each PR sits one level below its parent,
indented one space per level. Filled radios (`●`) mark the branches the
current selection would rebase — the root plus every branch between it and
the selected row (whose radio is bold) — while empty radios (`○`) are left
untouched. During a rebase all radios grey out until the cascade finishes.

```
  convoy · turo/web-schumacher-app

    ● main · 2 behind origin
     ● feat/set-phone-number [5/5]
       #14397 Set phone number  +881 −0 · 2 ahead
      ● feat/managed-vehicles-onboarding [3/5]
        #14331 Owner onboarding  +1464 −115 · 5 ahead
     ❯ ● feat/managed-vehicles-groups [2/3] ← you are here
         #14402 Managed groups dashboard  +1130 −53 · 3 ahead

  ↑↓ move · r rebase · c checkout · v view on github · q quit
  i translations - integrate · p translations - push
```

Bound action keys (here `i` and `p`) get their own footer line.

## Keys

- `↑`/`↓` or `k`/`j` — move the selection
- `r` — rebase the selected PR's chain (see below); with the root branch
  selected, this just pulls it from origin
- `c` — check out the selected branch
- `v` — view the selected PR on GitHub
- any bound action key (see `--configure`) — dispatch that GitHub Actions
  workflow on the selected branch; once the run is up the hint flips to
  `<key> view` and pressing it again opens the run in the browser
- `q` — quit

The root branch (e.g. `main`) is selectable like any other row.

## Checks

Each PR row shows `[passed/total]` for its checks, colored the way GitHub
would show it: red if any check failed, yellow if any is still pending,
green when everything passed. The counts come from the same `gh` calls that
load the PRs, so they cost nothing extra. Toggle the column off in
`--configure` ("Show checks", on by default).

## Configure

`git cv --configure` opens the settings UI:

- **Show checks** — toggle the `[passed/total]` column with `space`/`enter`.
- **Action keys** — every active GitHub Actions workflow in the repo is
  listed. Select one and press a letter or digit (`a-z`, `0-9`) to bind it
  (`t` on "Upload Translations" makes `t` dispatch that workflow from the
  main view); pressing a different key rebinds it, binding a key already in
  use steals it from the other workflow, and `esc` unbinds. `enter` renames
  the bound action — the name only lives in your local config, so shorten
  away. The letters `j k q r c v` are reserved for the main view.

### Sharing team configurations

`git cv --configure <url>` downloads a JSON file (a URL or a local path) and
merges its action bindings into this repo's config before opening the UI —
in a non-interactive shell it just merges and prints a summary. Imported
bindings win over your local ones; reserved keys are skipped. The file can
be a full config (bindings are read from `repos["owner/repo"].actions`) or a
repo-agnostic fragment:

```json
{
  "actions": {
    "i": { "workflow": "translations-integrate.yml", "name": "translations - integrate" },
    "p": { "workflow": "translations-push.yml", "name": "translations - push" }
  }
}
```

Check that fragment into your repo or a gist, and teammates pick it up with
one command.

Settings are saved per-repo in `~/.git-convoy.json`:

```json
{
  "version": 1,
  "repos": {
    "owner/repo": {
      "showChecks": true,
      "actions": {
        "t": { "workflow": "upload-translations.yml", "name": "Upload Translations" }
      }
    }
  }
}
```

## Rebasing

Select a PR and press `r`. Convoy fast-forwards the root from origin, then
rebases each branch between the root and your selection bottom-up, force-
pushing each with `--force-with-lease`. Every row animates through
`○ pending → ⠹ running → ✓ done` in place.

Safety properties:

- Refuses to start on a dirty tree, detached HEAD, an in-progress rebase, or
  when any branch in the chain has remote commits you don't have locally.
- Each branch's fork point is recorded before anything moves, so rebases use
  `git rebase --onto <new-parent> <old-fork-point> <branch>` and never replay
  a parent's commits as duplicates.
- On conflict the rebase is aborted, the row turns ✗, the cascade stops, and
  your original branch is checked back out. Already-completed branches were
  each rebased *and* pushed, so a partial rebase is safe to resume by
  pressing `r` again.
