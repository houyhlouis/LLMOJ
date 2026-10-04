#!/usr/bin/env python3
"""Run real installer shell branches with isolated files and substitute commands.

No system service, database, network endpoint or host setting is touched. PATH is
empty of real programs: unexpected external commands fail instead of touching the
host. The Node/Python substitutes use absolute /bin/bash and shell builtins only.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]


class InstallationFlow(unittest.TestCase):
    def run_flow(self, branch, role="all", fail=""):
        source = (DEPLOY / "install.sh").read_text()
        if branch == "complete":
            start = source.index('if [[ -f "$PROJECT_ROOT/config/install-complete.json" ]]; then')
            end = source.index("\nstep 'Claim this installation directory'", start)
            fragment = source[start:end]
        else:
            start = source.index("step 'Initialize this instance database, Redis and object storage'")
            fragment = source[start:]
        with tempfile.TemporaryDirectory(prefix="llmoj-install-flow-") as temporary:
            directory = Path(temporary)
            project = directory / "existing-installation"
            repair_source = directory / "new-source"
            (project / "config").mkdir(parents=True)
            (project / "data/mariadb/mysql").mkdir(parents=True)
            (project / "runtime/node/bin").mkdir(parents=True)
            (repair_source / "deploy").mkdir(parents=True)
            if branch == "complete":
                (project / "config/install-complete.json").write_text("{}")
            node = project / "runtime/node/bin/node"
            node.write_text('''#!/bin/bash
printf 'node|%s\\n' "$*" >> "$FLOW_TRACE"
case "$*" in
  *bootstrap-admin.mjs*)
    if [[ "$FLOW_FAIL" == admin ]]; then exit 17; fi
    case "$*" in
      *--show-credentials*) printf '%s\\n' SYNTHETIC_VERIFIED_ADMIN_PASSWORD ;;
    esac ;;
esac
''')
            node.chmod(0o700)
            python = directory / "python-substitute"
            python.write_text('''#!/bin/bash
printf 'python|%s\\n' "$*" >> "$FLOW_TRACE"
if [[ "$FLOW_FAIL" == host-setting ]]; then exit 18; fi
''')
            python.chmod(0o700)
            trace_file = directory / "calls.txt"
            environment = {
                **os.environ,
                "PATH": str(directory / "no-external-programs"),
                "PROJECT_ROOT": str(project),
                "SOURCE_ROOT": str(repair_source),
                "NODE": str(node),
                "PYTHON": str(python),
                "FLOW_TRACE": str(trace_file),
                "FLOW_FAIL": fail,
                "INSTALL_ROLE": role,
            }
            prelude = r'''
set -Eeuo pipefail
PUBLIC_PORT=39817
PUBLIC_ORIGIN=http://fixture.invalid:39817
LISTEN_ADDRESS=127.0.0.1
INSTALL_SUCCESS=0
ROLLBACK_STARTED=0
MOUNT_UNITS=(fixture-rootfs.mount)
SERVICE_UNITS=(libreoj-backend.service libreoj-redis.service)
trace() { printf '%s|%s\n' "$1" "${*:2}" >> "$FLOW_TRACE"; }
step() { trace step "$@"; }
say() { trace say "$@"; printf "$@"; }
die() { trace die "$@"; exit 20; }
support() {
    trace support "$@"
    if [[ "$FLOW_FAIL" == finish && "$1" == finish ]]; then return 21; fi
}
systemctl() {
    trace systemctl "$@"
    if [[ "$FLOW_FAIL" == service-start && "$1" == start ]]; then return 22; fi
}
systemd-run() {
    trace systemd-run "$@"
    if [[ "$FLOW_FAIL" == sandbox ]]; then return 23; fi
}
wait_http() {
    trace wait_http "$@"
    if [[ "$FLOW_FAIL" == health ]]; then return 24; fi
}
wait_judge() {
    trace wait_judge "$@"
    if [[ "$FLOW_FAIL" == judge ]]; then return 25; fi
}
mariadb() { trace mariadb "$@"; }
mariadb-install-db() { trace mariadb-install-db "$@"; }
cd "$PROJECT_ROOT"
'''
            result = subprocess.run(["/bin/bash"], input=prelude + fragment,
                                    env=environment, capture_output=True, text=True, timeout=10)
            events = trace_file.read_text().splitlines() if trace_file.exists() else []
            return result, events, str(project), str(repair_source)

    def test_both_success_paths_configure_redis_before_start_and_show_credentials_last(self):
        for branch in ("first", "complete"):
            for role in ("all", "web"):
                with self.subTest(branch=branch, role=role):
                    result, events, project, source = self.run_flow(branch, role)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.count("SYNTHETIC_VERIFIED_ADMIN_PASSWORD"), 1)
                    setting = [event for event in events if event.startswith("python|")]
                    self.assertEqual(setting, [f"python|{source if branch == 'complete' else project}/deploy/configure-redis-host.py"])
                    starts = [event for event in events if event.startswith("systemctl|start")
                              and ("libreoj.target" in event or "libreoj-redis.service" in event)]
                    self.assertTrue(starts)
                    self.assertLess(events.index(setting[0]), events.index(starts[0]))
                    bootstrap = [event for event in events if event.startswith("node|") and "bootstrap-admin.mjs" in event]
                    self.assertEqual(len(bootstrap), 2)
                    self.assertNotIn("--show-credentials", bootstrap[0])
                    self.assertIn(f"--root {project}", bootstrap[0])
                    self.assertIn(f"--root {project}", bootstrap[1])
                    self.assertTrue(bootstrap[1].endswith("--show-credentials"))
                    self.assertEqual(events[-1], bootstrap[1])
                    for event in events:
                        if event.startswith(("wait_http|", "wait_judge|", "systemd-run|", "support|finish")):
                            self.assertLess(events.index(event), events.index(bootstrap[1]))
                    if branch == "complete":
                        self.assertTrue(all(event.startswith(f"node|{source}/deploy/bootstrap-admin.mjs") for event in bootstrap))
                    else:
                        self.assertEqual(bootstrap[0], f"node|deploy/bootstrap-admin.mjs --root {project}")
                        self.assertEqual(bootstrap[1], f"node|{project}/deploy/bootstrap-admin.mjs --root {project} --show-credentials")

    def test_failures_never_reach_password_output(self):
        for branch in ("first", "complete"):
            failures = ["host-setting", "service-start", "health", "judge", "admin"]
            if branch == "first":
                failures += ["sandbox", "finish"]
            for failure in failures:
                with self.subTest(branch=branch, failure=failure):
                    result, events, _, _ = self.run_flow(branch, fail=failure)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("SYNTHETIC_VERIFIED_ADMIN_PASSWORD", result.stdout + result.stderr)
                    self.assertFalse(any("--show-credentials" in event for event in events))
                    if failure == "host-setting":
                        self.assertFalse(any(event.startswith("systemctl|start") for event in events))


if __name__ == "__main__":
    unittest.main()
