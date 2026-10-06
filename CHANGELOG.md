# Changelog

## 1.5.10 — 修复 fnOS 实机应用目录权限误判

- 修复 1.5.9 本机编译在 fnOS `/volX/@appcenter/<app>` 的 group-write/ACL 安装权限下被提前拒绝。
- 随包源码改为 appDir 固定边界 + 非 symlink + 实际字节 SHA256 校验，不再要求应用目录必须 0755/不可 group-write。
- 宿主 kernel build tree、headers、GCC/ld、root 私有缓存的严格权限检查保持不变。
- 新增 fnOS 0775/0664 应用树回归，源码篡改/symlink 拒绝测试继续保留。
- N5 驱动源码、温度映射、风扇曲线、UI 和远程通道均不修改。
- 触发问题的实机为 `6.18.18.c1107-trim`，具备完整 build tree、Module.symvers、GCC 12.2.0 和 kmod 30；1.5.9 在 make 前失败，因此本修正专门针对部署权限兼容性。

## 1.5.8 — 1.5.7 安全与可靠性复核

- 修正首次远程下载 `.ko.tmp` 无法被 modinfo 识别。
- 新增随包策略与缓存回执，每次加载校验 SHA256、ELF、元信息及节点；远程关闭时不加载远程缓存。
- 驱动缓存改为受 root 保护的目录，拒绝符号链接与不可信写权限。
- 网络/模块命令异步化，下载限定 HTTPS GitHub 主机、大小与总超时；单次任务重试、停止取消、延迟加载后的 BIOS 模式对齐。
- 新增 v2 驱动通道；发现全部缺失内核，不因读取失败清空索引；只读编译与发布作业隔离、序列化发布及不可变模块。
- headers 强制 SHA256/精确包名/架构验证，metadata commit 与构建镜像固定。
- 增加 31 项 Node 与 30 项 Python 测试，以及真实 .ko 元信息与成品反向验证。没有真实加载测试机内核模块。
- 完整源码交付包含对应驱动 C 源码归档；保留上游归属。
- 不改驱动 C 源码、已有温度算法和 UI。不能把 CI 通过等同于 NAS 实机验收。

详情见 [1.5.7 审查记录](docs/REVIEW-1.5.7.md)。

## 1.5.7 - c1126 support and exact-kernel self-update channel

### 新增

- 新增 fnOS `6.18.18.c1126-trim` 的精确 N5A/F8NAB 驱动模块。
- 1.5.7 同时内置 c1032 与 c1126 模块，运行时仍按 `uname -r` 精确选择。
- 新增滚动 `kernel-modules` Release 通道。定时 CI 自动发现新的 `6.18.18.cNNNN-trim` 构建环境并编译对应模块。
- 当未来内核没有内置模块时，应用可自动下载精确内核模块并缓存；驱动缺失时每 5 分钟重试。
- 远程模块加载前强制验证 SHA256、`vermagic`、driver version=`0.2.0`、`srcversion=96E49785C432E4B85FAF416` 与 `experimental_write` 参数。
- 可用 `HWMON_N5_REMOTE_DRIVER=0` 完全关闭远程驱动获取。

### 安全策略

- 不使用 `--force-vermagic`，不加载“相近版本”内核模块。
- 自动通道仅接受 `6.18.18.cNNNN-trim`；大版本内核变化会失败关闭，需要人工确认兼容性。
- N5A/F8NAB 仍仅在精确 DMI 匹配后传入上游 `experimental_write=1`。
- 找不到正确模块时保持无自定义 PWM 驱动状态，由 BIOS/EC 默认控制风扇。

### 保留

- 1.5.6 的 NVMe 精确 sysfs 映射、最高温度控制源、SPD5118 唯一 ID / memory 分组、HDD cached/stale、真实 autoSource、SSD/HDD 77/255 安全下限均保留。

### 构建验证

- c1032 与 c1126 均使用对应 fnOS headers 编译。
- CI 校验每个模块的 `vermagic`、version、srcversion 和模块参数。
- 最终 FPK 反向解包后再次校验所有内置模块和应用补丁。
- patched Node.js 文件执行语法检查。

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