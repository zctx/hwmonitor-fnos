#!/usr/bin/env bash
set -euo pipefail

KERNEL="${1:?usage: prepare-fnos-headers.sh <kernel-release>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/upstream.lock"
META_REF="${2:-$HEADER_METADATA_REF}"
[[ "$KERNEL" =~ ^6\.18\.18\.c[1-9][0-9]{0,8}-trim$ ]] || { echo "invalid kernel" >&2; exit 2; }
[[ "$META_REF" =~ ^[a-f0-9]{40}$ ]] || { echo "metadata ref must be a commit SHA" >&2; exit 2; }
META_URL="https://api.github.com/repos/GreenDamTan/DockerFile/contents/fnOS/buildKernelModulesEnv/${KERNEL}_amd64.dockerfile?ref=${META_REF}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[headers] metadata: $META_URL"
curl --proto '=https' --proto-redir '=https' -fL --retry 3 --connect-timeout 15 --max-time 120 --max-filesize 104857600 \
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

python3 "$ROOT/scripts/fnos_headers.py" "$TMP/kernel.dockerfile" "$KERNEL" "$TMP/vars.sh"
# shellcheck disable=SC1090
source "$TMP/vars.sh"
echo "[headers] package: $PKG"

case "$PKG" in
  *"$KERNEL"*"_amd64.deb") ;;
  *) echo "[headers] package/kernel mismatch: $PKG vs $KERNEL" >&2; exit 3 ;;
esac

SIGNED_URL="$(bash "$ROOT/scripts/signforfn.sh" "$DLKEY" "$BASE_URL/$PKG")"
echo "[headers] downloading $PKG"
curl --proto '=https' --proto-redir '=https' -fL --retry 3 --connect-timeout 15 --max-time 120 --max-filesize 104857600 "$SIGNED_URL" -o "$TMP/$PKG"

if [[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]]; then
  ACTUAL_SHA="$(sha256sum "$TMP/$PKG" | awk '{print $1}')"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || {
    echo "[headers] SHA256 mismatch: $ACTUAL_SHA != $EXPECTED_SHA" >&2
    exit 4
  }
else
  echo "required SHA256 missing" >&2; exit 4
fi

[ "$(dpkg-deb -f "$TMP/$PKG" Architecture)" = amd64 ]
[ "$(dpkg-deb -f "$TMP/$PKG" Package)" = "linux-headers-$KERNEL" ]
dpkg -i "$TMP/$PKG"

KDIR="/usr/src/linux-headers-$KERNEL"
[ -d "$KDIR" ] || KDIR="/lib/modules/$KERNEL/build"
[ -f "$KDIR/Makefile" ] || { echo "[headers] build tree missing for $KERNEL" >&2; exit 5; }

[ -s "$KDIR/Module.symvers" ] || { echo "Module.symvers missing" >&2; exit 6; }
[ -f "$KDIR/include/config/kernel.release" ] || { echo "kernel.release missing" >&2; exit 6; }
if [ -f "$KDIR/include/config/kernel.release" ]; then
  ACTUAL="$(cat "$KDIR/include/config/kernel.release")"
  [ "$ACTUAL" = "$KERNEL" ] || {
    echo "[headers] kernel.release mismatch: $ACTUAL != $KERNEL" >&2
    exit 6
  }
fi

mkdir -p "$ROOT/.headers-info"
printf '%s\n' "kernel=$KERNEL" "metadata_ref=$META_REF" "package=$PKG" "sha256=$EXPECTED_SHA" > "$ROOT/.headers-info/$KERNEL.txt"
echo "[headers] ready: $KERNEL -> $KDIR"
