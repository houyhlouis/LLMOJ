#!/usr/bin/env python3
"""Generate resource-aware judge configuration and delegated systemd units."""
from pathlib import Path
import grp
import json
import os
import re
import subprocess
import base64
import stat as stat_module
from urllib.parse import urlsplit

import yaml

if os.geteuid() != 0:
    raise SystemExit("Run as root after creating the libreoj service group")


def absolute_path(value: str, name: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value):
        raise SystemExit(f"{name} must be an absolute path without spaces or shell metacharacters")
    return path


root = absolute_path(os.environ.get("HYHOJ_ROOT", "/opt/LibreOJ"), "HYHOJ_ROOT").resolve()
if root == Path("/"):
    raise SystemExit("HYHOJ_ROOT must not be /")
node = absolute_path(os.environ.get("NODE_BINARY", str(root / "runtime/node/bin/node")), "NODE_BINARY")
remote = os.environ.get("OJ_JUDGE_REMOTE", "0") == "1"
if remote:
    server_url = os.environ.get("OJ_JUDGE_SERVER", "").rstrip("/")
    url = urlsplit(server_url)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment or re.search(r"[\s\"'\\;{}]", server_url)):
        raise SystemExit("OJ_JUDGE_SERVER must be an HTTP(S) origin without path or credentials")
    try:
        url.port
    except ValueError:
        raise SystemExit("Invalid judge server port") from None
    key_file = absolute_path(os.environ.get("OJ_JUDGE_KEY_FILE", ""), "OJ_JUDGE_KEY_FILE")
    fd = os.open(key_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        stat = os.fstat(stream.fileno())
        if not stat_module.S_ISREG(stat.st_mode) or stat.st_uid != 0 or stat.st_mode & 0o077:
            raise SystemExit("Judge key file must belong to root with mode 0600")
        judge_key = stream.read(128).strip()
    try:
        decoded = base64.b64decode(judge_key, validate=True)
    except ValueError:
        raise SystemExit("Invalid judge key (value withheld)") from None
    if len(judge_key) != 40 or len(decoded) != 30:
        raise SystemExit("Invalid judge key (value withheld)")
else:
    secret_file = root / "config/secrets.json"
    if secret_file.is_symlink() or not secret_file.is_file():
        raise SystemExit("Run configure-local.py first to create a regular secrets.json")
    s = json.loads(secret_file.read_text())
    judge_key = s["judge"]
    server_url = "http://127.0.0.1:2002"
rootfs = root / "runtime/sandbox-rootfs"
rootfs_id = (rootfs / "etc/libreoj-rootfs-id").read_text().strip()
if not re.fullmatch(r"[0-9a-f]{64}", rootfs_id):
    raise SystemExit("Installed LibreOJ rootfs ID must be a SHA-256 hex digest")
available_cpus = sorted(os.sched_getaffinity(0))
# Leave one CPU available to the web/database services when the host has several.
judge_cpus = available_cpus if remote or len(available_cpus) == 1 else available_cpus[1:]
meminfo = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
memory_mib = int(meminfo["MemTotal"].split()[0]) // 1024
memory_slots = max(1, (memory_mib - (1024 if remote else 2048)) // 512)
slots = min(7, len(judge_cpus), memory_slots)
requested_slots = os.environ.get("OJ_JUDGE_SLOTS", os.environ.get("HYHOJ_JUDGE_SLOTS"))
if requested_slots is not None:
    slots = int(requested_slots)
    if not 1 <= slots <= min(7, len(judge_cpus), memory_slots):
        raise SystemExit("Judge slots exceed available CPU/RAM capacity (one 512 MiB tmpfs per slot)")
judge_cpus = judge_cpus[:slots]
consumers = min(3, max(1, slots // 2))
config_directory = root / "config"
if config_directory.is_symlink():
    raise SystemExit("Private configuration directory must not be a symbolic link")
config_directory.mkdir(mode=0o751, exist_ok=True)
os.chown(config_directory, 0, 0)
config_directory.chmod(0o751)
config_file = root / "config/judge.yaml"
if config_file.exists():
    if config_file.is_symlink() or not config_file.is_file():
        raise SystemExit("Refusing non-regular judge.yaml")
    try:
        c = yaml.safe_load(config_file.read_text())
    except yaml.YAMLError:
        raise SystemExit("Cannot parse private judge configuration; review judge.yaml (key withheld)") from None
    if (c["key"] != judge_key or c["serverUrl"] != server_url or c["sandbox"]["rootfsId"] != rootfs_id
            or Path(c["sandbox"]["rootfs"]) != rootfs or (remote and c.get("aiRunnerSocket"))):
        raise SystemExit("Existing judge.yaml differs from this instance's key/rootfs; review the configuration instead of overwriting it")
else:
    c = yaml.safe_load((root / "apps/judge/config-example.yaml").read_text())
    port = int(os.environ.get("HYHOJ_PORT", "80"))
    c.update(serverUrl=server_url, key=judge_key,
             downloadEndpointOverride=None if remote else ("http://127.0.0.1" if port == 80 else f"http://127.0.0.1:{port}"),
             dataStore=str(root / "data/judge/testdata"),
             binaryCacheStore=str(root / "data/judge/cache"), taskConsumingThreads=consumers,
             maxConcurrentTasks=slots, maxConcurrentDownloads=min(4, slots),
             taskWorkingDirectories=[str(root / "data/judge/work" / str(i)) for i in range(1, slots + 1)],
             rpcTimeout=30000)
    c["sandbox"].update(rootfs=str(rootfs), rootfsId=rootfs_id, user="sandbox", hostname="libreoj-judge", resourceMode="default")
    c["aiRunnerSocket"] = None if remote else str(root / "data/judge/ai-runner.sock")
    c["aiGeneratedDirectory"] = None if remote else str(root / "data/ai-generated")
    c["aiRunnerGid"] = 0 if remote else grp.getgrnam("libreoj").gr_gid
    c["cpuAffinity"] = {key: judge_cpus for key in ("compiler", "userProgram", "interactor", "checker")}
    fd = os.open(config_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(yaml.safe_dump(c, sort_keys=False))
config_file.chmod(0o600)
os.chown(config_file, 0, 0)
slots = len(c["taskWorkingDirectories"])
if slots < 1 or c["maxConcurrentTasks"] != slots:
    raise SystemExit("Judge concurrency must equal its number of task workspaces")
judge_cpus = sorted({cpu for values in c["cpuAffinity"].values() for cpu in values})
if not judge_cpus or not set(judge_cpus).issubset(available_cpus):
    raise SystemExit("Existing judge CPU affinity contains CPUs unavailable on this host")
units = root / "deploy/systemd"
units.mkdir(parents=True, exist_ok=True)
# These source examples were generated for seven slots. Replace only this project's
# workspace definitions, so a smaller server does not acquire stale extra mounts.
for path in units.glob("*.mount"):
    if "Description=LibreOJ judge workspace\n" in path.read_text():
        path.unlink()
for workdir in c["taskWorkingDirectories"]:
    work_path = absolute_path(workdir, "Judge work directory").resolve()
    if not work_path.is_relative_to(root / "data/judge/work") or work_path == root / "data/judge/work":
        raise SystemExit("Judge workspaces must be children of HYHOJ_ROOT/data/judge/work")
    work_path.mkdir(mode=0o755, parents=True, exist_ok=True)
    name = subprocess.check_output(["systemd-escape", "--path", "--suffix=mount", str(work_path)], text=True).strip()
    target = "libreoj-judge.target" if remote else "libreoj.target"
    (units / name).write_text(f"[Unit]\nDescription=LibreOJ judge workspace\nPartOf={target}\n\n[Mount]\n"
        f"What=tmpfs\nWhere={work_path}\nType=tmpfs\nOptions=size=512m,mode=0755,nodev,nosuid\n\n[Install]\nWantedBy={target}\n")
# DelegateSubgroup is supported since systemd 254 (Ubuntu 24.04 ships 255).
# The manager runs in supervisor; native sandbox children use sibling cgroups.
threadpool = max(4, slots * 2 + 2)
target = "libreoj-judge.target" if remote else "libreoj.target"
dependencies = "After=network-online.target\nWants=network-online.target\n" if remote else "After=libreoj-backend.service\nRequires=libreoj-backend.service\n"
(units / "libreoj-judge.service").write_text("[Unit]\n"
    f"Description=LibreOJ judge ({slots} execution slots, {c['taskConsumingThreads']} submissions)\n"
    + dependencies + f"PartOf={target}\n"
    "RequiresMountsFor=" + " ".join(c["taskWorkingDirectories"]) + "\n\n[Service]\n"
    f"WorkingDirectory={root}/apps/judge\nEnvironment=NODE_ENV=production\n"
    f"Environment=PATH={node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
    f"Environment=LIBREOJ_JUDGE_CONFIG_FILE={config_file}\nEnvironment=UV_THREADPOOL_SIZE={threadpool}\n"
    "Environment=NODE_OPTIONS=--max-old-space-size=512\n"
    f"Environment=HYHOJ_AI_SAMPLE_INPUTS_DIR={root}/data/ai-sample-inputs\n"
    f"ExecStart={node} -r @swc-node/register index.mjs\nDelegate=cpu memory pids\nDelegateSubgroup=supervisor\n"
    "OOMPolicy=continue\nAllowedCPUs=" + " ".join(str(cpu) for cpu in judge_cpus) + "\n"
    "TasksMax=2048\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0022\nLimitCORE=0\n"
    f"StandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy={target}\n")
if remote:
    (units / target).write_text("[Unit]\nDescription=LibreOJ remote judge\nWants=libreoj-judge.service\n"
        "After=network-online.target\n\n[Install]\nWantedBy=multi-user.target\n")
print(f"Judge: {slots} execution slots, {c['taskConsumingThreads']} submission consumers, "
      f"CPUs {','.join(str(cpu) for cpu in judge_cpus)}; 512 MiB maximum tmpfs per slot (secrets withheld).")
