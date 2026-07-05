# git convoy

Interactive terminal tool for managing stacked GitHub pull requests — a line of
PRs following the lead, whether that's one branch against `main` or a three-deep
stack.

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

- `~/.local/bin/git-convoy` — the tool (a single self-contained Deno script)
- `~/.local/bin/git-cv` — alias symlink

Prefer a standalone binary with no Deno dependency? Grab a prebuilt
`deno compile` binary for your platform from the
[Releases page](https://github.com/jakiestfu/git-convoy/releases), drop it on
your `PATH` as `git-convoy`, and symlink `git-cv` to it.

To install somewhere else:

```sh
PREFIX=/usr/local/bin ./install.sh
```

If `~/.local/bin` is not on your `PATH`, add this to `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Re-running `./install.sh` is safe — it overwrites in place.

## Requirements

- `git`
- [`gh`](https://cli.github.com), authenticated
- [Deno](https://deno.com) 2.x (not needed if you install a prebuilt binary from
  Releases)

## Developing

```sh
git clone https://github.com/jakiestfu/git-convoy.git
cd git-convoy
./install.sh

deno task check      # type-check
deno task fmt        # format (deno fmt)
deno task run        # run from source
deno task compile    # build a standalone binary into dist/git-convoy
```

The tool is a single TypeScript file, `main.ts`, run directly by Deno via its
shebang; the installer copies it into place as `git-convoy`, and
`deno task compile` builds the real binary into `dist/`. Tagging a release
(`git tag v1.x.y && git push --tags`) makes CI compile binaries for Linux and
macOS (x86_64 and arm64) and attach them to a GitHub release.

### Editor setup

Deno's types (`Deno.*` globals) come from the Deno language server, not from an
npm package — there's nothing to install. If your editor reports
`Cannot find name 'Deno'`, it's using the plain TypeScript server: install the
[Deno extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno)
for VS Code (this repo's `.vscode/settings.json` already enables it), or enable
the Deno LSP in your editor of choice.

This project has no third-party dependencies at all — the standard-library-only
runtime API covers everything. If it ever needs one, Deno pulls dependencies
straight from [JSR](https://jsr.io) or npm via `deno add`, recorded in
`deno.json` — there's no `node_modules` to manage.

## Usage

```bash
git cv                       # current branch's PR and its ancestors (--current)
git cv --yours               # all of your open PRs in this repo, grouped into stacks
git cv --all                 # all of your open PRs across every repo, grouped by repo
git cv --org                 # like --all, limited to the current repo's organization
git cv --configure           # settings UI: checks column, auto-refresh, action keys
git cv --no-push             # rebase locally only; skip force-pushing
git cv --dir ./some-repo     # run against another directory's repository
```

`git cv` is an alias for `git convoy`; both names work everywhere. The TUI is
the whole tool — there are no subcommands.

The default view (`--current`) boots fast: one `gh pr view` for the current
branch, then one per ancestor while walking the PR bases up to the root (the
first base with no open PR, e.g. `main`) — it never lists the whole repo's PRs.
`--yours` instead lists all PRs you authored and groups them into stacks; a base
that isn't one of your PRs (like `main`, or a teammate's branch you stacked on)
renders as that stack's root.

`--all` widens that to every repo: it lists all your open PRs via `gh search
prs` and groups them under a root per repository. `--org` is the same but
scoped to the current repo's organization (the owner in `owner/repo`). Because
the cross-repo search exposes far less than `gh pr view` (no base branch, diff
size, or checks) and the PRs live outside your working directory, these are
read-only overviews — rebase, checkout, and the checks column are off; `enter`
opens the selected PR on GitHub.

The root renders at the top; each PR sits one level below its parent, indented
one space per level. Filled radios (`●`) mark the branches the current selection
would rebase — the root plus every branch between it and the selected row (whose
radio is bold) — while empty radios (`○`) are left untouched. During a rebase
all radios grey out until the cascade finishes.

```
  ● Stack  │    Settings   · tab/⇧tab switch                              ↻ 27s · q quit
  turo/web-schumacher-app

    ● main · 2 behind origin
     ● feat/set-phone-number [5/5] ▸
       #14397 Set phone number  +881 −0 · 2 ahead
      ● feat/managed-vehicles-onboarding [3/5] ▸
        #14331 Owner onboarding  +1464 −115 · 5 ahead
     ❯ ● feat/managed-vehicles-groups* [2/3] ▸
         #14402 Managed groups dashboard  +1130 −53 · 3 ahead

  → checks · r rebase · c checkout
  i translations - integrate · p translations - push
```

Bound action keys (here `i` and `p`) get their own footer line. The branch
you're currently on is marked with a trailing `*`; a `▸` after the checks badge
means the row's checks can be drilled into with `→` (it flips to `▾` while
expanded).

### Instant startup

The window paints as soon as it opens. The last-loaded stack is cached per repo
(in `~/.git-convoy-cache.json`), so a relaunch shows the previous PRs
immediately while the live data reloads in place — a small spinner in the
top-right of the header marks the refresh. On a cold start (no cache) the local
git stats fill in first and the `origin` fetch runs in the background, so ahead/
behind counts sharpen a moment after the PRs appear rather than blocking the
first paint.

## Keys

- `Tab` / `Shift-Tab` — switch between the **Stack** and **Settings** tabs
  (the tab bar sits at the top of both)
- `↑`/`↓` or `k`/`j` — move the selection
- `enter` / `space` — open the current selection: the PR on GitHub, or (with a
  check selected) that check in the browser. `v` also views the selected PR
- `r` — rebase the selected PR's chain (see below); with the root branch
  selected, this just pulls it from origin
- `c` — check out the selected branch
- `→` — expand the selected PR's checks into a list below it; `↑`/`↓` move onto
  a check and `enter`/`→` opens it in the browser; `←` collapses
- `R` — refresh the view now (shown when auto-refresh is enabled)
- any bound action key (see `--configure`) — dispatch that GitHub Actions
  workflow on the selected branch; once the run is up the hint flips to
  `<key> view` and pressing it again opens the run in the browser
- `q` — quit (shown in the top-right of the header)

The footer lists only the actions distinctive to the current selection; `enter`
to open, arrow-key navigation, tab-switching, and `q` are implicit.

The root branch (e.g. `main`) is selectable like any other row.

## Checks

Each PR row shows `[passed/total]` for its checks, colored the way GitHub would
show it: red if any check failed, yellow if any is still pending, green when
everything passed. The counts come from the same `gh` calls that load the PRs,
so they cost nothing extra. Toggle the column off in `--configure` ("Show
checks", on by default).

Press `→` on a PR row to expand its individual checks below it — each with its
own ✓/✗/pending glyph, failed checks sorted to the top — then move onto one and
press `→` again to open it in the browser (check links can point at GitHub or an
external CI). `←` collapses the list.

## Configure

Settings live on their own tab. Press `Tab` from the stack to reach it, or
launch straight onto it with `git cv --configure`; either way `Tab` /
`Shift-Tab` moves between the two (the tab bar stays pinned at the top of the
window). A preview PR in a bordered box re-renders as you change settings, so
you can see exactly what each toggle does:

- **Show checks** — toggle the `[passed/total]` column with `space`/`enter`.
- **Show pull request** — toggle the `#14397 title  +881 −0 · 2 ahead` line
  under each branch. When hidden, the `+881 −0 · 2 ahead` delta moves onto the
  branch line itself.
- **Auto refresh** — cycle `off → 30s → 1m → 5m` with `space`/`enter`. When
  enabled, the stack tab re-fetches PRs on that interval, shows a countdown in
  the top-right of the header, and `R` refreshes on demand.
- **Action keys** — every active GitHub Actions workflow in the repo is listed.
  Select one and press a letter or digit (`a-z`, `0-9`) to bind it (`t` on
  "Upload Translations" makes `t` dispatch that workflow from the main view);
  pressing a different key rebinds it, binding a key already in use steals it
  from the other workflow, and `esc` unbinds. `enter` renames the bound action —
  the name only lives in your local config, so shorten away. The letters
  `j k q r c v` are reserved for the main view.

### Sharing team configurations

`git cv --configure <url>` downloads a JSON file (a URL or a local path) and
merges its action bindings into this repo's config before opening the Settings
tab — in a non-interactive shell it just merges and prints a summary. Imported bindings win
over your local ones; reserved keys are skipped. The file can be a full config
(bindings are read from `repos["owner/repo"].actions`) or a repo-agnostic
fragment:

```json
{
  "actions": {
    "i": {
      "workflow": "translations-integrate.yml",
      "name": "translations - integrate"
    },
    "p": { "workflow": "translations-push.yml", "name": "translations - push" }
  }
}
```

Check that fragment into your repo or a gist, and teammates pick it up with one
command.

Settings are saved per-repo in `~/.git-convoy.json`:

```json
{
  "version": 1,
  "repos": {
    "owner/repo": {
      "showChecks": true,
      "showPr": true,
      "autoRefresh": 30,
      "actions": {
        "t": {
          "workflow": "upload-translations.yml",
          "name": "Upload Translations"
        }
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
  `git rebase --onto <new-parent> <old-fork-point> <branch>` and never replay a
  parent's commits as duplicates.
- On conflict the rebase is aborted, the row turns ✗, the cascade stops, and
  your original branch is checked back out. Already-completed branches were each
  rebased _and_ pushed, so a partial rebase is safe to resume by pressing `r`
  again.
