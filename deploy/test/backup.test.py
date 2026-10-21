#!/usr/bin/env python3
"""Run deploy/backup.sh against a temporary instance with a substitute systemctl.

No system service or host setting is touched: systemctl and install are shell functions,
and the maintenance lock lives in the temporary directory.
"""
import fcntl
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
ALL = ["libreoj.target", "libreoj-nginx.service", "libreoj-judge.service", "libreoj-backend.service",
       "libreoj-minio.service", "libreoj-redis.service", "libreoj-mariadb.service"]
WEB = [unit for unit in ALL if unit != "libreoj-judge.service"]


class Backup(unittest.TestCase):
    def run_backup(self, installed, active, fail="", hold_lock=False, arguments=(), prepare=None, inspect=None):
        source = (DEPLOY / "backup.sh").read_text()
        root_check = 'if [ "$EUID" -ne 0 ]; then exec sudo bash "$0" "${libreoj_backup_args[@]}"; fi\n'
        self.assertIn(root_check, source)
        with tempfile.TemporaryDirectory(prefix="llmoj-backup-") as temporary:
            directory = Path(temporary)
            root = directory / "instance"
            for name in ("config", "data/mariadb", "data/judge", "deploy"):
                (root / name).mkdir(parents=True)
            (root / "config/backend.yaml").write_text("synthetic: true\n")
            (root / "data/mariadb/table").write_text("rows")
            (root / "data/judge/cache").write_text("excluded")
            if prepare:
                prepare(directory, root)
            lock_directory = directory / "run-lock"
            script = source.replace(root_check, "").replace("/run/libreoj-installer", str(lock_directory))
            trace = directory / "calls.txt"
            prelude = r'''
systemctl() {
    printf 'systemctl %s\n' "$*" >> "$FLOW_TRACE"
    case "$1" in
        show) [[ " $FLOW_INSTALLED " == *" $2 "* ]] && printf '/etc/systemd/system/%s\n' "$2"; return 0 ;;
        is-active) [[ " $FLOW_ACTIVE " == *" ${*: -1} "* ]] ;;
        stop|start) return 0 ;;
    esac
}
install() { mkdir -p "${@: -1}"; }
tar() { if [[ "$FLOW_FAIL" == tar ]]; then return 2; fi; command tar "$@"; }
'''
            lock_file = None
            if hold_lock:
                lock_directory.mkdir()
                lock_file = open(lock_directory / "lock", "w")
                fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                result = subprocess.run(
                    ["/bin/bash", "-c", prelude + script, "backup.sh", "--prefix", str(root),
                     *[str(argument).replace("{directory}", str(directory)) for argument in arguments]],
                    env={**os.environ, "FLOW_TRACE": str(trace), "FLOW_FAIL": fail,
                         "FLOW_INSTALLED": " ".join(installed), "FLOW_ACTIVE": " ".join(active)},
                    capture_output=True, text=True, timeout=30)
            finally:
                if lock_file:
                    lock_file.close()
            calls = trace.read_text().splitlines() if trace.exists() else []
            backups = sorted(path.name for path in (root / "backups").glob("*")) if (root / "backups").exists() else []
            if inspect:
                inspect(directory, root)
            return result, calls, backups

    def actions(self, calls):
        return [call for call in calls if call.startswith(("systemctl stop", "systemctl start"))]

    def test_web_installation_never_touches_the_missing_judge_and_restores_its_services(self):
        result, calls, backups = self.run_backup(WEB, WEB)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any("libreoj-judge" in call for call in self.actions(calls)))
        services = " ".join(unit for unit in WEB if unit.endswith(".service"))
        self.assertEqual(self.actions(calls), [
            "systemctl stop libreoj.target",
            f"systemctl stop {services}",
            "systemctl start libreoj.target",
            f"systemctl start {services}",
        ])
        self.assertEqual(len(backups), 2)
        self.assertIn('/deploy/verify-backup.sh ', result.stdout)
        self.assertTrue(backups[0].endswith(".tar.gz") and backups[1].endswith(".tar.gz.sha256"))

    def test_a_stopped_instance_stays_stopped(self):
        result, calls, backups = self.run_backup(ALL, [])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call.startswith("systemctl start") for call in calls))
        self.assertNotIn("systemctl stop libreoj.target", calls)
        self.assertEqual(len(backups), 2)

    def test_only_previously_running_services_are_started_again(self):
        active = [unit for unit in ALL if unit not in ("libreoj.target", "libreoj-judge.service")]
        result, calls, _ = self.run_backup(ALL, active)
        self.assertEqual(result.returncode, 0, result.stderr)
        starts = [call for call in calls if call.startswith("systemctl start")]
        self.assertEqual(starts, ["systemctl start " + " ".join(active)])

    def test_failed_archive_still_restores_services_and_leaves_no_backup(self):
        result, calls, backups = self.run_backup(ALL, ALL, fail="tar")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.actions(calls)[-2:], [
            "systemctl start libreoj.target",
            "systemctl start " + " ".join(unit for unit in ALL if unit.endswith(".service")),
        ])
        self.assertFalse(any(name.endswith(".tar.gz") for name in backups))

    def test_concurrent_maintenance_is_refused_before_stopping_anything(self):
        result, calls, backups = self.run_backup(ALL, ALL, hold_lock=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Another installation, upgrade or maintenance task is running", result.stderr)
        self.assertEqual(calls, [])
        self.assertEqual(backups, [])


    def test_keep_deletes_only_the_oldest_backups_after_a_successful_backup(self):
        def prepare(directory, root):
            (root / "backups").mkdir()
            for stamp in ("20240101T000000Z", "20250101T000000Z", "20260101T000000Z"):
                (root / f"backups/libreoj-{stamp}.tar.gz").write_text("old")
                (root / f"backups/libreoj-{stamp}.tar.gz.sha256").write_text("old")
            (root / "backups/upgrade").mkdir()
        result, _, backups = self.run_backup(ALL, ALL, arguments=("--keep", "2"), prepare=prepare)
        self.assertEqual(result.returncode, 0, result.stderr)
        archives = [name for name in backups if name.endswith(".tar.gz")]
        self.assertEqual(len(archives), 2)
        self.assertIn("libreoj-20260101T000000Z.tar.gz", archives)
        self.assertNotIn("libreoj-20240101T000000Z.tar.gz.sha256", backups)
        self.assertIn("upgrade", backups, "upgrade backups are never touched")
        self.assertIn("Deleted the older backup libreoj-20250101T000000Z.tar.gz", result.stdout)
        for invalid in ("x", "-1", "99999"):
            result, calls, _ = self.run_backup(ALL, ALL, arguments=("--keep", invalid))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])

    def test_copy_to_a_directory_with_a_checksum_that_checks_there(self):
        result, _, backups = self.run_backup(ALL, ALL, arguments=("--copy-to", "{directory}/offsite/"),
                                             prepare=lambda directory, root: (directory / "offsite").mkdir(),
                                             inspect=lambda directory, root: self.copied.extend(
                                                 [sorted(p.name for p in (directory / "offsite").iterdir()),
                                                  subprocess.run(["sha256sum", "-c", "--quiet", *[p.name for p in (directory / "offsite").glob("*.sha256")]],
                                                                 cwd=directory / "offsite").returncode]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.copied[0], backups)
        self.assertEqual(self.copied[1], 0)

    def setUp(self):
        self.copied = []

    def test_encrypted_backups_never_exist_unencrypted_and_need_the_private_key(self):
        def prepare(directory, root):
            home = directory / "gnupg"
            home.mkdir(mode=0o700)
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--passphrase", "", "--quick-gen-key",
                            "LLMOJ backup test <backup@example.invalid>", "future-default", "default", "never"],
                           check=True, capture_output=True)
            exported = subprocess.run(["gpg", "--homedir", str(home), "--armor", "--export"], check=True, capture_output=True)
            (directory / "backup-key.asc").write_bytes(exported.stdout)
            (directory / "not-a-key.asc").write_text("not a key")

        def inspect(directory, root):
            for archive in (root / "backups").glob("*.gpg"):
                decrypted = subprocess.run(["gpg", "--homedir", str(directory / "gnupg"), "--batch", "--decrypt", str(archive)],
                                           capture_output=True)
                listing = subprocess.run(["tar", "-tz"], input=decrypted.stdout, capture_output=True)
                self.copied.append(listing.stdout.decode())
        result, calls, backups = self.run_backup(ALL, ALL, arguments=("--encrypt-to", "{directory}/backup-key.asc"),
                                                 prepare=prepare, inspect=inspect)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(backups), 2)
        self.assertTrue(backups[0].endswith(".tar.gz.gpg") and backups[1].endswith(".tar.gz.gpg.sha256"), backups)
        self.assertIn("config/backend.yaml", self.copied[0])
        self.assertNotIn("data/judge/cache", self.copied[0])
        # A file that isn't a usable public key is refused before anything is stopped
        result, calls, backups = self.run_backup(ALL, ALL, arguments=("--encrypt-to", "{directory}/not-a-key.asc"), prepare=prepare)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not an OpenPGP public key", result.stderr)
        self.assertEqual(calls, [])
        self.assertEqual(backups, [])


if __name__ == "__main__":
    unittest.main()
