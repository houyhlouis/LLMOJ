# 评测端完整配置与 CPU 扩缩容

[English](Judge-Configuration.md) | 简体中文

适用于安装器生成的 Ubuntu/systemd 部署，配置入口为 `/opt/LibreOJ/config/judge.yaml`（自定义 prefix 请替换）。本页覆盖当前评测端的所有 YAML 字段；后端下发限制、宿主环境变量和安装器生成值另行标明。

未变更字段来源固定为 `43a88bdd62fbf200889b36932fa921439a293190`；修改后的容量生成器使用 `main` 链接，对应待提交修订：[config.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/config.ts), [config-example.yaml](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/config-example.yaml), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [executionCapacity.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/executionCapacity.ts), [taskQueue.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/taskQueue.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/aiRunner.ts).

## 读取规则与完整字段

`LIBREOJ_JUDGE_CONFIG_FILE` 必须指向配置文件；未设置即退出。配置类没有为必填字段提供默认值。下表的 example 来自示例 YAML，不能理解成省略字段后的默认值；安装器生成值可能不同。示例中的 key/rootfsId 是占位符，必须替换。optional 字段允许缺省或 null；`sandbox` 必须提供，`cpuAffinity` 对象可省略。应使用表中字段，不依赖未知字段被拒绝。

