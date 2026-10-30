#!/usr/bin/env python3
"""Startup and migrations smoke test of the Rust backend, on SQLite or Postgres.

Starts the binary in production mode (so it runs the migrations) against a
fresh, private config directory and checks that:

  * it becomes ready, and the migrations table holds exactly the migrations
    this build ships (src/dbmigrate/{sqlite,postgres}.rs), in order;
  * a set of authenticated reads that query most tables answer 200;
  * a second start on the migrated database is ready again and applies
    nothing new.

The database comes from the environment, as for the server: `DB_TYPE=postgres`
with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME` (an empty database;
`psql` must be on PATH), otherwise `<config>/db/db.sqlite3`.

With `--mapping-db OUT` (SQLite only) it also downloads both mapping datasets
through the API and copies the resulting database to OUT, the scratch database
`FORESEERR_MAPPING_TEST_DB` names for src/mappinglayer/dbtests.rs.

Usage: backend-rs/scripts/ci-smoke.py [--bin target/debug/foreseerr] [--mapping-db OUT]
Standard library only.
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

CRATE = pathlib.Path(__file__).resolve().parent.parent
REPO = CRATE.parent
API_KEY = 'ci-smoke-api-key'
# Reads that touch the user, settings, request, media, issue, blocklist,
# watchlist and job tables. Each must answer 200 on a fresh database.
READS = [
    '/api/v1/status',
    '/api/v1/settings/public',
    '/api/v1/auth/me',
    '/api/v1/user',
    '/api/v1/user/1',
    '/api/v1/user/1/settings/main',
    '/api/v1/user/1/quota',
    '/api/v1/user/1/requests',
    '/api/v1/settings/main',
    '/api/v1/settings/jobs',
    '/api/v1/settings/mapping/status',
    '/api/v1/request',
    '/api/v1/request/count',
    '/api/v1/media',
    '/api/v1/issue',
    '/api/v1/issue/count',
    '/api/v1/blocklist',
]


def log(message):
    print(f'[ci-smoke] {message}', flush=True)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def request(port, method, path, timeout=30):
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}{path}',
        method=method,
        headers={'X-API-Key': API_KEY, 'Accept': 'application/json'},
        data=b'' if method == 'POST' else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def shipped_migrations(dialect):
    """The migration names src/dbmigrate/<dialect>.rs lists, in order."""
    text = (CRATE / 'src/dbmigrate' / f'{dialect}.rs').read_text()
    # SQLite's file ends with SEERR_MIGRATION, which only an Overseerr
    # database records.
    text = text.split('pub(super) const SEERR_MIGRATION', 1)[0]
    names = re.findall(r'^\s*name: "([^"]+)",$', text, re.M)
    if not names:
        raise SystemExit(f'no migrations found in {dialect}.rs')
    return names


class Database:
    def __init__(self, config):
        self.postgres = os.environ.get('DB_TYPE') == 'postgres'
        self.path = config / 'db/db.sqlite3'

    def query(self, sql):
        if self.postgres:
            env = dict(os.environ, PGPASSWORD=os.environ.get('DB_PASS', ''))
            out = subprocess.run(
                [
                    'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                    '-h', os.environ.get('DB_HOST', '127.0.0.1'),
                    '-p', os.environ.get('DB_PORT', '5432'),
                    '-U', os.environ.get('DB_USER', 'postgres'),
                    '-d', os.environ.get('DB_NAME', 'seerr'),
                    '-F', '\t', '-c', sql,
                ],
                env=env, capture_output=True, text=True, check=True,
            ).stdout
            return [line.split('\t') for line in out.splitlines() if line]
        with sqlite3.connect(self.path, timeout=10) as db:
            rows = db.execute(sql).fetchall()
        return [[str(v) for v in row] for row in rows]

    def execute(self, sql):
        if self.postgres:
            self.query(sql)
            return
        with sqlite3.connect(self.path, timeout=10) as db:
            db.execute(sql)


class Server:
    """One backend process on a private config directory under `root`, in
    production mode; `env` overrides the environment.
    """

    def __init__(self, binary, root, env=None):
        self.binary = binary
        self.root = root
        self.command = [str(binary)]
        self.extra_env = env or {}
        self.port = free_port()
        self.proc = None
        self.log_path = root / 'server.log'
        for name in ('config', 'cache', 'logs'):
            (root / name).mkdir(parents=True, exist_ok=True)

    def start(self):
        env = {
            k: v for k, v in os.environ.items()
            if not k.startswith(('FORESEERR_', 'NODE_EXTRA_CA_CERTS', 'SHADOW_CA_FILE'))
        }
        env.update({
            'CONFIG_DIRECTORY': str(self.root / 'config'),
            'CACHE_DIRECTORY': str(self.root / 'cache'),
            'LOG_DIRECTORY': str(self.root / 'logs'),
            'FORESEERR_APP_ROOT': str(REPO),
            'NODE_ENV': 'production',
            'HOST': '127.0.0.1',
            'PORT': str(self.port),
            'API_KEY': API_KEY,
            'RUST_LOG': env.get('RUST_LOG', 'warn'),
        })
        env.update(self.extra_env)
        log_file = open(self.log_path, 'a')
        self.proc = subprocess.Popen(
            self.command, cwd=REPO, env=env, stdout=log_file, stderr=log_file
        )
        log_file.close()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                self.fail(f'exited with {self.proc.returncode} during startup')
            try:
                if request(self.port, 'GET', '/api/v1/settings/public', timeout=5)[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.2)
        self.fail('not ready after 120 s')

    def stop(self):
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            self.fail('did not stop within 20 s of SIGTERM')

    def fail(self, why):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        sys.stderr.write(self.log_path.read_text() if self.log_path.exists() else '')
        raise SystemExit(f'[ci-smoke] the server ({self.command[0]}) {why}')


def check_migrations(db, dialect):
    want = shipped_migrations(dialect)
    got = [row[0] for row in db.query('SELECT "name" FROM "migrations" ORDER BY "id"')]
    if got != want:
        missing = [n for n in want if n not in got]
        extra = [n for n in got if n not in want]
        raise SystemExit(
            f'[ci-smoke] migrations differ: {len(got)} applied, {len(want)} shipped; '
            f'missing {missing}, unexpected {extra}'
        )
    log(f'{len(got)} {dialect} migrations applied, in order')


def check_reads(server):
    failed = []
    for path in READS:
        status, body = request(server.port, 'GET', path)
        if status != 200:
            failed.append(f'GET {path}: {status} {body[:300]}')
            continue
        try:
            json.loads(body)
        except ValueError:
            failed.append(f'GET {path}: not JSON: {body[:300]}')
    if failed:
        server.fail('answered reads wrongly:\n  ' + '\n  '.join(failed))
    log(f'{len(READS)} authenticated reads answered 200')


MAPPING_DATASETS = ('anibridge', 'fribb')


def build_mapping_db(server, out):
    # A forced refresh answers once its download is written. The startup's
    # own first download may already be running; the refresh waits for it,
    # and then finds the copy current (notModified).
    for key in MAPPING_DATASETS:
        status, body = request(
            server.port, 'POST', f'/api/v1/settings/mapping/datasets/{key}/refresh',
            timeout=600,
        )
        result = json.loads(body) if status == 200 else {}
        if status != 200 or result.get('status') not in ('downloaded', 'notModified'):
            server.fail(f'refreshing the {key} mapping dataset answered {status} {body[:500]}')
        log(f'mapping dataset {key}: {result.get("status")}, {result.get("edges")} edges')
    server.stop()
    db = sqlite3.connect(server.root / 'config/db/db.sqlite3')
    loaded = dict(db.execute(
        'SELECT "key", "edgeCount" FROM "mapping_dataset" WHERE "generation" > 0'
    ).fetchall())
    if any(not loaded.get(key) for key in MAPPING_DATASETS):
        raise SystemExit(f'[ci-smoke] mapping datasets not loaded: {loaded}')
    target = sqlite3.connect(out)
    with target:
        db.backup(target)
    target.close()
    db.close()
    log(f'mapping test database written to {out}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    target = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', CRATE / 'target'))
    parser.add_argument('--bin', type=pathlib.Path, default=target / 'debug/foreseerr')
    parser.add_argument('--mapping-db', type=pathlib.Path)
    parser.add_argument('--keep', action='store_true', help='keep the scratch directory')
    args = parser.parse_args()

    dialect = 'postgres' if os.environ.get('DB_TYPE') == 'postgres' else 'sqlite'
    if args.mapping_db and dialect != 'sqlite':
        parser.error('--mapping-db needs SQLite')
    root = pathlib.Path(tempfile.mkdtemp(prefix='foreseerr-ci-smoke-'))
    db = Database(root / 'config')
    server = Server(args.bin.resolve(), root)
    try:
        log(f'starting {args.bin} on {dialect} (port {server.port}, {root})')
        server.start()
        check_migrations(db, dialect)
        # API keys act as user 1, which a fresh install does not have yet.
        db.execute(
            'INSERT INTO "user" ("id", "email", "permissions", "userType", "avatar") '
            "VALUES (1, 'admin@example.test', 2, 2, '')"
        )
        check_reads(server)
        server.stop()

        log('restarting on the migrated database')
        server.start()
        check_migrations(db, dialect)
        check_reads(server)
        if args.mapping_db:
            build_mapping_db(server, args.mapping_db.resolve())
        server.stop()
        log('ok')
    finally:
        server.stop()
        if args.keep:
            log(f'kept {root}')
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    main()
