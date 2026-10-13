#!/usr/bin/env python3
"""Run the Node and Rust backends side by side and compare their answers.

Each backend gets its own fresh config directory and SQLite database: Node
from the repository (`bun server/launcher.ts`, development mode, so TypeORM
synchronizes the schema), Rust standalone in production mode (so it runs the
migrations). Both get the same seed rows and then the same scripted requests.

A case compares the status code and, for 2xx answers, the JSON body with
volatile fields (timestamps, generated keys) blanked. Error bodies are not
compared: the port deliberately does not reproduce Node's error texts.
Scenario cases compare a derived result instead (rows left after a failed
write, ids returned by concurrent creates, a credential in an error, ...).

Cases in KNOWN_GAPS are differences not fixed yet (none at present): they are
reported but do not fail the run, and one that starts agreeing is flagged so
it can be removed from the list.

Usage: backend-rs/scripts/ci-compare.py [--bin target/debug/foreseerr] [--keep]
Needs bun (run from the repository so mise picks the pinned version) and the
repository's node_modules. Standard library only.
"""

import argparse
import concurrent.futures
import gzip
import http.server
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import urllib.error
import urllib.request

_spec = importlib.util.spec_from_file_location(
    'ci_smoke', pathlib.Path(__file__).resolve().parent / 'ci-smoke.py'
)
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

# Open findings from the review that this comparison reproduces. Remove an
# entry once the Rust fix lands; the run says when one starts to agree.
KNOWN_GAPS: set[str] = set()

# Fields whose values differ between any two installs or runs.
VOLATILE = {
    'apiKey', 'clientId', 'vapidPublic',
    'vapidPrivate', 'sessionSecret', 'commitTag', 'version', 'updateAvailable',
    'commitsBehind', 'restartRequired', 'avatar', 'avatarETag', 'avatarVersion',
    'lastSync', 'nextExecutionTime', 'running', 'expiresAt', 'plexClientIdentifier',
}

SEED = [
    'INSERT INTO "user" ("id", "email", "username", "permissions", "userType", "avatar", "plexUsername") '
    "VALUES (1, 'admin@example.test', 'admin', 2, 2, '', 'admin')",
    'INSERT INTO "user" ("id", "email", "username", "permissions", "userType", "avatar", "plexUsername") '
    "VALUES (2, 'user@example.test', 'user', 32, 2, '', 'user')",
    'INSERT INTO "user_settings" ("id", "userId", "locale") VALUES (1, 2, \'en\')',
    'INSERT INTO "media" ("id", "tmdbId", "mediaType", "status") VALUES (1, 1399, \'tv\', 2)',
    'INSERT INTO "media" ("id", "tmdbId", "mediaType", "status") VALUES (2, 603, \'movie\', 5)',
    'INSERT INTO "media_request" ("id", "status", "type", "mediaId", "requestedById", "tvQuotaUnits") '
    "VALUES (1, 1, 'tv', 1, 2, 1)",
    'INSERT INTO "season_request" ("seasonNumber", "status", "requestId") VALUES (1, 1, 1)',
    'INSERT INTO "issue" ("id", "issueType", "status", "mediaId", "createdById") VALUES (1, 1, 1, 1, 2)',
    'INSERT INTO "issue_comment" ("id", "message", "issueId", "userId") VALUES (1, \'broken\', 1, 2)',
]

