#!/usr/bin/env bash
# Download a fixed official source revision; never run the installer for upgrades.
set -euo pipefail
# The upgrader names this script in the command that shows its progress from another terminal.
case "$0" in
  *.sh) LLMOJ_UPGRADE_SCRIPT="$(readlink -f -- "$0" || true)"; export LLMOJ_UPGRADE_SCRIPT ;;
esac
exec python3 - "$@" <<'PY'
import argparse
import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

REPO = 'houyhlouis/LLMOJ'
# Messages for people are in this language; the upgrader follows it. upgrade.zh-CN.sh differs only here.
LANGUAGE = 'en'
os.environ['LLMOJ_LANG'] = LANGUAGE


def say(english, chinese):
    return chinese if LANGUAGE == 'zh-CN' else english


args = sys.argv[1:]
options = argparse.ArgumentParser(allow_abbrev=False, description=say(
    'Upgrade a completed official all/web installation, keeping its configuration and data.',
    '升级已完成安装的官方 all/web 实例，保留配置和数据。'))
options.add_argument('--ref', action='append', default=[])
options.add_argument('--prefix', default='/opt/LLMOJ')
options.add_argument('--plan', action='store_true')
options.add_argument('--apply', action='store_true')
options.add_argument('--drained', action='store_true')
options.add_argument('--rollback')
options.add_argument('--status', action='store_true')
parsed = options.parse_args(args)
if len(parsed.ref) > 1:
    raise SystemExit(say('Specify --ref only once', '--ref 只能指定一次'))
ref = parsed.ref[0] if parsed.ref else 'main'
if not re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', ref) or '..' in ref:
    raise SystemExit(say('Invalid GitHub source reference', '无效的 GitHub 源码引用'))

def fetch(url, maximum, accept='application/vnd.github+json'):
    request = urllib.request.Request(url, headers={'User-Agent':'LLMOJ-upgrade-bootstrap','Accept':accept})
    with urllib.request.urlopen(request, timeout=60) as response:
        if urllib.parse.urlsplit(response.url).hostname not in ('api.github.com','raw.githubusercontent.com','codeload.github.com'):
            raise SystemExit(say('Unexpected redirect while downloading the source', '下载源码时出现意外的重定向'))
        data = response.read(maximum+1)
    if len(data) > maximum:
        raise SystemExit(say('The source is larger than allowed', '源码超过大小上限'))
    return data

try:
    sha = fetch('https://api.github.com/repos/'+REPO+'/commits/'+urllib.parse.quote(ref,safe=''), 1024*1024, 'application/vnd.github.sha').decode().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SystemExit(say('Invalid source commit', '无效的源码提交'))
    # A plan is genuinely read-only: execute the same fixed-commit preflight from
    # memory, with no temporary archive or source files. The plan reports build
    # and schema checks that cannot be completed without staging. --status only
    # reads the installation's upgrade records.
    if parsed.plan or parsed.status:
        code = fetch('https://raw.githubusercontent.com/'+REPO+'/'+sha+'/deploy/upgrade.py', 1024*1024)
        sys.argv = ['upgrade.py', *args, '--ref', sha]
        exec(compile(code, '<fixed-commit-upgrade>', 'exec'), {'__name__':'__main__','__file__':'<fixed-commit-upgrade>'})
        raise SystemExit(0)
    if os.geteuid() != 0:
        raise SystemExit(say('Run this script with sudo', '请使用 sudo 运行此脚本'))
    print(say('Downloading version '+sha[:12]+' from GitHub…', '正在从 GitHub 下载版本 '+sha[:12]+'…'), flush=True)
    archive = fetch('https://codeload.github.com/'+REPO+'/tar.gz/'+sha, 256*1024*1024)
    temporary = Path(tempfile.mkdtemp(prefix='llmoj-upgrade-', dir='/var/tmp'))
    try:
        source = temporary/'source'
        source.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            members = tar.getmembers()
            if not members or len(members)>30000:
                raise SystemExit(say('The source archive has too many files', '源码归档文件数量异常'))
            prefix = Path(members[0].name).parts[0]
            seen = set()
            total = 0
            for member in members:
                path = Path(member.name)
                total += member.size
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=prefix or member.name in seen or not(member.isdir() or member.isfile()) or total>256*1024*1024:
                    raise SystemExit(say('The source archive contains an unsafe entry', '源码归档包含不安全的条目'))
                seen.add(member.name)
            for member in members:
                relative = Path(*Path(member.name).parts[1:])
                if relative == Path('.'):
                    continue
                output = source/relative
                if member.isdir():
                    output.mkdir(parents=True,exist_ok=True,mode=0o755)
                else:
                    output.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
                    with tar.extractfile(member) as incoming, output.open('xb') as stream:
                        shutil.copyfileobj(incoming,stream)
                    output.chmod(0o755 if member.mode & 0o111 else 0o644)
        helper = source/'deploy/upgrade.py'
        if not helper.is_file():
            raise SystemExit(say('This version has no supported upgrader', '此版本没有受支持的升级程序'))
        result = subprocess.run(['python3',str(helper),'--source',str(source),'--source-digest'],check=True,capture_output=True,text=True)
        tree = result.stdout.strip()
        if not re.fullmatch(r'[0-9a-f]{64}',tree):
            raise SystemExit(say('Invalid source digest', '无效的源码摘要'))
        # stdin for this Python program is the here-document; reconnect a real
        # terminal for the upgrader's single maintenance acknowledgement.
        terminal = None
        if not parsed.apply and not parsed.rollback:
            try:
                terminal = open('/dev/tty','r')
            except OSError:
                raise SystemExit(say('Without a terminal, use --apply --drained', '非交互运行请使用 --apply --drained'))
        try:
            command = ['python3',str(helper),*args,'--source',str(source),'--source-sha256',tree,'--verified-commit',sha]
            # The upgrader goes on when the terminal goes away (a dropped SSH connection), and so does this script,
            # which deletes the downloaded source afterwards.
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            result = subprocess.run(command,stdin=terminal)
        finally:
            if terminal:
                terminal.close()
        raise SystemExit(result.returncode)
    finally:
        shutil.rmtree(temporary)
except (OSError, ValueError, KeyError, subprocess.SubprocessError):
    raise SystemExit(say("Couldn't prepare the official source (command output is not shown)", '无法准备官方源码（未输出命令内容）'))
PY
