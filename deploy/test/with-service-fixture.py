#!/usr/bin/env python3
"""Run a test command against a new private, socket-only MariaDB, as the calling user."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


def socket_for(kind, directory):
    admin = kind == 'admin'
    pattern = r'/tmp/libreoj-admin-test-[A-Za-z0-9_-]+' if admin else r'/var/tmp/llmoj-registration-[A-Za-z0-9_-]+'
    if kind not in ('registration', 'admin', 'migration') or not re.fullmatch(pattern, str(directory)):
        raise ValueError('Expected a private MariaDB test directory')
    if directory.resolve() != directory or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError('Fixture directory must be private and owned by the caller')
    return (directory if admin else directory/'mariadb')/'mysql.sock'


def start_server(socket, datadir, tmpdir):
    tmpdir.mkdir(mode=0o700)
    options = ['--no-defaults', f'--datadir={datadir}', f'--tmpdir={tmpdir}']
    env = {**os.environ, 'TMPDIR': str(tmpdir)}
    subprocess.run(['mariadb-install-db', *options, '--skip-test-db', '--auth-root-authentication-method=normal'],
                   env=env, check=True, stdout=subprocess.DEVNULL)
    return subprocess.Popen(['mariadbd', *options, f'--socket={socket}', '--skip-networking',
                             f'--pid-file={datadir.parent}/pid', f'--log-error={datadir.parent}/error.log',
                             '--innodb-buffer-pool-size=64M'], env=env)


def check_server(socket, datadir, tmpdir, identity):
    settings = identity.rstrip('\n').split('\t')
    if (len(settings) != 4 or settings[:3] != [str(socket), str(datadir)+'/', '1']
            or Path(settings[3]) != tmpdir or not socket.is_socket()):
        raise ValueError('The connected server is not the new socket-only fixture')


def run(kind, command, baseline=None):
    if os.geteuid() == 0:
        raise ValueError('Start the private fixture as the ordinary test account')
    if kind == 'migration' and (not baseline or not baseline.is_file()):
        raise ValueError('Supply the trusted synthetic pre-registration single-database SQL dump')
    admin = kind == 'admin'
    with tempfile.TemporaryDirectory(prefix='libreoj-admin-test-' if admin else 'llmoj-registration-',
                                     dir='/tmp' if admin else '/var/tmp') as tmp:
        directory = Path(tmp)
        socket = socket_for(kind, directory)
        socket.parent.mkdir(exist_ok=True)
        data = directory/'db'
        tmpdir = directory/'tmp'
        client = ['mariadb', '--no-defaults', '--protocol=socket', '--socket='+str(socket), '--user=root', '-BN']
        server = start_server(socket, data, tmpdir)
        try:
            for _ in range(300):
                if server.poll() is not None:
                    raise RuntimeError('Private MariaDB exited during startup')
                if socket.exists():
                    probe = subprocess.run(client+['-e', 'SELECT @@socket, @@datadir, @@skip_networking, @@tmpdir'],
                                           capture_output=True, text=True)
                    if not probe.returncode:
                        check_server(socket, data, tmpdir, probe.stdout)
                        break
                time.sleep(0.1)
            else:
                raise RuntimeError('Private MariaDB did not become ready')
            env = os.environ.copy()
            if kind == 'registration':
                database = 'llmoj_registration_test'
                # The revocation tests observe another transaction through INNODB_LOCK_WAITS and INNODB_TRX.
                subprocess.run(client, input="CREATE DATABASE llmoj_registration_test CHARACTER SET utf8mb4 "
                               "COLLATE utf8mb4_unicode_ci; CREATE USER 'registration'@'localhost'; "
                               "GRANT ALL ON `llmoj\\_registration\\_test`.* TO 'registration'@'localhost'; "
                               "GRANT PROCESS ON *.* TO 'registration'@'localhost';",
                               check=True, text=True)
                config = directory/'registration.json'
                config.write_text(json.dumps({'socketPath': str(socket), 'database': database, 'username': 'registration'}))
                env['LLMOJ_REGISTRATION_TEST_DATABASE'] = str(config)
            elif admin:
                env['LIBREOJ_ADMIN_TEST_SOCKET'] = str(socket)
            else:
                env.update(UPGRADE_TEST_MARIADB_SOCKET=str(socket), UPGRADE_TEST_ALLOW_DATABASE_CREATION='1',
                           UPGRADE_TEST_BASELINE_SQL=str(baseline.resolve()))
            return subprocess.run(command, env=env).returncode
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    def terminate(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, help='Trusted historical synthetic SQL dump for migration acceptance')
    parser.add_argument('kind', choices=['registration', 'admin', 'migration'])
    parser.add_argument('command', nargs='*')
    args = parser.parse_args()
    if args.kind == 'migration' and not args.command:
        args.command = ['node', str(Path(__file__).resolve().with_name('upgrade-migration.integration.mjs'))]
    if not args.command:
        parser.error('Supply the test command after --')
    raise SystemExit(run(args.kind, args.command, args.baseline))
