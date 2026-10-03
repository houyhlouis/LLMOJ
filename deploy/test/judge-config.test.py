#!/usr/bin/env python3
"""Validate standalone judge configuration without installing or running a judge."""
import base64
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

DEPLOY = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.geteuid() == 0, 'private configuration ownership requires root')
class RemoteJudge(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='libreoj-remote-test-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        (self.root / 'apps/judge').mkdir(parents=True)
        shutil.copyfile(DEPLOY.parent / 'apps/judge/config-example.yaml', self.root / 'apps/judge/config-example.yaml')
        (self.root / 'apps/judge/index.mjs').touch()
        (self.root / 'runtime/sandbox-rootfs/etc').mkdir(parents=True)
        (self.root / 'runtime/sandbox-rootfs/etc/libreoj-rootfs-id').write_text('0' * 64)
        self.key = base64.b64encode(b'x' * 30).decode()
        self.keyfile = self.root / 'judge.key'
        self.keyfile.write_text(self.key)
        self.keyfile.chmod(0o600)
        self.environment = {**os.environ, 'HYHOJ_ROOT': str(self.root), 'OJ_JUDGE_REMOTE': '1',
                            'OJ_JUDGE_SERVER': 'https://oj.example.invalid', 'OJ_JUDGE_KEY_FILE': str(self.keyfile),
                            'OJ_JUDGE_SLOTS': '1', 'NODE_BINARY': shutil.which('node')}

    def generate(self):
        return subprocess.run(['/usr/bin/python3', str(DEPLOY / 'configure-judge.py')],
                              env=self.environment, capture_output=True, text=True)

    def test_remote_configuration_is_private_and_independent_of_local_backend(self):
        result = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.key, result.stdout + result.stderr)
        file = self.root / 'config/judge.yaml'
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        original = file.read_bytes()
        config = yaml.safe_load(original)
        self.assertEqual(config['serverUrl'], 'https://oj.example.invalid')
        self.assertEqual(config['key'], self.key)
        self.assertIsNone(config['aiRunnerSocket'])
        self.assertIsNone(config['aiGeneratedDirectory'])
        self.assertIsNone(config['downloadEndpointOverride'])
        self.assertEqual(config['maxConcurrentTasks'], len(config['taskWorkingDirectories']))
        units = self.root / 'deploy/systemd'
        service = (units / 'libreoj-judge.service').read_text()
        self.assertNotIn('libreoj-backend.service', service)
        self.assertIn('PartOf=libreoj-judge.target', service)
        self.assertIn('DelegateSubgroup=supervisor', service)
        check = subprocess.run(['systemd-analyze', 'verify', str(units / 'libreoj-judge.service'),
                                str(units / 'libreoj-judge.target'), *map(str, units.glob('*.mount'))],
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)
        self.assertEqual(self.generate().returncode, 0)
        self.assertEqual(file.read_bytes(), original)

    def test_key_permissions_and_changed_endpoint_are_rejected_without_key_output(self):
        self.keyfile.chmod(0o644)
        result = self.generate()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(self.key, result.stdout + result.stderr)
        self.keyfile.chmod(0o600)
        self.assertEqual(self.generate().returncode, 0)
        self.environment['OJ_JUDGE_SERVER'] = 'https://other.example.invalid'
        self.assertNotEqual(self.generate().returncode, 0)


if __name__ == '__main__':
    unittest.main()
