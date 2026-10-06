#!/usr/bin/env bash
set -euo pipefail

KERNEL="${1:?usage: build-driver-only.sh <kernel-release> [output-dir]}"
OUT="${2:-dist-driver}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source ./upstream.lock

[[ "$KERNEL" =~ ^6\.18\.18\.c[1-9][0-9]{0,8}-trim$ ]] || { echo "invalid kernel" >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "output directory already exists: $OUT" >&2; exit 2; }
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
[ -s "$KDIR/Module.symvers" ]
[ "$(cat "$KDIR/include/config/kernel.release")" = "$KERNEL" ]
[ -f "$KDIR/Makefile" ] || { echo "missing headers for $KERNEL" >&2; exit 2; }

make -C "$KDIR" M="$DRV/repo/driver-prototype" clean >/dev/null 2>&1 || true
make -j2 -C "$KDIR" M="$DRV/repo/driver-prototype" modules

KO_SRC="$DRV/repo/driver-prototype/minisforum_n5_it5571.ko"
KO_NAME="minisforum_n5_it5571-$KERNEL.ko"
[ "$(modinfo -F version "$KO_SRC")" = "$EXPECTED_DRIVER_VERSION" ]
[ "$(modinfo -F srcversion "$KO_SRC")" = "$EXPECTED_DRIVER_SRCVERSION" ]
case "$(modinfo -F vermagic "$KO_SRC")" in
  "$KERNEL "*) ;;
  *) echo "vermagic mismatch" >&2; exit 3 ;;
esac
modinfo "$KO_SRC" | grep '^parm:.*experimental_write:'
cp "$KO_SRC" "$OUT/$KO_NAME"
SHA="$(sha256sum "$OUT/$KO_NAME" | awk '{print $1}')"
printf '%s\n' "$SHA  $KO_NAME" > "$OUT/SHA256SUMS"
python3 "$ROOT/scripts/driver_index.py" entry "$OUT/$KO_NAME" "$OUT/entry.json"
echo "built $KO_NAME $SHA"

git -C "$DRV/repo" archive "$N5_DRIVER_REF" driver-prototype | gzip -n > "$OUT/driver-source.tar.gz"
