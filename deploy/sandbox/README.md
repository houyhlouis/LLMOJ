# LibreOJ 原版评测沙盒

本项目使用 [LibreOJ/LibreOJ](https://github.com/LibreOJ/LibreOJ) 原版 `infra/sandbox-rootfs` 构建配方，保持该目录与仓库上游版本一致。评测进程和 AI 生成程序继续通过 `simple-sandbox` 执行，共享已有队列、资源限制和安全修复。

## 准备与构建

`build.sh` 默认仅显示配方 ID 和目标路径，不下载镜像、不挂载文件系统、不启动服务。构建需要支持 BuildKit 的 Docker/buildx、Git、Bash、gzip 和 SHA-256 工具；暂存验证需要 root、Linux `chroot`/挂载权限以及支持 amd64、32 位程序的宿主机内核。默认完整验证还要求 x32 内核支持；不支持 x32 的宿主机必须显式选择下述验证配置。

```bash
cd /opt/LibreOJ
bash deploy/sandbox/build.sh plan
bash deploy/sandbox/build.sh build
# 使用上一命令输出的 ARCHIVE 绝对路径：
sudo bash deploy/sandbox/build.sh stage /opt/LibreOJ/runtime/sandbox-archives/rootfs-实际ROOTFS_ID.tar.gz
# 仅当宿主机明确不支持执行 x32 程序：
sudo env LIBREOJ_X32_SUPPORTED=0 bash deploy/sandbox/build.sh stage /opt/LibreOJ/runtime/sandbox-archives/rootfs-实际ROOTFS_ID.tar.gz
```

构建脚本直接调用上游 `infra/sandbox-rootfs/build.sh`；基底镜像、下载包及 testlib 由上游配方固定 digest/checksum，APT 使用固定日期快照。配方内容生成 `ROOTFS_ID`，归档另带 SHA-256 文件。归档使用 gzip 的快速压缩级别，并向标准错误显示已处理字节数和速率；压缩级别不参与 `ROOTFS_ID`，归档格式和校验规则保持不变。固定来源提高可复现性，但不承诺 Docker 导出归档在不同构建器上逐字节一致。

暂存脚本直接调用上游 `stage.sh`，校验归档散列、内嵌 ID、设备节点和 sandbox UID，执行上游完整语言 smoke test，卸载验证挂载后安装到 `runtime/rootfs-<ID>`，再创建 `runtime/sandbox-rootfs` 符号链接和 `runtime/rootfs-id` 构建元数据。已有目标不会被覆盖。构建和暂存命令均不启动 judge 或任何服务。

默认使用 `infra/sandbox-rootfs/stage.sh`。两种暂存入口都显式设置验证目录的权限，保证安装器使用 `umask 0077` 时 UID 999 仍可读取只读挂载的校验脚本，且不能写入该目录。显式设置 `LIBREOJ_X32_SUPPORTED=0` 时使用 `stage-host.sh`/`smoke-test-host.sh`：仅跳过 x32 二进制的执行，仍编译 x32，并保留全部 amd64/i386、语言版本、testlib 和归档完整性验证。该选择不改变上游配方、镜像或内嵌 `ROOTFS_ID`。

Judge 配置使用：

```yaml
sandbox:
  rootfs: /opt/LibreOJ/runtime/sandbox-rootfs
  rootfsId: 此处填入build.sh输出的64位十六进制ROOTFS_ID
  user: sandbox
  resourceMode: default
  environments:
    PATH: /usr/local/bin:/usr/bin:/bin
    HOME: /tmp
    LC_ALL: en_US.UTF-8
    PYTHONDONTWRITEBYTECODE: "1"
```

`resourceMode: default` 使用既有 cgroup 资源控制。`rootfsId` 从镜像内 `/etc/libreoj-rootfs-id` 校验；不需要外置 ID 文件。服务启用和运行目录创建属于实际部署步骤。

## 语言能力

默认提交选项恢复原版 12 种语言：C++、C、Java、Kotlin、Pascal、Python、Rust、Swift、Go、Haskell、C# 和 F#。配方预期版本及路径见 `languages.json`；构建/暂存必须通过上游 smoke test 后才能视为安装成功。

GCC/Clang 通过 `/usr/local/bin` 中的原版链接调用。Python 使用原版 2.7、3.9、3.10 路径，前后端选项一致。C/C++ 标准、编译器、优化和 32 位选项与原版配方相符。本部署前后端默认只开放 amd64/i386（`64`/`32`），不会接受不受本机支持的 x32 提交；在明确支持 x32 并完成完整暂存验证的部署中，可同步扩展后端 C/C++ 校验和前端架构选项。保留通信题额外源文件链接、Python 栈限制、Go 并行限制以及 .NET 编译资源限制修复。

此前新增的 Ruby、Perl、Bash、Awk、bc、汇编、Emacs Lisp、sed、dc 适配器源码保留，但默认不注册、不接受对应提交选项。其中部分工具是构建依赖，其他解释器没有被原版配方显式安装或验证；启用这些语言需要独立定制配方并同步后端、前端和 judge 能力清单。

## 许可与分发

LibreOJ 项目代码按根目录 `LICENSE` 的 MIT 条款使用；`infra/sandbox-rootfs/LICENSE` 将该目录的配方与辅助脚本按 Unlicense 授权。保留这些许可文本。

生成的 rootfs 是第三方软件集合，其许可不会统一变为 MIT 或 Unlicense。Ubuntu 软件包、GCC/LLVM、Java、Python、Go、Rust、Swift、Kotlin、GHC、.NET/Mono 和 testlib 各自适用原许可。仓库发布只包含构建配方和适配源码，不包含构建后的 rootfs/二进制归档。若后续分发镜像，应保留其中的版权/许可材料，并逐组件落实适用的源码提供与其他分发义务；具体来源已经固定在上游 Dockerfile。

## 验证

部署前执行 `infra/sandbox-rootfs` 自带的构建与暂存 smoke test，并通过项目类型检查、原生沙盒测试、竞赛语言选项一致性测试和 grader/AI 回归。Judge 服务的正式运行验证须在实际部署并明确启动服务后完成。
