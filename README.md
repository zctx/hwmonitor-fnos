# hwmonitor-fnos

Minisforum N5 系列在 fnOS 上使用 `ltdstudio/hwmonitor` 的内核适配构建仓库。

本仓库采用 **上游锁定 + 驱动覆盖 + 应用层窄补丁 + 可复现打包**，避免长期分叉 hwmonitor 业务代码。

## 当前适配

- 机器：Minisforum N5A
- DMI：`product_name=N5A`，`board_name=F8NAB`
- fnOS kernel：`6.18.18.c1032-trim`
- hwmonitor upstream：`v1.5.1`
- N5 driver upstream：`0.2.0`
- patched package：`1.5.6`
- 发布说明：[`releases/v1.5.6.md`](releases/v1.5.6.md)
- 变更日志：[`CHANGELOG.md`](CHANGELOG.md)

## 为什么必须使用 0.2.0

官方 hwmonitor v1.5.1 原有 c938 模块对应 0.1.0 驱动，但该版本只支持 `N5/F8NAA`，在 `N5A/F8NAB` 上会 `-ENODEV`，无法注册 hwmon 设备。

0.2.0 增加了 `N5A/F8NAB` DMI profile，因此能够正确读取温度和风扇 RPM；但上游将该 profile 标记为实验机型，默认只读，并隐藏 PWM 节点。

上游 0.2.0 已提供 `experimental_write=1` 模块参数，用于在确认温度/RPM 数据合理后显式开启实验 PWM 写控制。

## 1.5.6 做了什么

1. 驱动源码保持上游 `0.2.0` 原样，不修改其 EC/PWM 控制实现。
2. 针对 fnOS `6.18.18.c1032-trim` 重新编译 `.ko`。
3. hwmonitor 加载器仅在 DMI 精确匹配 `product_name=N5A|N5 AIR` 且 `board_name=F8NAB` 时追加 `experimental_write=1`。
4. NVMe 温度按 sysfs 设备路径绑定：`/sys/block/nvmeXnY/device` 对应 `/sys/class/hwmon/hwmonX/device`，多 NVMe 机器不再拿第一个 nvme hwmon 充数。
5. 同一块 NVMe 多温度传感器取最高值，避免 Composite 偏低导致存储风扇转速偏低。
6. `temp_sources` 对重名 chip 生成唯一 ID，例如两个 `spd5118/temp1` 会区分为不同 `hwmonX`。
7. `spd5118` 归类为 `memory`，不再因 PCI 路径被误归到 `pcie`。
8. N5 EC 的 `CPU Temp` 归类为 `cpu`，`System/Board/Ambient` 归类为 `board`。
9. HDD/SATA 温度在无法实时读取但存在上次读数时标记为 `cached/stale`，UI 标签追加“缓存”，不再把缓存值伪装成实时值。
10. SSD/HDD 风扇软件曲线最低输出限制为 `77/255`，约 30%，避免存储风扇被温度源异常打到 0%。
11. UI 显示服务端实际选中的 `autoSource`，避免非 CPU 风扇显示成主板温度。

## 固定版本

- hwmonitor commit: `506ab0d316a2932e071f8102c2e7064b0b84feb5`
- driver commit: `e47545166ac93e3c5769dcaef75ee6ec4dd5d95d`
- driver source blob: `28484eba79bac7b5e65efa85cc48f27a87d5637e`
- driver version: `0.2.0`
- driver srcversion: `96E49785C432E4B85FAF416`

## 构建产物

GitHub Actions 在 `main` 更新后自动构建：

- `hwmonitor_1.5.6_x86.fpk`
- `minisforum_n5_it5571-6.18.18.c1032-trim.ko`
- `hwmonitor-fnos-1.5.6-source.tar.gz`
- `SHA256SUMS`
- `build-info.txt`

## 安全说明

`N5A/F8NAB` 的 PWM 写控制在上游驱动中仍被标记为 experimental。本仓库只是在已确认该机器温度/RPM 读取正常后使用上游预留的 `experimental_write=1` 开关，并没有把实验 profile 改成 validated。

首次启用手动或曲线控制时应观察风扇 RPM 和温度变化；若出现通道对应错误、风扇停转或温度异常，应立即切回 BIOS 自动控制并卸载模块。

## 上游

- https://github.com/ltdstudio/hwmonitor
- https://github.com/ltdstudio/minisforum-n5-it5571

驱动源码及生成内核模块遵循上游 GPL-2.0 许可；本仓库仅提供 fnOS 内核适配及构建自动化，不改变上游版权归属。
