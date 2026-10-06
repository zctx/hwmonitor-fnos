#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source ./upstream.lock
WORK="$ROOT/.work"
DIST="$ROOT/dist"
rm -rf "$WORK" "$DIST"
mkdir -p "$WORK" "$DIST"
for c in git make modinfo python3 sha256sum tar node; do command -v "$c" >/dev/null; done
HWMON="$WORK/hwmonitor"
git clone --quiet "$HWMONITOR_REPO" "$HWMON"
git -C "$HWMON" checkout --quiet "$HWMONITOR_REF"
[ "$(git -C "$HWMON" rev-parse HEAD)" = "$HWMONITOR_REF" ]
mkdir -p "$HWMON/app/drivers/n5" "$HWMON/kernel"
# 删除上游 c938/0.1.0，仅打包本次配置与验证的 0.2.0 模块。
rm -f "$HWMON"/app/drivers/n5/*.ko
for k in $SUPPORTED_KERNELS; do
  out="$WORK/modules/$k"
  bash "$ROOT/scripts/build-driver-only.sh" "$k" "$out"
  cp "$out/minisforum_n5_it5571-$k.ko" "$HWMON/app/drivers/n5/"
  cp "$out/minisforum_n5_it5571-$k.ko" "$DIST/"
  cp "$out/driver-source.tar.gz" "$HWMON/kernel/"
done
cp /usr/share/common-licenses/GPL-2 "$HWMON/kernel/COPYING"
python3 scripts/patch-driverload.py "$HWMON/app/driverload.js"
python3 scripts/patch-app.py "$HWMON/app/server.js" "$HWMON/app/web/app.js"
python3 scripts/patch-lifecycle.py "$HWMON/app/server.js"
python3 scripts/driver_index.py policy "$HWMON/app"
export HWMON_TEST_KO="$HWMON/app/drivers/n5/minisforum_n5_it5571-${TARGET_KERNEL}.ko"
export HWMON_TEST_APP="$HWMON/app"
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
sed -i -E "s/^version[[:space:]]*=.*/version = ${PACKAGE_VERSION}/" "$HWMON/manifest"
sed -i -E "s/^VER=.*/VER=${PACKAGE_VERSION}/" "$HWMON/build.sh"
python3 - "$HWMON/app/package.json" "$PACKAGE_VERSION" <<'PY'
import json, sys
from pathlib import Path
p=Path(sys.argv[1]);d=json.loads(p.read_text());d['version']=sys.argv[2]
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
PY
(cd "$HWMON"; bash ./build.sh)
FPK="$HWMON/hwmonitor_${PACKAGE_VERSION}_x86.fpk"
python3 scripts/verify-package.py "$FPK"
cp "$FPK" "$DIST/"
# 完整源码含驱动 C 源文件归档、GPL 文本及生成此 FPK 的构建/测试覆盖层。
mkdir -p "$HWMON/adapter"
cp -a scripts overlay tests docs .github upstream.lock package.json "$HWMON/adapter/"
cp README.md "$HWMON/README-adapter.md"
cp -a .headers-info "$HWMON/adapter/headers-info"
find "$HWMON/adapter" -type d -name __pycache__ -prune -exec rm -rf {} +
tar -czf "$DIST/hwmonitor-fnos-${PACKAGE_VERSION}-source.tar.gz" -C "$HWMON" \
  --exclude=.git --exclude="hwmonitor_${PACKAGE_VERSION}_x86.fpk" .
{
  echo "adapter_commit=$(git rev-parse HEAD)"
  echo "package_version=$PACKAGE_VERSION"
  echo "target_kernel=$TARGET_KERNEL"
  echo "supported_kernels=$SUPPORTED_KERNELS"
  echo "hwmonitor_ref=$HWMONITOR_REF"
  echo "driver_ref=$N5_DRIVER_REF"
  echo "driver_version=$EXPECTED_DRIVER_VERSION"
  echo "driver_srcversion=$EXPECTED_DRIVER_SRCVERSION"
  echo "build_image=$BUILD_IMAGE"
  echo "header_metadata_ref=$HEADER_METADATA_REF"
  echo "remote_driver_channel=$DRIVER_CHANNEL"
  echo "remote_driver_retry_seconds=300"
  echo "storage_curve_min_pwm=77"
  echo "fpk_sha256=$(sha256sum "$FPK" | awk '{print $1}')"
} > "$DIST/build-info.txt"
(cd "$DIST"; sha256sum *.ko *.fpk *.tar.gz build-info.txt > SHA256SUMS)
cat "$DIST/build-info.txt"
