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

SUPPORTED_KERNELS="${SUPPORTED_KERNELS:-$TARGET_KERNEL}"
read -r -a KERNELS <<< "$SUPPORTED_KERNELS"
[ "${#KERNELS[@]}" -gt 0 ] || fail "no supported kernels configured"

log "hwmonitor upstream: $HWMONITOR_REF ($HWMONITOR_TAG)"
log "driver upstream:    $N5_DRIVER_REF"
log "package version:    $PACKAGE_VERSION"
log "supported kernels:  ${KERNELS[*]}"

for cmd in git make modinfo python3 sha256sum tar; do
  command -v "$cmd" >/dev/null || fail "$cmd not found"
done

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

mkdir -p "$HWMON/app/drivers/n5"
MODULE_INFO="$WORK/module-info.txt"
: > "$MODULE_INFO"

for KERNEL in "${KERNELS[@]}"; do
  KDIR="/usr/src/linux-headers-$KERNEL"
  if [ ! -d "$KDIR" ]; then
    ALT="/lib/modules/$KERNEL/build"
    [ -d "$ALT" ] && KDIR="$ALT"
  fi
  [ -d "$KDIR" ] || fail "kernel build tree not found for $KERNEL"
  [ -f "$KDIR/Makefile" ] || fail "kernel Makefile missing for $KERNEL"

  if [ -f "$KDIR/include/config/kernel.release" ]; then
    ACTUAL_KERNEL="$(cat "$KDIR/include/config/kernel.release")"
    [ "$ACTUAL_KERNEL" = "$KERNEL" ] || fail "kernel tree mismatch: $ACTUAL_KERNEL != $KERNEL"
  fi

  log "building N5 module for $KERNEL with $(gcc --version | head -1)"
  make -C "$KDIR" M="$DRV/driver-prototype" clean >/dev/null 2>&1 || true
  make -j2 -C "$KDIR" M="$DRV/driver-prototype" modules

  KO_SRC="$DRV/driver-prototype/minisforum_n5_it5571.ko"
  [ -f "$KO_SRC" ] || fail "kernel module was not produced for $KERNEL"

  VERMAGIC="$(modinfo -F vermagic "$KO_SRC")"
  DRV_VERSION="$(modinfo -F version "$KO_SRC")"
  DRV_SRCVERSION="$(modinfo -F srcversion "$KO_SRC")"

  case "$VERMAGIC" in
    "$KERNEL"*) ;;
    *) fail "vermagic mismatch for $KERNEL: $VERMAGIC" ;;
  esac
  [ "$DRV_VERSION" = "$EXPECTED_DRIVER_VERSION" ] || fail "driver version mismatch: $DRV_VERSION"
  [ "$DRV_SRCVERSION" = "$EXPECTED_DRIVER_SRCVERSION" ] || fail "driver srcversion mismatch: $DRV_SRCVERSION"
  modinfo "$KO_SRC" | grep -q '^parm:.*experimental_write:' || fail "experimental_write module parameter missing"

  KO_NAME="minisforum_n5_it5571-$KERNEL.ko"
  cp "$KO_SRC" "$HWMON/app/drivers/n5/$KO_NAME"
  cp "$KO_SRC" "$DIST/$KO_NAME"
  KO_SHA="$(sha256sum "$DIST/$KO_NAME" | awk '{print $1}')"

  {
    echo "kernel=$KERNEL"
    echo "vermagic=$VERMAGIC"
    echo "sha256=$KO_SHA"
  } >> "$MODULE_INFO"
done

DRIVERLOAD="$HWMON/app/driverload.js"
python3 "$ROOT/scripts/patch-driverload.py" "$DRIVERLOAD"
grep -Fq "experimental_write=1" "$DRIVERLOAD" || fail "N5A write-enable loader patch missing"
grep -Fq "REMOTE_TAG = 'kernel-modules'" "$DRIVERLOAD" || fail "remote driver channel patch missing"
grep -Fq "sha256File" "$DRIVERLOAD" || fail "remote SHA256 verification missing"

python3 "$ROOT/scripts/patch-app.py" "$HWMON/app/server.js" "$HWMON/app/web/app.js"
grep -Fq "const nvmeHwmons = listHwmon()" "$HWMON/app/server.js" || fail "NVMe hwmon binding patch missing"
grep -Fq "storage fan safety floor" "$HWMON/app/server.js" || fail "storage fan safety floor missing"
grep -Fq "const auto = f.autoSource || null" "$HWMON/app/web/app.js" || fail "UI autoSource patch missing"
grep -Fq "n5DriverRetry = setInterval" "$HWMON/app/server.js" || fail "N5 driver retry patch missing"

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
# fnOS / Minisforum N5A F8NAB compatibility patch

