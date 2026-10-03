#!/usr/bin/env python3
"""Exercise the GitHub entry point with fake HTTPS downloads, without deploying."""
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ENTRY = Path(__file__).resolve().parents[2] / "install.sh"
SHA = "4" * 40


class GitHubEntry(unittest.TestCase):
    def run_entry(self, extra=(), unsafe=False, chinese=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "owner-repo-commit"
            (source / "deploy").mkdir(parents=True)
            (source / "infra/sandbox-rootfs").mkdir(parents=True)
            (source / "package.json").write_text("{}")
            (source / "LICENSE").write_text("MIT")
            (source / "infra/sandbox-rootfs/Dockerfile").write_text("FROM scratch")
            (source / "deploy/install.sh").write_text(
                '#!/bin/bash\nprintf "LANG=%s\\n" "$LLMOJ_INSTALL_LANG"\nprintf "SOURCE=%s\\n" "$OJ_SOURCE_COMMIT"\nprintf "ARG=%s\\n" "$@"\n')
            archive = root / "source.tar.gz"
            with tarfile.open(archive, "w:gz") as package:
                package.add(source, arcname=source.name)
                if unsafe:
                    member = tarfile.TarInfo("owner-repo-commit/escape")
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc"
                    package.addfile(member)
            (root / "commit.json").write_text(json.dumps({"sha": SHA}))
            executable = root / "bin"
            executable.mkdir()
            curl = executable / "curl"
            curl.write_text('''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
root = Path(os.environ['ENTRY_FIXTURE'])
arguments = sys.argv[1:]
url = arguments[-1]
with (root / 'requests.jsonl').open('a') as log:
    log.write(json.dumps(url) + '\\n')
source = 'commit.json' if url.startswith('https://api.github.com/') else 'source.tar.gz'
shutil.copyfile(root / source, arguments[arguments.index('-o') + 1])
''')
            curl.chmod(0o755)
            entry = ENTRY.with_name('install.zh-CN.sh') if chinese else ENTRY
            result = subprocess.run(['bash', str(entry), '--repository', 'owner/repo', '--plan', *extra],
                                    env={**os.environ, 'PATH': str(executable) + ':' + os.environ['PATH'],
                                         'ENTRY_FIXTURE': str(root)}, capture_output=True, text=True)
            requests = (root / 'requests.jsonl').read_text() if (root / 'requests.jsonl').exists() else ''
            return result, requests

    def test_resolves_commit_and_downloads_that_snapshot(self):
        result, requests = self.run_entry(('--ref', 'release/v1', '--port', '8080', '--site-name', 'AI Site'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('/commits/release%2Fv1', requests)
        self.assertIn('/tar.gz/' + SHA, requests)
        self.assertIn('SOURCE=' + SHA, result.stdout)
        self.assertIn('ARG=AI Site', result.stdout)
        self.assertIn('ARG=8080', result.stdout)

    def test_chinese_entry_is_standalone_and_forwards_language_and_mirrors(self):
        result, _ = self.run_entry(('--docker-source', 'https://packages.invalid/docker-ce',
                                    '--docker-mirrors', 'https://images.invalid'), chinese=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('LANG=zh-CN', result.stdout)
        self.assertIn('ARG=https://images.invalid', result.stdout)
        self.assertIn('正在下载源码提交', result.stdout)
        self.assertEqual(ENTRY.read_text().replace('LLMOJ_INSTALL_LANG=en','LLMOJ_INSTALL_LANG=zh-CN'),
                         ENTRY.with_name('install.zh-CN.sh').read_text())

    def test_rejects_source_symlink_before_running_installer(self):
        result, _ = self.run_entry(unsafe=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('link or special file', result.stderr)
        self.assertNotIn('SOURCE=', result.stdout)

    def test_invalid_repository_and_ref_fail_before_download(self):
        for arguments in (('--repository', '../bad'), ('--ref', '../bad')):
            with self.subTest(arguments=arguments):
                result, requests = self.run_entry(arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(requests, '')


if __name__ == '__main__':
    unittest.main()
