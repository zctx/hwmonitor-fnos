#!/usr/bin/env bash
set -euo pipefail

KERNEL="${1:?usage: prepare-fnos-headers.sh <kernel-release>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
META_URL="https://raw.githubusercontent.com/GreenDamTan/DockerFile/dev/fnOS/buildKernelModulesEnv/${KERNEL}_amd64.dockerfile"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -e "/lib/modules/$KERNEL/build/Makefile" ] || [ -e "/usr/src/linux-headers-$KERNEL/Makefile" ]; then
  echo "[headers] already installed: $KERNEL"
  exit 0
fi

echo "[headers] metadata: $META_URL"
curl -fsSL "$META_URL" -o "$TMP/kernel.dockerfile"

get_env() {
  local name="$1"
  sed -nE "s/^ENV[[:space:]]+${name}=[\"']?([^\"']+)[\"']?$/\1/p" "$TMP/kernel.dockerfile" | tail -1
}

BASE_URL="$(get_env BaseURL)"
PKG="$(get_env PKG)"
DLKEY="$(get_env dlkey)"
EXPECTED_SHA="$(sed -nE 's/^[[:space:]]*#[[:space:]]*"sign":[[:space:]]*"([0-9a-f]{64})".*/\1/p' "$TMP/kernel.dockerfile" | head -1)"

[ -n "$BASE_URL" ] || { echo "[headers] BaseURL missing" >&2; exit 2; }
[ -n "$PKG" ] || { echo "[headers] PKG missing" >&2; exit 2; }
[ -n "$DLKEY" ] || { echo "[headers] dlkey missing" >&2; exit 2; }

case "$PKG" in
  *"$KERNEL"*"_amd64.deb") ;;
  *) echo "[headers] package/kernel mismatch: $PKG vs $KERNEL" >&2; exit 3 ;;
esac

SIGNED_URL="$(bash "$ROOT/scripts/signforfn.sh" "$DLKEY" "$BASE_URL/$PKG")"
echo "[headers] downloading $PKG"
curl -fL --retry 3 --connect-timeout 15 "$SIGNED_URL" -o "$TMP/$PKG"

if [ -n "$EXPECTED_SHA" ]; then
  ACTUAL_SHA="$(sha256sum "$TMP/$PKG" | awk '{print $1}')"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
    echo "[headers] SHA256 mismatch: $ACTUAL_SHA != $EXPECTED_SHA" >&2
    exit 4
  }
fi

dpkg -i "$TMP/$PKG"

KDIR="/usr/src/linux-headers-$KERNEL"
[ -d "$KDIR" ] || KDIR="/lib/modules/$KERNEL/build"
[ -f "$KDIR/Makefile" ] || { echo "[headers] build tree missing for $KERNEL" >&2; exit 5; }

if [ -f "$KDIR/include/config/kernel.release" ]; then
  ACTUAL="$(cat "$KDIR/include/config/kernel.release")"
  [ "$ACTUAL" = "$KERNEL" ] || {
    echo "[headers] kernel.release mismatch: $ACTUAL != $KERNEL" >&2
    exit 6
  }
fi

echo "[headers] ready: $KERNEL -> $KDIR"
