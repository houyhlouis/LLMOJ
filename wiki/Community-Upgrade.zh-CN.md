# 团队、题解、作废、Hack 与自测升级

简体中文 | [English](Community-Upgrade.md) | [Wiki 首页](Home.md)

这一版本同时更新后端、前端、共享协议、评测任务处理器和数据库。比赛只支持四种赛制：NOI / OI、IOI、ICPC、严格 IOI。只覆盖网页资源不能安装这些功能，也不要通过启动自动同步来尝试未知旧数据库迁移。

## 已知增量结构

迁移只接受经过固定合同校验的变更：

- 八张团队表：`team`、`team_member`、`team_member_group`、`team_resource`、`team_assignment`、`team_file`、`team_invitation`、`team_file_upload`。最后一张表保存并发、分块上传的临时配额预留和过期时间。
- 两张 Hack 表 `hack`、`hack_problem` 和三张自测表 `self_eval_set`、`self_eval`、`self_eval_quota`，社区合同共包含十三张表。已有首版 Hack 表追加可空 `hack_problem.standardContent` JSON 内容字段（MariaDB 存储为 `longtext`），保存独立 STD 源码；旧参考提交配置保留。
- 用不删除数据的 `CHANGE` 将 `file.size`、`team_file.size` 从有符号 `int` 扩为有符号 `bigint`；`team.quotaLimit` 默认值及所有已有团队配额统一更新为 10 GiB（10,737,418,240 字节），保留已有用量、文件和成员。团队不设独立单文件上限。只接受这些已知存储变更。
- 给 `discussion` 新增 `type varchar(20) NOT NULL DEFAULT 'Discussion'` 和 `IDX_discussion_type` 索引。
- 在 `submission.status` 的十四个旧枚举值末尾依次追加 `Fake`、`Hacked`，保留全部旧值、顺序和已有记录；也接受已加入 Fake 的中间版本。
- 用不删除数据的 `CHANGE` 将 `contest.rule` 从 `varchar(8)` 扩为 `varchar(16)`，并新增可空 `contest.ruleOptions longtext`，保存 TypeORM `simple-json` 设置。只接受 `noi`、`ioi`、`acm`、`strictioi` 四种值。
- 追加八个权限：`ViewTeam`、`CreateTeam`、`ManageTeams`、`FakeSubmission`、`ViewHack`、`CreateHack`、`ManageHack`、`CreateSelfEval`。旧权限枚举值与显式用户规则保留；`user_permission_rule.permission` 仍是字符串字段。
- 保留既有注册审核、独立注册申请及旧空账户迁移的全部兼容校验。

旧普通讨论保持原类型；有明确 AI 任务引用、且题目和作者一致的旧题解会被分类为题解。已有讨论 ID、回复、正式账户、题目和评测代码不被重建。

已存在的社区表必须与受支持的固定结构一致；首版 Hack 的 STD 字段追加仅按上述已知迁移处理。未知字段、未知或重排的枚举、可空性或默认值变化、破坏性 SQL 均拒绝执行。TypeORM 对已知枚举追加产生的固定无变化索引重建会在逐项核验真实索引后省略，不执行 DROP。

评测运行代码的变化另由 `deploy/community-runtime-contract.json` 固定，升级器同时固定该文件的哈希。仅接受从已支持上游版本、首批社区功能版本或已部署的首版 Hack／Self Eval 到已审查协议与任务处理文件的精确变化。该单向合同不允许任意修改依赖、原生代码、rootfs 或评测逻辑。

默认查看、创建权限遵守站点规则。团队从自己的个人主页进入，仅列出已加入和申请中的团队；通过编号加入，免审核不意味着公开。全局团队管理仍属于管理特权。题解嵌入题目页，并保留在“我的讨论”中。Fake 的显式允许或拒绝优先于原 Delete 兼容授权。

Hack 只能从具体提交详情发起，Hack 页仅展示结果。管理员在题目 STD 代码编辑器中保存参考程序，或从已通过提交点击“设为此题 STD”；发起者不填写参考提交编号。输入校验器可复用题目已有程序，也可由管理员维护。成功记录将目标实际得分设为 0。

Hack 详情只展示一个始终展开的测试点，包含 Hack 输入和已记录的目标判定、运行时间、内存；旧记录会明确提示缺少目标判定信息。表格和只读长输入随整页展开，宽表格仍可横向滚动。Members 从首页 Top Users 右上角的“查看全部”按钮进入。

Self Eval 仅在已开启该功能的 NOI / OI 比赛题目页提供；普通题库、提交详情及其它赛制不提供。管理员赛前填写 `make.cpp`、`std.cpp`，或用“AI 生成正式数据与 Self Eval 程序”按钮重新生成正式数据并绑定同版程序，随后准备固定隐藏预测试集。评测沿用正式 SPJ，手工配置不要求另填 validator。每位选手默认全场最多 30 次。预测试集最多二十组，每组输入或输出最多 4 MiB，编码 JSON 总量最多 16 MiB。旧普通自测记录和未启用赛制的设置保留，但不开放新的运行入口。详见 [团队](Teams.zh-CN.md)、[题解](Solutions.zh-CN.md)、[Hack](Hacks.zh-CN.md)、[Self Eval](Self-Evaluation.zh-CN.md) 和 [作废与恢复](Submission-Moderation.zh-CN.md)。

## 官方安装实例

使用 GitHub 下载升级入口前，先将完整修改提交到自己的主仓库，确认目标版本包含全部代码、文档和迁移文件，再按 [安全升级](Upgrade.zh-CN.md) 使用新版本入口。已审核的本地完整源码可以直接通过 `--source` 使用，无需先发布到远程仓库。原来安装在 `/opt/LibreOJ` 的实例保持该目录，不改为默认的 `/opt/LLMOJ`。

升级器会在暂存目录重构建 judge-protocol，检查评测端类型并运行 Hack 回归，再构建后端和前端；先审计在线数据库，再恢复备份到临时库验证迁移，最后在排空维护窗口内重新备份、迁移并切换。配置、AI 密钥、对象存储、评测槽数和服务定制保留。启用新增任务类型前，远程评测节点也必须使用匹配且经过审查的协议和处理器。

包含 Hack／自测的评测运行代码自动过渡只支持官方 `all` 角色；`web` 角色需要单独协调远程评测节点升级，自动入口会拒绝这一步，不会假定远程端已兼容。社区 DDL 的首条语句执行前就安装禁止自动同步的保护；迁移中途失败也会保留该保护。

只读预检示例（使用目标完整源码中的入口）：

```bash
sudo bash /path/to/complete-source/deploy/upgrade.sh \
  --prefix /opt/LibreOJ --source /path/to/complete-source --plan
```

增量修改 ZIP 不能直接当作 `--source`：应先覆盖到完整本地仓库，再使用完整源码。实际升级的源码哈希、维护确认与回滚步骤沿用安全升级指南。

## 自定义部署的离线迁移

独立迁移入口只连接数据库，默认审计，不启动 Nest、后台任务或服务，也不会替你备份或切换代码。它同样要求成熟的已知数据库结构；空库应走新安装流程。

先准备与目标匹配的完整源码、安装依赖并构建：

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter @libreoj/judge run check-types
pnpm --filter @libreoj/backend run build
pnpm --filter @libreoj/frontend run build
```

只读审计：

```bash
node deploy/migrate-community-features.mjs \
  --root /path/to/complete-source \
  --config /path/to/instance/config/backend.yaml
```

正式迁移前暂停网站写入，等待普通评测、远程评测和 AI 任务结束，停止后端并备份数据库和配置。在独立数据库副本上验证后，显式执行：

```bash
node deploy/migrate-community-features.mjs \
  --root /path/to/complete-source \
  --config /path/to/instance/config/backend.yaml --apply --drained
```

`--drained` 表示操作者确认维护条件已满足，不会自动排空或停止服务。普通评测、Hack、预测试准备、自测及 AI 任务都需要排空，远程节点同样如此。连接账户需要相应 DDL 和数据迁移权限；工具不会输出密码。完成后用 `LIBREOJ_SCHEMA_SYNC=0` 启动新版后端，发布匹配的网页和评测处理器，验证四种赛制、权限、团队、题解、作废、Hack 与自测，再恢复入口。

`deploy/teams-migration.sql`、`deploy/solutions-migration.sql` 和 `deploy/fake-migration.sql` 保留作为首批三项功能的迁移审查材料，单独执行它们不会安装后续 Hack／自测表、Hacked 状态、新权限或比赛字段。合并版本应使用当前完整结构迁移入口或官方升级器。直接 SQL 不替代完整升级器的备份、结构审计与切换。

## 重试与回滚

迁移可以重复运行，完成后审计应无待执行结构变更、团队配额更新或待分类的已验证 AI 题解。未知结构应先人工排查，不要删除旧表、改枚举顺序或重新初始化账户来绕过校验。

旧版本缺少私人团队访问限制、题解分类、作废、保存的 STD、Hack、NOI 自测限制、严格 IOI 或新权限目录时，已有相应数据或显式权限设置会阻止回滚，避免泄露私有内容、解除处罚、丢失分类或忽略拒绝规则。已有 STD 保存独立输入输出设置时，也会拒绝回滚到将比赛文件名同时应用到 STD 的旧版。应修复新版；升级器不会用旧 SQL 备份覆盖新数据。社区结构已添加时，自动同步关闭保护会保留。

已有 10 GiB 团队配额或上传预留时，也会拒绝回滚到旧的小文件上传实现；文件元数据超过有符号 32 位范围时，拒绝回滚到使用整数文件大小字段的版本。请完成或取消上传并修复当前版本，不要降级存储处理代码。
