# 评测端完整配置与 CPU 扩缩容

[English](Judge-Configuration.md) | 简体中文

适用于安装器生成的 Ubuntu/systemd 部署，配置入口为 `/opt/LibreOJ/config/judge.yaml`（自定义 prefix 请替换）。本页覆盖当前评测端的所有 YAML 字段；后端下发限制、宿主环境变量和安装器生成值另行标明。

来源固定为 `43a88bdd62fbf200889b36932fa921439a293190`：[config.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/config.ts), [config-example.yaml](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/config-example.yaml), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-judge.py), [executionCapacity.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/executionCapacity.ts), [taskQueue.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/taskQueue.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/aiRunner.ts).

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
- `UV_THREADPOOL_SIZE`：在 Node 启动前设置，整数范围为 `2 × 实际执行槽 + 2` 到 `1024`。Node 默认 4 只够 1 槽；3 槽至少 8，7 槽至少 16。原生沙盒等待占 libuv worker，交互题每槽可能同时等待两个进程，另留两个文件系统 worker。安装生成 `max(4, slots*2+2)`，修改后必须重启 judge；写到 `sandbox.environments` 无效。
- `NODE_OPTIONS=--max-old-space-size=512` 是安装服务的 Node 堆设置，不是用户程序内存上限；`PATH` 指向安装的 Node 和宿主工具。
- `HYHOJ_AI_SAMPLE_INPUTS_DIR`：宿主 AI 输入样例目录，代码缺省 `/opt/LibreOJ/data/ai-sample-inputs`，服务生成 `<root>/data/ai-sample-inputs`；与后端必须一致，不能当作公共静态目录。

普通提交消费者由 `taskConsumingThreads` 控制；编译/测试点和本机 AI 验证共用 `min(maxConcurrentTasks, 工作目录数)` 的执行槽；文件下载另有 `maxConcurrentDownloads` 队列。AI runner 还有固定 3 个生成管线并发、最多 8 个已接收的未完成请求（包含等待），它们不是额外的 3/8 个 CPU 槽，也没有对应 YAML 调节项；后端 AI 并发又是另一层限制。不要仅增加消费者或后台 AI 并发来“扩 CPU”。

后端认证时下发 `limit.compilerMessage`、`limit.outputSize`、`limit.dataDisplay`、`limit.dataDisplayForSubmitAnswer`、`limit.stderrDisplay`，这些不是 judge.yaml 键。代码对 compilerMessage 超过 1 MiB、dataDisplay 超过 1 KiB、stderrDisplay 超过 10 KiB 发警告；binaryCacheMaxSize 小于 outputSize 为致命错误。题目/语言本身的时间与内存限制也来自后端。

安装器的资源估算：使用 `os.sched_getaffinity(0)` 的可用逻辑 CPU；本机 all 模式在有多个 CPU 时保留排序后的第一个给站点，remote 不保留这一个。按总 RAM 减去 all 模式 2048 MiB、remote 模式 1024 MiB 后，每 512 MiB 预算一个槽，再取 CPU 数、内存槽数和 7 的最小值。生成器内存槽数最低取 1；下面维护例子更保守，预算连 1 槽都不足时拒绝。3 GiB 是安装最低要求，不等于适合高并发。

每槽 512 MiB **tmpfs 最大容量**，不是预先分配 512 MiB，也不是该槽所有进程内存的上限。编译器、程序、页缓存、AI 数据、数据库同时占 RAM；高内存题、交互题和 AI 生成应减少槽数，监测 OOM、可用内存和评测耗时。容器/服务的 `memory.max`、`CPUQuota`、父 cgroup 可能比宿主资源更小，以下计算不能替代这些额度检查。

`lscpu -e=CPU,CORE,SOCKET,ONLINE` 可分辨逻辑 CPU 与物理核；SMT 的两个逻辑 CPU 共享一个物理核，8 个逻辑 CPU 不保证 8 核独占吞吐。CPU ID 也不保证连续；以当前可用集合为准。`cpuAffinity` 四组与 systemd 的 `AllowedCPUs`/父 cgroup 共同限制调度；生成器把四组并集写入 `AllowedCPUs`，并非每个槽独占绑定。

**8 个可用逻辑 CPU、8 GiB RAM 的 all 示例**：若 CPU ID 为 0–7，则使用 1–7 的 7 槽，消费者 3、下载并发 4、工作目录 1–7、线程池 16。内存公式允许此配置，但应先用实际题目观察负载；remote 同样最多生成 7 槽，可默认取 0–6。**7 是安装器/生成器支持上限，不是评测内核硬限制**。自行超过 7 要独立规划 mount、CPU、内存、线程池并验证，不能绕过安装器校验就视为受支持配置。

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

## 现有安装扩容或缩容

