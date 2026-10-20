# Judge configuration and resizing

[简体中文](Judge-Configuration.zh-CN.md) | English | [Wiki home](Home.en.md)

This page describes every setting in the judge's configuration file, `/opt/LLMOJ/config/judge.yaml` (use your own directory if you installed elsewhere), how the number of judge slots is chosen, the sandbox, the systemd service, and how to change the number of slots on an existing installation.

## Settings in `judge.yaml`

The judge reads the file named by `LIBREOJ_JUDGE_CONFIG_FILE` and won't start without it. Most settings have no built-in default: the examples below come from [config-example.yaml](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/config-example.yaml), and the installer may write other values. The example's `key` and `sandbox.rootfsId` are placeholders and won't work.

### Connection and downloads

| Setting | Example | Meaning |
| --- | --- | --- |
| `serverUrl` | `http://api.libreoj.test/` | The site's address, without `/api`. The installer writes `http://127.0.0.1:2002` for a judge on the same server, and the site's HTTPS address for a [remote judge](Remote-Judge.md). |
| `downloadEndpointOverride` | `null` | Replaces the scheme, host and port of test data download addresses, keeping their path and query. A judge on the same server uses Nginx on `127.0.0.1`; a remote judge normally leaves it out and must be able to reach the site's download addresses. |
| `key` | 40 base64 characters | This judge's key, registered for it alone. Keep the file owned by root with mode `0600`, and never put the key in a command line, screenshot or public log. |
| `rpcTimeout` | `20000` | Milliseconds to wait for the site to answer. When it expires, the judge restarts and cancels what it was doing. The installer writes `30000`. |
| `downloadTimeout` | `20000` | Milliseconds a download may take once the site has started answering |
| `downloadRetry` | `3` | Attempts per download in total: `3` means the first attempt and up to two retries |
| `maxConcurrentDownloads` | `10` | Simultaneous downloads (a warning above 20). The installer writes the number of slots, at most 4. |

### Caches

| Setting | Example | Meaning |
| --- | --- | --- |
| `dataStore` | `/root/judge/data` | Cache of downloaded test data. The installer writes `<root>/data/judge/testdata`. Its size isn't limited, so watch the free disk space. |
| `binaryCacheStore` | `/root/judge/cache` | Cache of compiled programs, emptied when the judge starts. The installer writes `<root>/data/judge/cache`. Never point it at a directory holding anything else. |
| `binaryCacheMaxSize` | `536870912` (512 MiB) | Size of that cache in bytes. It must be at least the site's `limit.outputSize`, or the judge stops after connecting. |

### Slots and concurrency

