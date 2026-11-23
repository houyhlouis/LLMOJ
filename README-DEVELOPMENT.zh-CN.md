# 开发说明

[English](README-DEVELOPMENT.md) | 简体中文

LLMOJ 基于 [LibreOJ](https://github.com/libreoj/libreoj)，采用 MIT 许可证；请保留所有组件的声明。功能介绍和安装方法见 [README](README.md) 和 [Wiki](wiki/Home.md)。

## 工具链

- Node.js 24.21（`.node-version`；安装时严格使用 24.21.0），以及 pnpm 11.13.1（`package.json` 的 `packageManager`）。其他固定的版本、尚未升级的部分以及如何检查依赖的安全通告，见[依赖与工具链](wiki/Dependencies.zh-CN.md)。
- 评测机的原生代码需要：amd64 或 arm64 上的 Linux、CMake、C++ 编译器和 libfmt。C 与 C++ 提交按评测机的架构编译（`apps/judge/src/architecture.ts`）；arm64 没有 32 位工具链。
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

## Redis 锁

`LockService`（`apps/backend/src/redis/lock.service.ts`）和 `LockLease`（`apps/backend/src/redis/lock-lease.ts`）把互斥锁和读写锁统一为带所有权的租约：

- **租约窗口：** 每次加锁的租期为 5 秒，每 2.5 秒续约一次；后端只在过期前 100 毫秒为止视其有效，时间从上一次成功的加锁或续约请求发出时起算。锁命令使用独立的 Redis 连接，命令超时为 2.5 秒，且不启用离线队列或重发。
- **失锁与写入防护：** 续约失败、被拒绝、锁连接断开、租约有效窗口到期或后端关闭时，即视为失锁：续约停止，租约的 `AbortSignal` 触发，操作以 `LockLeaseLostError`（HTTP 500 `LOCK_LEASE_LOST`）结束。仍在继续执行的回调无法写入：
  - `LockLeaseSubscriber`（`apps/backend/src/redis/lock-lease.subscriber.ts`）在查询前检查本地截止时间（仍允许 `ROLLBACK` 和 TypeORM 保存点回滚），并在事务提交以及自动提交的非 `SELECT` 语句前向 Redis 核验锁所有权；
  - 通过 `writeWithLockLeases`（`apps/backend/src/redis/lease-redis-command.ts`，`RedisService.cacheDelete` 也使用它）执行的 Redis 写入会在同一段 Lua 脚本中原子核验外层所有租约；
  - `FileService` 中受锁保护的对象存储写入会在发往 MinIO 前重新核验 Redis 所有权和本地截止时间。
  回调会收到租约对象（`lease.signal`、`lease.assertHeld()`）；嵌套锁会继承外层的所有租约。
- **编写新代码的规则：** 受锁保护的修改应把 SQL 和提交放在同一个事务中（否则等待行锁的自动提交语句可能在失锁后才完成）；持锁期间的 Redis 和对象存储写入应通过上述带检查的辅助函数（`writeWithLockLeases`、`RedisService.cacheDelete`、`FileService`）；失锁后重试前请重新读取状态，因为在租约仍有效时已发出的步骤可能已经完成。
- **读写锁：** `apps/backend/src/redis/scripts/read-write-lock.lua`（键名为 `rwlock-v2:<name>:write-intent`、`rwlock-v2:<name>:write-lock`、`rwlock-v2:<name>:readers`）在 Redis 有序集合中为每个读者分配独立令牌，分值为其过期时间。租约过期的读者不能释放或续约其他读者的租约，异常终止的读者在租期到期后不再计入，等待中的写者仍优先于新读者。

## 在本机运行

`deploy/dev/stack.mjs` 为后端和前端开发服务器启动一套一次性的 MariaDB、Redis 和 MinIO，可选地添加示例数据，用完后再全部删除，不需要 root：见[本地开发](wiki/Development.zh-CN.md)。[使用 API](wiki/API.zh-CN.md) 介绍 HTTP API 的约定，[容量](wiki/Capacity.zh-CN.md#重复这项测量)介绍 `deploy/benchmark` 中的性能测试工具。

## 测试

```bash
pnpm test
```

通过 [deploy/test/run-tests.mjs](deploy/test/run-tests.mjs) 运行所有测试，最后输出汇总。指定分组可以只运行这些分组，例如 `pnpm test backend frontend`：`ai`、`judge`、`backend`、`frontend`、`deploy` 和 `wiki`。请先构建（`pnpm build`）：数据库结构和 API 契约测试读取构建好的后端。CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）用 `--ci` 运行相同的分组。

在任何测试开始之前，运行器会检查仓库中的每个测试文件恰好属于一个分组，或属于一条写明原因的排除规则（[deploy/test/suite-inventory.mjs](deploy/test/suite-inventory.mjs)）：新增的测试文件没有登记或被登记两次时，运行会停止。新测试请登记在 `deploy/test/run-tests.mjs` 中（MariaDB 测试还需要在 `deploy/test/setup-community-ci.mjs` 中加入其数据库）。部署测试也在那里分类并写明原因：可移植的以普通用户运行，需要 root 的通过 `sudo` 运行（CI 中也是），需要真实安装环境或单独准备的夹具的主机验收测试不在 CI 中运行。使用 `--ci` 时，缺少任何 CI 承诺提供的夹具（数据库变量、`redis-server`、仅监听套接字的 MariaDB 夹具 `LLMOJ_REGISTRATION_TEST_DATABASE` 和 `LIBREOJ_ADMIN_TEST_SOCKET`、可执行的 `LLMOJ_MINIO_BINARY`，或运行 `deploy` 所需的 root/`sudo`）都会在测试开始前停止运行；而五组承诺的服务测试（`registration-review.mariadb.test.cjs`、`registration-settings.mariadb.test.cjs`、`file-sealing.minio.test.cjs`、`bootstrap-admin.test.mjs` 和 `verify-backup.test.py`）中只要有用例被跳过（或执行数为 0），运行就会失败，而不再跳过。汇总会列出每个测试运行和跳过了多少用例，以及原因。

需要本机缺少的条件的测试会跳过相应用例，汇总会列出缺少什么：

- **MariaDB：** 下面的[数据库测试](#数据库测试)需要设置各自的变量，注册测试和 `bootstrap-admin.test.mjs` 的事务用例还需要一个私有的、仅监听套接字的 MariaDB（`deploy/test/with-service-fixture.py`）；
- **redis-server**，用于评测队列和 Redis 测试（包括 `apps/backend/src/redis/{read-write-lock,lock-caller-recovery,lock-pause,lock-lease.mariadb}.test.cjs`；`lock-lifecycle.test.cjs` 不需要它）；
- **root**，用于部署测试中创建账户、挂载文件系统或运行服务的用例。运行器在可以时使用免密码的 `sudo`（与 CI 相同；设置 `LLMOJ_TEST_NO_SUDO=1` 可让它完全不尝试），并用 `-B` 运行 Python，以免在源码树中出现属于 root 的缓存文件；
- **MinIO**（`LLMOJ_MINIO_BINARY`，或某个安装的 `runtime/minio`），用于上传封存测试和备份检查器的内容检查。CI 使用与安装器相同的固定、经校验和验证的 Go 1.26.8 与 MinIO 源码构建它（`deploy/minio-source.sh`、`deploy/test/build-minio.sh`），并按提交和构建配方缓存该可执行文件；
- **`TMPDIR` 中 2 GiB 空间**，用于 AI 测试的 ZIP 归档。临时目录较小时，运行器改用 `/var/tmp`；
- **Chrome 或 Chromium**（`LLMOJ_TEST_CHROME`，或 `PATH` 中的 `google-chrome` 或 `chromium`），用于检查站点移除旧 bootstrap service worker 的测试（`deploy/test/service-worker-retirement.test.mjs`）和比赛草稿浏览器测试（`packages/frontend/test/contest-drafts-browser.test.cjs`）。两者都以无界面方式、不带沙箱运行浏览器，只打开本地测试页面。

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
| `LLMOJ_JUDGE_INFO_CACHE_TEST_DB_CONFIG` | `problem/problem-judge-info-cache.mariadb.test.cjs`（更改类型后的评测设置缓存；还需要 `redis-server`） |
| `LLMOJ_STATISTICS_CACHE_TEST_DB_CONFIG` | `submission/submission-statistics-cache.mariadb.test.cjs`（练习统计缓存与迟到的读取；还需要 `redis-server`） |
| `LLMOJ_CONTEST_VIRTUAL_TEST_DB_CONFIG` | `contest/contest-virtual-start.mariadb.test.cjs`（开始虚拟参赛与同时进行的提交和修改；数据库 `llmoj_test_contest_virtual`，须为空） |
| `LLMOJ_DIAGNOSTIC_BUNDLE_TEST_DB_CONFIG` | `site-management/diagnostic-bundle.mariadb.test.cjs`（诊断包中的已保存任务、队列和评测机状态；数据库 `llmoj_test_diagnostic_bundle`，须为空；还需要 `redis-server`） |
| `LLMOJ_LOCK_LEASE_TEST_DB_CONFIG` | `redis/lock-lease.mariadb.test.cjs`（持锁租约在行锁等待、暂停和 Redis 重启下的行为；数据库 `llmoj_test_lock_lease`，须为空，JSON 配置；还需要 `redis-server`） |
| `LLMOJ_NARROW_WRITES_TEST_DB_CONFIG` | `user/user-narrow-writes.mariadb.test.cjs`、`submission/submission-visibility.mariadb.test.cjs`（在修改资料、邮箱和公开状态的同时并发修改数据；使用各自的随机数据表） |
| `LLMOJ_SCHEMA_TEST_DB_CONFIG` | `deploy/test/initialize-schema.test.mjs` |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | `auth/registration-review.mariadb.test.cjs`、`site-management/registration-settings.mariadb.test.cjs` |

`apps/backend/src/` 下的路径做了缩写。`LLMOJ_REGISTRATION_TEST_DATABASE` 指向一个包含 `socketPath`、`database`、`username` 和可选 `password` 的 JSON 文件；socket 必须符合 `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` 或 `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`，数据库名必须以 `llmoj_registration_test` 或 `test_registration_v2` 开头。

部分测试还可以把结果写入文件（`HYHOJ_DISCUSSION_TEST_EVIDENCE`、`HYHOJ_COUNT_TEST_RESULTS`、`HYHOJ_SUBMISSION_TEST_OUTPUT`、`HYHOJ_PROBLEM_TEST_REPORT`、`LLMOJ_TEAM_TEST_REPORT`、`HYHOJ_AI_TEST_RESULTS`，所在目录必须已存在），或与基准源文件比较（`HYHOJ_COUNT_TEST_SERVICE_BASELINE`、`HYHOJ_SUBMISSION_TEST_BASELINE`、`HYHOJ_PROBLEM_TEST_BASELINE`）。其他仅用于测试的变量：`TEST_JUDGE_GATEWAY_SOURCE` 和 `TEST_JUDGE_GATEWAY_RESULTS`（评测网关测试）、`HYHOJ_TEST_CHECKER_BINARY`（原生 checker 测试：另一个已构建的 `builtin_checker` 程序）、`HYHOJ_TEST_EVIDENCE_DIR`（AI 浏览器测试截图）、`LIBREOJ_ADMIN_TEST_SOCKET` 和 `LIBREOJ_TEST_NODE`（管理员脚本测试）、`LLMOJ_MARIADB_BINARY`（Fake 迁移测试使用的 `mariadb` 客户端），以及 `ENTRY_FIXTURE`、`TEST_DOCKER_FAILURE` 和 `TEST_DOCKER_EXPORT`（安装器测试的夹具）。

在 CI 中，一个可丢弃的 MariaDB 服务运行在 3307 端口，`deploy/test/setup-community-ci.mjs` 为每组测试创建单独的数据库和受限账号，并把配置写在 `RUNNER_TEMP` 下。它拒绝在 CI 之外运行；在本地请自行创建可丢弃的数据库。

CI 的 **Code** 任务还会通过 `deploy/test/with-service-fixture.py` 运行 `backend frontend` 和 `deploy`：它为每组测试启动一个私有的、仅监听套接字的 MariaDB（`registration` 使用限定到单库的账号，`admin` 使用套接字 root），校验服务器身份和关闭网络监听的状态，并在结束后销毁它；同时配合由 `deploy/test/build-minio.sh` 构建的固定版本 MinIO 可执行文件（`run-tests.mjs` 会通过 `sudo` 把它传给 `verify-backup.test.py`）。在本地用普通测试账号、配置好可丢弃的 `*_TEST_DB_CONFIG` 变量运行相同步骤（需要 `gnupg`、`mariadb-client`、`mariadb-server`、`nginx`、`python3-cryptography`、`python3-yaml`、`redis-server`、`libreoj` 系统用户，以及运行 `deploy` 所需的免密码 `sudo`）：

```bash
pnpm --filter @libreoj/judge-protocol build
pnpm --filter @libreoj/backend build
source deploy/minio-source.sh
export LLMOJ_MINIO_BINARY="${TMPDIR:-/var/tmp}/llmoj-minio-$MINIO_COMMIT/minio"
bash deploy/test/build-minio.sh "$LLMOJ_MINIO_BINARY"

python3 -B deploy/test/with-service-fixture.py registration -- node deploy/test/run-tests.mjs --ci backend frontend
python3 -B deploy/test/with-service-fixture.py admin -- node deploy/test/run-tests.mjs --ci deploy
```

### 升级迁移测试

`deploy/test/upgrade-migration.integration.mjs` 在真实数据库上测试注册数据迁移。它仍作为发布主机验收测试，而不在 CI 中运行：仓库不跟踪独立、未经改动的注册功能前 SQL 导出文件，而从当前 TypeORM 实体倒推建表语句会默认采用如今的列类型、索引和关联，无法验证真实的历史数据库结构。

先构建后端，准备一份可信的、合成的注册功能前单库 SQL 导出文件（包含一个合成管理员账号），记下其 SHA-256 摘要，然后以普通账号通过包装脚本运行：

```bash
BASELINE=/var/tmp/llmoj-registration-fixture/baseline.sql
sha256sum "$BASELINE"
python3 -B deploy/test/with-service-fixture.py --baseline "$BASELINE" migration
```

包装脚本会创建一个符合 `llmoj-registration-*` 布局的全新私有、仅监听套接字的 MariaDB，设置 `UPGRADE_TEST_MARIADB_SOCKET`、`UPGRADE_TEST_ALLOW_DATABASE_CREATION=1` 和 `UPGRADE_TEST_BASELINE_SQL`，运行 `upgrade-migration.integration.mjs`（16 个用例，含升级器的文件大小归一化检查），并在结束后销毁该数据库实例。切换数据库或包含客户端命令的导出文件会被拒绝。它会创建并删除名为 `libreoj_upgrade_<16 位十六进制数>` 的数据库。直接运行 `upgrade-migration.integration.mjs` 而未设置这些变量时会输出 SKIP。

### 评测机与沙箱

```bash
pnpm --filter @libreoj/judge test:native
node --test packages/simple-sandbox/test/cgroup-events.test.mjs
```

第二条命令会围绕沙箱的 cgroup 事件等待函数编译一个小的 C++ 程序，检查它在事件文件格式错误时也会关闭描述符（需要 g++ 和 libfmt，缺少时跳过）。`pnpm test` 的 judge 组也会运行它，以及检查原生调用失败时沙箱清理的 `packages/simple-sandbox/test/sandbox-process.test.cjs`。

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