- hwmonitor upstream: ${HWMONITOR_REF} (${HWMONITOR_TAG})
- N5 driver upstream: ${N5_DRIVER_REF}
- driver source blob: ${N5_DRIVER_SOURCE_SHA1}
- driver version: ${EXPECTED_DRIVER_VERSION}
- supported bundled kernels: ${SUPPORTED_KERNELS}
- package version: ${PACKAGE_VERSION}
- N5A/F8NAB: upstream experimental_write=1 on exact DMI
- future kernels: exact-kernel module may be downloaded from the GitHub kernel-modules channel and SHA256-verified
- remote lookup retries every 5 minutes only while the N5 driver is missing
- NVMe temperature: block device bound to matching nvme hwmon through sysfs device path
- storage fan safety floor: 77/255 in software curve mode

The kernel driver source is unmodified. No mismatched module is force-loaded.
EOF

log "building FPK"
(
  cd "$HWMON"
  bash ./build.sh
)

FPK="$HWMON/hwmonitor_${PACKAGE_VERSION}_x86.fpk"
[ -f "$FPK" ] || fail "FPK not produced"
cp "$FPK" "$DIST/"

VERIFY="$WORK/verify"
mkdir -p "$VERIFY/root" "$VERIFY/app"
tar -xzf "$FPK" -C "$VERIFY/root"
[ -f "$VERIFY/root/app.tgz" ] || fail "FPK app.tgz missing"
tar -xzf "$VERIFY/root/app.tgz" -C "$VERIFY/app"

for KERNEL in "${KERNELS[@]}"; do
  KO_NAME="minisforum_n5_it5571-$KERNEL.ko"
  PACKED_KO="$VERIFY/app/drivers/n5/$KO_NAME"
  [ -f "$PACKED_KO" ] || fail "target module missing from packed FPK: $KO_NAME"
  case "$(modinfo -F vermagic "$PACKED_KO")" in
    "$KERNEL"*) ;;
    *) fail "packed vermagic mismatch: $KO_NAME" ;;
  esac
  [ "$(modinfo -F version "$PACKED_KO")" = "$EXPECTED_DRIVER_VERSION" ] || fail "packed driver version mismatch: $KO_NAME"
done

grep -Fq "REMOTE_TAG = 'kernel-modules'" "$VERIFY/app/driverload.js" || fail "packed remote loader patch missing"
grep -Fq "experimental_write=1" "$VERIFY/app/driverload.js" || fail "packed N5A write gate missing"
grep -Fq "n5DriverRetry = setInterval" "$VERIFY/app/server.js" || fail "packed retry patch missing"
grep -Fq "storage fan safety floor" "$VERIFY/app/server.js" || fail "packed storage floor missing"

tar -czf "$DIST/hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" -C "$HWMON" \
  --exclude=.git \
  --exclude="hwmonitor_${PACKAGE_VERSION}_x86.fpk" \
  .

FPK_SHA="$(sha256sum "$DIST/hwmonitor_${PACKAGE_VERSION}_x86.fpk" | awk '{print $1}')"
SOURCE_SHA="$(sha256sum "$DIST/hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" | awk '{print $1}')"

cat > "$DIST/build-info.txt" <<EOF
hwmonitor_ref=$HWMONITOR_REF
hwmonitor_tag=$HWMONITOR_TAG
driver_ref=$N5_DRIVER_REF
driver_source_blob=$N5_DRIVER_SOURCE_SHA1
driver_version=$EXPECTED_DRIVER_VERSION
driver_srcversion=$EXPECTED_DRIVER_SRCVERSION
target_kernel=$TARGET_KERNEL
supported_kernels=$SUPPORTED_KERNELS
compiler=$(gcc --version | head -1)
n5a_f8nab_experimental_write=1
remote_driver_channel=kernel-modules
remote_driver_sha256_verify=1
remote_driver_retry_seconds=300
nvme_sysfs_bound=1
storage_curve_min_pwm=77
fpk_sha256=$FPK_SHA
source_sha256=$SOURCE_SHA
package_version=$PACKAGE_VERSION
EOF
cat "$MODULE_INFO" >> "$DIST/build-info.txt"

(
  cd "$DIST"
  sha256sum minisforum_n5_it5571-*.ko \
    "hwmonitor_${PACKAGE_VERSION}_x86.fpk" \
    "hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" \
    > SHA256SUMS
)

log "build complete"
cat "$DIST/build-info.txt"
