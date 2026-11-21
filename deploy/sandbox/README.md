# LibreOJ 原版评测沙盒

简体中文 | [English](#the-original-libreoj-judging-sandbox)

本项目使用 [LibreOJ/LibreOJ](https://github.com/LibreOJ/LibreOJ) 原版 `infra/sandbox-rootfs` 构建配方，保持该目录与仓库上游版本一致。arm64（AArch64）服务器使用 `infra/sandbox-rootfs/arm64/` 中的配方：同样的编译器、版本和 Ubuntu 软件包快照，换用 arm64 的软件包和下载，没有 32 位与 x32 工具链（见 [ARM64 服务器](../../wiki/ARM64.zh-CN.md)）。评测进程和 AI 生成程序继续通过 `simple-sandbox` 执行，共享已有队列、资源限制和安全修复。

## 准备与构建

`build.sh` 默认仅显示配方 ID 和目标路径，不下载镜像、不挂载文件系统、不启动服务。构建需要支持 BuildKit 的 Docker/buildx、Git、Bash、gzip 和 SHA-256 工具；暂存验证需要 root、Linux `chroot`/挂载权限，以及与镜像架构相同的宿主机：amd64 镜像还需要支持 32 位程序的内核，默认完整验证另要求 x32 内核支持，不支持 x32 的宿主机必须显式选择下述验证配置。脚本默认使用本机架构的配方；`ROOTFS_ARCHITECTURE=amd64|arm64` 可指定另一种架构来显示计划或构建（构建另一种架构需要 Docker 的 QEMU 用户态模拟），暂存则只接受本机架构的镜像。

```bash
cd /opt/LLMOJ
bash deploy/sandbox/build.sh plan
bash deploy/sandbox/build.sh build
# 使用上一命令输出的 ARCHIVE 绝对路径：
sudo bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-实际ROOTFS_ID.tar.gz
# 仅当宿主机明确不支持执行 x32 程序：
sudo env LIBREOJ_X32_SUPPORTED=0 bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-实际ROOTFS_ID.tar.gz
```

构建脚本直接调用上游 `infra/sandbox-rootfs/build.sh`；基底镜像、下载包及 testlib 由上游配方固定 digest/checksum，APT 使用固定日期快照。配方内容生成 `ROOTFS_ID`，归档另带 SHA-256 文件。归档使用 gzip 的快速压缩级别，并向标准错误显示已处理字节数和速率；压缩级别不参与 `ROOTFS_ID`，归档格式和校验规则保持不变。固定来源提高可复现性，但不承诺 Docker 导出归档在不同构建器上逐字节一致。

暂存脚本直接调用上游 `stage.sh`，校验归档散列、内嵌 ID、设备节点和 sandbox UID，执行上游完整语言 smoke test，卸载验证挂载后安装到 `runtime/rootfs-<ID>`，再创建 `runtime/sandbox-rootfs` 符号链接和 `runtime/rootfs-id` 构建元数据。已有目标不会被覆盖。构建和暂存命令均不启动 judge 或任何服务。

默认使用 `infra/sandbox-rootfs/stage.sh`。arm64 镜像总是使用 `stage-host.sh` 与 `infra/sandbox-rootfs/arm64/smoke-test.sh`（没有需要跳过的 x32 检查）。两种暂存入口都显式设置验证目录的权限，保证安装器使用 `umask 0077` 时 UID 999 仍可读取只读挂载的校验脚本，且不能写入该目录。显式设置 `LIBREOJ_X32_SUPPORTED=0` 时使用 `stage-host.sh`/`smoke-test-host.sh`：仅跳过 x32 二进制的执行，仍编译 x32，并保留全部 amd64/i386、语言版本、testlib 和归档完整性验证。该选择不改变上游配方、镜像或内嵌 `ROOTFS_ID`。

Judge 配置使用：

```yaml
sandbox:
  rootfs: /opt/LLMOJ/runtime/sandbox-rootfs
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

默认提交选项恢复原版 12 种语言：C++、C、Java、Kotlin、Pascal、Python、Rust、Swift、Go、Haskell、C# 和 F#。配方预期版本及路径见 `languages.json`（C/C++ 的 `architectures` 为 amd64 的选项，`arm64Architectures` 为 arm64 的选项）；构建/暂存必须通过上游 smoke test 后才能视为安装成功。

GCC/Clang 通过 `/usr/local/bin` 中的原版链接调用。Python 使用原版 2.7、3.9、3.10 路径，前后端选项一致。C/C++ 标准、编译器、优化和 32 位选项与原版配方相符。本部署前后端默认只开放 amd64/i386（`64`/`32`）；arm64 评测机只编译 `64`（AArch64，附加 `-march=native -fsigned-char`），32 位提交以编译错误结束，网站的评测机都不能编译 32 位时前端不显示该选项；不会接受不受本机支持的 x32 提交；在明确支持 x32 并完成完整暂存验证的部署中，可同步扩展后端 C/C++ 校验和前端架构选项。保留通信题额外源文件链接、Python 栈限制、Go 并行限制以及 .NET 编译资源限制修复。

此前新增的 Ruby、Perl、Bash、Awk、bc、汇编、Emacs Lisp、sed、dc 适配器源码保留，但默认不注册、不接受对应提交选项。其中部分工具是构建依赖，其他解释器没有被原版配方显式安装或验证；启用这些语言需要独立定制配方并同步后端、前端和 judge 能力清单。

## 许可与分发

LibreOJ 项目代码按根目录 `LICENSE` 的 MIT 条款使用；`infra/sandbox-rootfs/LICENSE` 将该目录的配方与辅助脚本按 Unlicense 授权。保留这些许可文本。

生成的 rootfs 是第三方软件集合，其许可不会统一变为 MIT 或 Unlicense。Ubuntu 软件包、GCC/LLVM、Java、Python、Go、Rust、Swift、Kotlin、GHC、.NET/Mono 和 testlib 各自适用原许可。仓库发布只包含构建配方和适配源码，不包含构建后的 rootfs/二进制归档。若后续分发镜像，应保留其中的版权/许可材料，并逐组件落实适用的源码提供与其他分发义务；具体来源已经固定在上游 Dockerfile。

## 验证

部署前执行 `infra/sandbox-rootfs` 自带的构建与暂存 smoke test，并通过项目类型检查、原生沙盒测试、竞赛语言选项一致性测试和 grader/AI 回归。Judge 服务的正式运行验证须在实际部署并明确启动服务后完成。

---

<a id="the-original-libreoj-judging-sandbox"></a>

# The original LibreOJ judging sandbox

[简体中文](#libreoj-原版评测沙盒) | English. This is a translation of the Chinese text above.

This project uses the original `infra/sandbox-rootfs` build recipe of [LibreOJ/LibreOJ](https://github.com/LibreOJ/LibreOJ) and keeps that directory identical to the upstream version. arm64 (AArch64) servers use the recipe in `infra/sandbox-rootfs/arm64/`: the same compilers, versions and Ubuntu package snapshot, with arm64 packages and downloads, and no 32-bit or x32 toolchains (see [ARM64 servers](../../wiki/ARM64.md)). Judged programs and AI-generated programs still run through `simple-sandbox`, sharing the existing queues, resource limits and security fixes.

## Preparing and building

By default `build.sh` only shows the recipe ID and the target path: it downloads no image, mounts no file system and starts no service. Building needs Docker with BuildKit (buildx), Git, Bash, gzip and SHA-256 tools. Staging (checking and installing an image) needs root, Linux `chroot` and mount permissions, and a host of the image's architecture: an amd64 image also needs a kernel that runs 32-bit programs, and the default full check also needs x32 support in the kernel; a host without x32 support must choose the check described below explicitly. The script uses the recipe of the host's architecture; `ROOTFS_ARCHITECTURE=amd64|arm64` picks the other one for showing the plan or building (building for the other architecture needs Docker's QEMU user-mode emulation), and staging accepts only images of the host's architecture.

```bash
cd /opt/LLMOJ
bash deploy/sandbox/build.sh plan
bash deploy/sandbox/build.sh build
# With the absolute ARCHIVE path that the previous command printed:
sudo bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
# Only when the host definitely can't run x32 programs:
sudo env LIBREOJ_X32_SUPPORTED=0 bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
```

The build script calls the upstream `infra/sandbox-rootfs/build.sh` directly. The upstream recipe pins the base image, downloaded packages and testlib by digest or checksum, and APT uses a snapshot of a fixed date. The recipe's content gives the `ROOTFS_ID`, and the archive comes with a SHA-256 file. The archive uses gzip's fast compression level and shows the bytes processed and the rate on standard error; the compression level isn't part of the `ROOTFS_ID`, and the archive format and checksum rules stay the same. Pinned sources make builds more reproducible, but a Docker export isn't promised to be byte-for-byte identical across builders.

The staging script calls the upstream `stage.sh` directly. It checks the archive's hash, the embedded ID, device nodes and the sandbox UID, runs the upstream smoke test of every language, unmounts the check's mounts, installs the image to `runtime/rootfs-<ID>`, and then creates the `runtime/sandbox-rootfs` symbolic link and the `runtime/rootfs-id` build metadata. An existing target isn't overwritten. Neither building nor staging starts the judge or any other service.

`infra/sandbox-rootfs/stage.sh` is used by default. arm64 images always use `stage-host.sh` with `infra/sandbox-rootfs/arm64/smoke-test.sh` (there are no x32 checks to skip). Both staging entries set the permissions of the check directory explicitly, so that UID 999 can still read the check scripts on the read-only mount when the installer runs with `umask 0077`, and can't write to that directory. With `LIBREOJ_X32_SUPPORTED=0` set explicitly, `stage-host.sh` and `smoke-test-host.sh` are used: they skip only running x32 binaries, still compile x32, and keep every amd64/i386, language version, testlib and archive integrity check. This choice changes neither the upstream recipe, nor the image, nor its embedded `ROOTFS_ID`.

The judge configuration uses:

```yaml
sandbox:
  rootfs: /opt/LLMOJ/runtime/sandbox-rootfs
  rootfsId: the 64-hex-digit ROOTFS_ID that build.sh printed
  user: sandbox
  resourceMode: default
  environments:
    PATH: /usr/local/bin:/usr/bin:/bin
    HOME: /tmp
    LC_ALL: en_US.UTF-8
    PYTHONDONTWRITEBYTECODE: "1"
```

`resourceMode: default` uses the existing cgroup resource control. `rootfsId` is checked against `/etc/libreoj-rootfs-id` in the image; no separate ID file is needed. Enabling services and creating runtime directories belong to the actual deployment steps.

## Languages

The default submission options are the original 12 languages again: C++, C, Java, Kotlin, Pascal, Python, Rust, Swift, Go, Haskell, C# and F#. The versions and paths the recipe is expected to provide are in `languages.json` (for C and C++, `architectures` lists the amd64 options and `arm64Architectures` the arm64 ones); a build or staging counts as successful only after the upstream smoke test passes.

GCC and Clang are called through the original links in `/usr/local/bin`. Python uses the original 2.7, 3.9 and 3.10 paths, with the same options in the frontend and backend. The C and C++ standards, compilers, optimizations and 32-bit options match the original recipe. This deployment offers only amd64/i386 (`64`/`32`) by default in the frontend and backend; arm64 judge machines compile only `64` (AArch64, with `-march=native -fsigned-char`), a 32-bit submission ends with a compilation error there, and the frontend doesn't offer the option while none of the site's judge machines can compile 32-bit programs. x32 submissions that the host can't run aren't accepted; a deployment that explicitly supports x32 and has passed the full staging check can extend the backend's C/C++ validation and the frontend's architecture options together. The fixes for linking communication problems' extra source files, Python's stack limit, Go's parallelism limit and .NET's compilation resource limits are kept.

The adapter sources for Ruby, Perl, Bash, Awk, bc, assembly, Emacs Lisp, sed and dc that were added earlier are kept, but aren't registered by default, and their submission options aren't accepted. Some of these tools are build dependencies; the other interpreters aren't explicitly installed or checked by the original recipe. Enabling those languages needs a customized recipe of its own and matching changes to the backend's, frontend's and judge's language lists.

## Licenses and distribution

The LibreOJ project's code is used under the MIT terms of the root `LICENSE`; `infra/sandbox-rootfs/LICENSE` licenses that directory's recipe and helper scripts under the Unlicense. Keep these license texts.

The generated rootfs is a collection of third-party software, whose licenses don't all become MIT or the Unlicense. Ubuntu packages, GCC/LLVM, Java, Python, Go, Rust, Swift, Kotlin, GHC, .NET/Mono and testlib each keep their own licenses. Releases of the repository contain only the build recipe and adapter sources, not the built rootfs or binary archives. If you distribute an image later, keep the copyright and license material in it, and meet the applicable source and other distribution obligations component by component; the exact sources are pinned in the upstream Dockerfile.

## Checks

Before deploying, run the build and staging smoke tests that come with `infra/sandbox-rootfs`, and pass the project's type checks, the native sandbox tests, the contest language option consistency test and the grader/AI regression tests. The judge service's real operation can be confirmed only after it is actually deployed and explicitly started.
