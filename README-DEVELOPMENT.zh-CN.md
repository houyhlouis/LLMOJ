# 开发说明

[English](README-DEVELOPMENT.md) | 简体中文

LLMOJ 基于 [LibreOJ](https://github.com/libreoj/libreoj)，采用 MIT 许可证；请保留所有组件的声明。功能介绍和安装方法见 [README](README.md) 和 [Wiki](wiki/Home.md)。

## 工具链

- Node.js 24.21（`.node-version`；安装时严格使用 24.21.0），以及 pnpm 11.13.1（`package.json` 的 `packageManager`）。其他固定的版本、尚未升级的部分以及如何检查依赖的安全通告，见[依赖与工具链](wiki/Dependencies.zh-CN.md)。
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

```bash
pnpm test
```

通过 [deploy/test/run-tests.mjs](deploy/test/run-tests.mjs) 运行所有测试，最后输出汇总。指定分组可以只运行这些分组，例如 `pnpm test backend frontend`：`ai`、`judge`、`backend`、`frontend`、`deploy` 和 `wiki`。请先构建（`pnpm build`）：数据库结构和 API 契约测试读取构建好的后端。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）用 `--ci` 运行相同的列表，但不包括需要 Ubuntu 26.04 的 Python 和系统工具的部署测试；这些测试在这样的机器上用 `pnpm test` 运行。

需要本机缺少的条件的测试会跳过相应用例，汇总会列出缺少什么：

- **MariaDB：** 下面的[数据库测试](#数据库测试)需要设置各自的变量；
- **redis-server**，用于评测队列和 Redis 测试；
- **root**，用于部署测试中创建账户、挂载文件系统或运行服务的用例。运行器在可以时使用免密码的 `sudo`（与 CI 相同），并用 `-B` 运行 Python，以免在源码树中出现属于 root 的缓存文件；
- **MinIO**（`LLMOJ_MINIO_BINARY`，或某个安装的 `runtime/minio`），用于上传封存测试和备份检查器的内容检查；
- **`TMPDIR` 中 2 GiB 空间**，用于 AI 测试的 ZIP 归档。临时目录较小时，运行器改用 `/var/tmp`；
- **Chrome 或 Chromium**（`LLMOJ_TEST_CHROME`，或 `PATH` 中的 `google-chrome` 或 `chromium`），用于检查站点会移除旧 bootstrap service worker 的测试。测试以无界面方式、不带沙箱运行浏览器，只打开本地测试页面。

这些测试使用临时目录和模拟的服务：它们不能代替在真实 Ubuntu 服务器上试装或试升级。

### 数据库测试

名为 `*.mariadb.test.*` 的测试（以及少数其他测试）使用真实的 MariaDB。除非对应的变量指向一个包含 `services.database` 的私有 YAML 文件（注册测试为 JSON 文件），否则会被跳过。被跳过的测试不能证明任何事情。

**只能让它们使用可以丢弃的数据库**：它们会创建和删除表，有些还要求数据库为空。绝不能使用生产数据库、数据或登录会话。共用同一个数据库的测试请依次运行。

| 变量 | 测试 |
| --- | --- |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | `discussion/discussion-{boundaries,visibility,solutions}.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | `problem/problem-mutations.mariadb.test.cjs`, `study-list/study-list.mariadb.test.cjs` |
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
| `LLMOJ_OPERATIONS_TEST_DB_CONFIG` | `metrics/operational-metrics.mariadb.test.cjs`、`contest/contest-score-revision.mariadb.test.cjs`、`ai/ai-execution.mariadb.test.cjs`（会删除其中所有数据表） |
| `LLMOJ_SCHEMA_TEST_DB_CONFIG` | `deploy/test/initialize-schema.test.mjs` |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | `auth/registration-review.mariadb.test.cjs`、`site-management/registration-settings.mariadb.test.cjs` |

`apps/backend/src/` 下的路径做了缩写。`LLMOJ_REGISTRATION_TEST_DATABASE` 指向一个包含 `socketPath`、`database`、`username` 和可选 `password` 的 JSON 文件；socket 必须符合 `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` 或 `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`，数据库名必须以 `llmoj_registration_test` 或 `test_registration_v2` 开头。

部分测试还可以把结果写入文件（`HYHOJ_DISCUSSION_TEST_EVIDENCE`、`HYHOJ_COUNT_TEST_RESULTS`、`HYHOJ_SUBMISSION_TEST_OUTPUT`、`HYHOJ_PROBLEM_TEST_REPORT`、`LLMOJ_TEAM_TEST_REPORT`、`HYHOJ_AI_TEST_RESULTS`，所在目录必须已存在），或与基准源文件比较（`HYHOJ_COUNT_TEST_SERVICE_BASELINE`、`HYHOJ_SUBMISSION_TEST_BASELINE`、`HYHOJ_PROBLEM_TEST_BASELINE`）。其他仅用于测试的变量：`TEST_JUDGE_GATEWAY_SOURCE` 和 `TEST_JUDGE_GATEWAY_RESULTS`（评测网关测试）、`HYHOJ_TEST_CHECKER_BINARY`（原生 checker 测试：另一个已构建的 `builtin_checker` 程序）、`HYHOJ_TEST_EVIDENCE_DIR`（AI 浏览器测试截图）、`LIBREOJ_ADMIN_TEST_SOCKET` 和 `LIBREOJ_TEST_NODE`（管理员脚本测试）、`LLMOJ_MARIADB_BINARY`（Fake 迁移测试使用的 `mariadb` 客户端），以及 `ENTRY_FIXTURE`、`TEST_DOCKER_FAILURE` 和 `TEST_DOCKER_EXPORT`（安装器测试的夹具）。

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

### 通行密钥

[webauthn-conformance.test.cjs](apps/backend/src/auth/two-factor/webauthn-conformance.test.cjs) 用 W3C 测试向量、必须被拒绝的改动副本，以及一个软件验证器的流程（[webauthn-fixtures.cjs](apps/backend/src/auth/two-factor/webauthn-fixtures.cjs)）检查站点的 WebAuthn 验证器。如需评估其他实现（例如有人维护的库），为 [webauthn.ts](apps/backend/src/auth/two-factor/webauthn.ts) 中的 `WebAuthnVerifier` 接口编写适配器，并用同样的用例运行。只有在结果一致，或每处差异都已弄清时才替换验证器：库通常还会检查证明（attestation），而本站点不要求证明；库也可能接受嵌入其他站点框架中的流程，而本站点会拒绝。

### 在浏览器中检查

修改页面后，请在桌面和手机宽度、中英文两种语言下检查，包括空列表、长内容和宽表格的横向滚动。页面针对[受支持的浏览器](wiki/Dependencies.zh-CN.md#受支持的浏览器)构建。

每个控件还必须只用键盘就能操作（见[键盘与读屏软件](wiki/Accessibility.zh-CN.md)）：

- **可点击的元素：** Semantic UI 会把只有 `onClick` 的 `Menu.Item`、`Label` 或 `Icon` 渲染成 Tab 无法到达的元素。请在其上展开 `@/utils/keyboard` 中的 `actsAsButton`，并给图标加上 `aria-label`。
- **由 `Dropdown.Item` 子元素组成的下拉菜单**（而不是 `options`）需要 `keyboardMenu`，这样才能用方向键和 Enter 选择其中的选项。
- **给读屏软件的消息：** 用 `@/utils/announce` 中的 `announce()` 读出。通知（toast）已经会被读出。

`packages/frontend/test/keyboard-access.test.cjs` 会对既没有 `actsAsButton` 也没有 `keyboardMenu` 的可点击元素报错。`locale-parity.test.cjs` 会对只存在于一种语言的消息、或丢失了占位符的翻译报错。

## 源码包

```bash
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

它只根据 Git 跟踪的文件生成本地文件，不会提交、推送或发布。见[发布](wiki/Publishing.zh-CN.md)。
