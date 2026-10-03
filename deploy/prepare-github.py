#!/usr/bin/env python3
"""Check and optionally archive source files, without any network or Git writes."""
import argparse
import gzip
import hashlib
import io
import re
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRECTORIES = {"apps", "packages", "infra", "deploy", "config", ".github", "wiki"}
SOURCE_FILES = {
    "LICENSE", "README.md", "README.zh-CN.md", "README-DEVELOPMENT.md", "README-DEVELOPMENT.zh-CN.md",
    "THIRD_PARTY_NOTICES.md", "install.sh", "install.zh-CN.sh",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".gitignore",
    ".gitmodules", ".node-version", ".npmrc", ".prettierrc",
}
EXCLUDED_PARTS = {
    ".git", "node_modules", "dist", "build", "lib", "__pycache__",
    ".cache", "coverage", "verification", "data", "runtime", "backups",
    "logs", "cache", "release", "noi", "september20", "rootfs",
}
EXCLUDED_SUFFIXES = {
    ".log", ".tap", ".tsbuildinfo", ".iso", ".squashfs", ".key", ".pem",
    ".p12", ".pfx", ".gz", ".zip", ".core", ".pyc",
}
SECRET_PATTERNS = (
    re.compile(rb"\bsk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{24,}"),
    re.compile(rb"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}"),
    re.compile(rb"\btvly-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"\bAIza[A-Za-z0-9_-]{30,}"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
)


def included(relative):
    parts = relative.parts
    if not parts or (parts[0] not in SOURCE_DIRECTORIES and str(relative) not in SOURCE_FILES):
        return False
    if any(p in EXCLUDED_PARTS or p.startswith("dist-") for p in parts):
        return False
    if parts[0] == "config" and not relative.name.endswith(".example"):
        return False
    if relative.suffix in EXCLUDED_SUFFIXES or relative.name in {"stats.html", ".eslintcache", "core"}:
        return False
    if relative.name.startswith(".env") and relative.name != ".env.example":
        return False
    if relative.name in {"ADMIN-CREDENTIALS.txt", "secrets.json", "installation-summary.json", "local-changes.patch"}:
        return False
    if "verification" in relative.name and relative.suffix == ".json":
        return False
    return True


def source_paths():
    listing = subprocess.check_output([
        "git", "-C", str(ROOT), "ls-files", "-z", "--cached", "--others", "--exclude-standard"
    ])
    result = set()
    for raw in listing.split(b"\0"):
        if not raw:
            continue
        relative = Path(raw.decode("utf-8"))
        if not included(relative):
            continue
        absolute = ROOT / relative
        if absolute.is_symlink():
            raise ValueError(f"Source symlink requires manual review: {relative}")
        if absolute.is_dir():  # Include checked-out submodule source, without its Git metadata.
            for nested in absolute.rglob("*"):
                subrelative = nested.relative_to(ROOT)
                if included(subrelative) and nested.is_file() and not nested.is_symlink():
                    result.add(subrelative)
        elif absolute.is_file():
            result.add(relative)
    return sorted(result, key=str)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Create a local source archive; no upload")
    args = parser.parse_args()
    paths = source_paths()
    required = {Path(p) for p in SOURCE_FILES} | {Path("apps/judge/vendor/testlib/LICENSE")}
    if missing := required - set(paths):
        raise ValueError("Required source/notice missing: " + ", ".join(map(str, sorted(missing))))
    total = 0
    for relative in paths:
        content = (ROOT / relative).read_bytes()
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            raise ValueError(f"Possible secret in {relative}; value withheld")
        total += len(content)
    print(f"Source check passed: {len(paths)} files, {total} bytes; no common secret signatures")
    if args.archive:
        archive = args.archive.resolve()
        if archive.exists():
            raise ValueError("Archive already exists; refusing to overwrite it")
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open("xb") as output, gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as tar:
                for relative in paths:
                    absolute = ROOT / relative
                    content = absolute.read_bytes()
                    info = tarfile.TarInfo("LibreOJ/" + relative.as_posix())
                    info.size = len(content)
                    info.mode = 0o755 if absolute.stat().st_mode & 0o111 else 0o644
                    info.mtime = 0
                    tar.addfile(info, io.BytesIO(content))
        print(f"Local source archive: {archive}")
        print(f"SHA-256: {hashlib.sha256(archive.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
