# 安装 LLMOJ / Install LLMOJ

[中文教程](../wiki/Installation.zh-CN.md) | [English tutorial](../wiki/Installation.md)

从本地源码运行 `sudo bash deploy/install.zh-CN.sh`（中文）或 `sudo bash deploy/install.sh`（English）。GitHub 下载入口见 [中文 README](../README.md) / [English README](../README.en.md)。默认完整安装、监听 `0.0.0.0:80`，站名 LLMOJ；内部服务只监听本机，TLS 和防火墙需另行配置。

完整模式首次生成 `judge.yaml` 且未指定 `--judge-slots` 时询问评测实例数（执行槽），默认 `max(1, 有效 CPU 数-2)`，受 CPU/cgroup、RAM 和 libuv 容量约束；内存不足时要求明确选择较少数量。它不是系统线程数，也不是同机多个站点。已有节点扩缩容使用 [正式 resize 教程](../wiki/Judge-Configuration.zh-CN.md)，不通过重跑不同安装参数调整。成功安装显示管理员随机密码；正常重试保留数据和凭据。

The local English entry is `sudo bash deploy/install.sh`. All mode prompts for execution slots when first creating `judge.yaml` without `--judge-slots`, defaulting to effective CPUs minus two, minimum one. RAM shortages require an explicit smaller choice. Use the maintained [resize guide](../wiki/Judge-Configuration.md) for existing installations rather than changing installer metadata.

数据库初始化修复以 mysql 身份进行，并校验系统表；AppArmor 故障的隔离复现及安全重试见安装教程。真实 Ubuntu 24.04 部署与部分业务已验证；Ubuntu 26.04 的完整全新安装及真实多机仍未验收。新增容量/数据库/resize 功能属于待提交修订，部署前确认所用源码包含匹配文件。

See [distributed judging](../wiki/Distributed-Judging.md), [remote judges](../wiki/Remote-Judge.md), [Docker sources](../wiki/Docker-Sources.md) and [AI execution](../wiki/AI.md). Services retain `libreoj-*` names; default paths remain `/opt/LibreOJ`. Configuration generators write files without starting services, while the maintained resize tool deliberately manages the judge during an approved maintenance window.
