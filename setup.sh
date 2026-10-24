#!/usr/bin/env bash
# Installs and starts Hashdesk without root. Everything lives under $HOME.
set -euo pipefail

DIR="${1:-$HOME/miner}"
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

say "installing dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

say "building"
pnpm build

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

if ! command -v google-chrome >/dev/null 2>&1 &&
  ! command -v google-chrome-stable >/dev/null 2>&1 &&
  ! command -v chromium >/dev/null 2>&1 &&
  ! command -v chromium-browser >/dev/null 2>&1; then
  warn "Chrome/Chromium not found. The TUI needs it to hash."
  warn "Install without root:"
  warn "  npx @puppeteer/browsers install chrome@stable"
  warn "Then pass the binary path:"
  warn "  node scripts/mine-tui.mjs --chrome \"\$HOME/chrome/linux-*/chrome-linux64/chrome\""
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
