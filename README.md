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
git cv                       # interactive stack view for the current branch
git cv --no-push             # rebase locally only; skip force-pushing
git cv --dir ./some-repo     # run against another directory's repository
```

`git cv` is an alias for `git convoy`; both names work everywhere. The TUI is
the whole tool — there are no subcommands.

The view discovers the whole stack from a single `gh pr list` call: it walks
your branch's PR bases up to the root (the first base with no open PR, e.g.
`main`), then back down through every PR stacked on top. The root renders at
the top; each PR sits one level below its parent, indented one space per
level. Filled radios (`●`) mark the branches the current selection would
rebase — the root plus every branch between it and the selected row (whose
radio is bold) — while empty radios (`○`) are left untouched. During a rebase
all radios grey out until the cascade finishes.

```
  convoy · turo/web-schumacher-app

    ● main · 2 behind origin
     ● feat/set-phone-number
       #14397 Set phone number  +881 −0 · 2 ahead
      ● feat/managed-vehicles-onboarding
        #14331 Owner onboarding  +1464 −115 · 5 ahead
     ❯ ● feat/managed-vehicles-groups ← you are here
         #14402 Managed groups dashboard  +1130 −53 · 3 ahead

  ↑↓ move · r rebase · c checkout · o open pr · q quit
```

## Keys

- `↑`/`↓` or `k`/`j` — move the selection
- `r` — rebase the selected PR's chain (see below); with the root branch
  selected, this just pulls it from origin
- `c` — check out the selected branch
- `o` — open the selected PR on GitHub
- `q` — quit

The root branch (e.g. `main`) is selectable like any other row.

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
