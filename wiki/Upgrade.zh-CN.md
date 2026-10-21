# 升级

简体中文 | [English](Upgrade.md) | [Wiki 首页](Home.md)

升级器在由安装器安装的服务器上安装新版 LLMOJ，并保留你的配置和数据：账号、题目、提交、文件、AI 设置和密钥、评测槽、CPU 设置以及你对服务的自定义修改。它不会重新运行安装器，也不会重新创建管理员。

所有数据库修改都会先在数据库副本上测试，然后才修改真实数据库；切换只在一个短暂的维护时段内进行。

## 支持范围

- 由安装器安装、模式为 `all` 或 `web`、使用默认服务布局以及本机 MariaDB、Redis 和 MinIO 的站点。
- 网站代码、评测机和沙箱的修改。在 `all` 安装中，有改动的沙箱或评测机会在切换前重新构建并测试（见[评测机自检](Judge-Configuration.zh-CN.md#沙箱系统调用过滤器与自检)）。
- 依赖和锁文件的修改：见[依赖变更](#依赖变更)。
- LLMOJ 自身功能带来的数据库修改，每一项都会与预期的确切形式核对。完整列表见[功能升级](Community-Upgrade.zh-CN.md)。

以下情况会被拒绝：
- 用 Git 管理的安装、自定义布局、自定义数据库连接、后端或评测机的 `EnvironmentFile` 覆盖，或自定义的 AI 目录；
- 无法识别的数据库差异，以及 Node.js、pnpm 版本（24.21.0 和 11.13.1，见[依赖与工具链](Dependencies.zh-CN.md)）的变化；
- 删除或修改评测协议或数据库已在使用的取值（只能在末尾追加新取值）。

这些情况需要单独计划迁移。不要通过删除数据或重新安装来绕过拒绝。

新安装位于 `/opt/LLMOJ`；位于 `/opt/LibreOJ` 的安装保持不变，请加上 `--prefix /opt/LibreOJ`。

## 查看计划

先下载升级器并查看计划。`upgrade.zh-CN.sh` 输出中文，`upgrade.sh` 输出英文，其他方面完全相同。

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.zh-CN.sh -o /tmp/llmoj-upgrade.zh-CN.sh
sudo bash /tmp/llmoj-upgrade.zh-CN.sh --prefix /opt/LLMOJ --plan
```

脚本会先把 `main` 解析为具体的提交再下载；要安装某个特定提交，请使用 `--ref 完整提交SHA`。计划会检查安装，并列出之后才会进行的检查。它不构建任何东西、不复制数据库、不停止服务，因此计划通过并不代表升级完成。

## 升级

1. 选择空闲时段。停止新的提交、导入和 AI 任务，等待所有排队中和运行中的工作完成，包括 Hack、自测运行和预测试数据准备，以及远程评测机上的工作。升级器会检查数据库中是否还有运行中的工作，但无法替你停止远程评测机。
2. 不带 `--plan` 运行升级器：

   ```bash
   sudo bash /tmp/llmoj-upgrade.zh-CN.sh --prefix /opt/LLMOJ
   ```

   它会要求你输入 `UPGRADE`，以确认所有工作都已完成。如需不提问执行，请改用 `--apply --drained`；`--drained` 表示你确认工作已停止，它本身不会停止任何东西。

之后升级器会：
1. 获取维护锁（期间不能进行备份和评测扩缩容），检查服务和可用磁盘空间；
2. 使用独立的依赖副本构建新版本（依赖有变化时先安装新依赖），核对文件，并检查新后端接受你的 `config/backend.yaml`；
3. 备份配置、AI 主密钥和数据库，把备份导入临时数据库，并在其中测试所有结构和数据修改；
4. 停止 Nginx、评测机和后端，重新备份数据库并再次检查；
5. 切换到新文件并执行数据库修改；
6. 等待新后端[就绪](Operations-Configuration.zh-CN.md#存活与就绪检查)（能连接数据库、Redis 和对象存储）并检查本机评测机，然后启动之前在运行的服务，最后启动 Nginx。

评测机以账户 `libreoj-judge` 运行，只有其[沙箱启动器](Judge-Configuration.zh-CN.md#评测机账户与沙箱启动器)以 root 运行。在 `all` 安装上，如果该账户还不存在，升级器会在评测机自检之前创建它。升级计划中显示为 `judgeAccount`。同名账户如果可以登录，升级器会拒绝。回滚会保留该账户；旧版评测机以 root 运行，不使用它。

备份和构建日志保存在 `<prefix>/backups/upgrade/<UTC 时间>-<随机数>/`，升级器会输出该路径。其中包含密钥，请妥善保管；不再需要时请自行删除旧备份，升级器从不删除数据或备份。升级完成后，它只删除构建用的依赖副本（`staging/node_modules`，约 1 GiB），之后没有任何操作会用到它，回滚也不会。如果这次升级更改了依赖，这份副本会成为已安装的依赖，原来的依赖则保留在 `previous/node_modules` 中，供回滚使用。此版本之前的升级备份中仍保留该副本；[doctor](Operations-Configuration.zh-CN.md#运行-doctor) 会告诉你有多少份。对于已完成的升级，可以删除它：`sudo rm -rf /opt/LLMOJ/backups/upgrade/<UTC 时间>-<随机数>/staging/node_modules`。

升级器会安装 `/etc/systemd/system/libreoj-backend.service.d/90-libreoj-schema-sync.conf`，其中设置 `LIBREOJ_SCHEMA_SYNC=0`，使后端永远不会自行修改数据库结构；这些修改由升级器明确执行。你的其他 drop-in、Nginx 配置、凭据和评测容量都保持不变。

在网站中保存的设置（例如[注册模式](Registration-Approval.zh-CN.md)和首页内容）都会保留。

## 启动时检查数据库

后端在提供任何服务之前，会把数据库与其版本使用的数据表和列进行比较，比较方式与升级器的数据库结构检查相同：

- **缺少它需要的内容**（数据表或列）：它不会启动，并在日志中列出缺少的内容。数据库是从较旧版本恢复的，或者没有通过升级器更新代码时会发生这种情况。请用升级器升级数据库，或恢复与已安装版本相符的备份。
- **列的定义不同，或缺少索引**：它照常启动，在日志中列出最先发现的差异，[doctor](Operations-Configuration.zh-CN.md#运行-doctor) 也会发出警告。网站可以工作，但可能更慢或约束更少；如果是升级留下了这样的差异，请告诉项目维护者。
- **更新版本添加的内容**（列、索引）：忽略，因此回滚后照常启动。

在后端的环境中设置 `LIBREOJ_SCHEMA_CHECK=0` 可以跳过检查，例如为了从损坏的安装中导出数据。用完请删除该设置。

## 依赖变更

新版本修改了 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 或 `.npmrc` 时，升级器把新的锁文件安装（frozen：严格使用锁定的版本，并校验哈希）到构建用的依赖副本中。新的软件包从 npm 仓库下载到 `<prefix>/runtime/pnpm-store`，因此服务器需要能访问 `registry.npmjs.org`。只有 `pnpm-workspace.yaml` 的 `allowBuilds` 允许的软件包才会运行安装脚本。

计划中以 `dependencies` 显示这项变更：新锁文件中的软件包数量、新增和删除的数量，后端、评测机、前端、评测协议和沙箱每个有变化的直接依赖，以及允许运行安装脚本的软件包（`buildScriptsChanged` 表示该列表是否有变化）。

依赖有变化时，所有原生模块都会重新构建，并运行沙箱检查和评测机自检，与沙箱有改动时相同。新依赖在维护时段内随代码一起切换。回滚（自动回滚或 `--rollback`）会从备份中恢复原来的依赖。

Node.js 和 pnpm 的版本不能以这种方式更改。如果升级的 `packageManager` 指定了其他 pnpm 版本，或其安装程序固定了其他 Node.js 版本，升级会被拒绝。受支持的版本见[依赖与工具链](Dependencies.zh-CN.md)。

## 从本地源码升级

如果要从一份你已审查过的完整源码（而不是只含修改文件的 ZIP）升级，请使用其中的升级器：

```bash
sudo bash /path/to/LLMOJ/deploy/upgrade.sh \
  --prefix /opt/LLMOJ --source /path/to/LLMOJ --plan
```

核对它输出的 `sourceSha256`，然后同时带上 `--source` 和 `--source-sha256 <64 位摘要>` 再次运行。`python3 /path/to/LLMOJ/deploy/upgrade.py --source /path/to/LLMOJ --source-digest` 只输出摘要，不做任何修改。摘要只能说明源码在你检查之后没有变化，不能让未经审查的源码变得可信。

## 升级失败时

- 如果构建或在数据库副本上的测试失败，站点继续运行旧版本。
- 如果切换失败，升级器会尝试恢复旧文件和服务。如果恢复也失败，站点保持停止，升级器会告诉你备份的位置。出现错误信息后，不要以为站点一切正常。

解决原因后，用相同的参数再次运行升级器。已经完成的数据库修改不会重复执行。不要为了重试而删除配置、密钥或数据库。

## 回滚

再次停止新的工作并等待其完成，然后传入升级器输出的备份目录：

```bash
sudo bash /opt/LLMOJ/deploy/upgrade.sh --prefix /opt/LLMOJ \
  --rollback /opt/LLMOJ/backups/upgrade/ACTUAL_BACKUP --drained
```

回滚会恢复旧代码，但保留当前的数据库和文件，并且永远不会用旧的数据库备份覆盖较新的数据；数据库备份用于灾难恢复，需要另行计划。

如果旧版本无法处理你现在已有的数据，升级器会拒绝回滚，因为旧版本会忽略这些数据的规则。站点有团队、题解、Fake 或 Hacked 提交、Hack 参考程序或记录、自测数据、严格 IOI 比赛、已保存的比赛选项、已授予或拒绝的新权限、开启了[两步验证](Two-Factor-Sign-In.zh-CN.md)的账号、已保存的注册模式或注册申请时，都属于这种情况。此时请修复新版本。例如：

- 如果在 **网站管理** 中保存了注册模式，而旧版本没有该页面，请先点击 **恢复服务器配置**，并确认 `backend.yaml` 中的模式符合你的需要。
- 只要还有待审核或已拒绝的注册申请，旧版本就可能让这些人未经审核登录，因此会拒绝回滚。如果升级把旧的待审核或已拒绝账号转换成了申请，即使它们之后都已通过，回滚仍会被拒绝。

## 注册审核数据迁移

从第一个带注册审核的版本升级时，升级器会把待审核和已拒绝的账号转换为独立的申请。它先在数据库副本上演练；如果其中有账号已有内容、权限、自定义资料，或用户名、邮箱冲突，就会停止并等待人工检查。见[注册审核](Registration-Approval.zh-CN.md#升级)。不要只替换前端来升级，也不要删除旧的审核表。
