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
# next.config.mjs sets experimental.agentUpgrade=false so the build cannot stop
# to offer an interactive upgrade. Retry once anyway: a build that dies for any
# other reason leaves .next without BUILD_ID, and `next start` then fails with a
# confusing "Could not find a production build".
if ! pnpm build || [ ! -f .next/BUILD_ID ]; then
  warn "build incomplete, retrying once"
  pnpm build
fi
[ -f .next/BUILD_ID ] || die "build failed, no .next/BUILD_ID. Run 'pnpm build' to see the error."

# A listener on the port is not proof it is this app: another project may hold
# it. The telemetry route only exists here, so it identifies our server.
app_ok() { curl -sf --max-time 3 "http://127.0.0.1:$1/api/miner/telemetry?since=0" >/dev/null 2>&1; }
port_busy() { curl -s --max-time 2 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }

if app_ok "$PORT"; then
  say "server already running on :$PORT"
else
  if port_busy "$PORT"; then
    warn "port $PORT is taken by another process, looking for a free one"
    for candidate in $(seq $((PORT + 1)) $((PORT + 20))); do
      if ! port_busy "$candidate"; then
        PORT="$candidate"
        break
      fi
    done
    say "using port $PORT"
  fi
  say "starting server on :$PORT"
  # setsid detaches from the terminal so the job is not suspended when the
  # shell exits, which is what a bare `&` does on a non-interactive login.
  setsid nohup pnpm exec next start -p "$PORT" >"$DIR/server.log" 2>&1 </dev/null &
  for _ in $(seq 1 40); do
    sleep 1
    app_ok "$PORT" && break
  done
  if ! app_ok "$PORT"; then
    warn "server did not start, last lines of $DIR/server.log:"
    tail -15 "$DIR/server.log" 2>/dev/null | sed 's/^/    /'
    die "fix the error above, then rerun: bash setup.sh"
  fi
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
  for root in "$PWD/chrome" "$PWD/.cache/puppeteer" "$HOME/.cache/puppeteer" "$HOME/.cache/ms-playwright" "$HOME/chrome"; do
    [ -d "$root" ] || continue
    found="$(find "$root" -type f \( -name chrome -o -name chromium \) 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  done
  return 1
}

# Finding the binary is not enough: a downloaded Chrome usually fails to start
# on a bare VPS because its system libraries are missing. Rather than printing
# instructions, fix it here so the next command just works.
chrome_works() {
  local path
  path="$(find_chrome)" || return 1
  [ -n "$path" ] || return 1
  LD_LIBRARY_PATH="$PWD/libs/usr/lib/x86_64-linux-gnu/nss:$PWD/libs/usr/lib/x86_64-linux-gnu:$PWD/libs/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    FONTCONFIG_PATH="$PWD/libs/etc/fonts" \
    "$path" --version >/dev/null 2>&1
}

if chrome_works; then
  say "chrome ok: $("$(find_chrome)" --version 2>&1 | head -1)"
else
  say "chrome is missing or cannot start, setting it up"
  if bash scripts/fix-chrome-libs.sh; then
    say "chrome ready"
  else
    warn "chrome setup failed, the miner cannot hash without it"
    warn "run 'node scripts/mine-tui.mjs --doctor' to see what is missing"
  fi
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