本节不会重新安装或重新生成 key。`--judge-slots` 属于首次安装选项且记入 installer metadata；用不同值重跑可能被“metadata differs”拒绝，已完成分支也不会重建评测配置。`configure-judge.py` 对已存在 `judge.yaml` 只核对实例信息并保留其字段，单独改 `OJ_JUDGE_SLOTS` 不会替换已有 YAML。**不要删除 YAML、secrets、安装元数据或修改 metadata 来强行扩容。**

先确认 `libreoj-judge.service` 存在且此节点已经安装 judge；`--role web` 不适用直接扩槽，需另行部署 [远程评测机](Remote-Judge.zh-CN.md)，或规划完整 all 部署。local `all` 保留本机 AI worker；remote 只调普通评测，并使用 `libreoj-judge.target`。本例要求安装器的标准 `work/1..N` 路径；有自定义 mount、service symlink 或 drop-in 时先人工核对。

1. 安排维护窗口，暂停新提交、重测、测试运行与 AI 任务入口，等待**所有用户**的运行/排队任务结束，不能只看自己的 AI 列表。本版没有通用的 judge drain 命令；只看“CPU 空闲”不表示队列已空。管理员可检查提交列表 Pending、评测日志，AI 任务存储中的 queued/running 状态；确认无工作后才执行 apply。无法限制新请求时仍存在竞态，应停留在 plan。
2. 只读检查服务覆盖项和资源：下面命令仅显示指定属性，不输出完整环境或 key。若上层 CPU/内存额度较小，先降低目标槽数；有自定义 drop-in 时需保证其线程池/CPU 绑定不会覆盖新单元。

```bash
lscpu -e=CPU,CORE,SOCKET,ONLINE
free -h
sudo systemctl show libreoj-judge.service -p DropInPaths -p AllowedCPUs -p EffectiveCPUs -p MemoryMax -p CPUQuotaPerSecUSec
```

3. 以下完整块默认仅输出 plan，不写任何文件也不停止服务。`OJ_ROOT` 可替换安装 prefix，`OJ_RESIZE_SLOTS=7` 可改成较小值实现缩容；remote 节点将 `OJ_RESIZE_MODE=all` 改成 `remote`。确认排空后，重执行同一完整块，仅把 `OJ_RESIZE_APPLY=0` 改为 `1`。如需挑选非相邻物理核对应的逻辑 CPU，可额外给 `OJ_RESIZE_CPUS=1,2,3,4,5,6,7`，数量须等于槽数。

apply 会先私有备份 YAML、已安装关联单元及生成模板，然后仅停 judge。它保留 key、URL、rootfs 和 AI 设置，只改容量字段；远程 generator 的 URL 和私有 key 副本均取自原配置，绝不创建新身份。随后生成、校验、安装 service/mount，停用并移除旧的多余 mount 单元，启用新增 mount，重新加载 systemd，通过沙盒检查后启动。不会重启网页/数据库，也不卸载仍使用的工作目录。不要在其他终端同时执行本块。

