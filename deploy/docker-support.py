#!/usr/bin/env python3
"""Validate Docker source options and atomically merge registry mirrors."""
# SPDX-License-Identifier: MIT
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

OFFICIAL_SOURCE = "https://download.docker.com"


def validate_url(value):
    url = urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or re.search(r'[\s\"\'\\;{}]', value)):
        raise ValueError("Docker sources must be HTTPS URLs without credentials, queries or whitespace")
    url.port
    return value.rstrip("/")


def mirrors_from(value):
    return [validate_url(part.strip()) for part in value.split(",")] if value else []


def configure_mirrors(file, mirrors, validate):
    if not mirrors:
        return False  # Official/default mode leaves host Docker configuration alone.
    if file.is_symlink() or (file.exists() and not file.is_file()):
        raise ValueError("Docker configuration must be a regular file")
    original = file.read_bytes() if file.exists() else None
    config = json.loads(original) if original is not None else {}
    if not isinstance(config, dict):
        raise ValueError("Docker configuration must be a JSON object")
    if config.get("registry-mirrors") == mirrors:
        return False
    config["registry-mirrors"] = mirrors
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".llmoj-docker-", suffix=".json", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(config, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        validate(Path(temporary))
        if original is not None:
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = file.with_name(file.name + ".llmoj-backup-" + stamp)
            with backup.open("xb") as stream:
                stream.write(original)
            backup.chmod(0o600)
        os.chmod(temporary, file.stat().st_mode & 0o777 if original is not None else 0o644)
        os.replace(temporary, file)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=OFFICIAL_SOURCE)
    parser.add_argument("--mirrors", default="")
    parser.add_argument("--configure", action="store_true")
    args = parser.parse_args()
    validate_url(args.source)
    mirrors = mirrors_from(args.mirrors)
    if not args.configure:
        return
    if os.geteuid() != 0:
        raise ValueError("Run Docker configuration with sudo")
    daemon = shutil.which("dockerd")
    if mirrors and not daemon:
        raise ValueError("Docker Engine is required before configuring registry mirrors")
    def validate(candidate):
        result = subprocess.run([daemon, "--validate", "--config-file", str(candidate)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError("Docker rejected the candidate configuration; original configuration retained")
    changed = configure_mirrors(Path("/etc/docker/daemon.json"), mirrors, validate)
    print("changed" if changed else "unchanged")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # JSON errors and daemon diagnostics may contain private host configuration.
        message = ("Docker 源或配置验证失败，未输出私有配置内容。"
                   if os.environ.get("LLMOJ_INSTALL_LANG") == "zh-CN" else
                   "Docker source/configuration validation failed; configuration contents withheld.")
        print(message, file=__import__("sys").stderr)
        raise SystemExit(1)
