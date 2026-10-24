#!/usr/bin/env bash
# Installs and starts Hashdesk without root. Everything lives under $HOME.
#
#   bash setup.sh              install or update in $HOME/miner
#   bash setup.sh --clean      wipe node_modules/.next first, then rebuild
#   bash setup.sh ~/other      install into a different directory
set -euo pipefail

CLEAN=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

DIR="${ARGS[0]:-$HOME/miner}"
REPO="${REPO_URL:-https://github.com/phantrongkien12/hashdesk-miner.git}"
PORT="${PORT:-3100}"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[x]\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node not found. Install Node 20+ first."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is too old, need 20 or newer."

if ! command -v pnpm >/dev/null; then
  say "pnpm not found, enabling through corepack"
  corepack enable 2>/dev/null || npm install -g pnpm
fi

if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO" "$DIR"
fi

cd "$DIR"

if [ "$CLEAN" -eq 1 ]; then
  say "clean: removing node_modules, .next and logs"
  rm -rf node_modules .next
  rm -f server.log mine-tui.log mine-chrome.log mine-schedule.log
fi

say "installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

say "building"
# Next.js 16.4 stops the first build to print a security upgrade notice and
# exits 1. Retrying continues the build, so a fresh install must not give up.
if ! pnpm build; then
  warn "build stopped early (Next.js upgrade notice), retrying once"
  pnpm build
fi

if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  say "server already listening on :$PORT"
else
  say "starting server on :$PORT"
  # setsid detaches from the terminal so the job is not suspended when the
  # shell exits, which is what a bare `&` does on a non-interactive login.
  setsid nohup pnpm exec next start -p "$PORT" >"$DIR/server.log" 2>&1 </dev/null &
  for _ in $(seq 1 40); do
    sleep 1
    curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
  done
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 ||
    die "server did not start, see $DIR/server.log"
fi

say "server ready on http://127.0.0.1:$PORT"

# Chrome from a distro package lands on PATH, but Puppeteer and Playwright
# download into a cache dir, so both places have to be checked.
find_chrome() {
  for name in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  for root in "$HOME/.cache/puppeteer" "$HOME/.cache/ms-playwright" "$HOME/chrome"; do
    [ -d "$root" ] || continue
    found="$(find "$root" -type f \( -name chrome -o -name chromium \) 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  done
  return 1
}

if CHROME_PATH="$(find_chrome)"; then
  say "chrome found at $CHROME_PATH"
else
  warn "Chrome/Chromium not found. The TUI needs it to hash."
  warn "Install without root:"
  warn "  npx @puppeteer/browsers install chrome@stable"
  warn "The TUI finds it automatically afterwards, no --chrome needed."
fi

THREADS="$(node -p 'Math.max(1, require("os").cpus().length - 1)')"

cat <<EOF

Next:
  cd $DIR
  node scripts/mine-tui.mjs --threads $THREADS --port $PORT

Or let the TUI start the server itself on a free port:
  node scripts/mine-tui.mjs --serve --threads $THREADS

Stop the server:
  pkill -f "next start"

Server log:
  tail -f $DIR/server.log
EOF
