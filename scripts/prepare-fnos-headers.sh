#!/usr/bin/env bash
set -euo pipefail

KERNEL="${1:?usage: prepare-fnos-headers.sh <kernel-release>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
META_URL="https://api.github.com/repos/GreenDamTan/DockerFile/contents/fnOS/buildKernelModulesEnv/${KERNEL}_amd64.dockerfile?ref=dev"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -e "/lib/modules/$KERNEL/build/Makefile" ] || [ -e "/usr/src/linux-headers-$KERNEL/Makefile" ]; then
  echo "[headers] already installed: $KERNEL"
  exit 0
fi

echo "[headers] metadata: $META_URL"
curl -fL --retry 3 --connect-timeout 15 \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: hwmonitor-fnos' \
  "$META_URL" -o "$TMP/meta.json"
python3 - "$TMP/meta.json" "$TMP/kernel.dockerfile" <<'PY'
import base64, json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, 'r', encoding='utf-8') as f:
    obj = json.load(f)
content = obj.get('content')
if not content:
    raise SystemExit('GitHub contents response has no content')
with open(dst, 'wb') as f:
    f.write(base64.b64decode(content))
PY

python3 - "$TMP/kernel.dockerfile" "$TMP/vars.sh" <<'PY'
import re, shlex, sys
src, out = sys.argv[1], sys.argv[2]
text = open(src, encoding='utf-8').read()
def env(name):
    m = re.search(r'^ENV\\s+' + re.escape(name) + r'=["\\\']?([^"\\\'\\n]+)["\\\']?\\s*
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
, text, re.M)
    if not m:
        raise SystemExit(f'missing ENV {name}')
    return m.group(1)
m = re.search(r'^\\s*#\\s*"sign"\\s*:\\s*"([0-9a-f]{64})"', text, re.M)
vals = {
    'BASE_URL': env('BaseURL'),
    'PKG': env('PKG'),
    'DLKEY': env('dlkey'),
    'EXPECTED_SHA': m.group(1) if m else '',
}
with open(out, 'w', encoding='utf-8') as f:
    for k, v in vals.items():
        f.write(f"{k}={shlex.quote(v)}\\n")
PY
# shellcheck disable=SC1090
source "$TMP/vars.sh"
echo "[headers] package: $PKG"

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
