# 本地开发

简体中文 | [English](Development.md) | [Wiki 首页](Home.md)

本页介绍如何从源码目录运行 LLMOJ 进行开发：一套自己专用、用完即弃的 MariaDB、Redis 和 MinIO，后端，前端开发服务器，可选的示例数据，以及如何停止并全部删除。不会在系统中安装任何东西，也不需要 root。要安装站点，请看[安装教程](Installation.zh-CN.md)；构建和测试见[开发说明](../README-DEVELOPMENT.zh-CN.md)。

## 需要什么

- Linux（amd64 或 arm64），以及[工具链](../README-DEVELOPMENT.zh-CN.md#工具链)：Node.js 24.21 和 pnpm 11.13.1。
- 各服务的程序：`mariadbd`、`mariadb-install-db` 和 `mariadb`（MariaDB 11）、`redis-server`，以及 MinIO 服务端程序：把 `LLMOJ_MINIO_BINARY` 设为它的路径，或者放在源码目录的 `runtime/minio`（已安装的站点在自己的 `runtime/` 中就有一个）。
- `flock`（util-linux）和 Python 3.9 或更高版本：脚本用它们确保只停止自己启动的进程。
- `127.0.0.1` 上连续 7 个空闲端口，默认从 28400 开始：后端（28400）、后端指标（28401）、前端（28402）、MariaDB（28403）、Redis（28404）、MinIO（28405）和 MinIO 控制台（28406）。`start --base-port N` 使用另一段端口，之后会一直沿用。

这套环境不包含评测：连接评测机之前，提交会一直等待（见[下文](#评测)）。

## 1. 构建

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter @libreoj/backend build
```

## 2. 启动服务

```bash
node deploy/dev/stack.mjs start --dir /var/tmp/llmoj-dev-$(id -u)
```

- `--dir` 是存放一切的位置：数据库、日志、生成的配置和凭据，只有你自己能读取。默认是源码目录中的 `.dev-stack/`，Git 会忽略它。在 Ubuntu 上，AppArmor 只允许 MariaDB 使用 `/tmp`、`/var/tmp` 及其自身路径下的数据目录，所以请像上面那样使用 `/var/tmp` 下的目录；MariaDB 启动失败时脚本也会这样提示。
- 第一次 `start` 会用当前的表结构创建数据库 `llmoj_dev`（通过 [`deploy/initialize-schema.mjs`](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-schema.mjs)），创建存储桶，并与安装器一样用 `deploy/bootstrap-admin.mjs` 创建管理员 `admin`。它会写出 `backend.yaml`（由 `apps/backend/config-example.yaml` 生成，带有随机的、仅用于开发的密钥）和 `backend.env`（让后端使用这份配置，并把 AI、压缩包和临时文件都放在这套环境内）。
- 它会打印各个地址、管理员密码所在的文件（`admin-credentials.json`）以及下一步的命令。`stop` 之后再次运行 `start`，会带着原有数据启动同样的服务。

## 3. 启动后端和前端

在源码目录下打开两个终端：

```bash
(cd apps/backend && . /var/tmp/llmoj-dev-$(id -u)/backend.env && node dist/main)
```

```bash
node deploy/dev/stack.mjs frontend --dir /var/tmp/llmoj-dev-$(id -u)
```

打开 `http://127.0.0.1:28402`，以 `admin` 登录。修改 `packages/frontend` 时前端开发服务器会自动刷新，并把 `/api`（包括实时更新）转发给后端。修改后端后，重新构建并重启它所在的终端。后端也直接在 `http://127.0.0.1:28400` 上响应，OpenAPI 说明在 `/docs`（见[使用 API](API.zh-CN.md)），指标在 `http://127.0.0.1:28401/metrics`。

## 4. 添加示例数据

```bash
node deploy/dev/stack.mjs seed --dir /var/tmp/llmoj-dev-$(id -u)
```

它会添加普通用户 `dev_student`（密码在 `student-credentials.json` 中）、一道公开的传统题“Double an integer”（带一个样例和两个测试点），以及一份 C++ 提交（由于没有评测机，它是已取消的）。每套环境只运行一次。做性能测试时，请在一套单独的新环境上使用[容量](Capacity.zh-CN.md#重复这项测量)中介绍的工具。

## 评测

评测机需要 root、cgroup v2 和沙箱镜像，所以这套环境不会启动评测机。要评测提交，像连接任何站点一样把评测机连接到这个后端：在站点的**评测机**页面注册，并按[分布式评测](Distributed-Judging.zh-CN.md)和[远程评测机](Remote-Judge.zh-CN.md)设置。在此之前，提交会在队列中等待。

## 测试

测试套件不需要这套环境：见开发说明中的[测试](../README-DEVELOPMENT.zh-CN.md#测试)。使用数据库的套件需要自己的一次性 MariaDB（见[数据库测试](../README-DEVELOPMENT.zh-CN.md#数据库测试)）。

## 5. 停止与删除

先用 Ctrl-C 停止后端和前端。然后：

```bash
node deploy/dev/stack.mjs stop --dir /var/tmp/llmoj-dev-$(id -u)
```

停止 MariaDB、Redis 和 MinIO 并保留数据（`start` 可以再次启动它们）；

```bash
node deploy/dev/stack.mjs reset --dir /var/tmp/llmoj-dev-$(id -u)
```

停止它们并删除整个目录。两者都只作用于脚本自己创建的目录，也只停止它记录为自己启动的进程，所以机器上其他的 MariaDB、Redis 或 MinIO（例如已安装站点的）不会受到影响。

## 出现问题时

- **端口被占用：** `start` 会指出是哪个端口。新环境可以用 `--base-port` 换一段端口。已有的环境会沿用自己的端口：请释放该端口，或者 `reset` 后用另一段端口新建一套。
- **MariaDB 无法启动：** 查看环境目录中的 `mariadb.log`。在 Ubuntu 上请使用 `/var/tmp` 下的目录（AppArmor）。
- **没有 MinIO 程序：** 设置 `LLMOJ_MINIO_BINARY`。
- **无法创建表结构或管理员：** 先构建后端（第 1 步）；详情见 `schema.log`。
- 各服务的日志是环境目录中的 `mariadb.log`、`redis.log` 和 `minio.log`。错误信息不会打印任何凭据。
