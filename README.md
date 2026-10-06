# hwmonitor-fnos

Minisforum N5 系列在 fnOS 上使用 `ltdstudio/hwmonitor` 的社区适配构建仓库。不是飞牛或 Minisforum 官方软件。

当前稳定版本 **1.5.10**：修复 1.5.9 在 fnOS 实机安装目录下因 group-write/ACL 被误判为“不可信源码路径”，并已在 N5A / `6.18.18.c1107-trim` 上完成真实本机 Kbuild、模块加载、hwmon/PWM 节点与风扇 RPM 验收。驱动 C 源码仍锁定上游 **0.2.0**；温度映射、风扇曲线和 UI 不变。

[1.5.10 说明](releases/v1.5.10.md) · [本机编译设计](docs/LOCAL-BUILD.md) · [1.5.7 审查](docs/REVIEW-1.5.7.md) · [历史变更](CHANGELOG.md)

## 适配范围

FPK 内置 `6.18.18.c1032-trim` 和 `6.18.18.c1126-trim` 的独立模块，按运行内核精确选择。自动适配限定为 x86_64 的 `6.18.18.cNNNN-trim` 系列，不猜测新的基础内核兼容性。N5A / N5 AIR + F8NAB 继续使用上游 `experimental_write=1`；其他机型不扩大写权限。

安装前先执行 `uname -r`。1.5.10 已在 N5A / F8NAB、`6.18.18.c1107-trim` 实机验证本机编译与实际加载；其他内核/机型首次启用曲线控制仍应观察 RPM 与温度。

## 驱动选择顺序

1. 已加载且通过身份/节点健康检查的驱动直接复用，不抢占其他程序。
2. 使用随包策略记录的内置精确模块。
3. 复用经再次校验的本机编译缓存；不存在时，用本机已有的精确构建树和匹配 GCC 编译随包源码。
4. 本机编译不可用或失败，再使用已验证的远程缓存 / `kernel-modules-v2` 精确模块。
5. 都不可用则拒绝加载，不强制修改 vermagic，不开放 N5 PWM 写入。

本机编译不运行 apt，不联网下载源码或 headers，不运行 `modules_install`、`depmod`、`chroot`，不修改 `/etc/modules-load.d` 或 `/lib/modules`。产物保存在 `/var/cache/hwmonitor-fnos/n5/local`，仍由 hwmonitor 服务自己加载。

本机需要完整构建树，而不只是一个 headers 目录：检查 release、生成配置、Module.symvers、Kbuild 脚本和现有 GCC 版本。缺失或不匹配时自动回退，不替用户安装工具。make 阶段最多 120 秒、并行度 2；停止应用会取消编译进程组；每次服务启动最多尝试一次，防止每五分钟反复编译。

远程失败仍按 1.5.8 的规则在上一轮完成后五分钟重试。正常冷启动缺驱动时依赖 BIOS/EC 默认控制，并非任意异常下都保证硬件兜底。

## 独立开关

- `HWMON_N5_LOCAL_BUILD=0`：禁用本机编译及本机编译缓存。
- `HWMON_N5_REMOTE_DRIVER=0`：禁用远程下载及远程缓存；仍可本机编译。
- 两者同时为 0：仅允许内置模块或已加载且健康的驱动。

## 保留功能与边界

保留 NVMe 精确 sysfs 映射、该盘最高传感器作为控制温度、SPD5118 内存分组、CPU/board 分类、HDD cached/stale、真实 autoSource 和 SSD/HDD 软件曲线 77/255 下限。该下限不保证任意风扇必定起转；N5A 写入仍属于上游 experimental profile。不要同时用多个程序控制相同风扇。

本机编译信任 root 管理的宿主工具链和内核构建树，不是安全沙箱。宿主 headers/GCC/ld/cache 仍要求 root 所有且不可被 group/other 写入。fnOS 的应用安装目录可能按平台规则带 group-write/ACL，因此随包驱动源码不再套用宿主目录权限规则，而是限定在 appDir 内、拒绝 symlink，并对实际读入字节执行随包 SHA256 校验。本机新产物的 SHA256 在编译后计算并用于缓存完整性校验，不是独立签名。远程方案仍信任固定仓库的 HTTPS 发布权限。

## 构建与验证

版本和源码入口在 `upstream.lock`。在锁定镜像内准备对应 headers 后执行 `bash scripts/build.sh`。流水线运行 Node/Python 回归，并调用真实 GCC/Kbuild/modinfo 验证 c1032/c1126 的本机编译路径；insmod/hwmon 用测试桩，绝不在 CI 控制真实风扇。最终反向解包验证 FPK、版本、源码策略、模块及 UI 保留项。

- app commit：`506ab0d316a2932e071f8102c2e7064b0b84feb5`
- driver commit：`e47545166ac93e3c5769dcaef75ee6ec4dd5d95d`

完整工程归档含驱动源码、许可、覆盖层和测试。遵循各上游许可，驱动为 GPL-2.0-only，不改变作者归属。


## 1.5.10 实机验收

已在 N5A / F8NAB、fnOS `6.18.18.c1107-trim` 实机确认：

- `source=local-build`，使用 `/usr/src/linux-headers-6.18.18.c1107-trim` 和 GCC 12.2.0 完成 Kbuild；
- 驱动 `version=0.2.0`、`srcversion=96E49785C432E4B85FAF416`、`experimental_write=Y`；
- hwmon 温度、fan1-3 RPM、pwm1-4 / pwm_enable 节点完整；
- 实测风扇 RPM 均非零，HDD 软件曲线下限 `pwm3=77` 生效；
- 应用 API 返回 `controller=OK`，整体验收结果 `FINAL: PASS`。

该验收覆盖了 1.5.10 最关键的新路径：未内置的 c1107 → 使用本机现有精确 headers 自动编译 → 严格模块身份校验 → 实际 insmod/probe → hwmon/PWM 正常。
