# hwmonitor-fnos

Minisforum N5 系列在 fnOS 上使用 `ltdstudio/hwmonitor` 的社区适配构建仓库。不是飞牛或 Minisforum 官方软件。

当前源码版本 **1.5.8**：修正 1.5.7 的驱动首次远程加载、缓存校验与异步生命周期问题。内核驱动源码仍锁定 **0.2.0**；不改已有温度曲线算法。

[审查记录](docs/REVIEW-1.5.7.md) · [变更日志](CHANGELOG.md)

## 适配范围

FPK 内置 `6.18.18.c1032-trim` 和 `6.18.18.c1126-trim` 的独立模块，按运行内核精确选择。N5A / N5 AIR + F8NAB 继续使用上游 `experimental_write=1` 参数；其他机型不扩大写权限。

安装前先执行 `uname -r` 确认实际版本。CI 检验不代替 NAS 实测，首次启用曲线控制需要观察 RPM 与温度。

## 后续内核更新

1. 优先使用随包策略记录的内置模块，每次验证完整性和元信息。
2. 未内置的同系列内核从独立 `kernel-modules-v2` 通道获取精确模块，验证后缓存。
3. 缓存位于 `/var/cache/hwmonitor-fnos/n5`，只允许 root 所有且不可被普通用户写入。每次加载均重新校验。
4. 网络请求和 kmod 子进程异步执行。可重试的缺失/网络失败在上一轮完成后 5 分钟重试；退出时取消；已存在但不健康的模块不会被强行替换。
5. CI 发现 c1032 起同系列的全部缺失内核，固定该次元数据提交，隔离只读编译与写入发布。模块先上传、索引最后更新；不覆盖已发布内核二进制。

这减少人工重新打包，不是“一份驱动兼容所有内核”。依赖对应 headers、固定驱动兼容性、GitHub 可访问及 CI 持续运行。新基础内核版本需要人工适配。

设置 `HWMON_N5_REMOTE_DRIVER=0` 可禁用远程下载与远程缓存加载，仅使用内置模块。

## 保留功能与限制

保留多 NVMe sysfs 精确映射、该盘最高传感器作为控制温度、SPD5118 内存分组、CPU/board 分类、HDD cached/stale 字段、真实 autoSource 与 SSD/HDD 软件曲线 77/255 下限。最高传感器温度可能不同于 fnOS 显示的 Composite。

下限不保证任意风扇必定起转，PWM 写入在上游仍是 experimental。不要同时运行多个软件控制同一风扇；异常时切回 BIOS 默认并检查日志。

HTTPS + SHA256 依赖本仓库发布权限可信，并非独立签名；GitHub 权限失陷不在当前信任模型的防护范围。旧 1.5.7 客户端的远程通道不再扩展，建议更新。

## 构建

所有版本入口在 `upstream.lock`。使用其中 digest 固定的镜像，先为 `SUPPORTED_KERNELS` 安装对应头文件，再运行：

```bash
bash scripts/build.sh
```

构建会运行 Node/Python 回归测试并反向解包验证 FPK。`dist` 包含 FPK、各内核模块、完整源码归档、SHA256SUMS 和 build-info。完整源码归档另含驱动 C 源码与适配覆盖层；上游引用保持可追溯。

- app：`ltdstudio/hwmonitor`，commit `506ab0d316a2932e071f8102c2e7064b0b84feb5`
- driver：`ltdstudio/minisforum-n5-it5571`，commit `e47545166ac93e3c5769dcaef75ee6ec4dd5d95d`

遵循各上游许可，驱动为 GPL-2.0-only，不改变作者归属。
