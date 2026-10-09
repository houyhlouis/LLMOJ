#!/usr/bin/env python3
"""Private installer operations; credentials never appear in command arguments."""
import argparse
import datetime
import grp
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shlex
import shutil
import socket
import subprocess
import sys


class InstallerError(ValueError):
    """A message deliberately safe to show without private configuration contents."""


def fail(message):
    raise InstallerError(message)


def private_json(path, value):
    if path.is_symlink():
        fail(f"Refusing symbolic link: {path}")
    temporary = path.with_name(path.name + f".pending-{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def state_for(args):
    return {"version": 3, "root": str(args.root), "publicOrigin": args.origin, "port": args.port,
            "listenAddress": getattr(args, "listen_address", "0.0.0.0"),
            "role": getattr(args, "role", "all"), "siteName": getattr(args, "site_name", "LLMOJ"),
            "judgeSlots": getattr(args, "judge_slots", 0),
            "dockerSource": getattr(args, "docker_source", "https://download.docker.com"),
            "dockerMirrors": getattr(args, "docker_mirrors", "")}


def check_state(args):
    config = args.root / "config"
    state_file = config / "install-state.json"
    complete_file = config / "install-complete.json"
    for path in (state_file, complete_file):
        if path.is_symlink():
            fail("Installation metadata must not be a symbolic link")
        if path.exists():
            st = path.stat()
            if st.st_uid != 0 or st.st_mode & 0o077:
                fail("Installation metadata must belong to root with mode 0600")
            value = json.loads(path.read_text())
            if any(value.get(key) != expected for key, expected in state_for(args).items()):
                fail("Existing installation metadata differs; reuse the original options instead of taking over the instance")
    if not state_file.exists() and not complete_file.exists():
        if any((config / name).exists() for name in ("secrets.json", "backend.yaml", "judge.yaml", "admin-credentials.json")):
            fail("Existing private configuration has no installer metadata; refusing to take over this instance")
        if (args.root / "data").exists() and any((args.root / "data").iterdir()):
            fail("Existing runtime data has no installer metadata; use a new installation directory")
    return complete_file.exists()


def judge_capacity_module():
    # Also works when tests load this file by spec without deploy/ on sys.path.
    spec = importlib.util.spec_from_file_location("libreoj_judge_capacity", Path(__file__).with_name("judge_capacity.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_initial_judge_capacity(args):
    if args.role != "all" or (args.root / "config/judge.yaml").exists():
        return
    capacity_module = judge_capacity_module()
    try:
        capacity = capacity_module.discover_capacity()
        slots = args.judge_slots or capacity["default_slots"]
        capacity_module.validate_slots(slots, capacity)
    except capacity_module.CapacityError as error:
        fail(str(error))
    print(f"Initial judge capacity verified: {slots} slots, {capacity['effective_cpu_count']} effective CPUs, {capacity['memory_mib']} MiB RAM")


def preflight(args):
    os_info = platform.freedesktop_os_release()
    if os_info.get("ID") != "ubuntu" or os_info.get("VERSION_ID") not in ("24.04", "26.04"):
        fail("Supported servers: Ubuntu 24.04 / 26.04, amd64")
    if platform.machine() != "x86_64":
        fail("The original sandbox currently supports Linux amd64 only")
    if not Path("/run/systemd/system").is_dir() or Path("/proc/1/comm").read_text().strip() != "systemd":
        fail("A server booted with systemd is required")
    version = subprocess.check_output(["systemctl", "--version"], text=True).split()[1]
    if int(version) < 254:
        fail("systemd >=254 is required for sandbox cgroup delegation")
    controllers = Path("/sys/fs/cgroup/cgroup.controllers")
    if not controllers.is_file() or not {"cpu", "memory", "pids"}.issubset(controllers.read_text().split()):
        fail("Unified cgroup v2 with cpu, memory and pids controllers is required")
    if subprocess.run(["systemd-detect-virt", "--quiet", "--container"]).returncode == 0:
        fail("Use a normal virtual machine or physical server; container installation is unsupported")
    mem = int(re.search(r"^MemTotal:\s+(\d+)", Path("/proc/meminfo").read_text(), re.M)[1]) * 1024
    if mem < 3 * 1024**3:
        fail("At least 3 GiB RAM is required; 8 GiB is recommended for compilation")
    complete = check_state(args)
    if not complete:
        check_initial_judge_capacity(args)
    existing = args.root
    while not existing.exists():
        existing = existing.parent
    free = shutil.disk_usage(existing).free
    minimum_disk = 30 if args.role == "all" else 10
    if not complete and free < minimum_disk * 1024**3:
        fail(f"At least {minimum_disk} GiB free disk space is required for this installation role")
    units = ("backend", "judge", "nginx", "mariadb", "redis", "minio") if args.role == "all" else ("backend", "nginx", "mariadb", "redis", "minio")
    for name in units:
        unit = f"libreoj-{name}.service"
        fragment = subprocess.run(["systemctl", "show", unit, "--property=FragmentPath", "--value"],
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.strip()
        if fragment:
            content = Path(fragment).read_text()
            if str(args.root) + "/" not in content:
                fail(f"{unit} belongs to another installation; this installer uses one instance per server")
        if not complete and subprocess.run(["systemctl", "is-active", "--quiet", unit]).returncode == 0:
            fail(f"{unit} is already running; stop this incomplete installation before retrying")
    if not complete:
        for port in (args.port, 2002, 2020, 13306, 16379, 19000, 19001):
            with socket.socket() as probe:
                try:
                    probe.bind((args.listen_address if port == args.port else "127.0.0.1", port))
                except OSError:
                    fail(f"TCP port {port} is occupied; resolve the conflict before installing")
    print(f"Preflight passed: Ubuntu {os_info['VERSION_ID']}, systemd {version}, RAM {mem / 1024**3:.1f} GiB, free disk {free / 1024**3:.1f} GiB")
    print("The real namespace/cgroup sandbox check runs before installation is declared complete.")


def claim(args):
    if os.geteuid() != 0:
        fail("Run the installer with sudo")
    check_state(args)
    args.root.mkdir(parents=True, exist_ok=True)
    config = args.root / "config"
    if config.is_symlink():
        fail("The configuration directory must not be a symbolic link")
    config.mkdir(exist_ok=True)
    os.chown(config, 0, 0)
    config.chmod(0o751)
    if not (config / "install-state.json").exists():
        private_json(config / "install-state.json", state_for(args))


def permissions(args):
    # Change only this instance's known directories, not any host data/service.
    directories = {
        "data": ("root", "root", 0o751), "logs": ("root", "root", 0o751),
        "data/mariadb": ("mysql", "mysql", 0o750), "logs/mariadb": ("mysql", "mysql", 0o750),
        "data/redis": ("redis", "redis", 0o750), "data/minio": ("libreoj", "libreoj", 0o750),
        "data/ai": ("libreoj", "libreoj", 0o700), "data/tmp": ("libreoj", "libreoj", 0o700),
        "data/ai-generated": ("root", "libreoj", 0o750), "data/ai-sample-inputs": ("libreoj", "libreoj", 0o700),
        "data/backend-archives": ("libreoj", "libreoj", 0o700), "data/judge": ("root", "libreoj", 0o750),
        "data/judge/work": ("root", "root", 0o755), "data/judge/testdata": ("root", "root", 0o700),
        "data/judge/cache": ("root", "root", 0o700), "data/nginx": ("www-data", "www-data", 0o750),
        "data/nginx/client_body": ("www-data", "www-data", 0o700),
        "data/nginx/proxy": ("www-data", "www-data", 0o700), "logs/nginx": ("www-data", "www-data", 0o750),
    }
    for name, (user, group, mode) in directories.items():
        directory = args.root / name
        if directory.is_symlink():
            fail(f"Refusing symbolic link in runtime directories: {directory}")
        directory.mkdir(parents=True, exist_ok=True)
        os.chown(directory, pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid)
        directory.chmod(mode)


def apparmor(args):
    if not Path("/sys/module/apparmor").exists() or not shutil.which("apparmor_parser"):
        return
    root = str(args.root)
    rules = {
        "mariadb": [f'"{root}/config/mariadb.cnf" r,', f'"{root}/data/mariadb/" r,',
                    f'"{root}/data/mariadb/**" rwk,', f'"{root}/data/mariadb-init/" r,',
                    f'"{root}/data/mariadb-init/**" rwk,', f'"{root}/logs/mariadb/" r,', f'"{root}/logs/mariadb/**" rw,'],
        "nginx": [f'"{root}/config/nginx.conf" r,', f'"{root}/public/" r,', f'"{root}/public/**" r,',
                  f'"{root}/data/nginx/" rw,', f'"{root}/data/nginx/**" rw,',
                  f'"{root}/logs/nginx/" rw,', f'"{root}/logs/nginx/**" rw,'],
    }
    candidates = {"mariadb": ("mariadbd", "usr.sbin.mariadbd", "usr.sbin.mysqld"), "nginx": ("usr.sbin.nginx", "nginx")}
    for service, filenames in candidates.items():
        for filename in filenames:
            profile = Path("/etc/apparmor.d") / filename
            if not profile.is_file():
                continue
            # Ubuntu's MariaDB package can ship a comment-only placeholder. A
            # hash-prefixed include is an AppArmor directive, not a comment.
            active_lines = [line.strip() for line in profile.read_text().splitlines()
                            if line.strip() and (not line.lstrip().startswith("#") or
                                                 re.match(r"^[ \t]*#[ \t]*include\b", line))]
            if not active_lines:
                continue
            # Match a directive at the start of a line; examples in comments
            # must not authorize appending rules to an unrelated local file.
            match = re.search(r'^(?:#[ \t]*)?include(?:[ \t]+if[ \t]+exists)?[ \t]*[<"](local/[A-Za-z0-9_.-]+)[>"]',
                              "\n".join(active_lines), re.M)
            if not match:
                fail(f"AppArmor profile {profile} has no local include; add one before retrying")
            local = Path("/etc/apparmor.d") / match[1]
            local.parent.mkdir(exist_ok=True)
            if local.is_symlink():
                fail(f"Refusing symbolic link: {local}")
            old = local.read_text() if local.exists() else ""
            marker = f"# LibreOJ installer: {root}"
            block = marker + "\n" + "\n".join(rules[service]) + "\n"
            if marker not in old or any(rule not in old.splitlines() for rule in rules[service]):
                # Older installs have the marker but lack staged-bootstrap rules.
                # Append only missing instance rules; preserve administrator policy.
                block = marker + "\n" + "\n".join(rule for rule in rules[service] if rule not in old.splitlines()) + "\n"
                with local.open("a") as stream:
                    stream.write("\n" + block)
            subprocess.run(["apparmor_parser", "-r", str(profile)], check=True)


def database(args):
    import yaml
    secrets = json.loads((args.root / "config/secrets.json").read_text())
    db = yaml.safe_load((args.root / "config/backend.yaml").read_text())["services"]["database"]
    password = secrets["database"]
    if not re.fullmatch(r"[0-9a-f]{48}", password) or db.get("password") != password or db.get("database") != "libreoj" or db.get("username") != "libreoj":
        fail("Database configuration differs from installer credentials; review it without resetting data")
    sql = "CREATE DATABASE IF NOT EXISTS `libreoj` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n"
    for host in ("127.0.0.1", "localhost"):
        sql += f"CREATE USER IF NOT EXISTS 'libreoj'@'{host}' IDENTIFIED BY '{password}';\nGRANT ALL PRIVILEGES ON `libreoj`.* TO 'libreoj'@'{host}';\n"
    result = subprocess.run(["mariadb", "--protocol=socket", f"--socket={args.root}/data/mariadb/mysql.sock", "--user=root"],
                            input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode:
        fail("Project database initialization failed; check libreoj-mariadb.service (SQL and credentials withheld)")
    print("Project database initialized; credentials withheld.")


def verify_network(args):
    """Allow only the selected website listener; keep internal services private."""
    import yaml
    from urllib.parse import urlsplit
    config = args.root / "config"
    backend = yaml.safe_load((config / "backend.yaml").read_text())
    for service in ("server", "metrics"):
        if backend[service].get("hostname") != "127.0.0.1":
            fail(f"Backend {service} must listen on 127.0.0.1; no service was started")
    db = backend["services"]["database"]
    redis = urlsplit(backend["services"]["redis"])
    minio = urlsplit(backend["services"]["minio"]["default"]["endpoint"])
    if db.get("host") != "127.0.0.1" or redis.hostname != "127.0.0.1" or minio.hostname != "127.0.0.1":
        fail("Project database, Redis and MinIO endpoints must remain on loopback")
    mariadb_config = (config / "mariadb.cnf").read_text()
    binds = re.findall(r"^\s*bind-address\s*=\s*([^\s#;]+)", mariadb_config, re.M)
    if binds != ["127.0.0.1"]:
        fail("MariaDB must listen on 127.0.0.1; review config/mariadb.cnf")
    redis_config = (config / "redis.conf").read_text()
    binds = re.findall(r"^\s*bind\s+([^\n#]+)", redis_config, re.M)
    if [value.strip() for value in binds] != ["127.0.0.1"]:
        fail("Redis must listen on 127.0.0.1; review config/redis.conf")
    # -T validates and expands include files without starting the web server.
    # Capture its output: a custom configuration may itself contain secrets.
    nginx = subprocess.run(["/usr/sbin/nginx", "-T", "-p", f"{args.root}/", "-c", str(config / "nginx.conf")],
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if nginx.returncode:
        fail("Nginx configuration validation failed; no service was started (configuration withheld)")
    lexer = shlex.shlex(nginx.stdout, posix=True, punctuation_chars=";{}")
    lexer.whitespace_split = True
    tokens = list(lexer)
    listeners = []
    for index, token in enumerate(tokens):
        starts_directive = index == 0 or all(char in ";{}" for char in tokens[index - 1])
        if token == "listen" and starts_directive:
            listeners.append(tokens[index + 1] if index + 1 < len(tokens) else "")
    expected = f"{args.listen_address}:{args.port}"
    if not listeners or any(value != expected for value in listeners):
        fail("Every Nginx listener must match the selected address and port; no additional listener is permitted")
    print(f"Website listener verified: {expected}; database, Redis, MinIO, backend and metrics remain loopback-only.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("validate", "preflight", "claim", "permissions", "apparmor", "database", "verify-network", "finish"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--listen", dest="listen_address", choices=("0.0.0.0", "127.0.0.1"), default="0.0.0.0")
    parser.add_argument("--role", choices=("all", "web"), default="all")
    parser.add_argument("--site-name", default="LLMOJ")
    parser.add_argument("--docker-source", default="https://download.docker.com")
    parser.add_argument("--docker-mirrors", default="")
    parser.add_argument("--judge-slots", type=int, default=0)
    args = parser.parse_args()
    if args.root != args.root.resolve() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(args.root)) or len(args.root.parts) < 3:
        fail("Use a canonical, absolute installation directory such as /opt/LibreOJ")
    if args.port in (2002, 2020, 13306, 16379, 19000, 19001) or not 1 <= args.port <= 65535:
        fail("The public port is invalid or conflicts with an internal service")
    if not 0 <= args.judge_slots <= judge_capacity_module().MAX_SLOTS or (args.role == "web" and args.judge_slots):
        fail("Judge slots must be 0 (automatic) or 1..511, and only apply to role all")
    if not args.site_name.strip() or len(args.site_name) > 60 or not args.site_name.isprintable():
        fail("Website name must contain 1..60 printable characters")
    from urllib.parse import urlsplit
    url = urlsplit(args.origin)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.path or url.query or url.fragment or re.search(r"[\s\"'\\;{}]", args.origin):
        fail("Use an HTTP(S) origin without path, credentials or query")
    url.port  # Reject malformed port even in --plan/--check flows.
    if args.phase not in ("validate", "preflight") and os.geteuid() != 0:
        fail("Run with sudo")
    if args.phase == "validate":
        return
    if args.phase == "finish":
        check_state(args)
        private_json(args.root / "config/install-complete.json", {
            **state_for(args), "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "rootfsId": (args.root / "runtime/rootfs-id").read_text().strip() if args.role == "all" else None,
            "sourceRepository": os.environ.get("OJ_SOURCE_REPOSITORY"),
            "sourceCommit": os.environ.get("OJ_SOURCE_COMMIT"),
        })
    else:
        globals()[args.phase.replace("-", "_")](args)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not expose parsed YAML, SQL or exception representations containing credentials.
        error = sys.exc_info()[1]
        message = str(error) if isinstance(error, InstallerError) else "Installer operation failed; inspect this phase's service status and file permissions (private configuration withheld)"
        print(message, file=sys.stderr)
        sys.exit(1)
