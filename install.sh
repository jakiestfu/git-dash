#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${PREFIX:-$HOME/.local/bin}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray() { printf '\033[90m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

bold "Installing git-convoy to $INSTALL_DIR"

mkdir -p "$INSTALL_DIR/git-convoy.d"

gray "  Installing git-convoy dispatcher"
cp -f "$SCRIPT_DIR/bin/git-convoy" "$INSTALL_DIR/git-convoy"
chmod +x "$INSTALL_DIR/git-convoy"

gray "  Installing git-cv alias"
ln -sf "$INSTALL_DIR/git-convoy" "$INSTALL_DIR/git-cv"

for sub in "$SCRIPT_DIR/libexec/git-convoy.d"/*; do
	[[ -f "$sub" ]] || continue
	name="$(basename -- "$sub")"
	gray "  Installing git-convoy.d/$name"
	cp -f "$sub" "$INSTALL_DIR/git-convoy.d/$name"
	chmod +x "$INSTALL_DIR/git-convoy.d/$name"
done

green "Installed."

case ":$PATH:" in
*":$INSTALL_DIR:"*) gray "  Try it: git cv  (or git convoy)" ;;
*)
	yellow "  $INSTALL_DIR is not on your PATH; add it to use 'git cv':"
	gray "    export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac
