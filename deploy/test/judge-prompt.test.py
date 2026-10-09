#!/usr/bin/env python3
"""Exercise the actual installer prompt against synthetic capacity, without installation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]


class JudgePrompt(unittest.TestCase):
    def prompt(self, answers, default=30, maximum=32, language='zh-CN', existing=False):
        source = (DEPLOY/'install.sh').read_text()
        start = source.index('ask_judge_slots() {')
        end = source.index('\nif [[ "$MODE" == install', start)
        function = source[start:end]
        with tempfile.TemporaryDirectory(prefix='llmoj-prompt-') as temporary:
            root = Path(temporary)
            (root/'deploy').mkdir()
            if existing:
                (root/'config').mkdir()
                (root/'config/judge.yaml').write_text('existing private configuration')
            # Only resource discovery is substituted; run the production shell prompt.
            helper = root/'deploy/judge_capacity.py'
            helper.write_text('''import json,sys
c=json.loads(sys.argv[1]) if False else '''+repr({'default_slots': default, 'maximum_slots': maximum})+'''
if '--slots' in sys.argv:
    n=int(sys.argv[sys.argv.index('--slots')+1])
    if not 1 <= n <= c['maximum_slots']:
        print('CPU/RAM capacity exceeded',file=sys.stderr);sys.exit(2)
else: print(json.dumps(c))
''')
            env = {**os.environ, 'SOURCE_ROOT':str(root), 'PROJECT_ROOT':str(root), 'JUDGE_SLOTS':'0', 'PYTHON':sys.executable,
                   'LLMOJ_INSTALL_LANG':language, 'MESSAGES':str(DEPLOY/'install-messages.sh')}
            script = '''set -Eeuo pipefail
source "$MESSAGES"
die() { printf '%s\\n' "$(translate "$*")" >&2; exit 1; }
'''+function+'''\nask_judge_slots
printf '\\nSELECTED=%s\\n' "$JUDGE_SLOTS"
'''
            return subprocess.run(['bash','-c',script],input=answers,env=env,text=True,capture_output=True,timeout=10)

    def test_default_cpu_minus_two_preserves_zero_for_retry_metadata(self):
        p=self.prompt('\n')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('默认 30',p.stdout)
        self.assertIn('SELECTED=0',p.stdout)

    def test_explicit_30_and_zero_are_accepted(self):
        for answer,expected in [('30\n',30),('0\n',0),('030\n',30)]:
            p=self.prompt(answer)
            self.assertEqual(p.returncode,0,p.stderr)
            self.assertIn(f'SELECTED={expected}',p.stdout)

    def test_invalid_and_over_capacity_input_reprompt(self):
        p=self.prompt('text\n-1\n33\n24\n')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('SELECTED=24',p.stdout)
        self.assertIn('CPU/RAM capacity exceeded',p.stderr)

    def test_insufficient_memory_does_not_silently_lower_default(self):
        p=self.prompt('\n8\n',maximum=8)
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('自动数量超过可用资源',p.stdout)
        self.assertIn('SELECTED=8',p.stdout)
        self.assertIn('CPU/RAM capacity exceeded',p.stderr)

    def test_retry_keeps_existing_configuration_without_validating_new_default(self):
        p=self.prompt('', maximum=8, existing=True)
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('SELECTED=0',p.stdout)
        self.assertIn('保留现有 judge.yaml',p.stdout)
        self.assertNotIn('CPU/RAM capacity exceeded',p.stderr)
        self.assertNotIn('默认 30',p.stdout)

    def test_eof_fails_and_english_language_is_available(self):
        p=self.prompt('',language='en')
        self.assertNotEqual(p.returncode,0)
        self.assertIn('automatic CPU-2 default 30',p.stdout)
        self.assertIn('Input ended',p.stderr)


if __name__ == '__main__':
    unittest.main()