# (name, method, path, body, headers): compared on status and 2xx body.
REQUESTS = [
    ('public settings', 'GET', '/api/v1/settings/public', None, {}),
    ('current user', 'GET', '/api/v1/auth/me', None, {}),
    ('current user as user 2', 'GET', '/api/v1/auth/me', None, {'X-API-User': '2'}),
    ('no credential', 'GET', '/api/v1/auth/me', None, {'X-API-Key': ''}),
    ('wrong api key', 'GET', '/api/v1/auth/me', None, {'X-API-Key': 'wrong'}),
    ('user list', 'GET', '/api/v1/user?take=10&skip=0&sort=created', None, {}),
    ('one user', 'GET', '/api/v1/user/2', None, {}),
    ('missing user', 'GET', '/api/v1/user/999', None, {}),
    ('user main settings', 'GET', '/api/v1/user/2/settings/main', None, {}),
    ('user permissions', 'GET', '/api/v1/user/2/settings/permissions', None, {}),
    ('user notification settings', 'GET', '/api/v1/user/2/settings/notifications', None, {}),
    ('user quota', 'GET', '/api/v1/user/2/quota', None, {}),
    ('request count', 'GET', '/api/v1/request/count', None, {}),
    ('invalid query parameter', 'GET', '/api/v1/request?take=abc', None, {}),
    ('missing request', 'GET', '/api/v1/request/999', None, {}),
    ('issue count', 'GET', '/api/v1/issue/count', None, {}),
    ('missing issue', 'GET', '/api/v1/issue/999', None, {}),
    ('blocklist', 'GET', '/api/v1/blocklist?take=10', None, {}),
    ('radarr servers', 'GET', '/api/v1/settings/radarr', None, {}),
    ('sonarr servers', 'GET', '/api/v1/settings/sonarr', None, {}),
    ('email notification settings', 'GET', '/api/v1/settings/notifications/email', None, {}),
    ('webhook notification settings', 'GET', '/api/v1/settings/notifications/webhook', None, {}),
    ('settings as a regular user', 'GET', '/api/v1/settings/main', None, {'X-API-User': '2'}),
    ('undocumented method', 'PATCH', '/api/v1/settings/public', None, {}),
    ('unknown api route', 'GET', '/api/v1/does-not-exist', None, {}),
    ('update user main settings', 'POST', '/api/v1/user/2/settings/main',
     {'username': 'renamed', 'locale': 'fr'}, {}),
    ('user main settings after the update', 'GET', '/api/v1/user/2/settings/main', None, {}),
    ('invalid json body', 'POST', '/api/v1/user/2/settings/main', '{not json', {}),
    ('comment on an issue', 'POST', '/api/v1/issue/1/comment', {'message': 'still broken'}, {}),
    ('delete a missing issue comment', 'DELETE', '/api/v1/issueComment/999', None, {}),
]


def log(message):
    print(f'[ci-compare] {message}', flush=True)


def call(port, method, path, body=None, headers=None, timeout=60):
    h = {'X-API-Key': smoke.API_KEY, 'Accept': 'application/json'}
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    h.update(headers or {})
    h = {k: v for k, v in h.items() if v != ''}
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data, h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


TIMESTAMP = re.compile(r'^\d{4}-\d\d-\d\d[T ]\d\d:\d\d')