```bash
sudo env OJ_ROOT=/opt/LibreOJ OJ_RESIZE_MODE=all OJ_RESIZE_SLOTS=7 OJ_RESIZE_APPLY=0 python3 - <<'PY'
import datetime, json, os, re, shutil, subprocess, sys
from pathlib import Path
import yaml

root = Path(os.environ.get('OJ_ROOT', '/opt/LibreOJ'))
mode = os.environ.get('OJ_RESIZE_MODE', 'all')  # all or remote
slots = int(os.environ.get('OJ_RESIZE_SLOTS', '7'))
apply = os.environ.get('OJ_RESIZE_APPLY', '0') == '1'
if os.geteuid() != 0 or mode not in ('all', 'remote'):
    raise SystemExit('Run with sudo; mode must be all or remote')
if not root.is_absolute() or root == Path('/') or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(root)):
    raise SystemExit('Use a valid absolute installation prefix')
root = root.resolve()
config = root / 'config/judge.yaml'
if config.is_symlink() or not config.is_file():
    raise SystemExit('judge.yaml must be a regular file')
try:
    c = yaml.safe_load(config.read_text())
except yaml.YAMLError:
    raise SystemExit('Cannot parse judge.yaml (private key withheld)') from None
available = sorted(os.sched_getaffinity(0))
candidates = available if mode == 'remote' or len(available) == 1 else available[1:]
mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
ram_mib = int(mem['MemTotal'].split()[0]) // 1024
reserve_mib = 1024 if mode == 'remote' else 2048
maximum = min(7, len(candidates), max(0, (ram_mib - reserve_mib) // 512))
if not 1 <= slots <= maximum:
    raise SystemExit(f'Requested slots exceed CPU/RAM budget; maximum here is {maximum}')
cpus = candidates[:slots]
if os.environ.get('OJ_RESIZE_CPUS'):
    cpus = [int(x) for x in os.environ['OJ_RESIZE_CPUS'].split(',')]
if len(set(cpus)) != slots or len(cpus) != slots or not set(cpus) <= set(candidates):
    raise SystemExit('Choose one distinct allowed logical CPU per slot')
work = root / 'data/judge/work'
old_dirs = [Path(x) for x in c['taskWorkingDirectories']]
if old_dirs != [work / str(i) for i in range(1, len(old_dirs) + 1)]:
    raise SystemExit('This example requires standard work/1..N paths; review custom layouts separately')
if any(p.is_symlink() for p in [root/'config', work, *old_dirs]):
    raise SystemExit('Configuration/work directories must not be symlinks')
new_dirs = [work / str(i) for i in range(1, slots + 1)]
if any(p.is_symlink() for p in new_dirs):
    raise SystemExit('New workspace must not be a symlink')
def run(*args):
    return subprocess.run(list(args), check=True)
def mount_name(p):
    return subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', str(p)], text=True).strip()
old_mounts, new_mounts = [mount_name(p) for p in old_dirs], [mount_name(p) for p in new_dirs]
target = 'libreoj-judge.target' if mode == 'remote' else 'libreoj.target'
service = 'libreoj-judge.service'
extra = ['libreoj-judge.target'] if mode == 'remote' else []
installed = Path('/etc/systemd/system')
source_units = root / 'deploy/systemd'
print(f'Plan: {len(old_dirs)} -> {slots} slots; CPUs={cpus}; RAM={ram_mib}MiB; reserve={reserve_mib}MiB')
print(f'UV_THREADPOOL_SIZE={slots*2+2}; target={target}; key and other configuration retained')
if not apply:
    print('Read-only plan. Drain all submissions/AI jobs, then rerun with OJ_RESIZE_APPLY=1.')
    sys.exit(0)
# Nothing below runs in plan mode. Keep the backup private; it contains a judge key.
backup = Path('/var/backups/libreoj-judge') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup.mkdir(parents=True, mode=0o700)
backup.chmod(0o700)
shutil.copy2(config, backup/'judge.yaml')
(backup/'judge.yaml').chmod(0o600)
(backup/'installed').mkdir(mode=0o700)
shutil.copytree(source_units, backup/'generated')
names = [service, *extra, *old_mounts]
for name in set(names + new_mounts):
    if (installed/name).is_symlink():
        raise SystemExit('Custom symlink unit requires manual review: ' + name)
for name in names:
    p = installed/name
    if p.is_symlink():
        raise SystemExit('Custom symlink unit requires manual review: ' + name)
    if p.exists(): shutil.copy2(p, backup/'installed'/name)
enabled = {name: subprocess.run(['systemctl', 'is-enabled', '--quiet', name]).returncode == 0 for name in old_mounts}
manifest = {'root':str(root), 'mode':mode, 'old_mounts':old_mounts, 'new_mounts':new_mounts,
            'extra':extra, 'enabled':enabled}
(backup/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print('PRIVATE BACKUP:', backup, flush=True)
run('systemctl', 'stop', service)
try:
    # Only capacity-related YAML values change; key/rootfs/server/AI settings are untouched.
    c.update(maxConcurrentTasks=slots, taskWorkingDirectories=list(map(str, new_dirs)),
             taskConsumingThreads=min(3, max(1, slots//2)), maxConcurrentDownloads=min(4, slots))
    c['cpuAffinity'] = {name:cpus for name in ('compiler', 'userProgram', 'interactor', 'checker')}
    temporary = config.with_name('judge.yaml.resize-new')
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f: yaml.safe_dump(c, f, sort_keys=False)
    os.replace(temporary, config)
    env = dict(os.environ, HYHOJ_ROOT=str(root), NODE_BINARY=str(root/'runtime/node/bin/node'),
               OJ_JUDGE_REMOTE='1' if mode == 'remote' else '0', OJ_JUDGE_SLOTS=str(slots))
    if mode == 'remote':
        # A private copy of the existing key supplies the generator; no key in argv/logs.
        key_file = backup/'remote.key'
        key_file.write_text(c['key']+'\n'); key_file.chmod(0o600)
        env.update(OJ_JUDGE_SERVER=c['serverUrl'], OJ_JUDGE_KEY_FILE=str(key_file))
    subprocess.run(['python3', str(root/'deploy/configure-judge.py')], env=env, check=True)
    new_names = [service, *extra, *new_mounts]
    run('systemd-analyze', 'verify', *[str(source_units/name) for name in new_names])
    for name in sorted(set(old_mounts)-set(new_mounts)):
        run('systemctl', 'disable', '--now', name)
        (installed/name).unlink(missing_ok=True)
    for name in new_names:
        shutil.copy2(source_units/name, installed/name)
        (installed/name).chmod(0o644)
    run('systemctl', 'daemon-reload')
    for name in new_mounts: run('systemctl', 'enable', '--now', name)
    # No web/database restart. Verify the sandbox before restarting this judge.
    run('systemd-run', '--unit=libreoj-resize-check', '--wait', '--pipe', '--collect',
        '--property=Delegate=cpu memory pids', '--property=DelegateSubgroup=supervisor',
        '--property=LimitCORE=0', '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=15',
        '--property=WorkingDirectory='+str(root/'apps/judge'),
        str(root/'runtime/node/bin/node'), str(root/'deploy/sandbox/verify-installed.mjs'), '--root', str(root))
    run('systemctl', 'start', service)
    run('systemctl', 'is-active', '--quiet', service)
    print('Judge started. Verify online status and submissions; retain PRIVATE BACKUP:', backup)
except Exception:
    subprocess.run(['systemctl', 'stop', service], check=False)
    print('Resize failed; judge left stopped. Use the rollback block with PRIVATE BACKUP:', backup, file=sys.stderr)
    raise SystemExit(1) from None
PY
```

