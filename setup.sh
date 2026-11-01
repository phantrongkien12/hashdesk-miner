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

# --- node ------------------------------------------------------------------
#
# A distro `nodejs` package ships node without npm, and corepack is often
# stripped too, so `node` being on PATH says nothing about the toolchain. Check
# for a usable npm and install a complete Node under $HOME when it is missing.

NODE_VERSION="${NODE_VERSION:-22.11.0}"
NODE_DIR="$HOME/.local/node"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  npm --version >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null
}

node_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    armv7l) echo armv7l ;;
    *) echo "" ;;
  esac
}

install_node() {
  local arch ext url tmp unpacked
  arch="$(node_arch)"
  [ -n "$arch" ] || die "unsupported CPU: $(uname -m). Install Node 20+ by hand."
  command -v curl >/dev/null 2>&1 || die "curl is required to download Node."
  command -v tar >/dev/null 2>&1 || die "tar is required to unpack Node."

  # .tar.xz is roughly half the size, but needs xz-utils present.
  if command -v xz >/dev/null 2>&1; then ext=tar.xz; else ext=tar.gz; fi

  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.$ext"
  tmp="$(mktemp -d)"
  say "downloading Node $NODE_VERSION ($arch)"
  if ! curl -fsSL --max-time 600 "$url" -o "$tmp/node.$ext"; then
    rm -rf "$tmp"
    die "could not download $url. Set NODE_VERSION to a version that exists."
  fi

  mkdir -p "$HOME/.local"
  if ! tar -xf "$tmp/node.$ext" -C "$HOME/.local"; then
    rm -rf "$tmp"
    die "could not unpack Node."
  fi
  rm -rf "$tmp"

  unpacked="$HOME/.local/node-v$NODE_VERSION-linux-$arch"
  [ -d "$unpacked" ] || die "unexpected archive layout, no $unpacked"
  rm -rf "$NODE_DIR"
  mv "$unpacked" "$NODE_DIR"

  export PATH="$NODE_DIR/bin:$PATH"
  say "node $(node --version), npm $(npm --version)"
}

if node_ok; then
  say "node $(node --version), npm $(npm --version)"
else
  if command -v node >/dev/null 2>&1; then
    warn "node $(node --version 2>/dev/null) is incomplete or too old, installing a full copy"
  else
    warn "node not found, installing it"
  fi
  install_node
  node_ok || die "Node install did not produce a working npm."

  # Later shells need the same PATH, or `node scripts/mine-tui.mjs` fails.
  if ! grep -q 'hashdesk node' "$HOME/.bashrc" 2>/dev/null; then
    printf '\n# hashdesk node\nexport PATH="%s/bin:$PATH"\n' "$NODE_DIR" >>"$HOME/.bashrc"
    say "added $NODE_DIR/bin to PATH in ~/.bashrc"
  fi
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

# corepack writes a shim before it downloads, so a `pnpm` on PATH is not proof
# it runs. Verify, then repair instead of trusting it.
pm_ok() { command -v "$1" >/dev/null 2>&1 && "$1" --version >/dev/null 2>&1; }

PNPM_VER=$(node -p "try{require('./package.json').packageManager.split('@')[1]}catch(e){''}" 2>/dev/null)
[ -n "$PNPM_VER" ] || PNPM_VER=latest

PM=""
if pm_ok pnpm; then
  PM=pnpm
