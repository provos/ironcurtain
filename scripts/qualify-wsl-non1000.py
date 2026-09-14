#!/usr/bin/env python3
"""Run existing WSL smoke drivers under a real, temporary host process identity.

Build the checkout as its normal owner first. Then, for example:
  sudo python3 scripts/qualify-wsl-non1000.py --uid 1101 --gid 1102 offline

No account is created. Only /tmp test directories are assigned to the test UID;
Docker socket access uses its existing group without modifying the socket.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uid', type=int, default=1101)
    parser.add_argument('--gid', type=int, default=1102)
    parser.add_argument('--node', type=Path, help='absolute Node binary matching installed native dependencies')
    gates = {'offline', 'images', 'packages', 'pty', 'workflow', 'recovery', 'disabled'}
    parser.add_argument('gates', nargs='*', metavar='GATE', help=', '.join(sorted(gates)))
    args = parser.parse_args()
    args.gates = args.gates or ['offline']
    if any(gate not in gates for gate in args.gates):
        parser.error('unknown gate; choose ' + ', '.join(sorted(gates)))
    if os.getuid() != 0 or os.geteuid() != 0:
        parser.error('requires sudo to set a real WSL host UID/GID; no host account is created')
    if 'microsoft' not in os.uname().release.lower() or 'wsl2' not in os.uname().release.lower():
        parser.error('this evidence harness requires WSL2')
    if Path('/proc/self/uid_map').read_text().split() != ['0', '0', '4294967295']:
        parser.error('a mapped user namespace does not establish real WSL host identity evidence')
    if not 1001 <= args.uid < 65534 or not 1 <= args.gid < 65534:
        parser.error('test UID must be 1001..65533 and GID 1..65533')
    try:
        pwd.getpwuid(args.uid)
    except KeyError:
        pass
    else:
        parser.error('test UID already belongs to a host account; choose an unused UID')

    checkout = Path(__file__).resolve().parent.parent
    node = str(args.node) if args.node is not None else shutil.which('node')
    if node is not None and (not Path(node).is_absolute() or not os.access(node, os.X_OK)):
        parser.error('--node must name an executable absolute path')
    if node is None or not (checkout / 'dist/cli.js').is_file():
        parser.error('build the checkout as its normal owner first, with Node available on PATH')
    socket = Path('/var/run/docker.sock')
    socket_stat = socket.stat()
    if not stat.S_ISSOCK(socket_stat.st_mode) or not socket_stat.st_mode & stat.S_IWGRP or socket_stat.st_gid == 0:
        parser.error('local Docker socket must already permit access through a non-root group')

    root = Path(tempfile.mkdtemp(prefix='ic-n1-', dir='/tmp'))
    os.chmod(root, 0o700)
    os.chown(root, args.uid, args.gid)
    for name in ('home', 'docker', 'cache'):
        directory = root / name
        directory.mkdir(mode=0o700)
        os.chown(directory, args.uid, args.gid)
    environment = {
        'PATH': str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin',
        'HOME': str(root / 'home'),
        'DOCKER_CONFIG': str(root / 'docker'),
        'DOCKER_HOST': 'unix:///var/run/docker.sock',
        'XDG_CACHE_HOME': str(root / 'cache'),
        'TMPDIR': '/tmp',
        'LANG': 'C.UTF-8',
    }
    groups = sorted({args.gid, socket_stat.st_gid})

    def drop_identity():
        os.setgroups(groups)
        os.setgid(args.gid)
        os.setuid(args.uid)
        os.umask(0o077)
        if os.getuid() != args.uid or os.geteuid() != args.uid or os.getgid() != args.gid:
            raise RuntimeError('host identity transition failed')

    evidence = {'uid': args.uid, 'gid': args.gid, 'groups': groups,
                'checkout': str(checkout), 'gates': args.gates, 'results': []}
    print(f'Real WSL coordinator UID={args.uid} GID={args.gid}; diagnostics: {root}', flush=True)
    try:
        for gate in args.gates:
            script = 'smoke-nested-apple-workflow.ts' if gate == 'workflow' else 'smoke-nested-apple.ts'
            command = [node, str(checkout / 'node_modules/tsx/dist/cli.mjs'),
                       str(checkout / 'scripts' / script), '--environment', 'wsl-desktop']
            if gate != 'workflow':
                command.append(f'--docker-desktop-{gate}')
            log = root / f'{gate}.log'
            with log.open('wb') as output:
                os.fchmod(output.fileno(), 0o600)
                os.fchown(output.fileno(), args.uid, args.gid)
                result = subprocess.run(command, cwd=checkout, env=environment,
                                        preexec_fn=drop_identity, stdout=output, stderr=subprocess.STDOUT)
            evidence['results'].append({'gate': gate, 'exitCode': result.returncode, 'log': str(log)})
            print(f'{gate}: exit {result.returncode}; {log}', flush=True)
            if result.returncode != 0:
                return result.returncode
        return 0
    finally:
        path = root / 'identity-evidence.json'
        path.write_text(json.dumps(evidence, indent=2) + '\n')
        os.chmod(path, 0o600)
        os.chown(path, args.uid, args.gid)


if __name__ == '__main__':
    raise SystemExit(main())
