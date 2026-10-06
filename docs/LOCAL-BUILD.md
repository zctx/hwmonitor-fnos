# 1.5.9 本机精确内核编译

## 目标和范围

借鉴预编译优先、本机编译兜底的部署思路，不复制第三方修改过的驱动，也不使用其 apt/chroot/全局模块安装逻辑。只增加一个可独立测试的 `n5-local-build.js`，接入 1.5.8 现有校验器和异步生命周期。驱动 C、温控算法和 UI 不变。

## 路径

`内置精确模块 → 本机缓存 → 本机编译 → 远程缓存/下载 → 拒绝加载`。已加载且健康的同身份模块优先复用。

本机编译默认开启，独立于远程开关。FPK 内置了锁定 driver commit 的 Makefile/C 文件及 GPL 文本，`n5-driver-policy.json.local_build.files` 保存两个编译输入的 SHA256。生成策略时还核对 C 源码的 Git blob 与 upstream.lock 一致。

编译前寻找 `/lib/modules/<uname -r>/build`，仅该路径不存在时尝试 `/usr/src/linux-headers-<uname -r>`。若首选构建树存在但版本/权限有问题，不偷偷换另一棵树。要求 Makefile、非空 Module.symvers、kernel.release、auto.conf、autoconf.h、utsrelease.h 和 scripts/Makefile.build。release 与 UTS_RELEASE 必须一致，配置必须支持 x86_64/GCC/modules。优先选择现有 gcc-<major>，然后检查普通 gcc；数字版本必须与 CONFIG_GCC_VERSION 一致，不自动换装编译器。

检查实际路径/关键文件的 root 所有权及不可由组/其他用户写入的权限；允许系统正常的 /lib 和 build 符号链接。源码和输出不允许符号链接。宿主 Kbuild 与工具链仍属于受信输入，不声称抵抗已被篡改的宿主系统。

使用随机 root 私有工作目录，固定最小环境变量，调用 `make -j2 -C <exact-tree> M=<work> CC=<existing-gcc> HOSTCC=<existing-gcc> LD=<existing-ld> modules`。不经过 shell 拼接，不继承 MAKEFLAGS、CC、LD_PRELOAD 等用户环境。make 最多 120 秒，输出最多 256 KiB；超时/取消杀死整个进程组并清理工作目录。

生成的模块进入 1.5.8 同一验证器：大小、ELF、name、vermagic、version、srcversion、experimental_write 参数全部检查，通过后才原子缓存。加载后继续检查 hwmon/PWM 节点。计算新模块摘要用于以后缓存复核，不冒称预先知道本机产物哈希或具备签名认证。

本机缓存和远程缓存分目录，避免相互覆盖。每次加载本机缓存都核对源码哈希、驱动策略、文件哈希和真实 modinfo；缓存命中无需 headers/GCC 仍在。每个服务生命周期仅尝试一次本机编译；修复缺失工具或 headers 后重启应用即可再次尝试。远程重试不重复启动 make。

## 开关与诊断

`HWMON_N5_LOCAL_BUILD=0` 禁用本机路径及其缓存；`HWMON_N5_REMOTE_DRIVER=0` 禁用远程路径及其缓存。两者可以独立使用，同时关闭才恢复仅内置模式。

`GET /api/stats` 的 `n5_driver.source` 为 `bundled`、`local-build`、`local-cache`、`remote` 或 `cache`；已加载复用状态为 `already-loaded`，此时不伪造来源。`n5_driver.local_build` 报告启用状态、结果和失败原因。实际进入 make 后，最近一次编译日志保存在 `/var/cache/hwmonitor-fnos/n5/local/local-build.log`。预检查失败原因写入应用日志/API，不一定生成编译日志文件。

不建议为测试本机编译而删除正在使用的驱动或内置文件。现有 c1032/c1126 命中内置模块时不需要 make，这是正确行为。

## 验证

新增单元覆盖：源码篡改、错误/缺失 headers、版本不符、缺工具、权限异常、成功编译、日志上限、超时及子进程清理、取消、缓存篡改、重复请求、独立开关和远程回退。保留 1.5.8 原有回归。

`validation/local-build.cjs` 在 CI 对真实 c1032/c1126 headers 执行生产编译器逻辑，使用真实 modinfo，检查事件循环持续运行、零网络和新加载器离线缓存复用。仅测试实例清空 bundled 列表以覆盖该路径，实际 FPK 内置策略不变。insmod 和硬件节点为测试桩；NAS 安装和物理风扇响应仍须实机验收。

Linux Kbuild 参考：https://docs.kernel.org/kbuild/modules.html
