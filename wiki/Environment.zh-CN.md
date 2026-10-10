# 环境变量、构建与维护工具

[English](Environment.md) | 简体中文 | [配置总览](Configuration.zh-CN.md)

以下按读取位置分类。环境变量名保留历史 `LIBREOJ_`、`HYHOJ_` 和 `OJ_` 前缀；不能自行统一命名。在终端 `export` 不会改变 systemd 已运行服务的环境；服务配置需 drop-in、daemon-reload 和重启。不要把秘密值粘贴到诊断输出中。

## 服务运行环境

| 变量 | 含义与默认值 |
| --- | --- |
| `LIBREOJ_CONFIG_FILE` | 后端必填：完整 YAML 路径（建议绝对路径）；安装器设为 `<root>/config/backend.yaml` |
| `LIBREOJ_JUDGE_CONFIG_FILE` | 评测端必填：完整 YAML 路径；安装器设为 `<root>/config/judge.yaml` |
| `LIBREOJ_JUDGE_LOG_LEVEL` | 评测日志级别，缺省 `info`；采用 Winston 等级（如 error、warn、info、debug） |
| `LIBREOJ_SCHEMA_SYNC` | 值恰为 `0` 时禁止后端启动时自动同步数据库结构；未设或其它值保留旧行为。升级器先执行受控迁移，再用独立 systemd drop-in 固定为 0；不要靠开启自动同步绕过升级检查。 |
| `LIBREOJ_LOG_SQL` | 后端 SQL 日志；任意非空字符串都开启，包括 `0` 和 `false`；关闭应移除或留空 |
| `NODE_ENV` | 服务设为 `production`；后端仅输出 warn/error 等生产日志；也影响前端构建模式 |
| `NODE_OPTIONS` | 服务生成值 `--max-old-space-size=512`，构建脚本设为 `--max-old-space-size=2300`；单位 MiB，仅 V8 堆，不是总进程或沙盒上限 |
| `UV_THREADPOOL_SIZE` | 评测必须按执行槽同步配置，至少 `2 × 槽数 + 2`；生成器用 `max(4, 2N+2)`；见评测配置 |
| `TMPDIR` | 后端生成值 `<root>/data/tmp`；目录须对 libreoj 用户可写 |
| `PATH` | systemd 显式把实例的 `runtime/node/bin` 放在前面；交互终端的 Node 版本不能代表服务版本 |
| `LIBREOJ_MIGRATION_CONFIG_FILE` | 存在时后端改为执行旧站迁移而非 HTTP 服务；单次离线工具，见下表 |

AI 运行变量 `HYHOJ_AI_STATE_DIR`、`HYHOJ_AI_GENERATED_DIR`、`HYHOJ_AI_SAMPLE_INPUTS_DIR`、`HYHOJ_AI_RUNNER_SOCKET` 与共享 `HYHOJ_ARCHIVE_WORK_DIRECTORY` 的完整目录、权限和服务归属见 [AI 环境](AI-Environment.zh-CN.md)。`HYHOJ_AI_PRIVATE_HOSTS` 已无生产读取点，不是当前 URL 放行开关。

## 安装与配置生成器

这些是辅助程序输入，并不覆盖已存在的私有配置。

