# 开发说明

[English](README-DEVELOPMENT.md) | 简体中文

LLMOJ 基于 [LibreOJ](https://github.com/libreoj/libreoj)，采用 MIT 许可证；请保留所有组件的声明。功能介绍和安装方法见 [README](README.md) 和 [Wiki](wiki/Home.md)。

## 工具链

- Node.js 22.13 或更高版本（安装时使用 24.21.0），以及 `package.json` 中指定的 pnpm 11.13.1。
- 评测机的原生代码需要：amd64 上的 Linux、CMake、C++ 编译器和 libfmt。
- 在沙箱中实际运行程序还需要：命名空间和 cgroup v2。

## 构建

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts            # 共用的协议和 bootstrap 包
pnpm --filter simple-sandbox build
pnpm build:native               # 沙箱和评测机的原生扩展
pnpm build
pnpm check-types
```

源码包中已包含 testlib。只有在缺少 `apps/judge/vendor/testlib/testlib.h` 时才需要运行 `git submodule update --init --recursive`。

`pnpm check` 执行与 CI 第一步相同的内容：构建、类型检查、lint 和格式检查。

### 前端的 API 客户端

`packages/frontend/src/api-generated` 由后端的控制器和 DTO 生成，内容过时时 `packages/frontend/test/api-contract.test.cjs` 会失败。修改控制器或 DTO 后，先构建后端再重新生成客户端，不需要运行服务器：

```bash
pnpm --filter @libreoj/backend build
node packages/frontend/scripts/generate-api.js --from-backend-build
```

## 目录与配置

| 目录 | 内容 |
| --- | --- |
| `apps/backend` | NestJS 后端 |
| `apps/judge` | 评测机 |
| `packages/frontend` | React 前端 |
| `packages/judge-protocol` | 后端与评测机共用的消息定义 |
| `packages/simple-sandbox` | 原生沙箱 |
| `deploy` | 安装器、升级器和维护脚本及其测试 |
| `wiki` | 文档，发布到 GitHub Wiki（见[发布](wiki/Publishing.zh-CN.md)） |

`config/*.example` 是模板。真实配置、密码、数据、依赖、沙箱镜像和构建结果都不会进入仓库，由安装器生成。服务保留 `libreoj-*` 名称，`HYHOJ_*` 变量也为兼容而保留原名。站点显示名称来自 `--site-name`（`OJ_SITE_NAME`）。

评测沙箱镜像用 Docker 构建，提交的程序在原生 `simple-sandbox` 中运行。中英文安装器共用同一份代码，只有提示语言不同；有测试检查两个下载脚本除此之外完全相同。见 [Docker 源](wiki/Docker-Sources.zh-CN.md)。

## 测试

在仓库根目录用 `node --test` 或 `python3` 运行测试。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）每次推送都会运行下面这些；提交前请运行你修改的部分。

```bash
# 后端，按模块
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
node apps/backend/src/access/access-permissions.test.cjs
node --test --test-concurrency=1 apps/backend/src/access/capability-cache.test.cjs \
  apps/backend/src/access/route-access.test.cjs apps/backend/src/access/permission-matrix.mariadb.test.cjs \
  apps/backend/src/site-management/*.test.cjs
node --test --test-concurrency=1 apps/backend/src/discussion/*.test.cjs apps/backend/src/team/*.test.cjs \
  apps/backend/src/hack/*.test.cjs apps/backend/src/self-eval/*.test.cjs apps/backend/src/contest/*.test.cjs \
  apps/backend/src/judge/*.test.cjs apps/backend/src/auth/*.test.cjs apps/backend/src/auth/two-factor/*.test.cjs \
  apps/backend/src/submission/*.test.cjs apps/backend/src/problem/*.test.cjs apps/backend/src/file/*.test.cjs \
  apps/backend/src/database/*.test.cjs apps/backend/src/study-list/*.test.cjs
node --test --test-concurrency=1 apps/backend/src/health/*.test.cjs apps/backend/src/common/*.test.cjs \
  apps/backend/src/metrics/*.test.cjs apps/backend/src/redis/*.test.cjs

# 评测机
node --test apps/judge/src/aiQuality.test.cjs apps/judge/src/task/hack/hack.test.cjs \
  apps/judge/src/task/self-eval/self-eval.test.cjs apps/judge/src/rpc.test.cjs \
  apps/judge/src/executionScheduler.test.cjs apps/judge/src/selfTestConfig.test.cjs apps/judge/src/fileContent.test.cjs

# 前端
node --test packages/frontend/test/*.test.cjs

# 数据库结构与迁移
node --test deploy/test/upgrade-schema.test.mjs deploy/test/community-schema.test.mjs \
  deploy/test/team-storage.test.mjs deploy/test/upgrade-registration.test.mjs
node --test deploy/test/community-schema.mariadb.test.mjs deploy/test/initialize-schema.test.mjs
node --test deploy/fake-migration.test.cjs

# 安装器、升级器和 Wiki
python3 deploy/test/install-flow.test.py
python3 deploy/test/backup.test.py
python3 deploy/test/doctor.test.py
python3 deploy/test/verify-backup.test.py
node --test deploy/test/backup-keys.test.mjs
sudo python3 deploy/test/community-upgrade.test.py
sudo python3 deploy/test/community-runtime-upgrade.test.py
python3 deploy/test/wiki-export.test.py
```

其他部署测试需要 root、systemd 或真实的安装布局，因此不在 CI 中：

```bash
sudo python3 deploy/test/upgrade.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py      # sudo 的 PATH 中需要有 node
sudo python3 deploy/test/resize-judge.test.py
sudo python3 deploy/test/admin-output.test.py
sudo python3 deploy/test/redis-host.test.py
sudo python3 deploy/test/sandbox-staging.test.py
sudo python3 deploy/test/verify-backup.test.py     # 全部检查需要 MariaDB 服务器、Node.js 和 python3-cryptography
python3 deploy/test/judge-capacity.test.py
python3 deploy/test/judge-prompt.test.py
python3 deploy/test/github-entry.test.py
python3 deploy/test/docker-support.test.py
node --test deploy/test/bootstrap-admin.test.mjs
```

这些测试使用临时目录和模拟的服务：它们不能代替在真实 Ubuntu 服务器上试装或试升级。

### 数据库测试

名为 `*.mariadb.test.*` 的测试（以及少数其他测试）使用真实的 MariaDB。除非对应的变量指向一个包含 `services.database` 的私有 YAML 文件（注册测试为 JSON 文件），否则会被跳过。被跳过的测试不能证明任何事情。

**只能让它们使用可以丢弃的数据库**：它们会创建和删除表，有些还要求数据库为空。绝不能使用生产数据库、数据或登录会话。共用同一个数据库的测试请依次运行。

| 变量 | 测试 |
| --- | --- |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | `discussion/discussion-{boundaries,visibility,solutions}.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | `problem/problem-mutations.mariadb.test.cjs` |
| `HYHOJ_SUBMISSION_TEST_DB_CONFIG` | `submission/submission-delete.mariadb.test.cjs` |
| `HYHOJ_COUNT_TEST_DB_CONFIG` | `group/group-discussion-counts.mariadb.test.cjs` |
| `HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG` | `deploy/test/community-schema.mariadb.test.mjs` |
| `HYHOJ_AI_TEST_DB_CONFIG` | `ai/ai-*.mariadb.test.cjs`（见 [AI 测试说明](apps/backend/src/ai/README.md)） |
| `LLMOJ_TEAM_TEST_DB_CONFIG` | `team/team-workflows.mariadb.test.cjs`（空数据库） |
| `LLMOJ_TEAM_AUDIT_DB_CONFIG` | `team/team-permission-audit.mariadb.test.cjs`（空数据库） |
| `LLMOJ_FAKE_TEST_DB_CONFIG` | `submission/submission-fake.mariadb.test.cjs`、`deploy/fake-migration.test.cjs` |
| `LLMOJ_SELF_EVAL_TEST_DB_CONFIG` | `hack/hack-list.mariadb.test.cjs`、`self-eval/self-eval.mariadb.test.cjs` |
| `LLMOJ_TWO_FACTOR_TEST_DB_CONFIG` | `auth/two-factor/two-factor.mariadb.test.cjs` |
| `LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG` | `judge/judge-queue.test.cjs` |
| `LLMOJ_DATA_VERSION_TEST_DB_CONFIG` | `submission/submission-data-version.mariadb.test.cjs` |
| `LLMOJ_AI_BUDGET_TEST_DB_CONFIG` | `ai/ai-budget.mariadb.test.cjs`（空数据库） |
| `LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG` | `access/permission-matrix.mariadb.test.cjs`（空数据库） |
| `LLMOJ_OPERATIONS_TEST_DB_CONFIG` | `metrics/operational-metrics.mariadb.test.cjs`、`contest/contest-score-revision.mariadb.test.cjs`（会删除其中所有数据表） |
| `LLMOJ_SCHEMA_TEST_DB_CONFIG` | `deploy/test/initialize-schema.test.mjs` |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | `auth/registration-review.mariadb.test.cjs`、`site-management/registration-settings.mariadb.test.cjs` |

`apps/backend/src/` 下的路径做了缩写。`LLMOJ_REGISTRATION_TEST_DATABASE` 指向一个包含 `socketPath`、`database`、`username` 和可选 `password` 的 JSON 文件；socket 必须符合 `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` 或 `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`，数据库名必须以 `llmoj_registration_test` 或 `test_registration_v2` 开头。

部分测试还可以把结果写入文件（`HYHOJ_DISCUSSION_TEST_EVIDENCE`、`HYHOJ_COUNT_TEST_RESULTS`、`HYHOJ_SUBMISSION_TEST_OUTPUT`、`HYHOJ_PROBLEM_TEST_REPORT`、`LLMOJ_TEAM_TEST_REPORT`、`HYHOJ_AI_TEST_RESULTS`，所在目录必须已存在），或与基准源文件比较（`HYHOJ_COUNT_TEST_SERVICE_BASELINE`、`HYHOJ_SUBMISSION_TEST_BASELINE`、`HYHOJ_PROBLEM_TEST_BASELINE`）。其他仅用于测试的变量：`TEST_JUDGE_GATEWAY_SOURCE` 和 `TEST_JUDGE_GATEWAY_RESULTS`（评测网关测试）、`HYHOJ_TEST_CHECKER_BINARY`（原生 checker 测试）、`HYHOJ_TEST_EVIDENCE_DIR`（AI 浏览器测试截图）、`LIBREOJ_ADMIN_TEST_SOCKET` 和 `LIBREOJ_TEST_NODE`（管理员脚本测试）、`LLMOJ_MARIADB_BINARY`（Fake 迁移测试使用的 `mariadb` 客户端），以及 `ENTRY_FIXTURE`、`TEST_DOCKER_FAILURE` 和 `TEST_DOCKER_EXPORT`（安装器测试的夹具）。

在 CI 中，一个可丢弃的 MariaDB 服务运行在 3307 端口，`deploy/test/setup-community-ci.mjs` 为每组测试创建单独的数据库和受限账号，并把配置写在 `RUNNER_TEMP` 下。它拒绝在 CI 之外运行；在本地请自行创建可丢弃的数据库。

### 升级迁移测试

`deploy/test/upgrade-migration.integration.mjs` 在真实数据库上测试注册数据迁移。先构建后端，准备一个可丢弃的 MariaDB，以及注册申请功能出现之前的单库 SQL 导出文件，然后：

```bash
UPGRADE_TEST_ALLOW_DATABASE_CREATION=1 \
UPGRADE_TEST_MARIADB_SOCKET=/var/tmp/llmoj-registration-test/mariadb/mysql.sock \
UPGRADE_TEST_BASELINE_SQL=/path/to/dump.sql \
node deploy/test/upgrade-migration.integration.mjs
```

socket 必须符合上面的格式；切换数据库或包含客户端命令的导出文件会被拒绝。它会创建并删除名为 `libreoj_upgrade_<16 位十六进制数>` 的数据库。没有设置这些变量时会输出 SKIP。

### 评测机与沙箱

```bash
pnpm --filter @libreoj/judge test:native
```

运行沙箱自身的检查，以及针对已安装站点的评测机自检：

```bash
sudo systemd-run --wait --pipe --collect --property="Delegate=cpu memory pids" \
  --property=DelegateSubgroup=supervisor --property=OOMPolicy=continue \
  --working-directory="$PWD" "$(command -v node)" packages/simple-sandbox/demo/demo.js
sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh
```

原生代码有修改时，CI 会运行原生测试和这个演示程序。

### AI

默认的 AI 测试使用模拟的模型、数据库和沙箱，不需要凭据或沙箱镜像。夹具检查会用本机的 C++ 编译器编译几个小程序。真实的编译、资源限制和协议执行需要可丢弃的后端和评测机。见 [AI 测试说明](apps/backend/src/ai/README.md)和[测试数据验证](wiki/AI.zh-CN.md#测试数据验证与覆盖)。

### 在浏览器中检查

修改页面后，请在桌面和手机宽度、中英文两种语言下检查，包括空列表、长内容和宽表格的横向滚动。

## 源码包

```bash
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

它只根据 Git 跟踪的文件生成本地文件，不会提交、推送或发布。见[发布](wiki/Publishing.zh-CN.md)。
