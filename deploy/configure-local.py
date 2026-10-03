#!/usr/bin/env python3
"""Generate a private local instance configuration without starting services.

Existing instance configuration and secrets are retained on installation retry.
"""
from pathlib import Path
from urllib.parse import urlsplit
import base64
import grp
import json
import os
import re
import secrets

import yaml


if os.geteuid() != 0:
    raise SystemExit("Run as root after creating the libreoj, mysql and redis service groups")


def absolute_path(value: str, name: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", value):
        raise SystemExit(f"{name} must be an absolute path without spaces or shell metacharacters")
    return path


root = absolute_path(os.environ.get("HYHOJ_ROOT", "/opt/LibreOJ"), "HYHOJ_ROOT").resolve()
if root == Path("/"):
    raise SystemExit("HYHOJ_ROOT must not be /")
node = absolute_path(os.environ.get("NODE_BINARY", str(root / "runtime/node/bin/node")), "NODE_BINARY")
backend_gid = grp.getgrnam("libreoj").gr_gid
redis_gid = grp.getgrnam("redis").gr_gid
mysql_gid = grp.getgrnam("mysql").gr_gid
config = root / "config"
config.mkdir(mode=0o755, parents=True, exist_ok=True)
port = int(os.environ.get("HYHOJ_PORT", "80"))
if not 1 <= port <= 65535:
    raise SystemExit("HYHOJ_PORT must be between 1 and 65535")
public_origin = os.environ.get("HYHOJ_PUBLIC_ORIGIN", "http://127.0.0.1" if port == 80 else f"http://127.0.0.1:{port}").rstrip("/")
listen_address = os.environ.get("OJ_LISTEN_ADDRESS", "0.0.0.0")
role = os.environ.get("OJ_INSTALL_ROLE", "all")
site_name = os.environ.get("OJ_SITE_NAME", "LLMOJ")
if listen_address not in ("127.0.0.1", "0.0.0.0") or role not in ("all", "web"):
    raise SystemExit("Invalid website listener or installation role")
if not site_name.strip() or len(site_name) > 60 or not site_name.isprintable():
    raise SystemExit("Website name must contain 1..60 printable characters")
origin = urlsplit(public_origin)
try:
    origin_port = origin.port
except ValueError:
    raise SystemExit("Invalid HYHOJ_PUBLIC_ORIGIN port")
if (origin.scheme not in ("http", "https") or not origin.hostname or origin.username or origin.password
        or origin.path or origin.query or origin.fragment or re.search(r"[\s\"'\\;{}]", public_origin)):
    raise SystemExit("HYHOJ_PUBLIC_ORIGIN must be an http(s) origin, such as https://oj.example.com")


def create_private(path: Path, content: str, mode: int, gid: int = 0) -> None:
    """Create once, never replace administrator edits on a retry."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    except FileExistsError:
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"Refusing non-regular configuration file: {path}")
    else:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
    os.chown(path, 0, gid)
    path.chmod(mode)


secret_file = config / "secrets.json"
if not secret_file.exists():
    create_private(secret_file, json.dumps({
        "database": secrets.token_hex(24), "redis": secrets.token_hex(24),
        "minioAccess": "libreoj-local", "minioSecret": secrets.token_hex(32),
        "session": secrets.token_hex(48), "maintenance": secrets.token_hex(48),
        "judge": base64.b64encode(secrets.token_bytes(30)).decode(),
        "instanceId": secrets.token_hex(8)
    }, indent=2) + "\n", 0o600)
if secret_file.is_symlink() or not secret_file.is_file():
    raise SystemExit("Refusing non-regular secrets.json")
secret_file.chmod(0o600)
os.chown(secret_file, 0, 0)
s = json.loads(secret_file.read_text())

c = yaml.safe_load((config / "backend.yaml.example").read_text())
c["server"].update(hostname="127.0.0.1", port=2002, clusters=None, trustProxy=["loopback"])
c["metrics"].update(hostname="127.0.0.1", allowedIps=["127.0.0.1"])
c["services"]["database"].update(host="127.0.0.1", port=13306, username="libreoj", password=s["database"], database="libreoj")
c["services"]["redis"] = "redis://:" + s["redis"] + "@127.0.0.1:16379/0"
c["services"]["minio"].update(
    default={"endpoint": "http://127.0.0.1:19000", "urlEndpoint": None},
    forUserUpload={"endpoint": "http://127.0.0.1:19000", "urlEndpoint": public_origin + "/storage/"},
    forUserDownload={"endpoint": "http://127.0.0.1:19000", "urlEndpoint": public_origin + "/storage/"},
    forJudge={"endpoint": "http://127.0.0.1:19000", "urlEndpoint": public_origin + "/storage/"},
    accessKey=s["minioAccess"], secretKey=s["minioSecret"], bucket="libreoj-files"
)
# No SMTP credentials or network transport are supplied by the installer.
c["services"]["mail"] = {"address": None, "transport": {"jsonTransport": True}}
c["security"].update(crossOrigin={"enabled": False, "whiteList": []}, sessionSecret=s["session"],
                     maintainceKey=s["maintenance"], captcha={"turnstile": None, "tencentCaptcha": None})
c["preference"]["siteName"] = site_name
c["preference"]["security"]["requireEmailVerification"] = False
c["preference"]["misc"]["appLogo"] = ""
create_private(config / "backend.yaml", yaml.safe_dump(c, allow_unicode=True, sort_keys=False), 0o640, backend_gid)
create_private(config / "minio.env", "MINIO_ROOT_USER=" + s["minioAccess"] + "\nMINIO_ROOT_PASSWORD=" + s["minioSecret"] +
               "\nMINIO_BROWSER=off\nMINIO_UPDATE=off\nMINIO_CALLHOME_ENABLE=off\n", 0o600)
create_private(config / "redis.conf", "bind 127.0.0.1\nport 16379\nprotected-mode yes\nrequirepass " + s["redis"] +
               f"\ndir {root}/data/redis\nappendonly yes\nappendfsync everysec\nsave 900 1\nsave 300 10\n"
               'maxmemory 192mb\nmaxmemory-policy noeviction\nlogfile ""\ndaemonize no\n', 0o640, redis_gid)
nginx = (config / "nginx.conf.example").read_text().replace("/opt/LibreOJ", str(root)).replace("listen 0.0.0.0:80;", f"listen {listen_address}:{port};")
create_private(config / "nginx.conf", nginx, 0o644)
create_private(config / "mariadb.cnf", f"[mysqld]\nuser=mysql\nbind-address=127.0.0.1\nport=13306\n"
               f"datadir={root}/data/mariadb\nsocket={root}/data/mariadb/mysql.sock\npid-file={root}/data/mariadb/mysql.pid\n"
               f"log-error={root}/logs/mariadb/error.log\ncharacter-set-server=utf8mb4\ncollation-server=utf8mb4_unicode_ci\n"
               "innodb-buffer-pool-size=128M\nmax-connections=60\nskip-name-resolve\n", 0o640, mysql_gid)

units = root / "deploy/systemd"
units.mkdir(parents=True, exist_ok=True)
node_environment = (f"Environment=PATH={node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
                    "Environment=NODE_ENV=production\nEnvironment=NODE_OPTIONS=--max-old-space-size=512\n")
services = {
    "mariadb": ("After=network.target", "User=mysql\nGroup=mysql\n"
                f"ExecStart=/usr/sbin/mariadbd --defaults-file={config}/mariadb.cnf\nTimeoutStartSec=120"),
    "redis": ("After=network.target", f"User=redis\nGroup=redis\nExecStart=/usr/bin/redis-server {config}/redis.conf"),
    "minio": ("After=network.target", f"User=libreoj\nGroup=libreoj\nEnvironmentFile={config}/minio.env\n"
              f"ExecStart={root}/runtime/minio server --address 127.0.0.1:19000 --console-address 127.0.0.1:19001 {root}/data/minio"),
    "backend": ("After=libreoj-mariadb.service libreoj-redis.service libreoj-minio.service\n"
                "Requires=libreoj-mariadb.service libreoj-redis.service libreoj-minio.service",
                f"User=libreoj\nGroup=libreoj\nWorkingDirectory={root}/apps/backend\n" + node_environment +
                f"Environment=LIBREOJ_CONFIG_FILE={config}/backend.yaml\nEnvironment=TMPDIR={root}/data/tmp\n"
                f"Environment=HYHOJ_AI_STATE_DIR={root}/data/ai\nEnvironment=HYHOJ_AI_GENERATED_DIR={root}/data/ai-generated\n"
                f"Environment=HYHOJ_AI_SAMPLE_INPUTS_DIR={root}/data/ai-sample-inputs\n"
                f"Environment=HYHOJ_AI_RUNNER_SOCKET={root}/data/judge/ai-runner.sock\n"
                f"Environment=HYHOJ_ARCHIVE_WORK_DIRECTORY={root}/data/backend-archives\nExecStart={node} dist/main.js"),
    "nginx": ("After=libreoj-backend.service\nRequires=libreoj-backend.service", "Type=simple\n"
              f'ExecStart=/usr/sbin/nginx -p {root}/ -c {config}/nginx.conf -g "daemon off;"\n'
              f"ExecReload=/usr/sbin/nginx -p {root}/ -c {config}/nginx.conf -s reload\nKillSignal=SIGQUIT")
}
for name, (unit, service) in services.items():
    (units / f"libreoj-{name}.service").write_text("[Unit]\nDescription=LibreOJ " + name + "\n" + unit +
        "\nPartOf=libreoj.target\n\n[Service]\n" + service + "\nRestart=on-failure\nRestartSec=3\nUMask=0077\n"
        "LimitCORE=0\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=libreoj.target\n")
judge_wants = " libreoj-judge.service" if role == "all" else ""
if role == "web":
    for path in [units / "libreoj-judge.service", *units.glob("*.mount")]:
        if path.exists():
            text = path.read_text()
            if "Description=LibreOJ judge" not in text:
                raise SystemExit("Unexpected judge service/mount definition in a web-only source tree")
            path.unlink()
(units / "libreoj.target").write_text("[Unit]\nDescription=LibreOJ online judge\n"
    "Wants=libreoj-mariadb.service libreoj-redis.service libreoj-minio.service libreoj-backend.service libreoj-nginx.service" + judge_wants + "\n"
    "After=network.target\n\n[Install]\nWantedBy=multi-user.target\n")
print("本机配置与服务单元已生成；保留已有配置，未输出凭据。" if os.environ.get("LLMOJ_INSTALL_LANG") == "zh-CN"
      else "Local configuration and service definitions generated; existing configuration retained (secrets withheld).")
