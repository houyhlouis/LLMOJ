# ARM64 服务器

简体中文 | [English](ARM64.md) | [Wiki 首页](Home.md)

LLMOJ 在 64 位 ARM（arm64，也称 AArch64）服务器上的运行方式与 amd64（x86-64）相同：同一个[安装脚本](Installation.zh-CN.md)、[升级](Upgrade.zh-CN.md)、`doctor.sh`、备份和[远程评测机](Remote-Judge.zh-CN.md)。本页列出不同之处。

## 需要什么

- 运行 arm64 版 Ubuntu 24.04 或 26.04 的虚拟机或物理机，处理器为 64 位 ARM（ARMv8-A 或更新）：例如 Ampere Altra 或 AmpereOne、AWS Graviton、华为鲲鹏。其他[要求](Installation.zh-CN.md#环境要求)与 amd64 相同。
- 无需额外选择：安装脚本会识别架构，安装计划（`--plan`）中显示为 `架构：arm64`。

全部组件都可以运行在 arm64 上：完整安装（`--role all`）、仅网页（`--role web`）或远程评测机。arm64 远程评测机也可以为 amd64 网站评测，amd64 评测机也可以为 arm64 网站评测（见[混合评测机](#混合评测机)）。

## 安装脚本的不同之处

| 步骤 | amd64 | arm64 |
| --- | --- | --- |
| Node.js 24.21.0 | `linux-x64` 版本 | `linux-arm64` 版本，使用其自身的 SHA-256 |
| Go 1.26.8（从源码构建 MinIO） | `linux-amd64` | `linux-arm64`，使用其自身的 SHA-256 |
| Docker 软件包 | `amd64` 软件包 | 同一软件源的 `arm64` 软件包 |
| 沙箱镜像 | `infra/sandbox-rootfs/Dockerfile` | `infra/sandbox-rootfs/arm64/Dockerfile` |

两种沙箱镜像的编译器和版本相同（GCC 14.2、Clang 20.1、Java 21、Kotlin 1.9.25、Free Pascal 3.2.2、Python 2.7.18、3.9.25 和 3.10.20、Rust 1.97.0、Swift 6.3.3、Go 1.26.5、GHC 9.4.7，以及由 .NET 10.0.109 编译、Mono 6.8 运行的 C# 和 F#），来自同一个 Ubuntu 软件包快照。每种架构的镜像都有自己的 ID，各自按本架构的配方检查。

## arm64 上的 C 与 C++

- **64 位**编译为评测机自身的架构：在 arm64 上是 AArch64，与 amd64 一样使用 `-march=native`。
- **32 位（x86）**不可用：arm64 镜像没有 32 位工具链，arm64 处理器也不能运行 x86 程序。网站的评测机都无法编译 32 位程序时，不提供这一选项，已保存的 32 位偏好会改为 64 位。仍然（通过 API）提交的 32 位程序会以编译错误结束，说明 32 位程序需要 x86-64 评测机。
- **`char` 是有符号的**，与 x86-64 相同（`-fsigned-char`）。AArch64 上默认是无符号的，在 x86-64 上写的 `char c; while ((c = getchar()) != EOF)` 这类代码将永远不会结束。

与 x86-64 仍然不同、可能改变结果的地方：

| | x86-64 | AArch64 |
| --- | --- | --- |
| `long double` | 80 位（64 位尾数），硬件实现 | 128 位（113 位尾数），软件实现：更精确，也慢得多 |
| x86 内建函数（`<immintrin.h>`、`__builtin_ia32_*`）、`#pragma GCC target("avx2")`、x86 内联汇编 | 可以编译 | 编译错误 |
| 运行时间 | | 不同：请按实际评测的机器设置时间限制 |

其他语言在两种架构上表现相同。

## arm64 上的沙箱

沙箱的工作方式相同：命名空间、cgroup v2 限制、只读文件系统和 seccomp 过滤器（见[评测机配置](Judge-Configuration.zh-CN.md#沙箱系统调用过滤器与自检)）。过滤器检查 AArch64 自己的系统调用表。镜像中无法编译 32 位 ARM（AArch32）程序，仍然启动这类程序的进程会在第一次系统调用时被终止。

[自检](Judge-Configuration.zh-CN.md#沙箱系统调用过滤器与自检)与 amd64 一样检查每种语言；在 arm64 上，C 与 C++ 只检查 64 位。

`doctor.sh` 在 **本服务器** 下显示服务器的架构；已安装的沙箱镜像如果是为其他架构构建的（例如从 amd64 服务器复制而来），会报告失败。

## 混合评测机

两种架构的评测机可以为同一个网站评测：

- 评测机连接时会声明自己能编译什么（评测协议版本 5）。**评测机状态**页面显示每台评测机的架构及其 C 与 C++ 程序，在线评测机的架构不同时会给出提示。
- 含 32 位 C 或 C++ 程序的任务（提交，或题目的校验器、交互器）只交给 x86-64 评测机，只要网站有这样的评测机（无论是否在线）。arm64 评测机负责其他任务。不再使用的评测机请删除（评测机状态页面上的 **删除**），否则 32 位任务会一直等待它。
- 没有 x86-64 评测机时，arm64 评测机也会评测 32 位任务，它们以上述编译错误结束。
- 协议版本 5 之前的评测机视为 x86-64 评测机（两种都能编译），除非它们声明的运行环境是 arm64。

同一程序在不同机器上的运行时间不同，`long double` 的结果在不同架构之间也可能不同。一场比赛请只用同一种评测机：比赛期间[排空](Distributed-Judging.zh-CN.md#排空密钥与能力)其他评测机。

每种架构都有自己的沙箱镜像，因此评测机状态页面只在同一架构的机器之间比较沙箱镜像。所有评测机的评测程序必须是同一版本。

## 在其他机器上构建 arm64 镜像

远程 arm64 评测机可以从可信的机器获得镜像，而不必自己用 Docker 构建（见[远程评测机](Remote-Judge.zh-CN.md#3-准备沙箱镜像)）。在 arm64 机器上，`bash deploy/sandbox/build.sh build` 即可构建。amd64 机器借助 Docker 的 QEMU 用户态模拟也可以构建（慢得多）：

```bash
ROOTFS_ARCHITECTURE=arm64 bash deploy/sandbox/build.sh plan
sudo env BUILDX_BUILDER=default ROOTFS_ARCHITECTURE=arm64 bash deploy/sandbox/build.sh build
```

请在 arm64 评测机本机上安装（`stage`）：安装时的检查会运行镜像中的编译器，`build.sh stage` 也会拒绝其他架构的镜像。

## 升级

[升级](Upgrade.zh-CN.md)在 arm64 上的工作方式相同。升级沿用已安装的沙箱镜像，因此会拒绝修改本服务器架构配方的版本；修改另一种架构的配方则可以接受（安装计划在 `rootfsRecipe` 下列出）。

## 测试情况

arm64 支持在 arm64 版 Ubuntu 26.04 上测试过：虚拟机使用模拟的 Neoverse-N1 处理器（QEMU，比真实处理器慢很多倍），测试了用安装脚本完整安装、自检、每种语言的提交评测、升级（以及失败尝试的回滚）、用 `verify-backup.sh` 检查过的备份和 `doctor.sh`。还测试了 arm64 评测机与 amd64 评测机一起为 amd64 网站评测。CI 会在 GitHub 的 arm64 运行器上构建并测试沙箱和 arm64 镜像。尚未在 arm64 物理服务器上测试。
