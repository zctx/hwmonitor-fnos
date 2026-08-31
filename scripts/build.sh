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
command -v python3 >/dev/null || fail "python3 not found"

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
DRV_VERSION="$(modinfo -F version "$KO_SRC")"
DRV_SRCVERSION="$(modinfo -F srcversion "$KO_SRC")"
case "$VERMAGIC" in
  "$TARGET_KERNEL"*) ;;
  *) fail "vermagic mismatch: $VERMAGIC" ;;
esac
[ "$DRV_VERSION" = "$EXPECTED_DRIVER_VERSION" ] || fail "driver version mismatch: $DRV_VERSION"
[ "$DRV_SRCVERSION" = "$EXPECTED_DRIVER_SRCVERSION" ] || fail "driver srcversion mismatch: $DRV_SRCVERSION"
modinfo "$KO_SRC" | grep -q '^parm:.*experimental_write:' || fail "experimental_write module parameter missing"

KO_NAME="minisforum_n5_it5571-${TARGET_KERNEL}.ko"
mkdir -p "$HWMON/app/drivers/n5"
cp "$KO_SRC" "$HWMON/app/drivers/n5/$KO_NAME"
cp "$KO_SRC" "$DIST/$KO_NAME"

# 上游 0.2.0 将 N5A/F8NAB 标记为实验机型，默认只读。
# 用户已在该机型实机确认温度/RPM 数据合理，因此只对精确 DMI=N5A|N5 AIR + F8NAB
# 使用驱动官方预留的 experimental_write=1 参数；不修改驱动源码中的安全门禁。
DRIVERLOAD="$HWMON/app/driverload.js"
python3 - "$DRIVERLOAD" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old = """  try {\n    execFileSync(insmod, [match.file], { timeout: 20000, stdio: 'pipe' });\n    if (log) log(`N5 driver loaded: ${path.basename(match.file)}`);\n"""
new = """  const product = (dmi && dmi.product_name) || '';\n  const n5AirF8nab = /^(N5A|N5 AIR)$/i.test(product) && /^F8NAB$/i.test(board);\n  const insmodArgs = [match.file];\n  if (n5AirF8nab) {\n    insmodArgs.push('experimental_write=1');\n    if (log) log('N5A/F8NAB: enabling upstream experimental_write=1');\n  }\n\n  try {\n    execFileSync(insmod, insmodArgs, { timeout: 20000, stdio: 'pipe' });\n    if (log) log(`N5 driver loaded: ${path.basename(match.file)}`);\n"""
if old not in s:
    raise SystemExit('driverload patch anchor not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
PY

grep -Fq "insmodArgs.push('experimental_write=1')" "$DRIVERLOAD" || fail "N5A write-enable loader patch missing"
grep -Fq "/^(N5A|N5 AIR)$/i.test(product) && /^F8NAB$/i.test(board)" "$DRIVERLOAD" || fail "N5A/F8NAB DMI gate missing"

# 应用层补丁：多 NVMe 温度路径绑定、存储风扇最低占空比、UI 显示真实自动温度源。
python3 "$ROOT/scripts/patch-app.py" "$HWMON/app/server.js" "$HWMON/app/web/app.js"
grep -Fq "const nvmeHwmons = listHwmon()" "$HWMON/app/server.js" || fail "NVMe hwmon binding patch missing"
grep -Fq "storage fan safety floor" "$HWMON/app/server.js" || fail "storage fan safety floor missing"
grep -Fq "const auto = f.autoSource || null" "$HWMON/app/web/app.js" || fail "UI autoSource patch missing"

# 调整本地包版本。
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
# fnOS c1032 / Minisforum N5A F8NAB local patch

- hwmonitor upstream: ${HWMONITOR_REF} (${HWMONITOR_TAG})
- N5 driver upstream: ${N5_DRIVER_REF}
- driver source blob: ${N5_DRIVER_SOURCE_SHA1}
- driver version: ${DRV_VERSION}
- driver srcversion: ${DRV_SRCVERSION}
- target kernel: ${TARGET_KERNEL}
- module vermagic: ${VERMAGIC}
- package version: ${PACKAGE_VERSION}
- N5A/F8NAB: load upstream 0.2.0 with experimental_write=1
- NVMe temperature: bind block device to matching nvme hwmon through sysfs device path
- storage fan safety floor: 77/255 when in software curve mode

The kernel driver source is unmodified. The application loader passes the upstream
experimental_write=1 module parameter only when DMI is exactly N5A/N5 AIR + F8NAB.
EOF

log "building FPK"
(
  cd "$HWMON"
  bash ./build.sh
)

FPK="$HWMON/hwmonitor_${PACKAGE_VERSION}_x86.fpk"
[ -f "$FPK" ] || fail "FPK not produced"
cp "$FPK" "$DIST/"

# 反向解包成品，确认目标 ko 和本地补丁都真正进入 FPK。
VERIFY="$WORK/verify"
mkdir -p "$VERIFY/root" "$VERIFY/app"
tar -xzf "$FPK" -C "$VERIFY/root"
[ -f "$VERIFY/root/app.tgz" ] || fail "FPK app.tgz missing"
tar -xzf "$VERIFY/root/app.tgz" -C "$VERIFY/app"
PACKED_KO="$VERIFY/app/drivers/n5/$KO_NAME"
[ -f "$PACKED_KO" ] || fail "target module missing from packed FPK"
PACKED_VERMAGIC="$(modinfo -F vermagic "$PACKED_KO")"
[ "$PACKED_VERMAGIC" = "$VERMAGIC" ] || fail "packed module vermagic changed"
[ "$(modinfo -F version "$PACKED_KO")" = "$EXPECTED_DRIVER_VERSION" ] || fail "packed driver version mismatch"
grep -Fq "insmodArgs.push('experimental_write=1')" "$VERIFY/app/driverload.js" || fail "packed loader patch missing"
grep -Fq "const nvmeHwmons = listHwmon()" "$VERIFY/app/server.js" || fail "packed NVMe patch missing"
grep -Fq "storage fan safety floor" "$VERIFY/app/server.js" || fail "packed storage floor missing"
grep -Fq "const auto = f.autoSource || null" "$VERIFY/app/web/app.js" || fail "packed UI autoSource patch missing"

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
driver_version=$DRV_VERSION
driver_srcversion=$DRV_SRCVERSION
target_kernel=$TARGET_KERNEL
compiler=$(gcc --version | head -1)
module_vermagic=$VERMAGIC
n5a_f8nab_experimental_write=1
nvme_sysfs_bound=1
storage_curve_min_pwm=77
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
