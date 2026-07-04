#!/usr/bin/env bash
set -euo pipefail

GITHUB_REPO="${GIT_CONVOY_REPO:-jakiestfu/git-convoy}"
GITHUB_REF="${GIT_CONVOY_REF:-main}"
INSTALL_DIR="${PREFIX:-$HOME/.local/bin}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray() { printf '\033[90m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
	SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
else
	SCRIPT_DIR=""
fi

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/bin/git-convoy" ]]; then
	MODE=local
else
	MODE=remote
fi

bold "Installing git-convoy to $INSTALL_DIR"
gray "  source: $MODE${MODE:+ ($GITHUB_REPO@$GITHUB_REF)}"

mkdir -p "$INSTALL_DIR"

fetch() {
	local url=$1 dest=$2
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url" -o "$dest"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$dest" "$url"
	else
		echo "Error: need curl or wget to install from GitHub" >&2
		exit 1
	fi
}

if [[ "$MODE" == local ]]; then
	gray "  Installing git-convoy"
	cp -f "$SCRIPT_DIR/bin/git-convoy" "$INSTALL_DIR/git-convoy"
else
	gray "  Downloading git-convoy"
	tmp=$(mktemp -d -t git-convoy-install.XXXXXX)
	trap 'rm -rf "$tmp"' EXIT
	fetch "https://raw.githubusercontent.com/$GITHUB_REPO/$GITHUB_REF/bin/git-convoy" "$tmp/git-convoy"
	mv "$tmp/git-convoy" "$INSTALL_DIR/git-convoy"
fi
chmod +x "$INSTALL_DIR/git-convoy"

# Remove the subcommand directory left behind by older versions.
rm -rf "$INSTALL_DIR/git-convoy.d"

gray "  Installing git-cv alias"
ln -sf "$INSTALL_DIR/git-convoy" "$INSTALL_DIR/git-cv"

green "Installed."

missing_runtime_deps=()
for dep in git gh deno; do
	if ! command -v "$dep" >/dev/null 2>&1; then
		missing_runtime_deps+=("$dep")
	fi
done

if ((${#missing_runtime_deps[@]} > 0)); then
	yellow "  Warning: missing runtime dependencies: ${missing_runtime_deps[*]}"
fi

case ":$PATH:" in
*":$INSTALL_DIR:"*) gray "  Try it: git cv  (or git convoy)" ;;
*)
	yellow "  $INSTALL_DIR is not on your PATH; add it to use 'git cv':"
	gray "    export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac
