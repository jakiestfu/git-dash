# git convoy

Interactive terminal tool for managing stacked GitHub pull requests — a line
of PRs following the lead, whether that's one branch against `main` or a
three-deep stack.

Pure bash. Requires `git`, [`gh`](https://cli.github.com) (authenticated),
`jq`, and bash ≥ 4 (`brew install bash` on macOS).

## Install

```bash
./install.sh                 # installs to ~/.local/bin (override with PREFIX=…)
```

## Usage

```bash
git cv                       # interactive stack view for the current branch
git cv refresh               # refresh the current branch's chain, no TUI
git cv refresh B --no-push
```

`git cv` is an alias for `git convoy`; both names work everywhere.

The view discovers the whole stack from a single `gh pr list` call: it walks
your branch's PR bases up to the root (the first base with no open PR, e.g.
`main`), then back down through every PR stacked on top. The root renders at
the top, each PR below it indented one space per level. Filled radios (`●`)
mark the branches the current selection would refresh — the root plus every
branch between it and the selected row (whose radio is bold) — while empty
radios (`○`) are left untouched. During a refresh all radios grey out until
the cascade finishes.

```
  convoy · turo/web-schumacher-app

    ● main · 2 behind origin
    ● feat/set-phone-number
      #14397 Set phone number  +881 −0 · 2 ahead
     ● feat/managed-vehicles-onboarding
       #14331 Owner onboarding  +1464 −115 · 5 ahead
    ❯ ● feat/managed-vehicles-groups ← you are here
        #14402 Managed groups dashboard  +1130 −53 · 3 ahead

  ↑↓ move · enter refresh · q quit
```

## Refreshing

Select a PR and press Enter. Convoy fast-forwards the root from origin, then
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
  each rebased *and* pushed, so a partial refresh is safe to resume by
  pressing Enter again.

## Design notes

- Architecture mirrors [jakiestfu/git-ai](https://github.com/jakiestfu/git-ai):
  a `bin/git-convoy` dispatcher `exec`s subcommands from `libexec/git-convoy.d/`,
  discovered via their `# Description:` header lines.
- Sequential per-branch `git rebase --onto` was chosen over a single
  `git rebase --update-refs` from the tip: it maps one-to-one onto per-branch
  progress rows, attributes conflicts to the exact branch, and lets each ✓
  mean "rebased and pushed".
