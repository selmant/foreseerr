#!/usr/bin/env python3
"""Exercise standalone startup, auth failure cases and packaged browser assets.

The app root contains only seerr-api.yml and the built frontend, with no
node_modules. Uses SQLite by default, or the same dedicated
Postgres database as ci-smoke.py through DB_*; never run against a real install.

Usage: python3 backend-rs/scripts/ci-standalone.py --bin backend-rs/target/debug/foreseerr
Add --require-web after bun run build:web to require frontend/API-doc coverage.
Standard library only.
"""

import argparse
import concurrent.futures
import importlib.util
import json
import pathlib
import shutil
import tempfile
import urllib.error
import urllib.request
import uuid

SPEC = importlib.util.spec_from_file_location(
    'ci_smoke', pathlib.Path(__file__).with_name('ci-smoke.py')
)
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f'[ci-standalone] ok {message}', flush=True)


def call(server, method, path, body=None, key=None, headers=None):
    supplied = dict(headers or {})
    if key is not None:
        supplied['X-API-Key'] = key
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        supplied['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        f'http://127.0.0.1:{server.port}{path}', data, supplied, method=method
    )
    try:
        response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as err:
        response = err
    with response:
        return response.code, response.headers, response.read()


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def credentials_survive_file_failures(server, key):
    path = server.root / 'config/settings.json'
    original = path.read_bytes()
    try:
        for replacement in (None, b'null', b'{broken'):
            if replacement is None:
                path.unlink()
            else:
                path.write_bytes(replacement)
            check(
                call(server, 'GET', '/api/v1/auth/me', key=key)[0] == 200,
                f'last valid settings survive {replacement!r}',
            )
            check(
                call(server, 'GET', '/api/v1/auth/me', key='',
                     headers={'Cookie': 'connect.sid=unsigned'})[0] == 403,
                f'empty API key cannot authenticate after {replacement!r}',
            )
    finally:
        path.write_bytes(original)


def password_resets(server, db):
    guid = str(uuid.uuid4())
    email = f'standalone-regression-{guid}@example.test'
    user = db.query(
        'INSERT INTO "user" ("id", "email", "avatar", "password", "resetPasswordGuid", '
        '"recoveryLinkExpirationDate") VALUES '
        f'(9000001, {quote(email)}, \'\', \'original\', {quote(guid)}, '
        "'2099-01-01 00:00:00.000') RETURNING \"id\""
    )[0][0]
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            statuses = list(pool.map(
                lambda i: call(server, 'POST', f'/api/v1/auth/reset-password/{guid}',
                               {'password': f'PasswordForRegression{i}!'})[0],
                range(6),
            ))
        check(statuses.count(200) == 1 and statuses.count(500) == 5,
              f'only one concurrent reset consumes a link: {statuses}')
        check(call(server, 'POST', f'/api/v1/auth/reset-password/{guid}',
                   {'password': 'PasswordForReplay!'})[0] == 500,
              'a consumed reset link cannot be replayed')
        check(db.query(
            'SELECT COUNT(*) FROM "user" WHERE '
            f'"id" = {int(user)} AND "resetPasswordGuid" IS NULL '
            'AND "recoveryLinkExpirationDate" IS NULL'
        )[0][0] == '1', 'the reset clears both recovery fields')
    finally:
        db.execute(f'DELETE FROM "user" WHERE "id" = {int(user)}')


def packaged_assets(server, app_root, web):
    check(not (app_root / 'node_modules').exists(), 'app root has no node_modules')
    if not web:
        print('[ci-standalone] browser asset checks skipped (run build:web)', flush=True)
        return
    for name, mime in [
        ('/index.html', 'text/html'),
        ('/api-docs/swagger-ui.css', 'text/css'),
        ('/api-docs/swagger-ui-bundle.js', 'text/javascript'),
        ('/api-docs/swagger-ui-standalone-preset.js', 'text/javascript'),
        ('/api-docs/favicon-32x32.png', 'image/png'),
    ]:
        status, headers, data = call(server, 'GET', name)
        expected = (app_root / 'dist/public' / name.lstrip('/')).read_bytes()
        check(status == 200 and headers.get_content_type() == mime and data == expected,
              f'packaged {name} is served')
    status, headers, data = call(server, 'GET', '/api-docs/')
    check(status == 200 and b'Swagger UI' in data, 'API docs HTML loads')
    status, headers, data = call(server, 'GET', '/api-docs/swagger-ui-init.js')
    check(status == 200 and b'"swaggerDoc":' in data and b'"/status":' in data
          and b'Foreseerr API' in data,
          'API docs include the local spec')