| Setting | Example | Meaning |
| --- | --- | --- |
| `taskWorkingDirectories` | three paths | One directory per judge slot, each different. The installer writes `<root>/data/judge/work/1` to `N`, each a separate tmpfs that is emptied when the judge starts. Don't share them with the caches. |
| `maxConcurrentTasks` | `3` | Number of slots, shared by compiling, running tests and local AI checks. The installer makes it equal to the number of working directories; the smaller of the two counts. |
| `taskConsumingThreads` | `2` | How many submissions the judge takes from the site at a time (a warning above 3); each can have many tests. The installer writes half the slots, from 1 to 3. This isn't a number of CPUs. |
| `memoryBudget` | not set | MiB of memory the sandboxes of all running work may reserve together. By default 85% of the server's memory minus 512 MiB, and at least 256. Work starts only when the memory limit it declares fits, so several problems with large limits can't exhaust the server's memory. Lower it on a server shared with other services. |
| `aiExecutionSlots` | not set | Slots AI checks may use at once, from the local AI worker or from the judge queue. By default all slots but one (1 if there's only one), so judging always has a slot. It also limits how many AI program runs the judge takes from the queue at once. |

### Local AI worker

These are set only for a judge on the same server as the site; a remote judge leaves them empty, which turns the AI worker off.

| Setting | Meaning |
| --- | --- |
| `aiRunnerSocket` | The local socket the backend uses to send AI checks: `<root>/data/judge/ai-runner.sock`, owned by root and the `libreoj` group with mode `0660`. The [sandbox launcher](#the-judges-account-and-its-sandbox-launcher) creates it and hands the judge only the listening socket. Never expose it over TCP. |
| `aiGeneratedDirectory` | Private directory for AI results, shared with the backend: `<root>/data/ai-generated`, a real directory (not a link). The launcher gives it to the judge's account and the `libreoj` group with mode `2750`: new files get the group, so the backend can read them. |
| `aiRunnerGid` | The `libreoj` group's ID. It must be positive when the worker is on; a remote judge has `0`. |

### Sandbox

| Setting | Example | Meaning |
| --- | --- | --- |
| `sandbox.rootfs` | `/opt/rootfs-ng` | The sandbox's file system (the "rootfs"). The installer writes `<root>/runtime/sandbox-rootfs`. Don't change its owners. |
| `sandbox.rootfsId` | 64 hexadecimal digits | The SHA-256 ID of the sandbox image. It must match the ID file exactly, or the judge won't start. |
| `sandbox.rootfsIdFile` | not set | The ID file; `<sandbox.rootfs>/etc/libreoj-rootfs-id` by default. An image that can't be changed may keep the file elsewhere. |
| `sandbox.hostname` | `null` | Host name inside the sandbox; the installer writes `libreoj-judge` |
| `sandbox.immutable` | not set | `true` for an image that can't be changed: working paths then live under `/tmp/libreoj` instead of directories inside the image. It doesn't make an image read-only by itself. |
| `sandbox.resourceMode` | not set | `default` (written by the installer) measures a program's CPU time with cgroups. `arbiter` uses its user CPU time instead and also limits its address space. It applies only to submitted programs, and changes how they are judged. |
| `sandbox.syscallFilter` | not set | `true` by default: refuse system calls judged programs don't need; see [below](#sandbox-syscall-filter-and-self-test). Set `false` only to find out whether the filter breaks a particular language. |
| `sandbox.user` | `sandbox` | The user programs run as inside the sandbox. It must differ from the judge's own account, `libreoj-judge`. |
| `sandbox.environments` | see below | Environment variables for programs in the sandbox, as text. The example sets `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/sandbox` and `LC_ALL=en_US.UTF-8`. Variables for the judge itself, such as `UV_THREADPOOL_SIZE`, don't belong here. |

### CPU affinity

`cpuAffinity.compiler`, `cpuAffinity.userProgram`, `cpuAffinity.interactor` and `cpuAffinity.checker` list the logical CPUs each kind of program may use (for example `[0, 1]`). The installer gives all four the CPUs it chose for judging. They don't give each slot its own CPU, and they must lie within the CPUs systemd allows the service. Without them, only systemd's limits apply.

### Limits from the site

The site sends some limits when the judge connects: `limit.compilerMessage`, `limit.outputSize`, `limit.dataDisplay`, `limit.dataDisplayForSubmitAnswer` and `limit.stderrDisplay`. They aren't settings in `judge.yaml`. Neither are each problem's time and memory limits, which also come from the site.

## The judge's environment

- `LIBREOJ_JUDGE_CONFIG_FILE`: the configuration file, `<root>/config/judge.yaml`.
- `LIBREOJ_JUDGE_LOG_LEVEL`: `info` by default. Use `verbose` or `debug` only while investigating a problem, and keep those logs private, as they contain signed download addresses.
- `UV_THREADPOOL_SIZE`: at least twice the number of slots plus two (up to 1024); the installer writes `max(4, 2 × slots + 2)`. Each slot may wait on two programs at once (for interactive problems), and two more threads handle files. Restart the judge after changing it.
- `NODE_OPTIONS=--max-old-space-size=512`: the judge's own memory, not the limit for submitted programs.
- `HYHOJ_AI_SAMPLE_INPUTS_DIR`: private directory of AI sample inputs, `<root>/data/ai-sample-inputs`. It must be the same as the backend's, and must never be served publicly. The sandbox launcher opens the files in it for the judge.
- `LIBREOJ_JUDGE_USER`: the account the judge runs as, `libreoj-judge` if not set. Change it only for testing.

## How work is scheduled

- The judge takes up to `taskConsumingThreads` submissions from the site at a time.
- Compiling, running tests and local AI checks share the slots. A test reserves its program's memory limit plus the interactor's (or the checker's, if larger), a compilation 512 MiB, and anything else 256 MiB; work starts, in order of arrival, when both a slot and its memory are free. Work that needs more than the whole budget runs on its own.
- AI checks, local or from the judge queue, use at most `aiExecutionSlots` slots and never hold up judging behind them.
- Downloads have their own queue of `maxConcurrentDownloads`.
- The AI worker also runs at most three AI pipelines at a time and accepts at most eight requests; these aren't extra slots and can't be configured.

Raising `taskConsumingThreads` or AI concurrency doesn't add capacity: only slots, with the CPUs and memory behind them, do.

## Choosing the number of slots

A slot is where one compilation or one test runs at a time. One judge service runs all its slots. The default number of slots, which is also the most allowed, is:

> the number of CPUs the judge may use minus one, or its memory in MiB divided by 256, whichever is smaller, and at most 511

The same rule applies to a judge on the site's server and to remote judges. A server with only one CPU, or less than 256 MiB of memory, can't judge.

"The CPUs the judge may use" takes into account CPU affinity, cgroup CPU sets and CPU quotas, not just `nproc`; "its memory" is the smaller of the server's memory and any cgroup `memory.max`. The judge's CPUs are taken from the end of the allowed list, which doesn't have to start at 0 or be contiguous.

| CPUs | Slots, with enough memory |
| --- | --- |
| 1 | 0 |
| 2 | 1 |
| 3 | 2 |
| 4 | 3 |
| 8 | 7 |
| 16 | 15 |
| 32 | 31 |

For example, with eight CPUs (0–7) and 8 GiB of memory, the judge gets CPUs 1–7, seven slots, three submissions at a time, four downloads, working directories 1–7 and 16 threads. With only 512 MiB of memory, it gets two slots on CPUs 6 and 7 and six threads. Because work waits for memory, problems with large memory limits don't need fewer slots unless they're most of what you judge.

Each slot's 512 MiB tmpfs is the most it can hold, not memory set aside. Compilers, programs, the page cache, AI and the database all share the server's memory, and `TasksMax`, cgroups and CPU quotas still apply. `lscpu -e=CPU,CORE,SOCKET,ONLINE` shows which logical CPUs share a physical core; slots don't get cores to themselves.

The installer and the resize command use the same calculation, [judge_capacity.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/judge_capacity.py).

## Sandbox, syscall filter and self-test

Every compiler, program, checker and interactor runs in the sandbox:
- as the unprivileged `sandbox.user`, unable to gain privileges (`no_new_privs`);
- in its own mount, PID, network, UTS and IPC namespaces, with a read-only file system and only its own task's directories;
- under cgroup v2 limits on memory, processes and CPU time.

A seccomp filter also refuses system calls that judged programs don't need (`sandbox.syscallFilter`, on by default):
- creating or entering namespaces, mounting and changing the root directory;
- ptrace and reading other processes' memory;
- keyrings, io_uring, bpf, performance events and userfaultfd;
- kernel modules, rebooting, swap, and setting the system time or name.

These calls fail with "operation not permitted", including through the 32-bit system call table (`-m32` programs and `int 0x80`); x32 calls fail too. `clone3` reports "not implemented", so that the C library falls back to `clone`, whose flags the filter can check. If the filter can't be installed, nothing runs.

To check this judge, compiling and running every language through the judge's own code and probing the filter with 64-bit and 32-bit programs:

```bash
sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh
```

It prints one line per check and takes from a few seconds to a minute. It uses its own temporary directories and never the judge's key, so it can run while the judge is working, though it competes with judging for CPU. `--only cpp,java` checks only some languages. The upgrader runs it with the new version, before switching over, whenever the judge or the sandbox changes.

**What the sandbox can't do.** Programs in the sandbox share the server's kernel, so a kernel vulnerability could still let one escape. The filter reduces how much of the kernel they can reach, but doesn't prove isolation. The judge itself runs without privileges, but its small sandbox launcher has to run as root. For contests open to the public:
- run judges on their own machines, not on the web server;
- keep the kernel up to date;
- keep the site's credentials (database, MinIO, AI keys) off remote judges, which need only their judge key.

## The judge's account and its sandbox launcher

Starting a sandbox needs root: namespaces, mounts, cgroups and switching to `sandbox.user`. Only a small part of the judge runs as root, its **sandbox launcher**. It starts the judge itself as the account `libreoj-judge`, without privileges, and runs every sandbox for it.

| Part | Runs as | Does |
| --- | --- | --- |
| Sandbox launcher (`index.mjs`, `src/launcher`) | root | Reads `judge.yaml` and passes its contents to the judge. Prepares the judge's directories, starts the judge, and starts it again when it lost its connection to the site. Runs the sandboxes the judge asks for. For the local AI worker, listens on its socket and opens the backend's sample files. |
| The judge (`src/index.ts`) | `libreoj-judge` | Everything else: connecting to the site with its key, downloading and checking files, compiling and judging through the launcher, and reporting results. It has no capabilities, no extra groups, and can't gain privileges (`no_new_privs`). |

**What the launcher checks.** Each request is checked against `judge.yaml`, never trusting the judge:
- **From the configuration only:** the image, the sandbox user, the host name, the syscall filter, the CPUs and the resource mode. A request can't choose or turn off any of them.
- **Mounts:** only from the judge's own directories (the task working directories, the caches and the AI output root), and writable only from task working directories.
- **Standard I/O and other descriptors:** only as open descriptors the judge passes. The launcher never opens a path for a program.
- **Limits:** time, memory, processes and argument sizes must be within bounds. At most twice as many sandboxes as slots, plus two, run at once.

**Links.** Root never follows a link that the judge or a program left:
- **Mount sources:** they are opened one directory at a time, refusing links, both by the launcher and inside the sandbox.
- **Before a program runs:** its writable directories go to `sandbox.user`, and its read-only ones become readable, with mode `0755`. Only directories and regular files of the judge's or the sandbox user's change.
- **After it ends:** whatever the sandbox user left in the writable directories goes back to the judge's account.
- **The judge's own reads:** it reads a program's output without following links, so a submission can't make it read another file in place of its output.

**Directories.** When it starts, the launcher gives the judge's directories to its account: `dataStore`, `binaryCacheStore`, the task working directories and `aiGeneratedDirectory`. Files left by a judge that ran as root, or by the sandbox user, are given to the account too. A parent directory inside the installation that the account can't pass through gets search permission for others (`o+x`), for example `<root>/data/judge`. Elsewhere, the launcher stops and names the directory to fix. `config/judge.yaml` stays readable only by root.

**The account.** `configure-judge.py` creates it (the installer and remote judge setup run it), and so does the upgrade that installs the launcher. It is a system account without a login shell or home directory. To check it on a running judge:

```bash
ps -o user,pid,cmd --ppid "$(systemctl show -p MainPID --value libreoj-judge.service)"
```

`deploy/doctor.sh` reports it too. The self-test runs the same way, as the judge's account under the launcher.

## The systemd service

The installer and the resize command write the judge's service with these settings. Check the files they wrote, and any drop-ins that override them.

| Setting | Value |
| --- | --- |
| `After`, `Requires`, `Wants` | A judge on the site's server starts after, and needs, `libreoj-backend.service`. A remote judge waits for the network (`network-online.target`). |
| `PartOf`, `WantedBy` | The service and its mounts belong to `libreoj.target` on the site's server, or to `libreoj-judge.target` on a remote judge, which starts at boot. |
| `RequiresMountsFor` | Every working directory, so the service starts only after their tmpfs mounts |
| `WorkingDirectory`, `ExecStart` | `<root>/apps/judge`, running `<node> -r @swc-node/register index.mjs` |
| `Environment` | `NODE_ENV=production`, `PATH`, and the variables in [The judge's environment](#the-judges-environment) |
| `Delegate`, `DelegateSubgroup` | `cpu memory pids` and `supervisor` (systemd 254 or later): the sandbox manages its own cgroups. Don't remove these. |
| `OOMPolicy` | `continue`: a program running out of memory doesn't stop the whole service |
| `AllowedCPUs` | All CPUs in `cpuAffinity` |
| `TasksMax` | `2048` processes and threads in total |
| `Restart`, `RestartSec` | Restart 3 seconds after a failure |
| `TimeoutStopSec` | `30` seconds. Stopping doesn't wait for queued work: [drain](#2-drain-the-judge-and-apply) the judge first. |
| `UMask`, `LimitCORE` | `0022`, and no core dumps |
| `StandardOutput`, `StandardError` | `journal` |

`User` and `Group` aren't set: the service starts as root, its [sandbox launcher](#the-judges-account-and-its-sandbox-launcher) stays root, and the judge runs as `libreoj-judge`. `sandbox.user` is yet another user, inside the sandbox. `CPUAccounting`, `MemoryAccounting`, `TasksAccounting`, `MemoryMax`, `CPUQuota` and other limits aren't set and come from systemd's defaults or parent slices. To see the values in effect:

```bash
sudo systemctl show libreoj-judge.service -p CPUAccounting -p MemoryAccounting -p TasksAccounting -p LimitCORE -p TasksMax
```

Each working directory has its own mount unit (named by `systemd-escape --path --suffix=mount`): a `tmpfs` with `size=512m,mode=0755,nodev,nosuid`.

## Changing the number of slots

After adding or removing CPUs or memory, change the number of slots with the resize command. Don't rerun the installer with another `--judge-slots`, edit the installation records, or delete `judge.yaml` or the key to force a change.

The command works on a judge installed by the installer, with its standard working directories and services. A web-only server has no judge to resize; add a [remote judge](Remote-Judge.md) instead. `--mode auto` (the default) finds out whether this is a full site or a remote judge; `--mode all` or `--mode remote` only checks that it is the one you expect. The command refuses to change a service with its own `MemoryMax` or `CPUQuota`, drop-ins that affect it, or a service from another installation directory: review those by hand first.

`resize-judge.sh` prints English and `resize-judge.zh-CN.sh` Chinese; otherwise they're the same.

### 1. Look at the plan

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.sh --prefix /opt/LLMOJ --plan
# with a number of your choice, which must fit the CPUs and memory:
sudo bash /opt/LLMOJ/deploy/resize-judge.sh --prefix /opt/LLMOJ --slots 6 --plan
```

`--plan` changes nothing. It shows the old and new slots, CPUs, memory and threads.

### 2. Drain the judge and apply

Choose a quiet time. Stop new submissions, rejudges, test runs and AI jobs, and wait until **everyone's** queued and running work has finished. If other judges can take over the queue, **Drain** this judge on the **Judge Machine** page instead and wait until it shows **Drained**; local AI jobs must still finish, because draining doesn't cover them. Idle CPUs, or an empty list of your own AI jobs, don't prove that nothing is running. `--drained` is your confirmation that you've done this; the command doesn't drain anything itself.

Run without options, the command shows the capacity and the draining requirement and asks for the number of slots. **Entering a number (or pressing Enter for the default) confirms that the judge is drained and applies the change immediately, without asking again.** Press Ctrl+C if work is still running.

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.sh --prefix /opt/LLMOJ
```

Or, without questions:

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.sh --prefix /opt/LLMOJ --slots 6 --apply --drained
```

The command:
1. backs up `judge.yaml`, the judge's services and their state to `<prefix>/backups/judge-resize/<UTC time>/` and prints that directory;
2. stops only the judge;
3. updates the slots, working directories, CPUs, concurrency, threads, mounts and services, keeping the key, the site address, the sandbox image and the AI settings;
4. checks the services and runs a real sandbox test;
5. starts the judge again if it was running before (and checks its CPUs and threads); a judge that was stopped stays stopped.

If a check fails, it restores the backup. If even that fails, the judge stays stopped and the command tells you where the backup is. Keep the backup private: it contains the judge's key.

### 3. Check, or roll back

Check that the service is running and the judge is online on the site, then submit ordinary and interactive problems in the languages you use, and run a small AI job if you use local AI.

```bash
sudo systemctl is-active libreoj-judge.service
sudo systemctl show libreoj-judge.service -p AllowedCPUs -p EffectiveCPUs -p TasksMax
```

To undo the change, stop new work and drain again, then give the backup directory the command printed:

```bash
sudo bash /opt/LLMOJ/deploy/resize-judge.sh --prefix /opt/LLMOJ --rollback /path/to/backup --drained
```

This restores the judge's configuration, services and their previous state. It doesn't touch problems or the database, and doesn't undo submissions judged in the meantime. Check the judge again afterwards.

See also: [Remote judges](Remote-Judge.md) · [Distributed judging](Distributed-Judging.md). Sources: [config.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/config.ts), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [executionCapacity.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/executionCapacity.ts), [taskQueue.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/taskQueue.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts).
