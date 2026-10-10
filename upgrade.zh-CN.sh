#!/usr/bin/env bash
# Download a fixed official source revision; never run the installer for upgrades.
set -euo pipefail
exec python3 - "$@" <<'PY'
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

REPO = 'houyhlouis/LLMOJ'
args = sys.argv[1:]
options = argparse.ArgumentParser(allow_abbrev=False, description='Upgrade a completed official all/web installation; preserve configuration and data.')
options.add_argument('--ref', action='append', default=[])
options.add_argument('--prefix', default='/opt/LibreOJ')
options.add_argument('--plan', action='store_true')
options.add_argument('--apply', action='store_true')
options.add_argument('--drained', action='store_true')
options.add_argument('--rollback')
parsed = options.parse_args(args)
if len(parsed.ref) > 1:
    raise SystemExit('Specify --ref only once')
ref = parsed.ref[0] if parsed.ref else 'main'
if not re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', ref) or '..' in ref:
    raise SystemExit('Invalid GitHub source reference')

def fetch(url, maximum):
    request = urllib.request.Request(url, headers={'User-Agent':'LLMOJ-upgrade-bootstrap'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if urllib.parse.urlsplit(response.url).hostname not in ('api.github.com','raw.githubusercontent.com','codeload.github.com'):
            raise SystemExit('Unexpected source redirect')
        data = response.read(maximum+1)
    if len(data) > maximum:
        raise SystemExit('Source size limit exceeded')
    return data

try:
    sha = json.loads(fetch('https://api.github.com/repos/'+REPO+'/commits/'+urllib.parse.quote(ref,safe=''), 1024*1024))['sha']
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SystemExit('Invalid immutable source commit')
    # A plan is genuinely read-only: execute the same fixed-commit preflight from
    # memory, with no temporary archive or source files. The plan reports build
    # and schema checks that cannot be completed without staging.
    if parsed.plan:
        code = fetch('https://raw.githubusercontent.com/'+REPO+'/'+sha+'/deploy/upgrade.py', 1024*1024)
        sys.argv = ['upgrade.py', *args, '--ref', sha]
        exec(compile(code, '<fixed-commit-upgrade>', 'exec'), {'__name__':'__main__','__file__':'<fixed-commit-upgrade>'})
        raise SystemExit(0)
    if os.geteuid() != 0:
        raise SystemExit('Run this downloaded entry point with sudo')
    archive = fetch('https://codeload.github.com/'+REPO+'/tar.gz/'+sha, 256*1024*1024)
    temporary = Path(tempfile.mkdtemp(prefix='llmoj-upgrade-', dir='/var/tmp'))
    try:
        source = temporary/'source'
        source.mkdir(mode=0o700)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            members = tar.getmembers()
            if not members or len(members)>30000:
                raise SystemExit('Unsafe source file count')
            prefix = Path(members[0].name).parts[0]
            seen = set()
            total = 0
            for member in members:
                path = Path(member.name)
                total += member.size
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=prefix or member.name in seen or not(member.isdir() or member.isfile()) or total>256*1024*1024:
                    raise SystemExit('Unsafe source archive member')
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
            raise SystemExit('This release has no supported upgrade helper')
        result = subprocess.run(['python3',str(helper),'--source',str(source),'--source-digest'],check=True,capture_output=True,text=True)
        tree = result.stdout.strip()
        if not re.fullmatch(r'[0-9a-f]{64}',tree):
            raise SystemExit('Invalid verified source digest')
        # stdin for this Python program is the here-document; reconnect a real
        # terminal for the upgrader's single maintenance acknowledgement.
        terminal = None
        if not parsed.apply and not parsed.rollback:
            try:
                terminal = open('/dev/tty','r')
            except OSError:
                raise SystemExit('Non-interactive use requires --apply --drained')
        try:
            command = ['python3',str(helper),*args,'--source',str(source),'--source-sha256',tree,'--verified-commit',sha]
            result = subprocess.run(command,stdin=terminal)
        finally:
            if terminal:
                terminal.close()
        raise SystemExit(result.returncode)
    finally:
        shutil.rmtree(temporary)
except (OSError, ValueError, KeyError, subprocess.SubprocessError):
    raise SystemExit('Unable to prepare the fixed official source; private command output withheld')
PY
