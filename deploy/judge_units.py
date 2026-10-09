"""Pure rendering of installer and maintenance judge units (no host changes)."""
from pathlib import Path
import re
import subprocess


def workspace_paths(root, config):
    root = Path(root).resolve()
    work_root = root/'data/judge/work'
    paths = [Path(value) for value in config['taskWorkingDirectories']]
    if not paths or len(set(paths)) != len(paths):
        raise ValueError('Judge workspaces must be nonempty and unique')
    for path in paths:
        if (not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path))
                or path.resolve() != path or not path.is_relative_to(work_root) or path == work_root):
            raise ValueError('Judge workspaces must be canonical children of <root>/data/judge/work')
    return paths


def mount_name(path):
    return subprocess.check_output(['systemd-escape', '--path', '--suffix=mount', str(path)], text=True).strip()


def render_units(root, node, config, remote):
    root, node = Path(root), Path(node)
    paths = workspace_paths(root, config)
    slots = len(paths)
    if type(config['maxConcurrentTasks']) is not int or config['maxConcurrentTasks'] != slots:
        raise ValueError('Judge concurrency must equal its number of task workspaces')
    if type(config['taskConsumingThreads']) is not int or config['taskConsumingThreads'] < 1:
        raise ValueError('Judge task consumers must be a positive integer')
    cpus = sorted({cpu for values in config['cpuAffinity'].values() for cpu in values})
    if not cpus or any(type(cpu) is not int or cpu < 0 for cpu in cpus):
        raise ValueError('Judge CPU affinity must contain nonnegative integer IDs')
    target = 'libreoj-judge.target' if remote else 'libreoj.target'
    units = {}
    for path in paths:
        units[mount_name(path)] = (f'[Unit]\nDescription=LibreOJ judge workspace\nPartOf={target}\n\n[Mount]\n'
                                  f'What=tmpfs\nWhere={path}\nType=tmpfs\n'
                                  f'Options=size=512m,mode=0755,nodev,nosuid\n\n[Install]\nWantedBy={target}\n')
    dependencies = ('After=network-online.target\nWants=network-online.target\n' if remote else
                    'After=libreoj-backend.service\nRequires=libreoj-backend.service\n')
    units['libreoj-judge.service'] = (
        f'[Unit]\nDescription=LibreOJ judge ({slots} execution slots, {config["taskConsumingThreads"]} submissions)\n'
        + dependencies + f'PartOf={target}\nRequiresMountsFor=' + ' '.join(map(str, paths)) + '\n\n[Service]\n'
        f'WorkingDirectory={root}/apps/judge\nEnvironment=NODE_ENV=production\n'
        f'Environment=PATH={node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
        f'Environment=LIBREOJ_JUDGE_CONFIG_FILE={root}/config/judge.yaml\n'
        f'Environment=UV_THREADPOOL_SIZE={max(4, slots*2+2)}\nEnvironment=NODE_OPTIONS=--max-old-space-size=512\n'
        f'Environment=HYHOJ_AI_SAMPLE_INPUTS_DIR={root}/data/ai-sample-inputs\n'
        f'ExecStart={node} -r @swc-node/register index.mjs\nDelegate=cpu memory pids\nDelegateSubgroup=supervisor\n'
        'OOMPolicy=continue\nAllowedCPUs=' + ' '.join(map(str, cpus)) + '\nTasksMax=2048\n'
        'Restart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0022\nLimitCORE=0\n'
        f'StandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy={target}\n')
    if remote:
        units[target] = ('[Unit]\nDescription=LibreOJ remote judge\nWants=libreoj-judge.service\n'
                         'After=network-online.target\n\n[Install]\nWantedBy=multi-user.target\n')
    return units
