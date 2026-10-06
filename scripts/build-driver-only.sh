#!/usr/bin/env bash
set -euo pipefail

KERNEL="${1:?usage: build-driver-only.sh <kernel-release> [output-dir]}"
OUT="${2:-dist-driver}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source ./upstream.lock

rm -rf "$OUT"
mkdir -p "$OUT"
DRV="$(mktemp -d)"
trap 'rm -rf "$DRV"' EXIT

git clone --quiet "$N5_DRIVER_REPO" "$DRV/repo"
git -C "$DRV/repo" checkout --quiet "$N5_DRIVER_REF"
[ "$(git -C "$DRV/repo" rev-parse HEAD)" = "$N5_DRIVER_REF" ]
SRC="$DRV/repo/driver-prototype/minisforum_n5_it5571.c"
[ "$(git hash-object "$SRC")" = "$N5_DRIVER_SOURCE_SHA1" ]

KDIR="/usr/src/linux-headers-$KERNEL"
[ -d "$KDIR" ] || KDIR="/lib/modules/$KERNEL/build"
[ -f "$KDIR/Makefile" ] || { echo "missing headers for $KERNEL" >&2; exit 2; }

make -C "$KDIR" M="$DRV/repo/driver-prototype" clean >/dev/null 2>&1 || true
make -j2 -C "$KDIR" M="$DRV/repo/driver-prototype" modules

KO_SRC="$DRV/repo/driver-prototype/minisforum_n5_it5571.ko"
KO_NAME="minisforum_n5_it5571-$KERNEL.ko"
[ "$(modinfo -F version "$KO_SRC")" = "$EXPECTED_DRIVER_VERSION" ]
[ "$(modinfo -F srcversion "$KO_SRC")" = "$EXPECTED_DRIVER_SRCVERSION" ]
case "$(modinfo -F vermagic "$KO_SRC")" in
  "$KERNEL"*) ;;
  *) echo "vermagic mismatch" >&2; exit 3 ;;
esac
modinfo "$KO_SRC" | grep -q '^parm:.*experimental_write:'
cp "$KO_SRC" "$OUT/$KO_NAME"
SHA="$(sha256sum "$OUT/$KO_NAME" | awk '{print $1}')"
printf '%s\n' "$SHA  $KO_NAME" > "$OUT/SHA256SUMS"
printf '{\n  "kernel": "%s",\n  "asset": "%s",\n  "sha256": "%s",\n  "driver_version": "%s"\n}\n' \
  "$KERNEL" "$KO_NAME" "$SHA" "$EXPECTED_DRIVER_VERSION" > "$OUT/entry.json"
echo "built $KO_NAME $SHA"