def normalize(value):
    if isinstance(value, dict):
        return {
            k: '<volatile>' if k in VOLATILE else normalize(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [normalize(v) for v in value]
    # A timestamp keeps its format but not its value: the seed rows get the
    # time each backend's database stored them at.
    if isinstance(value, str) and TIMESTAMP.match(value):
        return re.sub(r'\d', '9', value)
    return value


def differences(a, b, path='$'):
    """The JSON paths where `a` and `b` differ, with both values."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out += differences(a.get(k, '<absent>'), b.get(k, '<absent>'), f'{path}.{k}')
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += differences(x, y, f'{path}[{i}]')
        return out
    if a == b:
        return []
    return [f'{path}: node {json.dumps(a)[:300]} / rust {json.dumps(b)[:300]}']


def comparable(status, body):
    if not 200 <= status < 300:
        return {'status': status}
    try:
        return {'status': status, 'body': normalize(json.loads(body))}
    except ValueError:
        return {'status': status, 'text': body}


class FakeArr(http.server.BaseHTTPRequestHandler):
    """Answers a Sonarr/Radarr settings test, optionally gzip-encoded."""

    compressed = False

    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802 (http.server's name)
        value = {'version': '4.0.0', 'urlBase': ''} if '/system/status' in self.path else []
        body = json.dumps(value).encode()
        if self.compressed:
            body = gzip.compress(body)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if self.compressed:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        self.wfile.write(body)


def scenarios(server, db_path):
    """The review's failure and concurrency cases, as comparable results."""
    port = server.port
    out = {}

    # A request edit that fails on its parent row must not leave the season
    # it inserted first.
    db = sqlite3.connect(db_path, timeout=10)
    db.execute(
        'CREATE TRIGGER "ci_fail_parent_update" BEFORE UPDATE ON "media_request" '
        "BEGIN SELECT RAISE(ABORT, 'ci injected parent failure'); END"
    )
    db.commit()
    status, _ = call(port, 'PUT', '/api/v1/request/1', {'mediaType': 'tv', 'seasons': [1, 2]})
    seasons = db.execute(
        'SELECT "seasonNumber" FROM "season_request" WHERE "requestId" = 1 ORDER BY "seasonNumber"'
    ).fetchall()
    db.execute('DROP TRIGGER "ci_fail_parent_update"')
    db.commit()
    db.close()
    out['request edit rolls back after a failed parent update'] = {
        'status': status, 'seasons': [s[0] for s in seasons],
    }

    # Concurrent creates each get their own row and id.
    n = 10
    barrier = threading.Barrier(n)

    def create(i):
        barrier.wait()
        return call(port, 'POST', '/api/v1/settings/radarr', {
            'name': f'ci-radarr-{i}', 'hostname': '127.0.0.1', 'port': 9,
            'apiKey': 'ci-secret-service-key', 'useSsl': False, 'activeProfileId': 1,
            'activeProfileName': 'any', 'activeDirectory': '/tmp', 'is4k': False,
            'minimumAvailability': 'released', 'isDefault': False,
        })

    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
        created = list(pool.map(create, range(n)))
    ids = sorted(json.loads(b).get('id') for s, b in created if s == 201)
    listed = json.loads(call(port, 'GET', '/api/v1/settings/radarr')[1])
    out['concurrent radarr server creation'] = {
        'statuses': sorted(s for s, _ in created), 'ids': ids, 'stored': len(listed),
    }

    # An upstream error message must not carry the service's API key.
    status, body = call(port, 'GET', '/api/v1/service/radarr/0', headers={'X-API-User': '2'})
    out['service error does not leak the api key'] = {
        'status': status, 'leaks key': 'ci-secret-service-key' in body,
    }

    # A gzip-encoded upstream answer decodes like a plain one.
    fake = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeArr)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    body = {'hostname': '127.0.0.1', 'port': fake.server_port, 'apiKey': 'x', 'useSsl': False}
    try:
        FakeArr.compressed = False
        plain = comparable(*call(port, 'POST', '/api/v1/settings/sonarr/test', body))
        FakeArr.compressed = True
        encoded = comparable(*call(port, 'POST', '/api/v1/settings/sonarr/test', body))
    finally:
        FakeArr.compressed = False
        fake.shutdown()
    out['gzip-encoded upstream answer'] = {'plain': plain, 'gzip': encoded}
    return out


def run(server):
    """Start, seed, run every case, stop. Returns {case: comparable}."""
    server.start()
    db_path = server.root / 'config/db/db.sqlite3'
    db = sqlite3.connect(db_path, timeout=10)
    for statement in SEED:
        db.execute(statement)
    db.commit()
    db.close()
    results = {}
    for name, method, path, body, headers in REQUESTS:
        results[name] = comparable(*call(server.port, method, path, body, headers))
    results.update(scenarios(server, db_path))
    server.stop()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    target = pathlib.Path(os.environ.get('CARGO_TARGET_DIR', smoke.CRATE / 'target'))
    parser.add_argument('--bin', type=pathlib.Path, default=target / 'debug/foreseerr')
    parser.add_argument('--keep', action='store_true', help='keep the scratch directory')
    args = parser.parse_args()
    if os.environ.get('DB_TYPE') == 'postgres':
        parser.error('the comparison runs on SQLite; unset DB_TYPE')

    root = pathlib.Path(tempfile.mkdtemp(prefix='foreseerr-ci-compare-'))
    node = smoke.Server(
        None, root / 'node', command=['bun', 'server/launcher.ts'],
        env={'NODE_ENV': 'development', 'FORESEERR_STANDALONE': ''},
    )
    rust = smoke.Server(args.bin.resolve(), root / 'rust')
    try:
        log(f'node on {node.port}, rust on {rust.port}, in {root}')
        # One at a time: Node's TypeScript startup is CPU-heavy, and the
        # concurrency cases should not race the other backend.
        want = run(node)
        got = run(rust)
    finally:
        node.stop()
        rust.stop()

    for side, results in (('node', want), ('rust', got)):
        (root / f'{side}.json').write_text(json.dumps(results, indent=2, sort_keys=True))
    failures, gaps, fixed = [], [], []
    for name, expected in want.items():
        actual = got.get(name)
        same = actual == expected
        if name in KNOWN_GAPS:
            (fixed if same else gaps).append(name)
            if same:
                continue
        elif same:
            log(f'ok       {name}')
            continue
        line = name + ''.join(f'\n    {d}' for d in differences(expected, actual)[:20])
        if name in KNOWN_GAPS:
            log(f'known    {line}')
        else:
            log(f'DIFFERS  {line}')
            failures.append(name)
    for name in fixed:
        log(f'FIXED    {name}: agrees now; remove it from KNOWN_GAPS')
        if os.environ.get('GITHUB_ACTIONS'):
            print(f'::warning title=ci-compare::"{name}" agrees now; remove it from KNOWN_GAPS')
    log(
        f'{len(want) - len(failures) - len(gaps)}/{len(want)} agree, '
        f'{len(gaps)} known gaps, {len(failures)} unexpected differences'
    )
    if args.keep:
        log(f'kept {root}')
    else:
        shutil.rmtree(root, ignore_errors=True)
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    main()
