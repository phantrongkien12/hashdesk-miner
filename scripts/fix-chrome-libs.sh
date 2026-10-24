#!/usr/bin/env bash
# Makes Chrome runnable on a box with no root and no package manager.
#
# A downloaded Chrome needs ~21 system libraries. Instead of installing them,
# this uses @sparticuz/chromium, a build that bundles everything except nss,
# nspr and fontconfig, then unpacks those few from Debian packages into ./libs.
# The TUI points LD_LIBRARY_PATH and FONTCONFIG_PATH at ./libs automatically.
#
#   bash scripts/fix-chrome-libs.sh
#   node scripts/mine-tui.mjs --doctor
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

LIBS="$DIR/libs"
DEBS="$DIR/.debs"
MIRROR="https://deb.debian.org/debian/pool/main"

say() { printf '==> %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }
die() { printf '[x] %s\n' "$*" >&2; exit 1; }

for tool in curl ar tar xz; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed"
done

# --- 1. the bundled Chromium ------------------------------------------------

if [ -d node_modules/@sparticuz/chromium ]; then
  say "@sparticuz/chromium already installed"
else
  say "installing @sparticuz/chromium"
  pnpm add @sparticuz/chromium || die "could not install @sparticuz/chromium"
fi

# --- 2. the few libraries it does not bundle --------------------------------

# Package names differ per distro, so the Debian archive is used directly: it
# is public, needs no root, and ar+tar can unpack a .deb anywhere.
PACKAGES=(
  "n/nspr:libnspr4"
  "n/nss:libnss3"
  "f/fontconfig:libfontconfig1"
  "f/fonts-dejavu:fonts-dejavu-core"
)

mkdir -p "$DEBS" "$LIBS"

# A previous run may have left libraries from a different Debian release, and
# mixing them fails in confusing ways. Start from a clean tree.
if [ -d "$LIBS/usr" ]; then
  say "clearing previous libraries"
  find "$LIBS/usr" -type f -delete 2>/dev/null || true
  find "$LIBS/usr" -type d -empty -delete 2>/dev/null || true
fi

# The pool listing is the only index available without apt metadata. Newer
# builds are not better here: bookworm's libnss3 needs glibc 2.36 and a VPS
# often has 2.34, so the oldest build is the one most likely to load.
resolve_deb() {
  local pool="$1" pkg="$2" all bullseye
  all="$(curl -sL --max-time 60 "$MIRROR/$pool/" |
    grep -oE "${pkg}_[^\"]+_(amd64|all)\.deb" | sort -u)"
  [ -n "$all" ] || return 0

  bullseye="$(printf '%s\n' "$all" | grep -E 'deb11' | sort -V | tail -1)"
  if [ -n "$bullseye" ]; then
    printf '%s' "$bullseye"
    return 0
  fi
  printf '%s\n' "$all" | sort -V | head -1
}

for entry in "${PACKAGES[@]}"; do
  pool="${entry%%:*}"
  pkg="${entry##*:}"

  file="$(resolve_deb "$pool" "$pkg")"
  if [ -z "$file" ]; then
    warn "could not resolve $pkg, skipping"
    continue
  fi

  if [ -f "$DEBS/$file" ]; then
    say "$pkg already downloaded"
  else
    say "downloading $file"
    curl -sL --max-time 180 -o "$DEBS/$file" "$MIRROR/$pool/$file" ||
      { warn "download failed: $file"; continue; }
  fi

  # A .deb is an ar archive holding data.tar.{xz,gz,zst}.
  ( cd "$DEBS" && ar x "$file" 2>/dev/null )
  for member in data.tar.xz data.tar.gz data.tar.zst; do
    if [ -f "$DEBS/$member" ]; then
      tar xf "$DEBS/$member" -C "$LIBS" 2>/dev/null && say "extracted $member"
      break
    fi
  done
  rm -f "$DEBS"/data.tar.* "$DEBS"/control.tar.* "$DEBS"/debian-binary
done

# --- 3. fontconfig needs a config file, not just the library ----------------

say "writing fontconfig config"
mkdir -p "$LIBS/etc/fonts" "$LIBS/fontcache"
cat > "$LIBS/etc/fonts/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$LIBS/usr/share/fonts</dir>
  <cachedir>$LIBS/fontcache</cachedir>
</fontconfig>
EOF

# --- 4. verify --------------------------------------------------------------

say "unpacking chromium"
CHROME="$(node --input-type=module -e "
import chromium from '@sparticuz/chromium'
process.stdout.write(await chromium.executablePath())
" 2>/dev/null)" || die "could not unpack @sparticuz/chromium"

[ -x "$CHROME" ] || die "chromium binary missing at $CHROME"

LIBPATH="$LIBS/usr/lib/x86_64-linux-gnu/nss:$LIBS/usr/lib/x86_64-linux-gnu:$LIBS/usr/lib"
export LD_LIBRARY_PATH="$LIBPATH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export FONTCONFIG_PATH="$LIBS/etc/fonts"

# ldd prints "name => not found" for a missing library, but when the loader
# itself cannot start it prints "<binary>: error while loading ..." instead.
# grep exits 1 when nothing matches, which is the success case here, so the
# pipeline must not be allowed to trip set -e.
missing="$(ldd "$CHROME" 2>/dev/null | grep 'not found' | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
if [ -n "$missing" ]; then
  warn "still missing: $missing"
  die "run this script again, or ask the box admin to install those libraries"
fi

if ! version="$("$CHROME" --version 2>&1 | head -1)"; then
  warn "chromium still cannot start:"
  warn "$version"
  die "the libraries above are incompatible with this system's glibc"
fi

say "chromium runs: $version"
say "done. start the miner with:"
say "  node scripts/mine-tui.mjs --serve --threads $(nproc)"
