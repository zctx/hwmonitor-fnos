# hwmonitor-fnos

Minisforum N5 在 fnOS 上使用 `ltdstudio/hwmonitor` 的内核适配构建仓库。

本仓库不长期复制/分叉 hwmonitor 业务代码，而采用 **上游锁定 + 驱动覆盖 + 可复现打包**：

1. 固定 `ltdstudio/hwmonitor` v1.5.1 的 commit。
2. 固定 `ltdstudio/minisforum-n5-it5571` 驱动源码 commit。
3. 在与 fnOS `6.18.18.c1032-trim` 匹配的构建镜像内重新编译 `minisforum_n5_it5571.ko`。
4. 把新驱动加入 `app/drivers/n5/`，保留上游已有的 c938 驱动。
5. 本地修复版本提升为 `1.5.2`，重新生成 FPK。
6. CI 校验 `vermagic`、模块源码 hash、FPK 内容和 SHA256。

## 当前目标

- fnOS kernel: `6.18.18.c1032-trim`
- hwmonitor upstream: `v1.5.1`
- patched package version: `1.5.2`
- target: `x86_64`

## 构建产物

GitHub Actions 在 `main` 更新后自动构建：

- `hwmonitor_1.5.2_x86.fpk`
- `minisforum_n5_it5571-6.18.18.c1032-trim.ko`
- `hwmonitor-fnos-1.5.2-source.tar.gz`
- `SHA256SUMS`
- `build-info.txt`

## 维护方式

以后 fnOS 再升级内核时，优先只调整 `upstream.lock` / workflow 的目标内核与构建镜像，不修改 hwmonitor 的风扇控制业务逻辑。运行时继续使用上游的“内核版本精确匹配”安全门禁，禁止拿相近版本 `.ko` 冒充目标内核。

## 上游

- https://github.com/ltdstudio/hwmonitor
- https://github.com/ltdstudio/minisforum-n5-it5571

驱动源码及生成内核模块遵循上游 GPL-2.0 许可；hwmonitor 本体遵循其上游仓库许可。本仓库仅提供 fnOS 内核适配及构建自动化，不改变上游版权归属。