| 字段 | 类型/校验/示例值 | 用途、安装值与限制 |
| --- | --- | --- |
| `serverUrl` | string; example `http://api.libreoj.test/` | 后端 origin，不带 `/api`；自动连接 namespace `/judge`、路径 `/api/socket`。本机安装为 `http://127.0.0.1:2002`，远程使用站点 HTTPS origin。 |
| `downloadEndpointOverride` | optional string/null; example `null` | 下载 URL 的 origin 替换；保留原路径与查询参数，覆盖值中的路径不会成为前缀。本机为 Nginx 回环 origin；远程默认不覆盖，必须能访问签名下载 URL。 |
| `key` | base64 string, exactly 40 characters | 30 字节密钥的 Base64 表示；每台 judge 独立注册，不是用户密码。保留 root:root `0600`；不要放在命令参数、截图或公开日志。 |
| `dataStore` | string path; example `/root/judge/data` | 已下载测试文件的磁盘缓存；安装为 `<root>/data/judge/testdata`，按 UUID 缓存。这里无自动总容量限制配置，应监测磁盘。 |
| `binaryCacheStore` | string path; example `/root/judge/cache` | 编译产物缓存；安装为 `<root>/data/judge/cache`。启动时清空，绝不能指向题库、数据备份或其他共享目录。 |
| `binaryCacheMaxSize` | integer bytes; example `536870912` (512 MiB) | 类校验仅要求整数；实际必须至少等于后端 `limit.outputSize`，否则认证后退出。不是单个程序内存限制。安装器保留示例值。 |
| `taskConsumingThreads` | positive integer; example `2` | 同时从后端领取并处理的任务/提交消费者数，不是 CPU 数；每个任务可含多个测试点。大于 3 启动警告。安装生成 `min(3,max(1,slots//2))`。 |
| `maxConcurrentDownloads` | positive integer; example `10` | 测试文件下载队列并发；大于 20 警告。安装生成 `min(4,slots)`；提高它不会增加执行槽。 |
| `maxConcurrentTasks` | positive integer; example `3` | 执行队列容量；实际为与工作目录数的较小值，编译、运行、AI 验证共用。安装器要求恰好等于工作目录数；大于 OS 报告逻辑 CPU 数会警告。 |
| `taskWorkingDirectories` | nonempty string array; example 3 paths | 每个执行槽一个唯一绝对路径；解析后的重复路径会拒绝。安装为 `<root>/data/judge/work/1..N`，每个单独 tmpfs，启动时清空。不得复用缓存/数据目录。缺少 tmpfs 可能只警告，不能据此认为部署合格。 |
| `rpcTimeout` | positive integer milliseconds; example `20000` | RPC/认证等待超时；超时重启进程并取消在途任务。安装生成 `30000`。 |
| `downloadTimeout` | positive integer milliseconds; example `20000` | 每次下载取得响应后的流传输计时；当前代码不是覆盖 DNS/连接/响应头等待的完整请求截止时间。安装保留 `20000`。 |
| `downloadRetry` | positive integer; example `3` | 总尝试次数，3 表示首次加最多 2 次重试；不是额外重试 3 次。 |
| `aiRunnerSocket` | optional string; example omitted | 本机 AI UNIX socket；缺它或输出目录时不启动 AI worker。all 安装为 `<root>/data/judge/ai-runner.sock`，权限 root:后端组 `0660`；remote 为 null。不能改成公开 TCP 服务。 |
| `aiGeneratedDirectory` | optional string; example omitted | 本机 AI 私有输出目录，all 安装为 `<root>/data/ai-generated`，真实目录、非符号链接，root:后端组 `0750`。与后端同机共享；remote 为 null。 |
| `aiRunnerGid` | optional integer; example omitted | 启用 AI worker 时另行要求正整数；all 为 `libreoj` 组实际 GID。remote 生成 0 但 socket 为 null，因此不启用；不要在启用时使用 0。 |
| `sandbox.rootfs` | string path; example `/opt/rootfs-ng` | 沙盒根文件系统；安装为 `<root>/runtime/sandbox-rootfs`。保留匹配的配方、UID 和挂载结构，不要递归 chown。 |
| `sandbox.rootfsId` | 64 lowercase hex characters | 必填的 SHA-256 配方 ID；启动时与 ID 文件逐字比对，不匹配拒绝启动。示例占位符不能直接运行。 |
| `sandbox.rootfsIdFile` | optional string; example omitted | 默认从 `<sandbox.rootfs>/etc/libreoj-rootfs-id` 读取；不可变镜像可把 ID 文件放镜像外并指定绝对路径。 |
| `sandbox.hostname` | optional string/null; example `null` | 沙盒 hostname；安装生成 `libreoj-judge`。不是评测机到后端的网络地址。 |
| `sandbox.immutable` | optional boolean; example omitted | 未设置按 false 路径处理；true 时内部工作路径使用 `/tmp/libreoj`，避免在镜像内建立挂载目录。不是自动将任意 rootfs 变为只读的开关，应与镜像布局成套使用。 |
| `sandbox.resourceMode` | optional `default` or `arbiter`; example omitted | 安装生成 `default`；只作用于用户程序。default 使用 cgroup CPU 统计；arbiter 使用进程用户态 CPU 时间并附加地址空间限制。编译器/checker/interactor 固定 default。变更会影响判题口径，不能作为提速开关。 |
| `sandbox.user` | string; example `sandbox` | rootfs 内的运行用户名，解析其 UID/GID；安装为 sandbox。不是宿主 systemd 服务的 User；沙盒管理器需要其宿主权限。 |
| `sandbox.environments` | object of environment variables | 例子为 `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`、`HOME=/sandbox`、`LC_ALL=en_US.UTF-8`；值应写为字符串，按具体任务环境合并。此对象不控制宿主 Node 的线程池。 |
| `cpuAffinity.compiler` | optional integer array; example `[0,1]` | 编译器允许使用的逻辑 CPU ID；安装生成所选 judge CPU 集合。 |
| `cpuAffinity.userProgram` | optional integer array; example `[1]` | 用户程序允许使用的逻辑 CPU ID；不是为每个槽固定独占一个 CPU。 |
| `cpuAffinity.interactor` | optional integer array; example `[0]` | 交互器允许使用的逻辑 CPU ID；必须与 cgroup 允许的 CPU 相容。 |
| `cpuAffinity.checker` | optional integer array; example `[0,1]` | 检查器允许使用的逻辑 CPU ID；四个键未设置时不增加此类 affinity 约束，但仍受 systemd/父 cgroup 限制。 |

示例环境映射完整键为 `sandbox.environments.PATH`、`sandbox.environments.HOME`、`sandbox.environments.LC_ALL`。`sandbox.environments.*` 是可扩展的字符串映射，没有另外一套固定字段；它们的示例值见上表。

## 宿主环境、队列与资源预算

- `LIBREOJ_JUDGE_CONFIG_FILE`：必填路径；systemd 生成值为 `<root>/config/judge.yaml`。
- `LIBREOJ_JUDGE_LOG_LEVEL`：未设置为 `info`；排错可暂用 `verbose`/`debug`，避免公开包含签名下载地址的日志。
- `UV_THREADPOOL_SIZE`：在 Node 启动前设置，整数范围为 `2 × 实际执行槽 + 2` 到 `1024`。Node 默认 4 只够 1 槽；3 槽至少 8，6 槽至少 14。原生沙盒等待占 libuv worker，交互题每槽可能同时等待两个进程，另留两个文件系统 worker。安装生成 `max(4, slots*2+2)`，修改后必须重启 judge；写到 `sandbox.environments` 无效。
- `NODE_OPTIONS=--max-old-space-size=512` 是安装服务的 Node 堆设置，不是用户程序内存上限；`PATH` 指向安装的 Node 和宿主工具。
- `HYHOJ_AI_SAMPLE_INPUTS_DIR`：宿主 AI 输入样例目录，代码缺省 `/opt/LibreOJ/data/ai-sample-inputs`，服务生成 `<root>/data/ai-sample-inputs`；与后端必须一致，不能当作公共静态目录。

普通提交消费者由 `taskConsumingThreads` 控制；编译/测试点和本机 AI 验证共用 `min(maxConcurrentTasks, 工作目录数)` 的执行槽；文件下载另有 `maxConcurrentDownloads` 队列。AI runner 还有固定 3 个生成管线并发、最多 8 个已接收的未完成请求（包含等待），它们不是额外的 3/8 个 CPU 槽，也没有对应 YAML 调节项；后端 AI 并发又是另一层限制。不要仅增加消费者或后台 AI 并发来“扩 CPU”。

后端认证时下发 `limit.compilerMessage`、`limit.outputSize`、`limit.dataDisplay`、`limit.dataDisplayForSubmitAnswer`、`limit.stderrDisplay`，这些不是 judge.yaml 键。代码对 compilerMessage 超过 1 MiB、dataDisplay 超过 1 KiB、stderrDisplay 超过 10 KiB 发警告；binaryCacheMaxSize 小于 outputSize 为致命错误。题目/语言本身的时间与内存限制也来自后端。

## 默认容量与内存预算

首次安装会询问“评测实例数（执行槽）”。它表示同时执行编译/测试点的工作位置数量，不是安装多套 OJ，也不是操作系统线程数。一个 judge 服务使用多个工作目录和沙盒进程；`taskConsumingThreads` 是领取提交的消费者并发，`UV_THREADPOOL_SIZE` 则是 Node 原生等待/文件操作线程池，三者含义不同。

默认槽数为 `max(1, 有效 CPU 数 - 2)`，本机 all 与远程 judge 使用相同公式。有效 CPU 数同时考虑进程 affinity、cgroup 有效 cpuset 和各级 CPU quota；有限 quota 向下取整且至少计 1，不只读取宿主 `nproc`。默认从允许集合末尾选择所需 CPU ID，因此 CPU ID 不连续时也不会假定 0..N。

内存使用宿主 RAM 与适用 cgroup `memory.max` 的较小值；all 预留 2048 MiB，remote 预留 1024 MiB，每槽再预算 512 MiB。实际允许的最大值是有效 CPU 数、内存槽数与 libuv 上限 511 的最小值。**不再有 7 槽上限；默认值超过内存预算或 511 时会明确报错，要求选择较少槽数，不会悄悄降低。** 显式槽数可使用全部有效 CPU，但必须通过容量校验。

| 有效 CPU 数 | 默认执行槽（内存足够时） |
| --- | --- |
| 1 / 2 / 3 | 1 |
| 4 | 2 |
| 8 | 6 |
| 16 | 14 |
| 32 | 30 |

**8 个有效逻辑 CPU、8 GiB RAM 的 all 示例**：若允许 ID 为 0–7，则默认使用 2–7 的 6 槽、3 个消费者、4 个下载并发、工作目录 1–6、线程池 14。8 CPU 但只有 4 GiB 可用内存时，all 最多预算 4 槽；默认 6 会报错，应明确选择 4 或更少。不要只凭 CPU 数决定高内存题或 AI 工作负载的并发。

每槽 512 MiB 是 **tmpfs 最大容量**，不是预分配，也不是进程内存上限。编译器、选手程序、页缓存、AI、数据库同时占 RAM。`TasksMax`、父 cgroup、CPU quota 和物理核心共享仍可能形成瓶颈。`lscpu -e=CPU,CORE,SOCKET,ONLINE` 可分辨逻辑 CPU 与物理核；SMT 不等于独占物理核，`cpuAffinity` 与 systemd `AllowedCPUs` 也不会自动给每槽分配独占核心。

容量算法由 [judge_capacity.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/judge_capacity.py) 在安装和扩缩容中共用。该新文件及本节新策略属于待提交修订；发布前须确认部署版本已包含它，不能用旧提交的源码链接冒充已发布实现。

## 生成的 systemd 服务与 tmpfs 挂载

下面列出 `configure-judge.py` 生成单元的所有指令，并标明常见但未显式生成的 accounting/limit 项。部署模板可能与按实际槽数生成后的内容不同，应检查生成后的文件；service drop-in 的优先级仍可能更高。

| 指令 | 生成值 | 含义/注意点 |
| --- | --- | --- |
| `Unit.Description` | `Judge: slots/consumers; workspace/remote target descriptions` | 说明文本，不是资源限制。 |
| `Unit.After` | `local: libreoj-backend.service; remote: network-online.target` | 定义启动顺序；远程 target 同样 After=network-online.target。 |
| `Unit.Requires` | `local service: libreoj-backend.service` | 远程无此后端依赖；停本机后端会影响依赖的 judge。 |
| `Unit.Wants` | `remote service: network-online.target; remote target: libreoj-judge.service` | 远程启动网络及 judge 的弱依赖；不是多机任务调度规则。 |
| `Unit.PartOf` | `service and mounts: libreoj.target or libreoj-judge.target` | all 与 remote 的停止/重启归属不同；扩槽只停 judge service，不停整个 all target。 |
| `Unit.RequiresMountsFor` | `all taskWorkingDirectories` | service 自动依赖配置中的工作目录挂载；必须与 YAML 同步。 |
| `Unit.Before` | `not explicitly generated` | 不要从 source 样例猜测显式 Before 值；RequiresMountsFor 与 systemd 默认依赖另行形成顺序。 |
| `Service.WorkingDirectory` | `<root>/apps/judge` | Node 启动目录；保持该目录的依赖可读。 |
| `Service.Environment` | `NODE_ENV=production; PATH=<node-parent>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` | 另生成 LIBREOJ_JUDGE_CONFIG_FILE、UV_THREADPOOL_SIZE、NODE_OPTIONS=--max-old-space-size=512、HYHOJ_AI_SAMPLE_INPUTS_DIR；含义见上节。 |
| `Service.ExecStart` | `<node> -r @swc-node/register index.mjs` | 当前 judge 运行 TypeScript 注册入口，不是 backend dist/main.js。 |
| `Service.Delegate` | `cpu memory pids` | 委托 cgroup 控制器给原生沙盒；不要删除或靠sudo前缀替代。 |
| `Service.DelegateSubgroup` | `supervisor` | 需要 systemd 254+；管理进程与沙盒子 cgroup 分离。 |
| `Service.OOMPolicy` | `continue` | 单个沙盒 OOM 不按 stop/kill 策略杀整个服务；不保证宿主不会内存耗尽。 |
| `Service.AllowedCPUs` | `union of the four cpuAffinity sets` | 是逻辑 CPU ID 集合，受父 cgroup 限制；重新生成后需重启生效。 |
| `Service.TasksMax` | `2048` | 宿主服务的任务/线程数量上限；不是并发提交数或评测槽数。 |
| `Service.Restart` | `on-failure` | 异常退出时重启；配置错误可能导致重复失败，应检查日志。 |
| `Service.RestartSec` | `3` | 失败重启等待 3 秒。 |
| `Service.TimeoutStopSec` | `30` | 停止超时为 30 秒；不等于排空队列，不保证在途任务完成。 |
| `Service.UMask` | `0022` | judge 新建普通文件的默认掩码；私有配置和 AI 目录/socket 仍有显式更严格权限。 |
| `Service.LimitCORE` | `0` | 禁止 core dump。其他 Limit*（如 LimitNOFILE）未由生成器显式设置，继承宿主/systemd 配置。 |
| `Service.StandardOutput` | `journal` | 标准输出进入 systemd journal；诊断日志应私有保存。 |
| `Service.StandardError` | `journal` | 标准错误进入 systemd journal。 |
| `Service.User / Service.Group` | `not explicitly generated` | system service 默认宿主 root；sandbox.user 是沙盒内用户，两者不可混淆。 |
| `Service.CPUAccounting / Service.MemoryAccounting / Service.TasksAccounting` | `not explicitly generated` | 继承 systemd 管理器/父 slice 设置；不要声称本生成器启用了某个值。用 systemctl show 查询生效值。 |
| `Service.MemoryMax / Service.CPUQuota` | `not explicitly generated` | 本机父 cgroup 或 drop-in 仍可能限额；每题沙盒限制另行由评测参数配置。 |
| `Mount.What` | `tmpfs` | 每个工作目录一个独立 tmpfs 文件系统。 |
| `Mount.Where` | `each taskWorkingDirectories path` | 单元名由 systemd-escape --path --suffix=mount 得到；不要手写假定路径转义。 |
| `Mount.Type` | `tmpfs` | 不是磁盘题库目录，也不能挂在 rootfs 上替代题库。 |
| `Mount.Options` | `size=512m,mode=0755,nodev,nosuid` | size 是每个 tmpfs 的上限；mode 是挂载根权限；nodev/nosuid 禁止设备节点与 setuid 生效。 |
| `Install.WantedBy` | `service/mounts: mode target; remote target: multi-user.target` | 启用服务/挂载单元建立对应 .wants；远程目标需开机启用。已有安装的目标启用状态在扩缩容时保留。 |

`CPUAccounting`、`MemoryAccounting`、`TasksAccounting` 可用以下只读查询确认；不需要为改槽数而额外修改它们。

```bash
sudo systemctl show libreoj-judge.service -p CPUAccounting -p MemoryAccounting -p TasksAccounting -p LimitCORE -p TasksMax
```

## 使用正式脚本扩容或缩容

使用包含本次修改的 [resize-judge.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/resize-judge.sh)，不再复制长段维护程序。新脚本属于待提交修订，旧安装不存在该文件时，先按更新包说明部署匹配版本。已有实例的安装器参数用于首次安装；不要通过改安装元数据、删除 YAML/key 或以不同 `--judge-slots` 重跑安装来强行扩容。