else
  say "pnpm is not usable, repairing"

  # Drop the shim first. A failed download leaves one behind that shadows any
  # real install, so repairing on top of it can never succeed.
  if command -v corepack >/dev/null 2>&1; then
    corepack disable >/dev/null 2>&1 || true

    # A non-interactive shell cannot answer corepack's download prompt.
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    # prepare fetches into the cache; enable only writes shims. Running enable
    # first is exactly what leaves a shim pointing at a file never downloaded.
    # The first fetch after a fresh Node install sometimes fails, so retry once
    # and keep the output: piping to `tail` would hide the actual error.
    corepack_log="$(mktemp)"
    for attempt in 1 2; do
      if corepack prepare "pnpm@$PNPM_VER" --activate >"$corepack_log" 2>&1; then
        break
      fi
      # corepack ships its own copy of the npm registry signing keys. When pnpm
      # is signed with a newer key it reports "Cannot find matching keyid" and
      # no amount of retrying helps, so skip straight to npm.
      if grep -q "Cannot find matching keyid" "$corepack_log"; then
        warn "corepack cannot verify pnpm@$PNPM_VER, its signing keys are outdated"
        break
      fi
      if [ "$attempt" = 1 ]; then
        warn "corepack prepare failed, retrying"
        sleep 2
      else
        warn "corepack prepare failed:"
        tail -3 "$corepack_log" | sed 's/^/    /'
      fi
    done
    rm -f "$corepack_log"

    corepack enable >/dev/null 2>&1 || true
    pm_ok pnpm && PM=pnpm
  else
    say "corepack is not installed, skipping it"
  fi

  if [ -z "$PM" ] && command -v npm >/dev/null 2>&1; then
    say "installing pnpm@$PNPM_VER with npm"
    # --force: corepack leaves shims (pnpm, pnpx, yarn) at the same paths and
    # npm refuses to overwrite them without it.
    npm install -g --force "pnpm@$PNPM_VER" >/dev/null 2>&1 || true
    pm_ok pnpm && PM=pnpm
  fi

  if [ -z "$PM" ] && command -v npx >/dev/null 2>&1; then
    say "global install failed, running pnpm through npx"
    if npx --yes "pnpm@$PNPM_VER" --version >/dev/null 2>&1; then
      PM=npx
    fi
  fi

  if [ -z "$PM" ]; then
    warn "pnpm unavailable, falling back to npm"
    PM=npm
  fi
fi

pm() {
  case "$PM" in
    pnpm) pnpm "$@" ;;
    npx) npx --yes "pnpm@$PNPM_VER" "$@" ;;
    npm) npm "$@" ;;
  esac
}

if [ "$CLEAN" -eq 1 ]; then
  say "clean: removing node_modules, .next and logs"
  rm -rf node_modules .next
  rm -f server.log mine-tui.log mine-chrome.log mine-schedule.log
fi

say "installing dependencies with $PM"
if [ "$PM" = npm ]; then
  # npm cannot read pnpm-lock.yaml, so it resolves the tree from scratch. That
  # occasionally trips an arborist bug ("Cannot read properties of null
  # (reading 'edgesOut')") on a corrupt cache entry, which a clean fixes.
  npm install --no-audit --no-fund || {
    warn "npm install failed, clearing its cache and retrying"
    npm cache clean --force >/dev/null 2>&1 || true
    npm install --no-audit --no-fund
  }
else
  pm install --frozen-lockfile 2>/dev/null || pm install
fi

run_build() {
  if [ "$PM" = npm ]; then npm run build; else pm run build; fi
}

say "building"
# next.config.mjs sets experimental.agentUpgrade=false so the build cannot stop
# to offer an interactive upgrade. Retry once anyway: a build that dies for any
# other reason leaves .next without BUILD_ID, and `next start` then fails with a
# confusing "Could not find a production build".
if ! run_build || [ ! -f .next/BUILD_ID ]; then
  warn "build incomplete, retrying once"
  run_build
fi
[ -f .next/BUILD_ID ] || die "build failed, no .next/BUILD_ID. Run '$PM run build' to see the error."

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
  # Run next directly: a package-manager wrapper would be the process we track,
  # not the one holding the port.
  if [ -f node_modules/next/dist/bin/next ]; then
    setsid nohup node node_modules/next/dist/bin/next start -p "$PORT" >"$DIR/server.log" 2>&1 </dev/null &
  else
    setsid nohup npx next start -p "$PORT" >"$DIR/server.log" 2>&1 </dev/null &
  fi
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