| 变量 | 用途 |
| --- | --- |
| `HYHOJ_ROOT` | 生成器实例目录，缺省 `/opt/LibreOJ`；不迁移现有文件 |
| `NODE_BINARY` | 生成器 Node 绝对路径，缺省 `<root>/runtime/node/bin/node` |
| `HYHOJ_PORT` | 网页生成器端口，缺省 `80`；本机评测配置生成时也读取 |
| `HYHOJ_PUBLIC_ORIGIN` | 网页生成器 origin；缺省回环 HTTP 地址，非 80 时附带端口；安装入口会传入检测／指定值 |
| `OJ_LISTEN_ADDRESS` | `configure-local.py` 缺省 `0.0.0.0`；另可 `127.0.0.1` |
| `OJ_INSTALL_ROLE` | 生成器缺省 `all`，另可 `web`；不是安装后在线切换开关 |
| `OJ_SITE_NAME` | 生成器和本地前端构建标题，缺省 `LLMOJ`；已有后端 YAML 保留 |
| `OJ_JUDGE_REMOTE` | 评测生成器只有值 `1` 表示远程，其余为本机；缺省 `0` |
| `OJ_JUDGE_SERVER` | 远程模式必填 HTTP(S) 站点 origin；本机内部连接自动生成 |
| `OJ_JUDGE_KEY_FILE` | 远程模式必填，root 所有且 0600 的绝对路径文件；内容为节点密钥 |
| `OJ_JUDGE_SLOTS` | 首次评测生成显式正整数槽数；变量不存在时为 `max(1, 有效 CPU-2)`，环境值 `0` 会报错；CPU／内存及 511 上限校验，已有 YAML 不被覆盖 |
| `HYHOJ_JUDGE_SLOTS` | 兼容旧名；仅没有 `OJ_JUDGE_SLOTS` 时读取，限制相同 |
| `LLMOJ_INSTALL_LANG` | 安装／辅助工具语言：`zh-CN` 中文，其他值走英文；中英文入口会选定语言 |
| `OJ_SOURCE_REPOSITORY` | 下载入口写入源仓库元数据；内部记录用途，不是认证信息或运行参数 |
| `OJ_SOURCE_COMMIT` | 下载入口解析后的源提交记录；不是覆盖现有安装版本的开关 |
| `LIBREOJ_ROOT` | 仅管理员初始化工具的根目录后备值，缺省 `/opt/LibreOJ`；`--root` 优先 |
| `INVOCATION_ID / JOURNAL_STREAM` | systemd 自动注入；管理员工具据此避免向后台服务日志打印凭据，不应手动伪造 |

## 构建、rootfs 与可选旧发布路径

| 变量 | 用途 |
| --- | --- |
| `HYHOJ_PUBLIC_DIR` | 本地前端输出目录，缺省 `<root>/public`；不修改 Nginx root |
| `HYHOJ_QUOTE_FILE` | 可选本地语录 JSON 文件（需合法授权）；省略则不提供旧 hitokoto 资源 |
| `PNPM_BINARY` | 本地前端脚本 `--build` 使用的 pnpm 命令／路径，缺省 `pnpm` |
| `CMAKE_BUILD_PARALLEL_LEVEL` | 原生扩展构建并行度；安装脚本固定设置为 `2` |
| `npm_config_nodedir` | 原生扩展 Node 头文件根路径；安装器设为 `<root>/runtime/node` |
| `pnpm_config_verify_deps_before_run` | 安装器设为 `false`，控制 pnpm 运行前依赖校验 |
| `RUNTIME_DIRECTORY` | rootfs 包装构建脚本运行目录，缺省 `<repo>/runtime` |
| `OUTPUT_DIRECTORY` | 包装脚本缺省 `<runtime>/sandbox-archives`；直接运行 infra 构建脚本缺省其 `dist` |
| `LIBREOJ_X32_SUPPORTED` | rootfs 主机测试只接受 `0`／`1`；缺省 `1`，安装器设 `0` 跳过宿主 x32 执行测试；并非禁用所有沙盒测试 |
| `ARCHIVE / CHECKSUM / DESTINATION_PARENT` | rootfs stage 脚本必填的归档、校验文件和目标父目录绝对路径；包装脚本通常自动传入 |
| `BUILDX_BUILDER` | Docker Buildx 自身的 builder 选择变量，远程教程使用；LLMOJ 不定义它的默认值 |
| `CLOUDFLARE_WORKER_NAME / CLOUDFLARE_ACCOUNT_ID` | 可选旧 bootstrap-cloudflare 配置生成必填；不用于一键安装 |
| `ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET / ALIYUN_OSS_BUCKET / ALIYUN_OSS_ENDPOINT` | 可选旧 bootstrap-static OSS 发布必填；执行会向外部存储上传，不用于一键安装 |

`NODE_OPTIONS`、`CMAKE_BUILD_PARALLEL_LEVEL`、`npm_config_nodedir`、`pnpm_config_verify_deps_before_run` 在一键安装中会被脚本显式设置，不能把外层同名变量当作安装器覆盖接口。`ROOTFS_ID` 是配方内容哈希生成的构建参数，不是可随意配置的版本号。Shell 自带变量、编译器／依赖工具的全部通用变量不逐项复制；例如补丁里的 `DEBUG` 属于 Vite 插件诊断。测试专用变量见 AI 环境页，不能当作生产配置。

## 部署测试专用环境

