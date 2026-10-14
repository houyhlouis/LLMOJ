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

`HYHOJ_*` 是二次开发早期采用的内部环境变量名，暂时保留以兼容已有功能代码；它们不控制站点展示名称。新部署默认目录为 `/opt/LLMOJ`，可用显式 prefix 保留已有实例目录；服务使用 `libreoj-*`，站名由 `--site-name` / `OJ_SITE_NAME` 设置。

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

## 测试数据校验回归

在仓库根目录运行后端工作流及评测侧质量校验测试：

```bash
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
node --test apps/judge/src/aiQuality.test.cjs
```

CI 会运行这两套测试，以及现有 Wiki 导出与导航检查。默认测试使用模拟模型服务、数据库或沙盒接口，不需要生产凭据和 rootfs；可选数据库测试未配置时会跳过。后端测试覆盖质量计划、旧任务恢复、独立生成请求和发布门槛；评测侧测试覆盖对拍、判题器、多种合法输出、慢算法判定和反例替换。 新增的集成夹具离线测试会用本机 C++ 编译器在临时目录中验证固定的合成程序；它不连接数据库或模型服务。

真实编译、资源限制和协议执行需要另行配置隔离后端与评测环境，不能用上述 mock 结果替代。使用小规模可独立求解的样例、错误标程、存活候选、多解题和最坏情况构造检查端到端行为；慢算法应在小数据上正确、只在正式数据上因实际时间或内存限制被拦截。执行条件见 [AI 模块测试说明](apps/backend/src/ai/README.md)，生成流程及验证报告见 [使用说明](wiki/AI.zh-CN.md#测试数据验证与覆盖)。

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

## 私人团队、题解、Hack 与 NOI Self Eval 回归

共享协议、评测处理器、后端和前端必须一起构建与检查。合并版赛制只有 NOI / OI、IOI、ICPC 和严格 IOI；Self Eval 仅在启用开关的 NOI / OI 比赛题目页提供。CI 新增讨论、进度、文件、比赛计分和严格社区迁移回归；相关文件见 apps/backend/src/team、src/discussion、src/submission、src/file 和 deploy/test/community-*。升级编排测试使用临时根目录和模拟服务。

默认 CI 的 Code 任务会在 3307 端口启动可丢弃的 MariaDB 服务。`deploy/test/setup-community-ci.mjs` 创建独立测试库及各自仅有本库权限的账户，将私有配置写入 `RUNNER_TEMP`，启用团队、题解、Fake、题目／提交事务和迁移的真实数据库回归。数据库套件串行执行，任务结束后销毁服务。CI 还会创建根目录升级测试所需的 `libreoj` 组。该流程不会执行完整安装、真实 systemd 维护切换或原生判题。

在仓库根目录执行以下构建和隔离编排检查：

```bash
pnpm --filter @libreoj/judge-protocol run build
pnpm --filter @libreoj/judge run check-types
node apps/judge/src/task/hack/hack.test.cjs
node apps/judge/src/task/self-eval/self-eval.test.cjs
node --test apps/backend/src/hack/hack-reference.test.cjs
node --test apps/backend/src/self-eval/self-eval-noi.test.cjs apps/backend/src/self-eval/self-eval-list.test.cjs
node --test apps/backend/src/contest/contest-rules.test.cjs
pnpm --filter @libreoj/backend run build
pnpm --filter @libreoj/frontend run check-types
node --test deploy/test/community-schema.test.mjs
sudo python3 deploy/test/community-upgrade.test.py
sudo python3 deploy/test/community-runtime-upgrade.test.py
node --test apps/backend/src/self-eval/self-eval.mariadb.test.cjs
python3 deploy/test/wiki-export.test.py
```

本机开发仍须显式准备专用可丢弃库和低权限测试账户，不能提供生产连接。CI 配置脚本拒绝普通本机调用，不会自动创建本机测试环境。YAML/JSON 配置形状为 services.database；各套件通过 LLMOJ_TEAM_TEST_DB_CONFIG、LLMOJ_TEAM_AUDIT_DB_CONFIG、LLMOJ_FAKE_TEST_DB_CONFIG、HYHOJ_DISCUSSION_TEST_DB_CONFIG、HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG、HYHOJ_PROBLEM_TEST_DB_CONFIG 或 HYHOJ_SUBMISSION_TEST_DB_CONFIG 显式启用。完整 metadata 测试要求其代码白名单内的空测试库，并在结束清理；Team workflows 也要求空库，不能和其它测试并行共用。未启用时的 skipped 不算数据库验收。

重点检查团队列表始终仅含自己的成员身份或待审申请、未知用户不能按链接读取团队详情、免审核团队仍不在公共目录出现、申请人只能查看或撤回自己的申请，以及退团/归档后作者与公开标记不绕过私有边界、事务内撤权和锁顺序、截止时间及 Fake 计分、旧评测回调不能覆盖 Fake、源题数据复制隔离、上传实际大小与空间、分页、My Discussions 分类、迁移重跑和异常结构拒绝。完整升级脚本模拟与隔离数据库验证不等同于真实 Ubuntu/systemd 维护切换验收。

Hack 列表及固定预测试自测的数据库回归通过 LLMOJ_SELF_EVAL_TEST_DB_CONFIG 指向专用可丢弃 YAML 配置；同一连接的套件必须串行执行。回归覆盖全场共享配额、并发计数、隐藏预测试、NOI-only 与赛前准备限制、非选手数据泄露、回调幂等与失败恢复；无配置的 skipped 不算验收。

隔离浏览器检查应覆盖个人主页“我的团队”、编号加入与审核中的有限视图、题目页内题解及“我的讨论”。Hack 检查八列、筛选与 My hacks、空表样式、普通和比赛提交的详情入口、列表没有 Hack 按钮、STD 编辑器与已通过提交快捷设为 STD。Self Eval 检查仅 NOI 比赛出现开关和题目按钮、普通题与提交详情无入口、make/std 编辑器与正式 SPJ、AI 重生成正式数据并绑定同版源码、全场次数和结果隐私。桌面与手机都应核对居中、间距、横向滚动和代码编辑器宽度。

新运行代码由 deploy/community-runtime-contract.json 固定旧、新哈希，升级器另外固定合同哈希。只有合同中逐项审查的协议／评测文件可以过渡，原生程序、依赖和 rootfs 保持兼容要求。十二张社区表、首版 Hack 表的可空 STD 内容字段追加、两个比赛字段和八个新权限由严格合同校验；使用前见 [社区功能升级](wiki/Community-Upgrade.zh-CN.md)。不能通过随意修改合同或重排旧枚举绕过拒绝。
