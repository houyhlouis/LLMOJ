# 源码包与下载依赖

[English](SOURCE-PACKAGE.md) | 简体中文

源码包包含后端、前端、judge、simple-sandbox、testlib、原版 rootfs 构建配方、安装工具、配置模板、中英文 Wiki、中英文安装和升级入口（`install.sh`、`upgrade.sh` 及其 `.zh-CN` 版本）、共享的代码检查规则（`eslint.airbnb-base.mjs`）、CI、依赖锁文件及原许可证。它可以建立新的源码仓库，不携带原部署目录的 Git 历史。

完整性经过检查，而不是默认成立：Git 跟踪的每个文件要么在源码包中，要么属于以下已命名的排除规则之一：Git 元数据、已安装的依赖、构建产物、实例配置和数据（`config/*` 中除 `.example` 以外的文件，以及 `data`、`runtime`、`backups`、`logs`、`cache`）、发布和验证输出、日志和核心转储、下载的镜像、私钥、本地压缩包、`.env` 文件、安装后的私有状态，以及 `deploy/noi`、`deploy/september20`、`deploy/rootfs` 中的旧部署产物。被跟踪的文件不符合任何规则、文件缺失或是符号链接时，`deploy/prepare-github.py` 会停止，而不是悄悄漏掉它。CI 每次推送都会生成源码包、解压、离线安装锁定的依赖，并在其中运行类型检查和代码检查。和新克隆的仓库一样，解压后的源码包需要先 `git init` 并提交一次才能构建：旧版 bootstrap 包会记录构建时的提交。只打包 Git 跟踪的文件（testlib 取自其子模块自己的索引）；`--include-untracked` 会加上 Git 没有跟踪、也没有忽略的文件。该工具需要 Git 检出副本：在没有 `.git` 的已安装副本中，它不会写入任何文件，而是输出检出已安装版本的方法。

源码包不包含真实密码、API Key、数据库、题库、用户内容、运行日志、备份、node_modules、完整 rootfs、Docker 镜像、系统 ISO 或安装后二进制。

安装时从服务器配置的 Ubuntu 源安装 MariaDB、Redis、Nginx、编译工具等；从 nodejs.org 下载 Node 24.21.0，从 npm 下载 pnpm 11.13.1 和锁定依赖；从 go.dev 下载 Go 1.26.8，取得固定 MinIO 源码并编译。Twemoji 图形、Hack 字体和部分依赖的原生资源来自其 GitHub 项目。

完整安装还使用 Docker 构建 rootfs：基底为配方固定 digest 的 Swift / Ubuntu 镜像，APT 使用固定快照，语言工具链按 Dockerfile 中的版本和来源取得。完整 rootfs 在服务器上生成，不从本项目的 Release 下载。仅网页模式不构建 rootfs，也不安装 Docker。

生成的配置、systemd 单元、随机 admin 密码、数据库和构建产物留在安装服务器。主体源码的 MIT 许可不替代第三方组件许可；分发二进制或完整 rootfs 前须另行落实对应义务。

具体地址见 `install.sh`、`deploy/install.sh`、`pnpm-lock.yaml`、`deploy/build-frontend-offline.mjs` 和 `infra/sandbox-rootfs/Dockerfile`。
