#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source ./upstream.lock

WORK="$ROOT/.work"
DIST="$ROOT/dist"
rm -rf "$WORK" "$DIST"
mkdir -p "$WORK" "$DIST"

log() { printf '[build] %s\n' "$*"; }
fail() { printf '[build][ERROR] %s\n' "$*" >&2; exit 1; }

log "hwmonitor upstream: $HWMONITOR_REF ($HWMONITOR_TAG)"
log "driver upstream:    $N5_DRIVER_REF"
log "target kernel:      $TARGET_KERNEL"
log "package version:    $PACKAGE_VERSION"

command -v git >/dev/null || fail "git not found"
command -v make >/dev/null || fail "make not found"
command -v modinfo >/dev/null || fail "modinfo not found"

HWMON="$WORK/hwmonitor"
DRV="$WORK/minisforum-n5-it5571"

git clone --quiet "$HWMONITOR_REPO" "$HWMON"
git -C "$HWMON" checkout --quiet "$HWMONITOR_REF"
[ "$(git -C "$HWMON" rev-parse HEAD)" = "$HWMONITOR_REF" ] || fail "hwmonitor commit mismatch"

git clone --quiet "$N5_DRIVER_REPO" "$DRV"
git -C "$DRV" checkout --quiet "$N5_DRIVER_REF"
[ "$(git -C "$DRV" rev-parse HEAD)" = "$N5_DRIVER_REF" ] || fail "driver commit mismatch"

DRIVER_SRC="$DRV/driver-prototype/minisforum_n5_it5571.c"
[ -f "$DRIVER_SRC" ] || fail "driver source missing"
SRC_HASH="$(git hash-object "$DRIVER_SRC")"
[ "$SRC_HASH" = "$N5_DRIVER_SOURCE_SHA1" ] || fail "driver source hash mismatch: $SRC_HASH"

KDIR="/usr/src/linux-headers-${TARGET_KERNEL}"
if [ ! -d "$KDIR" ]; then
  ALT="/lib/modules/${TARGET_KERNEL}/build"
  [ -d "$ALT" ] && KDIR="$ALT"
fi
[ -d "$KDIR" ] || fail "kernel build tree not found for $TARGET_KERNEL"
[ -f "$KDIR/include/config/kernel.release" ] || fail "kernel.release missing"
ACTUAL_KERNEL="$(cat "$KDIR/include/config/kernel.release")"
[ "$ACTUAL_KERNEL" = "$TARGET_KERNEL" ] || fail "kernel tree mismatch: $ACTUAL_KERNEL"

log "building N5 module with $(gcc --version | head -1)"
make -C "$KDIR" M="$DRV/driver-prototype" clean >/dev/null 2>&1 || true
make -j2 -C "$KDIR" M="$DRV/driver-prototype" modules

KO_SRC="$DRV/driver-prototype/minisforum_n5_it5571.ko"
[ -f "$KO_SRC" ] || fail "kernel module was not produced"
VERMAGIC="$(modinfo -F vermagic "$KO_SRC")"
case "$VERMAGIC" in
  "$TARGET_KERNEL"*) ;;
  *) fail "vermagic mismatch: $VERMAGIC" ;;
esac

KO_NAME="minisforum_n5_it5571-${TARGET_KERNEL}.ko"
mkdir -p "$HWMON/app/drivers/n5"
cp "$KO_SRC" "$HWMON/app/drivers/n5/$KO_NAME"
cp "$KO_SRC" "$DIST/$KO_NAME"

# 保留上游业务代码，仅调整本地包版本。驱动加载逻辑本身已经按 uname -r 精确匹配。
sed -i -E "s/^version[[:space:]]*=.*/version         = ${PACKAGE_VERSION}/" "$HWMON/manifest"
python3 - "$HWMON/app/package.json" "$PACKAGE_VERSION" <<'PY'
import json, sys
p, ver = sys.argv[1], sys.argv[2]
with open(p, 'r', encoding='utf-8') as f:
    d = json.load(f)
d['version'] = ver
with open(p, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
sed -i -E "s/^VER=.*/VER=${PACKAGE_VERSION}/" "$HWMON/build.sh"

cat > "$HWMON/PATCH_INFO.md" <<EOF
# fnOS c1032 local patch

- hwmonitor upstream: ${HWMONITOR_REF} (${HWMONITOR_TAG})
- N5 driver upstream: ${N5_DRIVER_REF}
- driver source blob: ${N5_DRIVER_SOURCE_SHA1}
- target kernel: ${TARGET_KERNEL}
- module vermagic: ${VERMAGIC}
- package version: ${PACKAGE_VERSION}

Only the target-kernel N5 module and package version metadata are added/changed.
EOF

log "building FPK"
(
  cd "$HWMON"
  bash ./build.sh
)

FPK="$HWMON/hwmonitor_${PACKAGE_VERSION}_x86.fpk"
[ -f "$FPK" ] || fail "FPK not produced"
cp "$FPK" "$DIST/"

# 反向解包成品，再次确认目标 ko 真正进入 FPK，避免只验证工作目录。
VERIFY="$WORK/verify"
mkdir -p "$VERIFY/root" "$VERIFY/app"
tar -xzf "$FPK" -C "$VERIFY/root"
[ -f "$VERIFY/root/app.tgz" ] || fail "FPK app.tgz missing"
tar -xzf "$VERIFY/root/app.tgz" -C "$VERIFY/app"
PACKED_KO="$VERIFY/app/drivers/n5/$KO_NAME"
[ -f "$PACKED_KO" ] || fail "target module missing from packed FPK"
PACKED_VERMAGIC="$(modinfo -F vermagic "$PACKED_KO")"
[ "$PACKED_VERMAGIC" = "$VERMAGIC" ] || fail "packed module vermagic changed"

# 源码归档包含已注入驱动的完整可维护工程，但不包含 .git 历史。
tar -czf "$DIST/hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" -C "$HWMON" \
  --exclude=.git \
  --exclude="hwmonitor_${PACKAGE_VERSION}_x86.fpk" \
  .

KO_SHA="$(sha256sum "$DIST/$KO_NAME" | awk '{print $1}')"
FPK_SHA="$(sha256sum "$DIST/hwmonitor_${PACKAGE_VERSION}_x86.fpk" | awk '{print $1}')"
SOURCE_SHA="$(sha256sum "$DIST/hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" | awk '{print $1}')"

cat > "$DIST/build-info.txt" <<EOF
hwmonitor_ref=$HWMONITOR_REF
hwmonitor_tag=$HWMONITOR_TAG
driver_ref=$N5_DRIVER_REF
driver_source_blob=$N5_DRIVER_SOURCE_SHA1
target_kernel=$TARGET_KERNEL
compiler=$(gcc --version | head -1)
module_vermagic=$VERMAGIC
module_sha256=$KO_SHA
fpk_sha256=$FPK_SHA
source_sha256=$SOURCE_SHA
package_version=$PACKAGE_VERSION
EOF

(
  cd "$DIST"
  sha256sum \
    "$KO_NAME" \
    "hwmonitor_${PACKAGE_VERSION}_x86.fpk" \
    "hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" \
    > SHA256SUMS
)

log "build complete"
cat "$DIST/build-info.txt"