class ExpectedFailure(smoke.Server):
    def fail(self, why):
        raise RuntimeError(why)


def reject_future_schema(binary, root, db, app_root):
    rows = db.query('SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id"')
    last_id, timestamp, name = rows[-1]
    marker = 'UnknownFutureStandaloneRegression9999999999999'
    db.execute(f'DELETE FROM "migrations" WHERE "id" = {int(last_id)}')
    db.execute('INSERT INTO "migrations" ("timestamp", "name") VALUES '
               f'(9999999999999, {quote(marker)})')
    before = db.query('SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id"')
    server = ExpectedFailure(binary, root, env={'FORESEERR_APP_ROOT': str(app_root)})
    try:
        try:
            server.start()
            raise AssertionError('a future schema started')
        except RuntimeError:
            check(server.proc.poll() == 1 and marker in server.log_path.read_text(),
                  'future database is refused with the schema error')
        check(db.query('SELECT "id", "timestamp", "name" FROM "migrations" ORDER BY "id"')
              == before, 'no pending migration runs before the schema guard')
    finally:
        server.stop()
        db.execute(f'DELETE FROM "migrations" WHERE "name" IN ({quote(marker)}, {quote(name)})')
        db.execute('INSERT INTO "migrations" ("id", "timestamp", "name") VALUES '
                   f'({int(last_id)}, {int(timestamp)}, {quote(name)})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin', type=pathlib.Path,
                        default=smoke.CRATE / 'target/debug/foreseerr')
    parser.add_argument('--require-web', action='store_true')
    args = parser.parse_args()
    binary = args.bin.resolve()
    with tempfile.TemporaryDirectory(prefix='foreseerr-standalone-regression-') as temp:
        root = pathlib.Path(temp)
        app_root = root / 'app'
        app_root.mkdir()
        shutil.copyfile(smoke.REPO / 'seerr-api.yml', app_root / 'seerr-api.yml')
        public = smoke.REPO / 'dist/public'
        web = (public / 'api-docs/swagger-ui-bundle.js').is_file()
        if args.require_web and not web:
            raise AssertionError('run bun run build:web first')
        if web:
            shutil.copytree(public, app_root / 'dist/public')
        server = smoke.Server(binary, root / 'server', env={
            'FORESEERR_APP_ROOT': str(app_root),
            'API_KEY': '',
        })
        db = smoke.Database(server.root / 'config')
        try:
            server.start()
            check(True, 'starts from an app root without node_modules')
            if db.query('SELECT COUNT(*) FROM "user" WHERE "id" = 1')[0][0] == '0':
                db.execute('INSERT INTO "user" ("id", "email", "avatar", "permissions") '
                           "VALUES (1, 'standalone-admin@example.test', '', 2)")
            key = json.loads((server.root / 'config/settings.json').read_text())['main']['apiKey']
            check(call(server, 'GET', '/api/v1/auth/me', key=key)[0] == 200,
                  'generated API key authenticates')
            check(call(server, 'GET', '/api/v1/auth/me', key=key,
                       headers={'X-API-User': ''})[0] == 200,
                  'an empty optional API user header keeps the default admin')
            credentials_survive_file_failures(server, key)
            password_resets(server, db)
            packaged_assets(server, app_root, web)
        finally:
            server.stop()
        restarted = smoke.Server(binary, server.root, env={
            'FORESEERR_APP_ROOT': str(app_root),
        })
        try:
            restarted.start()
            check(True, 'starts again on the same config directory')
        finally:
            restarted.stop()
        reject_future_schema(binary, server.root, db, app_root)
    print('[ci-standalone] all checks passed', flush=True)


if __name__ == '__main__':
    main()
