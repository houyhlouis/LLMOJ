#!/usr/bin/env python3
"""Check and optionally archive source files, without any network or Git writes."""
import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRECTORIES = {"apps", "packages", "infra", "deploy", "config", ".github", "wiki"}
SOURCE_FILES = {
    "LICENSE", "README.md", "README.en.md", "README.zh-CN.md", "README-DEVELOPMENT.md", "README-DEVELOPMENT.zh-CN.md",
    "THIRD_PARTY_NOTICES.md", "install.sh", "install.zh-CN.sh", "upgrade.sh", "upgrade.zh-CN.sh",
    "eslint.airbnb-base.mjs",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".gitignore",
    ".gitmodules", ".node-version", ".npmrc", ".prettierrc",
}
# Named exclusions are the source manifest's only permitted omissions. Unknown tracked
# paths fail closed below, including new root files that have not been reviewed yet.
EXCLUDED_DIRECTORY_RULES = {
    "git-metadata": {".git"},
    "installed-dependencies": {"node_modules", ".pnpm-store"},
    "build-output": {"dist", "build", "lib", "__pycache__", ".cache", "coverage"},
    "instance-data": {"data", "runtime", "backups", "logs", "cache"},
    "local-release-output": {"release"},
    "local-verification-output": {"verification"},
}
EXCLUDED_SUFFIX_RULES = {
    "diagnostic-output": {".log", ".tap", ".core"},
    "build-output": {".tsbuildinfo", ".pyc"},
    "downloaded-images": {".iso", ".squashfs"},
    "private-keys": {".key", ".pem", ".p12", ".pfx"},
    "local-archives": {".gz", ".zip"},
}
SECRET_PATTERNS = (
    re.compile(rb"\bsk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{24,}"),
    re.compile(rb"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}"),
    re.compile(rb"\btvly-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"\bAIza[A-Za-z0-9_-]{30,}"),
    re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
)


def exclusion_rule(relative):
    """Return the reviewed reason for omitting a path, or None for source candidates."""
    parts = relative.parts
    for rule, names in EXCLUDED_DIRECTORY_RULES.items():
        if any(part in names for part in parts):
            return rule
    if any(part.startswith("dist-") for part in parts):
        return "build-output"
    if parts[:2] in {("deploy", "noi"), ("deploy", "september20"), ("deploy", "rootfs")}:
        return "local-deployment-artifacts"
    if parts and parts[0] == "config" and not relative.name.endswith(".example"):
        return "instance-configuration"
    for rule, suffixes in EXCLUDED_SUFFIX_RULES.items():
        if relative.suffix in suffixes:
            return rule
    if relative.name in {"stats.html", ".eslintcache", "core"}:
        return "diagnostic-output"
    if relative.name.startswith(".env") and relative.name != ".env.example":
        return "environment-secrets"
    if relative == Path("deploy/release-manifest.json"):
        return "build-output"
    if relative.name in {"ADMIN-CREDENTIALS.txt", "secrets.json", "installation-summary.json", "local-changes.patch"}:
        return "private-installation-state"
    if "verification" in relative.name and relative.suffix == ".json":
        return "local-verification-output"
    return None


def included(relative):
    parts = relative.parts
    return bool(parts and (parts[0] in SOURCE_DIRECTORIES or str(relative) in SOURCE_FILES)
                and exclusion_rule(relative) is None)


def recorded_source():
    try:
        install = json.loads((ROOT / "config/install-complete.json").read_text())
    except FileNotFoundError:
        install = {}
    try:
        backups = list((ROOT / "backups/upgrade").iterdir())
    except FileNotFoundError:
        backups = []
    initial_revision = install.get("sourceRepository"), install.get("sourceCommit")
    if not backups and install.get("treeSha256") is None:
        return initial_revision  # Older installer record without a tree digest.
    sources = [(install.get("treeSha256"), initial_revision)]
    # A rollback can restore any saved backup, and completed records may be pruned.
    # Match the installed tree rather than the order of the records.
    for backup in backups:
        try:
            record = json.loads((backup / "manifest.json").read_text())
        except FileNotFoundError:
            continue
        if record["status"] in {"complete", "rolled-back"}:
            source = record["provenance"]
            sources.append((source.get("treeSha256"), (source.get("repository"), source.get("commit"))))
    current = subprocess.check_output([sys.executable, "-B", str(ROOT / "deploy/upgrade.py"),
                                       "--source-digest", "--source", str(ROOT)], stderr=subprocess.DEVNULL, text=True).strip()
    matches = {revision for digest, revision in sources if digest == current}
    return matches.pop() if len(matches) == 1 else (None, None)


def checkout_instructions():
    message = ("Source packaging requires a Git checkout with .git at the project root. "
               "Use a clean checkout of the installed revision in a separate directory.")
    try:
        repository, commit = recorded_source()
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.CalledProcessError):
        repository, commit = None, None
    if isinstance(repository, str):
        repository = repository.removeprefix("https://github.com/")
    if isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit):
        if isinstance(repository, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
            url = f"https://github.com/{repository}.git"
        else:
            message += "\nSet REPOSITORY_URL to the original release repository's clone URL."
            url = '"$REPOSITORY_URL"'
        return (f"{message}\n  cd ~ &&\n  git clone {url} llmoj-source &&\n"
                f"  cd llmoj-source &&\n  git checkout --detach {commit} &&\n"
                "  git submodule update --init --recursive &&\n"
                "  python3 deploy/prepare-github.py --archive ../llmoj-source.tar.gz")
    return (message + "\nThe current revision could not be identified. Ask the installation administrator to check "
            "config/install-complete.json and the completed upgrade records in backups/upgrade/*/manifest.json. "
            "For a local source installation without a recorded commit, use the original release checkout.")


def git_listing(directory, *options):
    listing = subprocess.check_output(["git", "-C", str(directory), "ls-files", "-z", *options])
    return listing.split(b"\0")[:-1]


def git_paths(directory, include_untracked):
    if not (directory / ".git").exists():
        if directory == ROOT:
            raise SystemExit(checkout_instructions())
        raise ValueError(f"Source submodule must be checked out: {directory.relative_to(ROOT)}")
    paths = {}
    for entry in git_listing(directory, "--stage"):
        metadata, name = entry.split(b"\t", 1)
        paths[Path(name.decode("utf-8"))] = metadata.split(b" ", 1)[0]
    if include_untracked:
        for name in git_listing(directory, "--others", "--exclude-standard"):
            paths.setdefault(Path(name.decode("utf-8")), None)
    return paths


def source_paths(include_untracked=False, repository=Path()):
    result = set()
    for path, mode in git_paths(ROOT / repository, include_untracked).items():
        relative = repository / path
        if exclusion_rule(relative) is not None:
            continue
        if not included(relative):
            if mode is not None:
                raise ValueError(f"Unclassified tracked source path: {relative}; add it to the source manifest "
                                 "or a narrow named exclusion rule")
            continue
        absolute = ROOT / repository
        for part in path.parts:
            absolute /= part
            if absolute.is_symlink():
                raise ValueError(f"Source symlink requires manual review: {absolute.relative_to(ROOT)}")
        if mode == b"160000":  # Select from a checked-out submodule's own Git index.
            result.update(source_paths(include_untracked, relative))
        elif absolute.is_file():
            result.add(relative)
        elif mode is not None:
            raise ValueError(f"Tracked source file missing or not a regular file: {relative}")
    return sorted(result, key=str)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Create a local source archive; no upload")
    parser.add_argument("--include-untracked", action="store_true", help="Also select eligible, non-ignored untracked files")
    args = parser.parse_args()
    paths = source_paths(args.include_untracked)
    required = {Path(p) for p in SOURCE_FILES} | {Path("apps/judge/vendor/testlib/LICENSE")}
    if missing := required - set(paths):
        raise ValueError("Required source/notice missing: " + ", ".join(map(str, sorted(missing))))
    total = 0
    for relative in paths:
        content = (ROOT / relative).read_bytes()
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            raise ValueError(f"Possible secret in {relative}; value withheld")
        total += len(content)
    selection = "tracked and eligible untracked files" if args.include_untracked else "tracked files only"
    print(f"Source check passed ({selection}): {len(paths)} files, {total} bytes; no common secret signatures")
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
