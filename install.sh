#!/usr/bin/env bash
set -euo pipefail

GITHUB_REPO="${GIT_DASH_REPO:-jakiestfu/git-dash}"
INSTALL_DIR="${PREFIX:-$HOME/.local/bin}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray() { printf '\033[90m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# The compile target for this machine, matching the asset names CI attaches
# to each release.
case "$(uname -s)-$(uname -m)" in
Darwin-arm64) TARGET=aarch64-apple-darwin ;;
Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
Linux-aarch64 | Linux-arm64) TARGET=aarch64-unknown-linux-gnu ;;
*)
	echo "Error: no prebuilt binary for $(uname -s)/$(uname -m)." >&2
	echo "To run from source, see https://github.com/$GITHUB_REPO#developing" >&2
	exit 1
	;;
esac

fetch() {
	local url=$1 dest=$2
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url" -o "$dest"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$dest" "$url"
	else
		echo "Error: need curl or wget to install git-dash" >&2
		exit 1
	fi
}

bold "Installing git-dash to $INSTALL_DIR"
gray "  Downloading the latest release binary ($TARGET)"

mkdir -p "$INSTALL_DIR"
tmp=$(mktemp -d -t git-dash-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

fetch "https://github.com/$GITHUB_REPO/releases/latest/download/git-dash-$TARGET" \
	"$tmp/git-dash"
chmod +x "$tmp/git-dash"
# mv over the old binary is atomic, so an existing install never half-updates.
mv -f "$tmp/git-dash" "$INSTALL_DIR/git-dash"

# Source files from the old from-source installer are no longer needed.
rm -rf "$INSTALL_DIR/git-dash.d"

green "Installed."

missing_runtime_deps=()
for dep in git gh; do
	if ! command -v "$dep" >/dev/null 2>&1; then
		missing_runtime_deps+=("$dep")
	fi
done

if ((${#missing_runtime_deps[@]} > 0)); then
	yellow "  Warning: missing runtime dependencies: ${missing_runtime_deps[*]}"
fi

case ":$PATH:" in
*":$INSTALL_DIR:"*) gray "  Try it: git dash" ;;
*)
	yellow "  $INSTALL_DIR is not on your PATH; add it to use 'git dash':"
	gray "    export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac
