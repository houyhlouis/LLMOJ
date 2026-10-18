# 评测配置与扩缩容

简体中文 | [English](Judge-Configuration.md) | [Wiki 首页](Home.md)

本页介绍评测机配置文件 `/opt/LLMOJ/config/judge.yaml`（如果安装在其他目录，请换成你的目录）中的每项设置、评测槽数量的计算方法、沙箱、systemd 服务，以及如何修改已有安装的评测槽数量。

## `judge.yaml` 中的设置

评测机读取 `LIBREOJ_JUDGE_CONFIG_FILE` 指定的文件，没有该文件就无法启动。大多数设置没有内置默认值：下面的示例值来自 [config-example.yaml](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/config-example.yaml)，安装器可能写入其他值。示例中的 `key` 和 `sandbox.rootfsId` 只是占位符，不能直接使用。

### 连接与下载

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `serverUrl` | `http://api.libreoj.test/` | 站点地址，不带 `/api`。与站点在同一台服务器的评测机由安装器写入 `http://127.0.0.1:2002`，[远程评测机](Remote-Judge.zh-CN.md)写入站点的 HTTPS 地址 |
| `downloadEndpointOverride` | `null` | 替换测试数据下载地址中的协议、主机和端口，保留路径和查询参数。同一服务器上的评测机使用 `127.0.0.1` 上的 Nginx；远程评测机通常不设置，但必须能访问站点的下载地址 |
| `key` | 40 个 base64 字符 | 该评测机独有的密钥。文件所有者为 root、权限为 `0600`；不要把密钥写在命令行、截图或公开日志中 |
| `rpcTimeout` | `20000` | 等待站点响应的毫秒数。超时后评测机会重启，并取消正在进行的工作。安装器写入 `30000` |
| `downloadTimeout` | `20000` | 站点开始响应后，一次下载可用的毫秒数 |
| `downloadRetry` | `3` | 每次下载总共尝试的次数：`3` 表示首次尝试加最多两次重试 |
| `maxConcurrentDownloads` | `10` | 同时进行的下载数（超过 20 会警告）。安装器写入评测槽数量，最多 4 |

### 缓存

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `dataStore` | `/root/judge/data` | 已下载测试数据的缓存。安装器写入 `<root>/data/judge/testdata`。它的大小没有限制，请关注磁盘空间 |
| `binaryCacheStore` | `/root/judge/cache` | 编译结果的缓存，评测机启动时清空。安装器写入 `<root>/data/judge/cache`。不要指向保存其他内容的目录 |
| `binaryCacheMaxSize` | `536870912`（512 MiB） | 编译缓存的大小（字节）。必须至少等于站点的 `limit.outputSize`，否则评测机连接后会停止 |

### 评测槽与并发

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `taskWorkingDirectories` | 三个路径 | 每个评测槽一个目录，互不相同。安装器写入 `<root>/data/judge/work/1` 到 `N`，每个都是单独的 tmpfs，评测机启动时清空。不要与缓存共用 |
| `maxConcurrentTasks` | `3` | 评测槽数量，由编译、运行测试点和本机 AI 检查共用。安装器使它等于工作目录数；实际取两者中较小的值 |
| `taskConsumingThreads` | `2` | 评测机同时从站点领取的提交数（超过 3 会警告），每份提交可以有很多测试点。安装器写入评测槽数的一半，范围 1～3。它不是 CPU 数 |
| `memoryBudget` | 未设置 | 所有正在运行的工作的沙箱合计可预留的内存（MiB）。默认为服务器内存的 85% 减 512 MiB，至少 256。工作在其声明的内存限制装得下时才开始，因此多道内存限制很大的题目不会耗尽服务器内存。与其他服务共用服务器时可调低 |
| `aiExecutionSlots` | 未设置 | AI 检查（来自本机 AI 任务或评测队列）同时可用的评测槽数。默认为除一个之外的全部槽（只有一个槽时为 1），保证评测始终有槽可用。它也限制评测机同时从队列领取的 AI 程序运行数 |

### 本机 AI 任务

这些设置只用于与站点在同一台服务器上的评测机；远程评测机将它们留空，即关闭 AI 任务。

| 设置 | 含义 |
| --- | --- |
| `aiRunnerSocket` | 后端发送 AI 检查所用的本机 socket：`<root>/data/judge/ai-runner.sock`，所有者为 root 和 `libreoj` 组，权限 `0660`。不要通过 TCP 公开 |
| `aiGeneratedDirectory` | 与后端共用的 AI 结果私有目录：`<root>/data/ai-generated`，必须是真实目录（不能是链接），所有者为 root 和 `libreoj` 组，权限 `0750` |
| `aiRunnerGid` | `libreoj` 组的 ID。开启 AI 任务时必须为正数；远程评测机为 `0` |

### 沙箱

| 设置 | 示例 | 含义 |
| --- | --- | --- |
| `sandbox.rootfs` | `/opt/rootfs-ng` | 沙箱的文件系统（rootfs）。安装器写入 `<root>/runtime/sandbox-rootfs`。不要修改其中文件的所有者 |
| `sandbox.rootfsId` | 64 位十六进制数 | 沙箱镜像的 SHA-256 ID，必须与 ID 文件完全一致，否则评测机无法启动 |
| `sandbox.rootfsIdFile` | 未设置 | ID 文件，默认为 `<sandbox.rootfs>/etc/libreoj-rootfs-id`。不可修改的镜像可以把它放在别处 |
| `sandbox.hostname` | `null` | 沙箱内的主机名；安装器写入 `libreoj-judge` |
| `sandbox.immutable` | 未设置 | 用于不可修改的镜像：设为 `true` 时，工作路径改为 `/tmp/libreoj`，而不是镜像内的目录。它本身不会让镜像变成只读 |
| `sandbox.resourceMode` | 未设置 | `default`（安装器写入）用 cgroup 统计程序的 CPU 时间；`arbiter` 改用程序的用户态 CPU 时间，并额外限制地址空间。只影响提交的程序，会改变评测结果的计算方式 |
| `sandbox.syscallFilter` | 未设置 | 默认 `true`：拒绝评测程序用不到的系统调用，见[下文](#沙箱系统调用过滤器与自检)。只在需要确认过滤器是否影响某种语言时设为 `false` |
| `sandbox.user` | `sandbox` | 程序在沙箱中运行的用户（不是评测服务本身的运行用户） |
| `sandbox.environments` | 见右 | 沙箱中程序的环境变量，值为文本。示例设置 `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`、`HOME=/sandbox` 和 `LC_ALL=en_US.UTF-8`。评测机自身的变量（如 `UV_THREADPOOL_SIZE`）不能写在这里 |

### CPU 亲和性

`cpuAffinity.compiler`、`cpuAffinity.userProgram`、`cpuAffinity.interactor` 和 `cpuAffinity.checker` 分别列出各类程序可以使用的逻辑 CPU（例如 `[0, 1]`）。安装器为四者都写入它为评测选择的 CPU。它们不会为每个评测槽分配独占的 CPU，并且必须在 systemd 允许该服务使用的 CPU 范围内。不设置时只受 systemd 的限制。

### 来自站点的限制

评测机连接时，站点会发送一些限制：`limit.compilerMessage`、`limit.outputSize`、`limit.dataDisplay`、`limit.dataDisplayForSubmitAnswer` 和 `limit.stderrDisplay`。它们不是 `judge.yaml` 中的设置；每道题的时间和内存限制同样来自站点。

## 评测机的环境变量

- `LIBREOJ_JUDGE_CONFIG_FILE`：配置文件，`<root>/config/judge.yaml`。
- `LIBREOJ_JUDGE_LOG_LEVEL`：默认 `info`。只在排查问题时使用 `verbose` 或 `debug`，并且不要公开这些日志，其中包含带签名的下载地址。
- `UV_THREADPOOL_SIZE`：至少为评测槽数的两倍加二（最多 1024）；安装器写入 `max(4, 2 × 槽数 + 2)`。每个槽可能同时等待两个程序（交互题），另外两个线程处理文件。修改后需要重启评测机。
- `NODE_OPTIONS=--max-old-space-size=512`：评测机自身的内存，不是提交程序的内存限制。
- `HYHOJ_AI_SAMPLE_INPUTS_DIR`：AI 样例输入的私有目录，`<root>/data/ai-sample-inputs`。必须与后端相同，并且不能公开访问。

## 工作如何调度

- 评测机同时最多从站点领取 `taskConsumingThreads` 份提交。
- 编译、运行测试点和本机 AI 检查共用评测槽。一个测试点预留程序的内存限制加上交互器的内存限制（如果校验器的更大则用校验器的），一次编译预留 512 MiB，其他工作预留 256 MiB；工作按到达顺序，在评测槽和所需内存都空闲时开始。需要的内存超过全部预算的工作单独运行。
- AI 检查（本机的或来自评测队列的）最多使用 `aiExecutionSlots` 个槽，不会阻塞排在它后面的评测。
- 下载有单独的队列，大小为 `maxConcurrentDownloads`。
- AI 任务另外最多同时运行三个 AI 流程，最多接受八个请求；这些不是额外的评测槽，也不能配置。

提高 `taskConsumingThreads` 或 AI 并发不会增加评测能力：只有评测槽（以及它们背后的 CPU 和内存）才会。

## 如何确定评测槽数量

一个评测槽同一时间运行一次编译或一个测试点。一个评测服务运行它所有的评测槽。默认的评测槽数量（也是允许的最大值）为：

> 评测机可用的 CPU 数减一，与其可用内存（MiB）除以 256，两者取较小值，且不超过 511

与站点在同一台服务器上的评测机和远程评测机都使用这一规则。只有一个 CPU 或内存不足 256 MiB 的服务器不能评测。

“可用的 CPU 数”会考虑 CPU 亲和性、cgroup CPU 集合和 CPU 配额，而不仅是 `nproc`；“可用内存”取服务器内存与 cgroup `memory.max` 中的较小值。评测机使用的 CPU 从允许列表的末尾选取，列表不必从 0 开始，也不必连续。

| CPU 数 | 评测槽数（内存足够时） |
| --- | --- |
| 1 | 0 |
| 2 | 1 |
| 3 | 2 |
| 4 | 3 |
| 8 | 7 |
| 16 | 15 |
| 32 | 31 |

例如有 8 个 CPU（0–7）和 8 GiB 内存时，评测机使用 CPU 1–7、7 个评测槽、同时领取 3 份提交、4 个下载、工作目录 1–7 和 16 个线程。只有 512 MiB 内存时，它使用 CPU 6 和 7 上的 2 个评测槽和 6 个线程。由于工作会等待内存，除非大部分题目都有很大的内存限制，否则不需要减少评测槽。

每个评测槽的 512 MiB tmpfs 是它最多能容纳的大小，而不是预留的内存。编译器、程序、页缓存、AI 和数据库共用服务器内存，`TasksMax`、cgroup 和 CPU 配额也仍然有效。`lscpu -e=CPU,CORE,SOCKET,ONLINE` 可以显示哪些逻辑 CPU 共用一个物理核心；评测槽不会独占核心。

安装器和扩缩容命令使用同一计算方法：[judge_capacity.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/judge_capacity.py)。

## 沙箱、系统调用过滤器与自检

所有编译器、程序、校验器和交互器都在沙箱中运行：
- 以无特权的 `sandbox.user` 身份运行，无法获得特权（`no_new_privs`）；
- 使用独立的挂载、PID、网络、UTS 和 IPC 命名空间，文件系统只读，只能访问自己任务的目录；
- 受 cgroup v2 对内存、进程数和 CPU 时间的限制。

此外，seccomp 过滤器会拒绝评测程序用不到的系统调用（`sandbox.syscallFilter`，默认开启）：
- 创建或进入命名空间、挂载和更改根目录；
- ptrace 和读取其他进程的内存；
- 密钥环、io_uring、bpf、性能事件和 userfaultfd；
- 内核模块、重启、交换区以及设置系统时间或主机名。

这些调用返回“不允许的操作”，通过 32 位系统调用表（`-m32` 程序和 `int 0x80`）调用时也一样；x32 调用同样失败。`clone3` 返回“未实现”，使 C 库改用 `clone`，过滤器可以检查后者的参数。如果过滤器无法安装，任何程序都不会运行。

检查本评测机（通过评测机自身的代码编译并运行每种语言，并用 64 位和 32 位程序测试过滤器）：

```bash
sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh
```

每项检查输出一行，耗时几秒到一分钟。它使用自己的临时目录，从不使用评测机密钥，因此可以在评测机工作时运行，但会与评测争用 CPU。`--only cpp,java` 只检查部分语言。每当评测机或沙箱有改动时，升级器都会在切换之前用新版本运行它。

**沙箱不能做到的事。** 沙箱中的程序与服务器共用内核，因此内核漏洞仍可能让程序逃逸。过滤器减少了程序能接触到的内核功能，但不能证明完全隔离，而且评测机的控制进程以 root 运行。对于公开的比赛：
- 在独立的机器上运行评测机，不要放在网页服务器上；
- 及时更新内核；
- 不要在远程评测机上存放站点的凭据（数据库、MinIO、AI 密钥），它们只需要评测机密钥。

## systemd 服务

安装器和扩缩容命令为评测服务写入以下设置。请检查它们写入的文件，以及可能覆盖这些设置的 drop-in。

| 设置 | 值 |
| --- | --- |
| `After`、`Requires`、`Wants` | 与站点在同一服务器上的评测机在 `libreoj-backend.service` 之后启动，并依赖它。远程评测机等待网络就绪（`network-online.target`） |
| `PartOf`、`WantedBy` | 服务及其挂载在站点服务器上属于 `libreoj.target`，在远程评测机上属于开机启动的 `libreoj-judge.target` |
| `RequiresMountsFor` | 所有工作目录，因此服务只在它们的 tmpfs 挂载完成后启动 |
| `WorkingDirectory`、`ExecStart` | `<root>/apps/judge`，运行 `<node> -r @swc-node/register index.mjs` |
| `Environment` | `NODE_ENV=production`、`PATH`，以及[评测机的环境变量](#评测机的环境变量)中的变量 |
| `Delegate`、`DelegateSubgroup` | `cpu memory pids` 和 `supervisor`（需要 systemd 254 或更高版本）：由沙箱自己管理 cgroup。不要删除 |
| `OOMPolicy` | `continue`：某个程序内存不足不会停止整个服务 |
| `AllowedCPUs` | `cpuAffinity` 中的所有 CPU |
| `TasksMax` | 总共 `2048` 个进程和线程 |
| `Restart`、`RestartSec` | 失败 3 秒后重启 |
| `TimeoutStopSec` | `30` 秒。停止服务不会等待排队的工作：请先[排空](#2-排空评测机并应用)评测机 |
| `UMask`、`LimitCORE` | `0022`，不生成 core 文件 |
| `StandardOutput`、`StandardError` | `journal` |

没有设置 `User` 和 `Group`，因此服务以 root 运行；`sandbox.user` 是沙箱内的另一个用户。`CPUAccounting`、`MemoryAccounting`、`TasksAccounting`、`MemoryMax`、`CPUQuota` 等限制也没有设置，由 systemd 默认值或上级 slice 决定。查看实际生效的值：

```bash
sudo systemctl show libreoj-judge.service -p CPUAccounting -p MemoryAccounting -p TasksAccounting -p LimitCORE -p TasksMax
```

每个工作目录有自己的挂载单元（名称由 `systemd-escape --path --suffix=mount` 生成）：一个 `tmpfs`，选项为 `size=512m,mode=0755,nodev,nosuid`。

## 修改评测槽数量

增加或减少 CPU、内存后，请使用扩缩容命令修改评测槽数量。不要用不同的 `--judge-slots` 重新运行安装器，不要修改安装记录，也不要删除 `judge.yaml` 或密钥来强行修改。

该命令适用于安装器安装的评测机，要求使用标准的工作目录和服务。仅网页的服务器没有可调整的评测机；请改为添加[远程评测机](Remote-Judge.zh-CN.md)。`--mode auto`（默认）会判断这是完整站点还是远程评测机；`--mode all` 或 `--mode remote` 只用于确认是否为你预期的那一种。如果服务自己设置了 `MemoryMax` 或 `CPUQuota`、有影响它的 drop-in，或属于其他安装目录，命令会拒绝修改：请先人工检查。

`resize-judge.sh` 输出英文，`resize-judge.zh-CN.sh` 输出中文，其他方面完全相同。

### 1. 查看计划

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.zh-CN.sh --prefix /opt/LLMOJ --plan
# 指定数量（必须符合 CPU 和内存）：
sudo bash /opt/LLMOJ/deploy/resize-judge.zh-CN.sh --prefix /opt/LLMOJ --slots 6 --plan
```

`--plan` 不做任何修改，只显示新旧评测槽数、CPU、内存和线程数。

### 2. 排空评测机并应用

选择空闲时段。停止新的提交、重测、测试运行和 AI 任务，等待**所有人**排队中和运行中的工作完成。如果其他评测机可以接手队列，也可以在 **评测机状态** 页面 **排空** 本评测机，等待显示 **已排空**；但本机 AI 任务仍需完成，因为排空不包括它们。CPU 空闲或自己的 AI 任务列表为空，都不能证明没有工作在运行。`--drained` 表示你确认已完成这一步，命令本身不会排空任何东西。

不带参数运行时，命令会显示容量和排空要求，并询问评测槽数量。**输入数字（或直接回车使用默认值）即表示确认已排空，并立即执行修改，不会再次确认。** 如果仍有工作在运行，请按 Ctrl+C 退出。

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.zh-CN.sh --prefix /opt/LLMOJ
```

或者不提问直接执行：

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.zh-CN.sh --prefix /opt/LLMOJ --slots 6 --apply --drained
```

该命令会：
1. 把 `judge.yaml`、评测服务及其状态备份到 `<prefix>/backups/judge-resize/<UTC 时间>/`，并输出该目录；
2. 只停止评测机；
3. 更新评测槽、工作目录、CPU、并发、线程、挂载和服务，保留密钥、站点地址、沙箱镜像和 AI 设置；
4. 检查服务并运行真实的沙箱测试；
5. 如果评测机之前在运行，则重新启动它（并检查其 CPU 和线程）；之前已停止的评测机保持停止。

如果检查失败，它会恢复备份。如果恢复也失败，评测机保持停止，命令会告诉你备份所在的位置。请妥善保管备份：其中包含评测机密钥。

### 3. 检查或回滚

确认服务正在运行、站点上显示评测机在线，然后用常用语言提交普通题和交互题；如果使用本机 AI，再运行一个小的 AI 任务。

```bash
sudo systemctl is-active libreoj-judge.service
sudo systemctl show libreoj-judge.service -p AllowedCPUs -p EffectiveCPUs -p TasksMax
```

要撤销修改，先停止新的工作并再次排空，然后传入命令输出的备份目录：

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.zh-CN.sh --prefix /opt/LLMOJ --rollback /path/to/backup --drained
```

这会恢复评测机的配置、服务及其之前的状态。它不会改动题目或数据库，也不会撤销期间已评测的提交。之后请再次检查评测机。

另见：[远程评测机](Remote-Judge.zh-CN.md) · [分布式评测](Distributed-Judging.zh-CN.md)。来源：[config.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/config.ts)、[configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py)、[executionCapacity.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/executionCapacity.ts)、[taskQueue.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/taskQueue.ts)、[aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts)。
