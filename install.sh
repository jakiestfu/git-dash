#!/usr/bin/env bash
set -euo pipefail

GITHUB_REPO="${GIT_DASH_REPO:-jakiestfu/git-dash}"
GITHUB_REF="${GIT_DASH_REF:-main}"
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

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/main.ts" ]]; then
	MODE=local
else
	MODE=remote
fi

bold "Installing git-dash to $INSTALL_DIR"

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

# The compile target for this machine, matching the asset names CI attaches
# to each release. Empty when no prebuilt binary exists for the platform.
release_target() {
	case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) echo aarch64-apple-darwin ;;
	Darwin-x86_64) echo x86_64-apple-darwin ;;
	Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
	Linux-aarch64 | Linux-arm64) echo aarch64-unknown-linux-gnu ;;
	*) echo "" ;;
	esac
}

APP_DIR="$INSTALL_DIR/git-dash.d"
tmp=$(mktemp -d -t git-dash-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT

# install_binary: grab the prebuilt standalone binary from the latest GitHub
# release. Returns non-zero when there's no release (or no asset for this
# platform) so the caller can fall back to running from source.
install_binary() {
	local target
	target=$(release_target)
	[[ -n "$target" ]] || return 1
	gray "  Downloading prebuilt binary (latest release, $target)"
	fetch "https://github.com/$GITHUB_REPO/releases/latest/download/git-dash-$target" \
		"$tmp/git-dash" 2>/dev/null || return 1
	mv -f "$tmp/git-dash" "$INSTALL_DIR/git-dash"
	# Source files from a previous from-source install are no longer needed.
	rm -rf "$APP_DIR"
}

# install_source: install the TypeScript sources (run by Deno) — main.ts, its
# sibling modules, and deno.json for the @std import map. They live together
# in git-dash.d/ so the relative imports and bare specifiers resolve; the
# git-dash entry on PATH is a thin wrapper pointing at them.
install_source() {
	local files=(main.ts cli.ts colors.ts format.ts subprocess.ts deno.json)
	if [[ "$MODE" == local ]]; then
		gray "  Installing from source ($SCRIPT_DIR)"
		for f in "${files[@]}"; do
			cp -f "$SCRIPT_DIR/$f" "$tmp/$f"
		done
	else
		gray "  Downloading source ($GITHUB_REPO@$GITHUB_REF)"
		for f in "${files[@]}"; do
			fetch "https://raw.githubusercontent.com/$GITHUB_REPO/$GITHUB_REF/$f" "$tmp/$f"
		done
	fi

	# Swap the whole directory in one go so a half-fetched download never
	# replaces a working install.
	rm -rf "$APP_DIR"
	mkdir -p "$APP_DIR"
	mv "$tmp"/* "$APP_DIR/"

	cat >"$INSTALL_DIR/git-dash" <<-EOF
		#!/usr/bin/env bash
		exec deno run --quiet --allow-run=git,gh,open,xdg-open,explorer --allow-read --allow-write --allow-env --allow-net "$APP_DIR/main.ts" "\$@"
	EOF

	if ! command -v deno >/dev/null 2>&1; then
		yellow "  Warning: running from source requires Deno (https://deno.com)"
	fi
}

# A local checkout installs from source (the dev flow); a curl install takes
# the prebuilt binary when a release has one for this platform.
if [[ "$MODE" == local ]]; then
	install_source
else
	install_binary || install_source
fi
chmod +x "$INSTALL_DIR/git-dash"

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
