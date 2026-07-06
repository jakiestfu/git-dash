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

# The sources git-dash runs from: main.ts plus its sibling modules, and
# deno.json for the @std import map. They live together in git-dash.d/ so the
# relative imports and bare specifiers resolve; the git-dash entry on PATH is
# a thin wrapper pointing at them.
FILES=(main.ts cli.ts colors.ts format.ts subprocess.ts deno.json)
APP_DIR="$INSTALL_DIR/git-dash.d"

tmp=$(mktemp -d -t git-dash-install.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
if [[ "$MODE" == local ]]; then
	gray "  Installing git-dash"
	for f in "${FILES[@]}"; do
		cp -f "$SCRIPT_DIR/$f" "$tmp/$f"
	done
else
	gray "  Downloading git-dash"
	for f in "${FILES[@]}"; do
		fetch "https://raw.githubusercontent.com/$GITHUB_REPO/$GITHUB_REF/$f" "$tmp/$f"
	done
fi

# Swap the whole directory in one go so a half-fetched download never
# replaces a working install.
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
mv "$tmp"/* "$APP_DIR/"

cat >"$INSTALL_DIR/git-dash" <<EOF
#!/usr/bin/env bash
exec deno run --quiet --allow-run=git,gh,open,xdg-open,explorer --allow-read --allow-write --allow-env --allow-net "$APP_DIR/main.ts" "\$@"
EOF
chmod +x "$INSTALL_DIR/git-dash"

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
*":$INSTALL_DIR:"*) gray "  Try it: git dash" ;;
*)
	yellow "  $INSTALL_DIR is not on your PATH; add it to use 'git dash':"
	gray "    export PATH=\"$INSTALL_DIR:\$PATH\""
	;;
esac
