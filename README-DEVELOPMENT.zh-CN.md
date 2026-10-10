# 开发与构建

[English](README-DEVELOPMENT.md) | 简体中文

项目基于 LibreOJ，主体采用 MIT；各组件原声明必须保留。项目介绍见 [README](README.md)，部署见 [Wiki](wiki/Home.zh-CN.md)。

## 工具链

- Node.js 至少 22.13；一键安装固定使用 24.21.0。
- 使用 `package.json` 指定的 pnpm 11.13.1。
- Linux amd64、CMake、C++ 编译器、libfmt；实际沙盒执行还需 namespaces 与 cgroup v2。

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter simple-sandbox build
pnpm build:native
pnpm build
pnpm check-types
```

源码归档包含 testlib；仅在 Git 子模块内容缺失时执行 `git submodule update --init --recursive`。

## 运行配置

`config/*.example` 是模板。实际配置、API Key、数据库、依赖、rootfs 和构建产物不进入源码仓库。安装器生成这些文件，默认站点监听 `0.0.0.0:80`；后端与存储仅监听本机。

`HYHOJ_*` 是二次开发早期采用的内部环境变量名，暂时保留以兼容已有功能代码；它们不控制站点展示名称。新部署服务使用 `libreoj-*`，站名由 `--site-name` / `OJ_SITE_NAME` 设置。

原版 rootfs 构建及验证见 [沙盒说明](deploy/sandbox/README.md)。Docker 用于构建，不参与每次提交的原生沙盒执行。

## 测试与打包

```bash
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
python3 deploy/test/github-entry.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py
sudo python3 deploy/test/admin-output.test.py
python3 deploy/test/install-flow.test.py
sudo python3 deploy/test/redis-host.test.py
sudo python3 deploy/test/sandbox-staging.test.py
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

数据库及浏览器集成测试应使用一次性实例，具体约束见 [AI 说明](apps/backend/src/ai/README.md)。不要把生产数据库或会话作为测试 fixture。打包器仅检查并创建本地归档，不提交、推送或发布到 GitHub。

## 注册审核与升级回归

在仓库根目录使用项目要求的 Node 版本：

```bash
node --test apps/backend/src/auth/registration-review.test.cjs
node --test packages/frontend/test/registration-review.test.cjs
sudo python3 deploy/test/upgrade.test.py
node --test deploy/test/upgrade-schema.test.mjs deploy/test/upgrade-registration.test.mjs
python3 deploy/test/wiki-export.test.py
```

真实 MariaDB 审核并发测试为 `apps/backend/src/auth/registration-review.mariadb.test.cjs`，仅在设置 `LLMOJ_REGISTRATION_TEST_DATABASE` 时启用。它读取私有 JSON 的 `socketPath`、`database`、`username`、可选 `password`；只允许专用 `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` 或 `/var/tmp/llmoj-registration-*/mariadb/mysql.sock` 套接字，库名必须符合测试文件中的 `llmoj_registration_test*`／`test_registration_v2*` 白名单，使用随机表前缀并清理这些表。应先创建专用、可丢弃的 MariaDB 实例；不要提供生产连接。数据库测试未启用时会显示 skipped，不能算作通过数据库验收。

升级器的 Python 测试使用临时目录和模拟服务控制，不能代替真实 Ubuntu/systemd 升级验收。正式运行范围、只读预检与回滚限制见 [升级说明](wiki/Upgrade.zh-CN.md)。

本轮回归应特别检查：注册／拒绝前后正式用户表行数及用户 ID 序列保持不变；批准时四张账户表与审核日志原子提交；重复／并发审批只创建一个账户；待审与拒绝申请不能从用户搜索或个人主页访问。还应定向验证拒绝后批准、默认用户拒绝／授权审核者允许、权限撤销、禁止审核者进入权限管理，以及 `ViewSite` 被拒绝时不能审核。升级测试同时覆盖旧空账户和审计档案迁移、保留已通过账户、危险关联拒绝及重复执行。

真实升级迁移测试为 `deploy/test/upgrade-migration.integration.mjs`。先构建后端，准备专用隔离 MariaDB 和仅含合成数据、尚未加入审核表／申请表的单库 SQL 备份，然后显式设置 `UPGRADE_TEST_ALLOW_DATABASE_CREATION=1`、`UPGRADE_TEST_MARIADB_SOCKET`、`UPGRADE_TEST_BASELINE_SQL`，执行 `node deploy/test/upgrade-migration.integration.mjs`。套接字真实路径也必须符合上述隔离目录白名单；不接受数据库切换、跨库限定或客户端命令的备份。测试创建并清理随机的 `libreoj_upgrade_<16位十六进制>` 数据库，涵盖密码／审计迁移、重复执行、危险关联拒绝、跨库级联引用和事务故障恢复，还验证旧权限枚举仅追加 `ManageRegistrationReviews`、已有权限值与序号保留，以及未知枚举值／顺序拒绝。未提供配置时只输出 SKIP，不能算作集成测试通过。禁止使用生产套接字或生产数据备份。