4. 检查打印的备份路径；其中包含密钥，保留 root 私有权限，不放进公开报告。失败时本块尽量将 judge 留在停止状态；不要继续下一步，使用下面回滚。若进程被强制杀死/宿主重启，先停止 judge 并按备份恢复。成功后执行：

```bash
sudo systemctl status libreoj-judge.service --no-pager
sudo systemctl show libreoj-judge.service -p AllowedCPUs -p EffectiveCPUs
sudo findmnt -t tmpfs
sudo journalctl -u libreoj-judge.service -n 50 --no-pager
```

核对日志认证成功、实际 work/1..N 挂载、后端节点在线；提交正确 C++、错误程序、交互题和（all 模式）一个现有 AI 验证任务做验收。检查 AC/WA、超时/内存限制、队列与资源曲线后恢复入口。不需重新构建源码。不要通过“导入 config.ts 来验证 YAML”：它会在启动期间清空工作目录和二进制缓存。

## 从本次私有备份回滚

把下面路径替换为 resize 实际打印的目录。本块停止 judge、停用新增 mount、恢复原 YAML 和已备份 service/mount/生成模板、恢复原挂载启用状态，再启动旧配置。它不修改安装 metadata、不删题库、不删缓存根或物理工作目录。随后重复上面的在线/提交验收。

```bash
sudo env OJ_RESIZE_BACKUP=/var/backups/libreoj-judge/REPLACE_WITH_PRINTED_DIRECTORY python3 - <<'PY'
import json, os, shutil, subprocess
from pathlib import Path
backup = Path(os.environ['OJ_RESIZE_BACKUP']).resolve()
if os.geteuid() != 0 or not backup.is_relative_to('/var/backups/libreoj-judge'):
    raise SystemExit('Use sudo and the exact private backup directory printed by resize')
m = json.loads((backup/'manifest.json').read_text())
root, installed = Path(m['root']), Path('/etc/systemd/system')
def run(*args): subprocess.run(list(args), check=True)
run('systemctl', 'stop', 'libreoj-judge.service')
for name in sorted(set(m['new_mounts'])-set(m['old_mounts'])):
    # A failure before installation may mean that this unit does not exist yet.
    if (installed/name).exists():
        run('systemctl', 'disable', '--now', name)
        (installed/name).unlink()
shutil.copy2(backup/'judge.yaml', root/'config/judge.yaml')
(root/'config/judge.yaml').chmod(0o600)
for name in ['libreoj-judge.service', *m['extra'], *m['old_mounts']]:
    saved = backup/'installed'/name
    if saved.exists(): shutil.copy2(saved, installed/name)
# Restore only generator-managed files; do not delete other project/service units.
generated = root/'deploy/systemd'
for p in generated.glob('*.mount'):
    if 'Description=LibreOJ judge workspace\n' in p.read_text(): p.unlink()
for p in (backup/'generated').iterdir():
    if p.is_file() and (p.suffix == '.mount' or p.name in ['libreoj-judge.service', *m['extra']]):
        shutil.copy2(p, generated/p.name)
run('systemctl', 'daemon-reload')
for name in m['old_mounts']:
    run('systemctl', 'enable' if m['enabled'][name] else 'disable', name)
    run('systemctl', 'start', name)
run('systemctl', 'start', 'libreoj-judge.service')
run('systemctl', 'is-active', '--quiet', 'libreoj-judge.service')
print('Old judge configuration and units restored; verify online status and submissions.')
PY
```

相关：[独立评测机](Remote-Judge.zh-CN.md) · [分布式评测](Distributed-Judging.zh-CN.md)。本页命令经语法与隔离临时 fixture 校验；没有为编写文档调整在线机器或真实队列。
