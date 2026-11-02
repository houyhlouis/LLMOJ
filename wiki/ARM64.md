# ARM64 servers

[简体中文](ARM64.zh-CN.md) | English | [Wiki home](Home.en.md)

LLMOJ runs on 64-bit ARM (arm64, also called AArch64) servers as it does on amd64 (x86-64): the same [installer](Installation.md), [upgrades](Upgrade.md), `doctor.sh`, backups and [remote judges](Remote-Judge.md). This page lists what is different.

## What you need

- Ubuntu 24.04 or 26.04 for arm64 on a virtual machine or physical server with a 64-bit ARM processor (ARMv8-A or later): for example Ampere Altra or AmpereOne, AWS Graviton, or Huawei Kunpeng. The other [requirements](Installation.md#requirements) are the same as on amd64.
- Nothing else to choose: the installer finds the architecture, and the plan (`--plan`) shows it as `Architecture: arm64`.

Everything can be on arm64: a full installation (`--role all`), a website only (`--role web`), or remote judges. Remote arm64 judges can also judge for an amd64 site, and amd64 judges for an arm64 site (see [Mixed judge machines](#mixed-judge-machines)).

## What the installer does differently

| Step | amd64 | arm64 |
| --- | --- | --- |
| Node.js 24.21.0 | `linux-x64` build | `linux-arm64` build, with its own SHA-256 |
| Go 1.26.8 (builds MinIO from source) | `linux-amd64` | `linux-arm64`, with its own SHA-256 |
| Docker packages | `amd64` packages | `arm64` packages from the same source |
| Sandbox image | `infra/sandbox-rootfs/Dockerfile` | `infra/sandbox-rootfs/arm64/Dockerfile` |

The two sandbox images have the same compilers and versions (GCC 14.2, Clang 20.1, Java 21, Kotlin 1.9.25, Free Pascal 3.2.2, Python 2.7.18, 3.9.25 and 3.10.20, Rust 1.97.0, Swift 6.3.3, Go 1.26.5, GHC 9.4.7, and C# and F# compiled by .NET 10.0.109 and run by Mono 6.8), from the same Ubuntu package snapshot. Each architecture's image has its own ID, so each one is checked against the recipe of its own architecture.

## C and C++ on arm64

- **64-bit** builds for the judge machine's own architecture: AArch64 on arm64, with `-march=native` as on amd64.
- **32-bit (x86)** isn't available: the arm64 image has no 32-bit toolchain, and arm64 processors don't run x86 programs. The site doesn't offer it while none of its judge machines can build it, and a saved preference for it becomes 64-bit. A 32-bit submission sent anyway (through the API) ends with a compilation error saying that 32-bit programs need an x86-64 judge machine.
- **`char` is signed**, as on x86-64 (`-fsigned-char`). On AArch64 it is unsigned by default, and solutions written on x86-64 such as `char c; while ((c = getchar()) != EOF)` would never stop.

What still differs from x86-64, and may change a result:

| | x86-64 | AArch64 |
| --- | --- | --- |
| `long double` | 80-bit (64-bit mantissa), in hardware | 128-bit (113-bit mantissa), in software: more precise, and much slower |
| x86 intrinsics (`<immintrin.h>`, `__builtin_ia32_*`), `#pragma GCC target("avx2")`, x86 inline assembly | compile | compilation error |
| Running time | | Different: set time limits with the machines that judge |

Other languages behave the same on both.

## The sandbox on arm64

The sandbox works the same way: namespaces, cgroup v2 limits, a read-only file system and the seccomp filter (see [Judge configuration](Judge-Configuration.md#sandbox-syscall-filter-and-self-test)). The filter checks AArch64's own system call table. 32-bit ARM programs (AArch32) can't be built in the image, and a program that starts one anyway is killed at its first system call.

The [self-test](Judge-Configuration.md#sandbox-syscall-filter-and-self-test) checks every language as on amd64; on arm64 it checks C and C++ at 64 bits only.

`doctor.sh` shows the server's architecture under **This server**, and reports a failure if the installed sandbox image was built for another architecture (for example, copied from an amd64 server).

## Mixed judge machines

Judge machines of both architectures can judge for one site:

- Judge machines announce what they can build when they connect (judge protocol version 5). The **Judge Machine** page shows each one's architecture and its C and C++ programs, and points out when online judge machines have different architectures.
- A task with a 32-bit C or C++ program (a submission, or a problem's checker or interactor) goes only to x86-64 judge machines while the site has one, online or not. arm64 judge machines take the other tasks. Remove a judge machine you no longer use (**Delete** on the Judge Machine page), or 32-bit tasks keep waiting for it.
- With no x86-64 judge machine, arm64 ones judge 32-bit tasks too, and they end with the compilation error above.
- Judge machines older than protocol version 5 count as x86-64 ones, which build both, unless the runtime they announce is arm64.

The same program's running time differs between machines, and `long double` results can differ between architectures. For a contest, judge on one kind of machine: [drain](Distributed-Judging.md#draining-keys-and-capabilities) the others while it runs.

Each architecture has its own sandbox image, so the Judge Machine page compares sandbox images only between machines of the same architecture. The judge program must be the same version on all of them.

## Building the arm64 image on another machine

A remote arm64 judge can get its image from a trusted machine instead of building it with Docker itself (see [Remote judges](Remote-Judge.md#3-prepare-the-sandbox-image)). On an arm64 machine, `bash deploy/sandbox/build.sh build` builds it. An amd64 machine can build it too, with QEMU user emulation for Docker (much slower):

```bash
ROOTFS_ARCHITECTURE=arm64 bash deploy/sandbox/build.sh plan
sudo env BUILDX_BUILDER=default ROOTFS_ARCHITECTURE=arm64 bash deploy/sandbox/build.sh build
```

Install (`stage`) it on the arm64 judge itself: its checks run the image's compilers, and `build.sh stage` refuses an image of another architecture.

## Upgrades

[Upgrades](Upgrade.md) work the same on arm64. An upgrade keeps the installed sandbox image, so it refuses a release that changes the recipe of the server's own architecture; a change to the other architecture's recipe is accepted (the plan lists it under `rootfsRecipe`).

## Tested

The arm64 support was tested on Ubuntu 26.04 for arm64 in a virtual machine with an emulated Neoverse-N1 processor (QEMU, many times slower than a real one): a full installation with the installer, the self-test, judged submissions in every language, an upgrade (and rollbacks of failed attempts), a backup checked with `verify-backup.sh`, and `doctor.sh`. An arm64 judge machine also judged for an amd64 site next to an amd64 one. CI builds and tests the sandbox and the arm64 image on GitHub's arm64 runners. It hasn't been tested on physical arm64 servers yet.
