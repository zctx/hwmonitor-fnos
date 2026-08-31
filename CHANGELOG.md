# Changelog

## 1.5.6 - N5A/F8NAB c1032 stable handoff

### 适配范围

- 机器：Minisforum N5A
- DMI：`product_name=N5A`，`board_name=F8NAB`
- fnOS kernel：`6.18.18.c1032-trim`
- hwmonitor upstream：`v1.5.1`
- N5 driver upstream：`0.2.0`

### 修复

- 保持上游 0.2.0 驱动源码不变，仅在 N5A/F8NAB 上通过加载参数启用 `experimental_write=1`。
- 修复多 NVMe 机器温度映射错误：按 sysfs device 路径绑定 `/sys/block/nvmeXnY/device` 与 `/sys/class/hwmon/hwmonX/device`。
- 同一块 NVMe 多传感器时，风扇控制温度取最高传感器值，避免 Composite 偏低导致存储风扇转速偏低。
- 修复两个 `spd5118/temp1` 温度源 ID 冲突，重名 chip 会追加 `hwmonX` 形成唯一 ID。
- 将 `spd5118` 归类为 `memory`，避免因 PCI 路径误归类为 `pcie`。
- 将 N5 EC 的 `CPU Temp` 归类为 `cpu`，`System/Board/Ambient` 归类为 `board`。
- HDD/SATA 温度无法实时读取但有上次读数时，标记 `cached/stale`，UI 追加“缓存”。
- SSD/HDD 软件曲线最低 PWM 限制为 `77/255`，约 30%，防止存储风扇被异常温度源打到 0%。
- UI 显示服务端实际 `autoSource`，不再把非 CPU 风扇误显示为主板温度。

### 已验证

- `version=1.5.6`。
- `nvme0n1 -> hwmon3`，`nvme1n1 -> hwmon5`，`nvme2n1 -> hwmon6`，`nvme3n1 -> hwmon4`。
- `fan1 -> CPU Tctl`。
- `fan2 -> SSD/NVMe`，PWM 不低于 `77/255`。
- `fan3 -> HDD`，PWM 不低于 `77/255`。
- `fan4 -> PCIe/NIC`。
- `spd5118` 两路内存温度 ID 已唯一，且归类为 `memory`。

### 已知说明

- NVMe 卡片温度使用“该盘最高传感器温度”，可能高于 fnOS 资源管理中显示的 Composite 温度。该选择偏向风扇控制安全性。
- 上游 0.2.0 对 N5A/F8NAB 的 PWM 写控制仍标记为 experimental。本适配包只在精确 DMI 匹配时启用该上游预留参数。
- 首次使用手动或曲线控制时，应观察风扇 RPM 与温度变化；异常时切回 BIOS 默认。

### 构建产物

- `hwmonitor_1.5.6_x86.fpk`
- `minisforum_n5_it5571-6.18.18.c1032-trim.ko`
- `hwmonitor-fnos-1.5.6-source.tar.gz`
- `SHA256SUMS`
- `build-info.txt`

### SHA256

- `hwmonitor_1.5.6_x86.fpk`: `73a7a0029efe9387b55c3e881a438781c0d8f4b624a87d8156c6075ac45c570c`
