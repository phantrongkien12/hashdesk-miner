#!/usr/bin/env bash
# Extracts Chrome's system libraries into ./libs without root.
#
# A Chrome downloaded by @puppeteer/browsers starts fine on a desktop but fails
# on a bare VPS with "error while loading shared libraries". Installing the
# packages needs root, so this downloads the .deb files and unpacks them into a
# local directory instead. The TUI picks up ./libs automatically.
set -euo pipefail

LIBS_DIR="${LIBS_DIR:-$PWD/libs}"
PACKAGES=(
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0
  libcups2 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libasound2
  libx11-6 libxcb1 libxext6 libxrender1 libxi6 libxtst6
  libglib2.0-0 libdbus-1-3 libexpat1 libfontconfig1 libfreetype6
  libpng16-16 libpixman-1-0 libwayland-client0 libwayland-server0
  libxkbcommon-x11-0 libxcb-render0 libxcb-shm0 libxcb-shape0
  libxcb-xfixes0 libxcb-glx0 libxcb-dri3-0 libxcb-present0
  libxcb-sync1 libxcb-xkb1 libxcb-icccm4 libxcb-image0 libxcb-keysyms1
  libxcb-randr0 libxcb-render-util0 libxcb-util1 libxcb-xinerama0
  libx11-xcb1 libxau6 libxdmcp6 libbsd0 libmd0 libselinux1 libpcre2-8-0
)

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v apt-get >/dev/null 2>&1 ||
  die "apt-get not found. This script needs a Debian/Ubuntu box."
command -v dpkg-deb >/dev/null 2>&1 ||
  die "dpkg-deb not found. Install dpkg or ask the admin for the packages."

mkdir -p "$LIBS_DIR"
cd "$LIBS_DIR"

say "downloading ${#PACKAGES[@]} packages into $LIBS_DIR"
# apt-get download needs no root and writes into the current directory.
missing=()
for pkg in "${PACKAGES[@]}"; do
  if ! apt-get download "$pkg" >/dev/null 2>&1; then
    missing+=("$pkg")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  warn "could not download: ${missing[*]}"
  warn "the box may need 'apt-get update' first, or the names differ on this distro"
fi

say "extracting"
count=0
for deb in *.deb; do
  [ -e "$deb" ] || continue
  dpkg-deb -x "$deb" . && count=$((count + 1))
done
say "extracted $count packages"

LIB_PATH=""
for candidate in \
  "$LIBS_DIR/usr/lib/x86_64-linux-gnu" \
  "$LIBS_DIR/usr/lib/aarch64-linux-gnu" \
  "$LIBS_DIR/usr/lib" \
  "$LIBS_DIR/lib/x86_64-linux-gnu"; do
  [ -d "$candidate" ] && LIB_PATH="$candidate:$LIB_PATH"
done

[ -n "$LIB_PATH" ] || die "no library directory found after extraction"

cat <<EOF

Libraries are in $LIBS_DIR

The TUI finds this directory automatically. To use it in this shell:

  export LD_LIBRARY_PATH="$LIB_PATH\$LD_LIBRARY_PATH"

Then check:

  node scripts/mine-tui.mjs --doctor

EOF
