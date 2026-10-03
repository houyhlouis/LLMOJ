# 源码包与下载依赖

[English](SOURCE-PACKAGE.md) | 简体中文

源码包包含后端、前端、judge、simple-sandbox、testlib、原版 rootfs 构建配方、安装工具、配置模板、中英文 Wiki 和安装入口、CI、依赖锁文件及原许可证。它可以建立新的源码仓库，不携带原部署目录的 Git 历史。

源码包不包含真实密码、API Key、数据库、题库、用户内容、运行日志、备份、node_modules、完整 rootfs、Docker 镜像、系统 ISO 或安装后二进制。

安装时从服务器配置的 Ubuntu 源安装 MariaDB、Redis、Nginx、编译工具等；从 nodejs.org 下载 Node 24.21.0，从 npm 下载 pnpm 11.13.0 和锁定依赖；从 go.dev 下载 Go 1.26.8，取得固定 MinIO 源码并编译。Twemoji 图形、Hack 字体和部分依赖的原生资源来自其 GitHub 项目。

完整安装还使用 Docker 构建 rootfs：基底为配方固定 digest 的 Swift / Ubuntu 镜像，APT 使用固定快照，语言工具链按 Dockerfile 中的版本和来源取得。完整 rootfs 在服务器上生成，不从本项目的 Release 下载。仅网页模式不构建 rootfs，也不安装 Docker。

生成的配置、systemd 单元、随机 admin 密码、数据库和构建产物留在安装服务器。主体源码的 MIT 许可不替代第三方组件许可；分发二进制或完整 rootfs 前须另行落实对应义务。

具体地址见 `install.sh`、`deploy/install.sh`、`pnpm-lock.yaml`、`deploy/build-frontend-offline.mjs` 和 `infra/sandbox-rootfs/Dockerfile`。