脚本要求已安装 `libreoj-judge.service`、标准 `work/1..N` 工作目录及受管理的服务/挂载单元。纯 web 节点没有本机 judge 可扩；可部署 [远程评测机](Remote-Judge.zh-CN.md)。本机 all 保留 AI worker，remote 使用 `libreoj-judge.target`。模式默认 `--mode auto`，从已安装服务推断；`--mode all` 或 `--mode remote` 仅用于明确并核验模式，不会把网页节点转换为远程节点。

入口调用同目录的 `resize-judge.py` 实现并原样传递参数，不下载远程脚本。主单元直接设置的 `MemoryMax` / `CPUQuota`、任意相关 drop-in 或不属于该 prefix 的服务也会被拒绝，需先人工审查。

### 1. 查看计划

```bash
sudo bash /opt/LibreOJ/deploy/resize-judge.sh --prefix /opt/LibreOJ --plan
# 指定目标：数字为示例，必须满足本机 CPU／内存预算
sudo bash /opt/LibreOJ/deploy/resize-judge.sh --prefix /opt/LibreOJ --slots 6 --plan
```

`--plan` 不写配置、不停服务。检查旧/新槽数、CPU 集合、内存预算和线程池；自定义安装路径替换 `--prefix`。脚本会拒绝需要人工审查的服务 drop-in 或非标准布局，不会删除这些设置来绕过校验。

### 2. 排空并应用

安排维护时间，阻止新的提交、重评、测试运行及 AI 任务，确认**所有用户**的排队/运行任务结束；CPU 空闲或只看自己的 AI 列表不能证明已排空。脚本的 `--drained` 是操作者确认，不是自动排空队列的功能。

默认交互方式会用中文展示容量和排空要求，只询问实例数。**提交该数字（或按回车接受默认值）即表示已经排空，并立即执行维护，没有第二次确认。** 未排空时按 Ctrl+C 退出：

```bash
sudo bash /opt/LibreOJ/deploy/resize-judge.sh --prefix /opt/LibreOJ
```

已排空后的非交互示例：

```bash
sudo bash /opt/LibreOJ/deploy/resize-judge.sh --prefix /opt/LibreOJ --slots 6 --apply --drained
```

脚本先将私有 judge YAML、受管理单元及状态备份到 `<prefix>/backups/judge-resize/<UTC时间>/`，打印该私有目录，再只停止 judge，更新槽数、工作目录、CPU affinity、消费者/下载并发、线程池、挂载和服务单元；不会重新生成节点 key、改变服务器 URL、rootfs 或 AI 配置。它会检查 systemd 单元并执行真实沙盒探针；原来运行的 judge 恢复运行并核对实际 CPU/线程池，原来停止的 judge 保持停止。验证失败会尝试恢复备份；若自动恢复也失败则保持 judge 停止，报告供人工回滚的目录。保管备份目录，不要把含 key 的 YAML 放入公开报告。

### 3. 验收与回滚

应用完成后确认服务正常、网页评测节点在线，再实际提交普通题、交互/通信题及所需语言。使用本机 AI 时再验证小型 AI 数据任务；命令成功不等于全部业务通过。

```bash
sudo systemctl is-active libreoj-judge.service
sudo systemctl show libreoj-judge.service -p AllowedCPUs -p EffectiveCPUs -p TasksMax
```

需要回退时，先阻止新任务并再次排空，将下面路径替换为脚本实际输出的私有备份目录：

```bash
sudo bash /opt/LibreOJ/deploy/resize-judge.sh --prefix /opt/LibreOJ --rollback /path/to/private-backup --drained
```

回滚恢复备份中的配置/单元及记录的运行、挂载状态；不是题库或数据库备份恢复，也不会撤回扩容后已完成的提交。回滚后同样检查节点在线和真实提交结果。

本文介绍待提交修订的接口与隔离回归范围，不宣称当前运行服务器已经完成扩容或 Ubuntu 26.04 全新部署验收。相关内容：[独立评测机](Remote-Judge.zh-CN.md) · [分布式评测](Distributed-Judging.zh-CN.md)。
