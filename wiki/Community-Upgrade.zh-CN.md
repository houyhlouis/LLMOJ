# 功能升级与数据库修改

简体中文 | [English](Community-Upgrade.md) | [Wiki 首页](Home.md)

LLMOJ 在原版 LibreOJ 之外增加的功能，例如团队、题解、Fake 处罚、Hack、自测、严格 IOI、两步验证、持久评测和测试数据版本，除了新代码之外还需要修改数据库。[升级器](Upgrade.zh-CN.md)会替你完成这些修改。本页列出它可以修改的全部内容，以及在升级器不支持的安装上如何应用这些修改。

只更新网页不会安装这些功能；为了迁移未知的数据库而打开自动结构同步（`LIBREOJ_SCHEMA_SYNC`）也不安全。

## 升级器可以进行的修改

升级器只接受以下修改，并且每一项都必须是预期的确切形式。其他任何差异（未知的列、类型变化、可空性或默认值变化、删除或重排取值，或会删除数据的 SQL）都会使它停止。

**团队**
- 八张表：`team`、`team_member`、`team_member_group`、`team_resource`、`team_assignment`、`team_file`、`team_invitation` 和 `team_file_upload`（记录上传过程中预留的空间）。
- `file.size` 和 `team_file.size` 从 `int` 扩大为 `bigint`，不丢失数据。
- 所有团队的空间以及新团队的默认空间（`team.quotaLimit`）改为 10 GiB（10,737,418,240 字节）。

**题解：** `discussion.type varchar(20) NOT NULL DEFAULT 'Discussion'` 及索引 `IDX_discussion_type`。已有的讨论仍然是讨论。只有当 AI 任务记录同时写明了帖子和题目、并且帖子作者一致时，AI 撰写的帖子才会成为题解。

**处罚：** 在 `submission.status` 现有十四个取值的末尾依次加入 `Fake` 和 `Hacked`，原有取值顺序不变。已经包含 `Fake` 的数据库同样可以升级。

**Hack 与自测**
- 两张 Hack 表：`hack` 和 `hack_problem`。第一版 Hack 的 `hack_problem` 表会加上可空的 `standardContent` 列（`longtext`），用于保存题目的标准代码。
- 三张自测表：`self_eval_set`、`self_eval` 和 `self_eval_quota`。

**比赛：** `contest.rule` 从 `varchar(8)` 扩大为 `varchar(16)`，不丢失数据；并新增可空的 `contest.ruleOptions longtext` 保存比赛选项。只接受 `noi`、`ioi`、`acm` 和 `strictioi` 四种赛制。

**权限：** 在权限列表末尾加入 `ViewTeam`、`CreateTeam`、`ManageTeams`、`FakeSubmission`、`ViewHack`、`CreateHack`、`ManageHack`、`CreateSelfEval` 和 `ManageRegistrationReviews`；原有取值、顺序和已有授权保持不变。

**注册审核：** `registration_application` 表，见[注册审核](Registration-Approval.zh-CN.md#升级)。

**两步验证：** `user_two_factor` 和 `user_passkey` 两张表。

**持久评测：** `judge_job` 和 `judge_job_attempt` 两张表，以及用于排空评测机的 `judge_client.draining`。

**测试数据版本：** `problem_data_version`、`deferred_file_deletion`、`submission_result_history` 和 `statistics_outbox` 四张表，以及可空的 `submission.problemDataVersionId`。

已有的编号、回复、账号、题目和提交的代码永远不会被修改。MariaDB 在已知修改前后重建索引时，升级器会先检查索引定义，并且从不删除任何内容。

### 评测机的修改

只增加内容的评测机和评测协议修改都可以升级，见[升级](Upgrade.zh-CN.md#支持范围)。从原版评测机第一次过渡到带 Hack 和自测的评测机是一个特例：允许的文件及其新旧哈希列在 `deploy/community-runtime-contract.json` 中，而该文件自身的哈希固定在升级器里。这一步只对 `all` 模式自动执行。在 `web` 安装上升级器会拒绝，因为远程评测机必须与站点同步更新；请先用相同版本更新它们。

## 升级器不支持的安装

对于自定义安装，`deploy/migrate-community-features.mjs` 会对数据库执行同样经过检查的修改。它只连接数据库：不启动后端或任何服务，不备份，也不切换代码。它要求数据库已经存在；新安装的数据库由安装器创建。

1. 获取要安装版本的完整源码并构建：

   ```bash
   pnpm install --frozen-lockfile
   pnpm build:artifacts
   pnpm --filter @libreoj/judge run check-types
   pnpm --filter @libreoj/backend run build
   pnpm --filter @libreoj/frontend run build
   ```
2. 检查数据库（不做任何修改）：

   ```bash
   node deploy/migrate-community-features.mjs \
     --root /path/to/complete-source \
     --config /path/to/instance/config/backend.yaml
   ```
3. 停止新的工作，等待所有评测、Hack、自测运行、预测试数据准备和 AI 任务完成，包括远程评测机上的工作。停止后端，备份数据库和配置。先在数据库副本上尝试下一步。
4. 执行修改：

   ```bash
   node deploy/migrate-community-features.mjs \
     --root /path/to/complete-source \
     --config /path/to/instance/config/backend.yaml --apply --drained
   ```

   `--drained` 表示你确认工作已停止。数据库账号需要有修改表的权限；密码不会被输出。
5. 以 `LIBREOJ_SCHEMA_SYNC=0` 启动新的后端，发布对应版本的前端和评测机，检查赛制、权限、团队、题解、处罚、Hack 和自测后再重新开放网站。

`deploy/teams-migration.sql`、`deploy/solutions-migration.sql` 和 `deploy/fake-migration.sql` 保留供审阅。它们只包含最初的三个功能，不包括之后的表、状态、权限和比赛字段；手动执行它们也会跳过备份和检查。

## 重复执行与回滚

再次运行升级器或辅助脚本是安全的：全部修改完成后不会再有需要执行的内容。如果数据库不匹配，请先调查原因，不要删除表、重排取值或重建账号。

只要存在依赖某项功能的数据，就会拒绝回滚到没有该功能的代码，以免泄露团队私有内容、撤销处罚或忽略已保存的拒绝设置。具体包括：
- 团队、题解、处罚、标准代码、Hack、自测、严格 IOI 或新权限的数据；
- 使用独立输入输出文件名的标准代码（旧代码会改用比赛的文件名）；
- 10 GiB 团队空间或正在进行的上传（旧的上传代码无法处理）；请先完成或取消上传；
- 大于 2 GiB 的文件（旧的文件大小列无法保存）。

请修复新版本。旧的数据库备份不会被导入覆盖当前数据，阻止后端修改数据库的设置也会保留。