`LIBREOJ_ADMIN_TEST_SOCKET` 为管理员初始化集成测试指定 MariaDB socket，未设置则跳过该测试；启用后会访问测试数据库。`LIBREOJ_TEST_NODE` 为管理员输出测试选择 Node，缺省从 PATH 查找。`ENTRY_FIXTURE`、`TEST_DOCKER_FAILURE`、`TEST_DOCKER_EXPORT` 是部署测试内部桩使用的目录／故障开关／导出文件，不影响生产安装。AI 和后端集成测试变量见 [AI 环境](AI-Environment.zh-CN.md)。

`HYHOJ_TEST_CHECKER_BINARY` 仅供原生 token checker 测试选择 `.node` 文件，缺省 `../../build/Release/builtin_checkers.node`；不会更改生产 judge 使用的检查器。

下表补充其他后端回归测试的变量，均不是生产配置。数据库测试会创建、修改并在结束时清理随机前缀表；应明确选择可丢弃的测试数据库，这些 CJS 测试不统一强制 `hyhoj_test_*` 名称。结果文件的父目录须预先存在且可写；未设置输出路径时，不写该 JSON 文件。

| 变量 | 默认 / 用途 | 读取它的测试 |
| --- | --- | --- |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | 审核并发集成测试的私有 JSON，含隔离 socket 与测试库连接；未设则跳过；详见开发文档 | `registration-review.mariadb.test.cjs` |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | 含 `services.database` 的后端 YAML 路径；未设置则跳过真实 MariaDB 讨论边界测试 | `discussion-boundaries.mariadb.test.cjs` |
| `HYHOJ_DISCUSSION_TEST_EVIDENCE` | 可选 JSON 证据文件路径，记录边界用例及临时表清理结果 | 同上 |
| `HYHOJ_COUNT_TEST_SERVICE_BASELINE` | 可选基线源码根目录；保留 `apps/backend/src/...` 层级，只替换加载的 `discussion.service.ts`、`group.service.ts`；未设置使用当前源码 | `group-discussion-counts.mariadb.test.cjs` |
| `HYHOJ_COUNT_TEST_DB_CONFIG` | 含 `services.database` 的 YAML 路径；未设置则跳过真实 MariaDB 计数并发测试 | 同上 |
| `HYHOJ_COUNT_TEST_RESULTS` | 可选 JSON 结果文件路径，记录计数用例及临时表清理结果 | 同上 |
| `HYHOJ_SUBMISSION_TEST_BASELINE` | 可选 `submission.service.ts` 基线文件路径；未设置使用当前文件，其他模块仍用当前源码 | `submission-delete.mariadb.test.cjs` |
| `HYHOJ_SUBMISSION_TEST_DB_CONFIG` | 含 `services.database` 的 YAML 路径；未设置则跳过真实 MariaDB 提交删除/计数测试 | 同上 |
| `HYHOJ_SUBMISSION_TEST_OUTPUT` | 可选 JSON 结果文件路径 | 同上 |
| `HYHOJ_PROBLEM_TEST_BASELINE` | 可选 `problem.service.ts` 基线文件路径；未设置使用当前文件，其他模块仍用当前源码 | `problem-mutations.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | 含 `services.database` 的 YAML 路径；未设置则跳过真实 MariaDB 题目修改/文件所有权测试 | 同上 |
| `HYHOJ_PROBLEM_TEST_REPORT` | 可选 JSON 报告文件路径 | 同上 |
| `TEST_JUDGE_GATEWAY_SOURCE` | 可选网关源码文件路径，默认测试同目录的 `judge.gateway.ts`；提取真实方法体并用模拟 socket/队列执行，不连接线上 judge 或 Redis | `judge-gateway.test.cjs` |
| `TEST_JUDGE_GATEWAY_RESULTS` | 可选 JSON 证据文件路径，包含源码哈希和用例记录 | 同上 |
| `SWC_NODE_PROJECT` | `@swc-node/register` 的 TypeScript 配置定位变量；本仓库隐私测试**主动覆盖**为 `<源码根>/apps/backend/tsconfig.json`，并非该测试提供的外部覆盖开关，也不是生产服务配置 | `config-privacy.test.cjs` |

对应源码：[讨论边界](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/discussion/discussion-boundaries.mariadb.test.cjs)、[讨论/小组计数](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/group/group-discussion-counts.mariadb.test.cjs)、[提交删除](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/submission/submission-delete.mariadb.test.cjs)、[题目修改](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/problem/problem-mutations.mariadb.test.cjs)、[评测网关](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/judge/judge-gateway.test.cjs)、[私有配置诊断](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config-privacy.test.cjs)。

## 旧站迁移配置

`LIBREOJ_MIGRATION_CONFIG_FILE` 指向的文件包含 `database.host`（字符串）、`database.port`（数字）、`database.username`、`database.password`、`database.database`（均字符串）及 `uploads`（字符串，旧站附件路径）。这些字段无接口默认值。迁移入口会执行数据转换和写入，不能在正常后端服务中长期启用；它不等于当前版本升级。

## 维护脚本参数索引

| 工具 | 参数与作用 |
| --- | --- |
| `upgrade.zh-CN.sh` / `upgrade.sh` → `deploy/upgrade.sh` | `--prefix`、`--plan`、`--ref`、`--source`、`--source-sha256`、`--apply --drained`、`--rollback BACKUP --drained`；完整兼容范围、维护确认与回滚规则见 [升级教程](Upgrade.zh-CN.md) |
| `deploy/resize-judge.sh`（实现 `resize-judge.py`） | 已有 judge 的正式维护入口；`--prefix`（默认 `/opt/LibreOJ`）、`--slots`、`--plan`、`--apply --drained`、`--rollback PRIVATE_BACKUP --drained`、`--mode auto\|all\|remote`；默认中文交互，详情见 [扩缩容教程](Judge-Configuration.zh-CN.md) |
| `deploy/judge_capacity.py` | 只读容量检查；`--remote`、`--json`、`--slots N`；读取 affinity/cgroup/内存，不创建工作目录或改变服务 |
| `deploy/initialize-mariadb.py` | 内部安装工具，必填 `--root`；使用 mysql 身份暂存初始化及系统表验证，已有非空数据库保留并验证；不是在线升级/重置接口 |
| `deploy/bootstrap-admin.mjs` | `--root`、`--config`、`--email`、`--show-credentials`；root 优先于 `LIBREOJ_ROOT`，config 优先于 `LIBREOJ_CONFIG_FILE`；email 默认 `admin@localhost.invalid`，仅初始化；显示凭据前核验，不是重置密码接口 |
| `deploy/bootstrap-services.mjs` | `--root` 必填；`--phase storage\|judge\|verify-judge` 必填；`--help`；用于创建存储、登记本机评测或检查连接 |
| `deploy/sandbox/verify-installed.mjs` | 可选 `--root`（默认 `/opt/LibreOJ`）；会运行真实沙盒探针，不是无副作用的 YAML 校验 |
| `deploy/build-frontend-offline.mjs` | `--assets-only` 只准备依赖；`--build` 先构建；省略则发布已有 dist；见前端页 |
| `deploy/docker-support.py` | `--source` 默认官方源；`--mirrors` 默认空；`--configure` 合并写入镜像配置（不自行重启 Docker），省略仅校验参数 |
| `deploy/install-support.py` | 内部阶段 `validate`、`preflight`、`claim`、`permissions`、`apparmor`、`database`、`verify-network`、`finish`；`--root`、`--origin`、`--port` 必填，另有 `--listen`、`--role`、`--site-name`、`--docker-source`、`--docker-mirrors`、`--judge-slots`，与安装入口同义；不要单独运行阶段来升级 |
| `deploy/sandbox/build.sh` | 位置参数 `plan`（默认）、`build` 或 `stage ABS_ARCHIVE`；环境变量见上表 |
| `deploy/export-wiki.py` | 必填 `--repository OWNER/REPO`、`--output DIR`；只导出本地文档，见发布页 |
| `deploy/prepare-github.py` | 可选 `--archive PATH`；源码发布筛选／打包工具，需可读取 Git 清单；已有归档不覆盖 |
| `deploy/backup.sh` | 无参数；当前固定 `/opt/LibreOJ`，停服务、备份后恢复 target；自定义安装目录不能直接照用 |

核对来源：[deploy/configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py), [deploy/configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [deploy/install.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install.sh), [deploy/build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/build-frontend-offline.mjs), [apps/backend/src/main.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/main.ts), [apps/backend/src/migration/migration-config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/migration/migration-config.schema.ts), [apps/judge/src/config.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/config.ts).

新增容量检查、数据库初始化和扩缩容工具属于待提交修订；相关 `main` 链接须在发布后对应部署版本。
