// Differential corpus for the Rust OpenAPI request validator.
//
// Mounts express + the real express-openapi-validator with seerr-api.yml the
// way server/index.ts does (cookie-parser, express.json, urlencoded, the
// validator on /api, the same error handler), sends it a generated corpus of
// raw HTTP requests covering every operation, and writes one JSON line per
// request with Node's answer. Requests the validator lets through reach an
// echo handler that answers 299 with what the route handlers would read
// (req.query, the path params, req.body), so coercion and defaults are
// compared too. `cargo test --locked openapi_differential -- --ignored`
// (with OPENAPI_CORPUS pointing at the file) replays it against Rust.
//
// Run it with the backend's runtime, from the repository (mise picks the
// pinned bun there):
//   cd <repo> && bun backend-rs/scripts/openapi-diff.js [out.jsonl] [port]
// Without out.jsonl the corpus goes to a fresh private directory under the
// OS temp dir (printed at the end).
// NODE_MODULES and OPENAPI_SPEC override where the libraries and the spec
// are read from.
import fs from 'fs';
import { createRequire } from 'module';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const NM = process.env.NODE_MODULES || path.join(repo, 'node_modules');
const SPEC = process.env.OPENAPI_SPEC || path.join(repo, 'seerr-api.yml');
const OUT_ARG = process.argv[2];
const PORT = Number(process.argv[3] || 6801);

// The harness libraries come from the repo's node_modules (or NODE_MODULES).
const load = createRequire(import.meta.url);
const req = (m) => load(path.join(NM, m));
const express = req('express');
const cookieParser = req('cookie-parser');
const OpenApiValidator = req('express-openapi-validator');
const yaml = req('js-yaml');

const doc = yaml.load(fs.readFileSync(SPEC, 'utf8'), {
  schema: yaml.JSON_SCHEMA,
});

// ---------------------------------------------------------------- server
function app() {
  const server = express();
  server.use(cookieParser());
  server.use(express.json());
  server.use(express.urlencoded({ extended: true }));
  server.use(
    '/api',
    OpenApiValidator.middleware({ apiSpec: SPEC, validateRequests: true })
  );
  server.use('/api', (r, res) => {
    res.status(299).json({
      matched: !!r.openapi,
      query: r.query,
      params: r.openapi ? r.openapi.pathParams : null,
      body: r.body === undefined ? '<undefined>' : r.body,
    });
  });
  // Outside /api nothing validates; answer like the echo's "not matched".
  server.use((_r, res) => res.status(299).json({ matched: false }));
  // eslint-disable-next-line no-unused-vars
  server.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    res
      .status(err.status || 500)
      .json({ message: err.message, errors: err.errors });
  });
  return server;
}

// ---------------------------------------------------------------- schema helpers
const deref = (s) => {
  let guard = 0;
  while (s && s.$ref && guard++ < 20) {
    s = s.$ref
      .split('/')
      .slice(1)
      .reduce((o, k) => o[k], doc);
  }
  return s || {};
};
const param = (p) => deref(p);

function sample(schema, full, depth = 0) {
  const s = deref(schema);
  if (depth > 6) return null;
  if (s.enum) return s.enum[0];
  if (s.oneOf) return sample(s.oneOf[0], full, depth + 1);
  if (s.anyOf) return sample(s.anyOf[0], full, depth + 1);
  if (s.allOf) return sample(s.allOf[0], full, depth + 1);
  switch (s.type) {
    case 'string':
      if (s.format === 'date') return '2024-01-02';
      if (s.format === 'date-time') return '2024-01-02T03:04:05Z';
      if (s.pattern === '^[a-f0-9]{64}$') return 'a'.repeat(64);
      if (s.pattern) return 'A'.repeat(43);
      return 'abc';
    case 'number':
    case 'integer':
      return s.minimum !== undefined ? Math.max(s.minimum, 1) : 1;
    case 'boolean':
      return true;
    case 'array':
      return s.items ? [sample(s.items, full, depth + 1)] : [];
    case 'object':
    default: {
      if (!s.properties && s.type !== 'object') return 'abc';
      const out = {};
      const required = new Set(s.required || []);
      for (const [k, v] of Object.entries(s.properties || {})) {
        if (deref(v).readOnly) continue;
        if (full || required.has(k)) out[k] = sample(v, full, depth + 1);
      }
      return out;
    }
  }
}

function wrong(schema) {
  const s = deref(schema);
  if (s.enum) return typeof s.enum[0] === 'string' ? 'zzz-not-in-enum' : 987654;
  switch (s.type) {
    case 'string':
      return 12345;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'true';
    case 'array':
      return { not: 'an array' };
    case 'object':
      return ['not', 'an', 'object'];
    default:
      return 42;
  }
}

const enc = (v) => encodeURIComponent(String(v));

// ---------------------------------------------------------------- corpus
const COOKIE = ['Cookie', 'connect.sid=s%3Aabc.def'];
const corpus = [];
function add(method, target, headers = [COOKIE], body = null, note = '') {
  corpus.push({ method, target, headers, body, note });
}
const JSON_CT = ['Content-Type', 'application/json'];
function addJson(method, target, value, extra = [], note = '') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  add(method, target, [COOKIE, JSON_CT, ...extra], text, note);
}

const methods = ['get', 'post', 'put', 'delete', 'patch'];
for (const [p, item] of Object.entries(doc.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!methods.includes(m)) continue;
    const M = m.toUpperCase();
    const params = [...(op.parameters || []), ...(item.parameters || [])].map(
      param
    );
    const pathParams = params.filter((x) => x.in === 'path');
    const query = params.filter((x) => x.in === 'query');
    const fillPath = (over = {}) =>
      '/api/v1' +
      p.replace(/\{([^}]+)\}/g, (_, name) => {
        if (name in over) return over[name];
        const pp = pathParams.find((x) => x.name === name);
        return enc(pp ? sample(pp.schema, false) : 'x');
      });
    const qs = (pairs) => (pairs.length ? '?' + pairs.join('&') : '');
    const requiredQuery = query
      .filter((x) => x.required)
      .map((x) => `${x.name}=${enc(sample(x.schema, false))}`);
    const allQuery = query.map(
      (x) => `${x.name}=${enc(sample(x.schema, true))}`
    );
    const rb = op.requestBody ? deref(op.requestBody) : null;
    const bodySchema =
      rb && rb.content && rb.content['application/json']
        ? rb.content['application/json'].schema
        : null;
    const send = (
      target,
      note,
      bodyValue = bodySchema ? sample(bodySchema, false) : undefined,
      extra = []
    ) => {
      if (bodyValue === undefined)
        add(M, target, [COOKIE, ...extra], null, note);
      else addJson(M, target, bodyValue, extra, note);
    };
    const base = fillPath();
    send(base + qs(requiredQuery), 'minimal');
    send(
      base + qs(allQuery),
      'all query',
      bodySchema ? sample(bodySchema, true) : undefined
    );
    // security
    if (!(Array.isArray(op.security) && op.security.length === 0)) {
      const body = bodySchema
        ? JSON.stringify(sample(bodySchema, false))
        : null;
      const hs = (h) => (body === null ? h : [...h, JSON_CT]);
      add(M, base + qs(requiredQuery), hs([]), body, 'no credentials');
      add(
        M,
        base + qs(requiredQuery),
        hs([['Cookie', 'connect.sid=']]),
        body,
        'empty cookie'
      );
      add(
        M,
        base + qs(requiredQuery),
        hs([['Cookie', 'other=1; connect.sid="x"']]),
        body,
        'quoted cookie'
      );
      add(
        M,
        base + qs(requiredQuery),
        hs([['Cookie', 'connect.sid=""']]),
        body,
        'empty quoted cookie'
      );
      add(
        M,
        base + qs(requiredQuery),
        hs([['X-Api-Key', 'nope']]),
        body,
        'api key'
      );
      add(
        M,
        base + qs(requiredQuery),
        hs([['X-Api-Key', '']]),
        body,
        'empty api key'
      );
      add(
        M,
        base + qs('zz=1'.split(' ')),
        hs([]),
        body,
        'no credentials, unknown query'
      );
    }
    // methods
    add('HEAD', base + qs(requiredQuery), [COOKIE], null, 'head');
    add('OPTIONS', base, [COOKIE], null, 'options');
    for (const other of methods) {
      if (!item[other])
        add(other.toUpperCase(), base, [COOKIE], null, 'method not in spec');
    }
    // paths
    send(base + '/' + qs(requiredQuery), 'trailing slash');
    send(base.toUpperCase() + qs(requiredQuery), 'upper case');
    send(
      base.replace('/api/v1/', '/api/v1//') + qs(requiredQuery),
      'double slash'
    );
    send(base + '/extra-segment' + qs(requiredQuery), 'extra segment');
    // unknown and odd query keys
    for (const extra of [
      'zz=1',
      'zz=',
      'zz',
      '2=a&1=b',
      '__proto__=1',
      'a[b]=1',
      'zz=1&zz=2',
      '=x',
      '&&',
      'zz%5B%5D=1',
    ]) {
      send(base + qs([...requiredQuery, extra]), 'query ' + extra);
    }
    // missing required query params
    for (const r of query.filter((x) => x.required)) {
      send(
        base + qs(requiredQuery.filter((x) => !x.startsWith(r.name + '='))),
        'missing ' + r.name
      );
    }
    // query param mutations
    for (const q of query) {
      const s = deref(q.schema);
      const others = requiredQuery.filter((x) => !x.startsWith(q.name + '='));
      const values = [
        '',
        'abc',
        'a,b',
        'a:b',
        'a+b',
        "a'b",
        'a/b',
        'a%2Cb',
        'a%20b',
        '%E0%A4%A',
        '%ZZ',
        '%C3%A9',
        'zzz-not-in-enum',
        'null',
      ];
      if (s.type === 'number' || s.type === 'integer') {
        values.push(
          '1e3',
          '1.5',
          '%207',
          '0x1F',
          'Infinity',
          '-0',
          '00012',
          '1.0',
          '9007199254740993',
          '-5',
          '1e400',
          'NaN',
          '%20',
          '.5',
          '5.',
          '+3',
          '1_000'
        );
        if (s.minimum !== undefined) values.push(String(s.minimum - 1));
        if (s.maximum !== undefined) values.push(String(s.maximum + 1));
      }
      if (s.type === 'boolean')
        values.push('1', '0', 'TRUE', 'false', 'true', 'yes');
      if (s.enum) values.push(...s.enum.map(enc));
      if (s.anyOf)
        values.push(
          '2024-01-02',
          '2024-01-02T03:04:05Z',
          '2024-13-02',
          '2024-01-02T25:00:00Z',
          '2024-01-02t03:04:05.123+01:00',
          '2024-01-02 03:04:05Z'
        );
      if (s.minLength) values.push('');
      for (const v of values)
        send(base + qs([...others, `${q.name}=${v}`]), `query ${q.name}=${v}`);
      send(
        base + qs([...others, `${q.name}=1`, `${q.name}=2`]),
        `query ${q.name} repeated`
      );
      send(base + qs([...others, q.name]), `query ${q.name} without =`);
      send(
        base + qs([...others, `${q.name}[x]=1`]),
        `query ${q.name} brackets`
      );
      send(
        base + qs([`${q.name}=abc`, ...others, 'zz=1']),
        `query ${q.name} bad then unknown`
      );
    }
    // path param mutations
    for (const pp of pathParams) {
      for (const v of [
        'abc',
        '1.5',
        '%31',
        '%ZZ',
        '-1',
        '0x10',
        '%20',
        '%C3%A9',
        '1e2',
        '0',
        '99999999999999999999',
        'a%2Fb',
        'Infinity',
      ]) {
        send(
          fillPath({ [pp.name]: v }) + qs(requiredQuery),
          `path ${pp.name}=${v}`
        );
      }
    }
    // bodies
    if (bodySchema) {
      const s = deref(bodySchema);
      const valid = sample(bodySchema, true);
      const target = base + qs(requiredQuery);
      addJson(M, target, valid, [], 'body full');
      addJson(M, target, [], [], 'body array');
      addJson(M, target, '"str"', [], 'body string');
      addJson(M, target, '{bad json', [], 'body malformed');
      addJson(M, target, 'null', [], 'body null');
      add(
        M,
        target,
        [COOKIE, JSON_CT, ['Content-Length', '0']],
        '',
        'body empty with length'
      );
      add(M, target, [COOKIE, JSON_CT], null, 'json type without body');
      add(
        M,
        target,
        [COOKIE],
        JSON.stringify(valid),
        'body without content type'
      );
      add(M, target, [COOKIE], null, 'no body, no content type');
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'text/plain']],
        'hello',
        'text body'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'text/plain; charset=UTF-8; a=b']],
        'hello',
        'text body params'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'application/x-www-form-urlencoded']],
        'a=1',
        'form body'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'application/json; charset=utf-8']],
        JSON.stringify(valid),
        'json charset'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'APPLICATION/JSON']],
        JSON.stringify(valid),
        'json upper'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'application/json; charset=latin1']],
        JSON.stringify(valid),
        'json latin1'
      );
      add(
        M,
        target,
        [COOKIE, ['Content-Type', 'application/vnd.api+json']],
        JSON.stringify(valid),
        'json suffix'
      );
      if (s.type === 'object' || s.properties) {
        addJson(M, target, { ...valid, zzExtra: 1 }, [], 'body extra prop');
        addJson(
          M,
          target,
          { 2: 'a', 1: 'b', ...valid },
          [],
          'body numeric keys'
        );
        for (const r of s.required || []) {
          const v = { ...valid };
          delete v[r];
          addJson(M, target, v, [], 'body missing ' + r);
        }
        for (const [k, ps] of Object.entries(s.properties || {})) {
          addJson(
            M,
            target,
            { ...valid, [k]: wrong(ps) },
            [],
            `body ${k} wrong`
          );
          addJson(M, target, { ...valid, [k]: null }, [], `body ${k} null`);
          const d = deref(ps);
          if (d.type === 'number' || d.type === 'integer') {
            addJson(
              M,
              target,
              { ...valid, [k]: 1.5 },
              [],
              `body ${k} fraction`
            );
            addJson(
              M,
              target,
              { ...valid, [k]: -100 },
              [],
              `body ${k} negative`
            );
            addJson(
              M,
              target,
              `${JSON.stringify({ ...valid, [k]: 0 }).slice(0, -1)},"${k}x":1e400}`,
              [],
              `body ${k} huge`
            );
          }
          if (d.type === 'string')
            addJson(M, target, { ...valid, [k]: '' }, [], `body ${k} empty`);
          if (d.type === 'array') {
            addJson(
              M,
              target,
              { ...valid, [k]: [wrong(d.items || {})] },
              [],
              `body ${k} wrong item`
            );
            addJson(
              M,
              target,
              {
                ...valid,
                [k]: Array.from({ length: 101 }, () =>
                  sample(d.items || {}, false)
                ),
              },
              [],
              `body ${k} long`
            );
          }
          if (d.type === 'object' && d.properties) {
            for (const [k2, ps2] of Object.entries(d.properties)) {
              addJson(
                M,
                target,
                { ...valid, [k]: { ...sample(d, true), [k2]: wrong(ps2) } },
                [],
                `body ${k}.${k2} wrong`
              );
            }
            addJson(
              M,
              target,
              { ...valid, [k]: { ...sample(d, true), zz: 1 } },
              [],
              `body ${k} extra`
            );
          }
          if (d.oneOf || d.anyOf) {
            for (const [i, br] of (d.oneOf || d.anyOf).entries()) {
              const bs = sample(br, true);
              addJson(
                M,
                target,
                { ...valid, [k]: bs },
                [],
                `body ${k} branch ${i}`
              );
              if (bs && typeof bs === 'object' && !Array.isArray(bs)) {
                for (const k2 of Object.keys(bs)) {
                  const mut = { ...bs };
                  delete mut[k2];
                  addJson(
                    M,
                    target,
                    { ...valid, [k]: mut },
                    [],
                    `body ${k} branch ${i} missing ${k2}`
                  );
                  addJson(
                    M,
                    target,
                    { ...valid, [k]: { ...bs, [k2]: 'zz' } },
                    [],
                    `body ${k} branch ${i} bad ${k2}`
                  );
                }
              }
            }
            addJson(M, target, { ...valid, [k]: 'all' }, [], `body ${k} all`);
            addJson(
              M,
              target,
              { ...valid, [k]: [1, -1] },
              [],
              `body ${k} negative item`
            );
          }
          if (d.readOnly)
            addJson(
              M,
              target,
              { ...valid, [k]: sample(d, false) },
              [],
              `body ${k} read-only`
            );
        }
      }
    }
  }
}
// Seeded fuzzing: random values at random places of valid bodies, and
// random combinations of query values.
let seed = 12345;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
};
const POOL = [
  null,
  0,
  -1,
  1.5,
  '',
  'x',
  true,
  false,
  [],
  {},
  [1],
  ['x'],
  { a: 1 },
  1e20,
  'all',
  'movie',
  'tv',
  -0.5,
  100000,
  '2024-01-02',
];
const QPOOL = [
  '',
  '1',
  '0',
  '-1',
  'abc',
  'true',
  'false',
  '1.5',
  '1e2',
  'movie',
  'tv',
  'all',
  'a%2Cb',
  '%20',
  'null',
  '2024-01-02',
];
function paths(v, prefix = []) {
  const out = [prefix];
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) out.push(...paths(v[k], [...prefix, k]));
  }
  return out;
}
function setAt(v, path, value) {
  if (path.length === 0) return value;
  const copy = Array.isArray(v) ? [...v] : { ...v };
  copy[path[0]] = setAt(v[path[0]], path.slice(1), value);
  return copy;
}
for (const [p, item] of Object.entries(doc.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!methods.includes(m)) continue;
    const params = [...(op.parameters || []), ...(item.parameters || [])].map(
      param
    );
    const query = params.filter((x) => x.in === 'query');
    const target = '/api/v1' + p.replace(/\{([^}]+)\}/g, () => '1');
    const rb = op.requestBody ? deref(op.requestBody) : null;
    const bodySchema =
      rb && rb.content && rb.content['application/json']
        ? rb.content['application/json'].schema
        : null;
    const required = query
      .filter((x) => x.required)
      .map((x) => `${x.name}=${enc(sample(x.schema, false))}`);
    for (let i = 0; i < 12 && query.length; i++) {
      const picks = Array.from(
        { length: 1 + rand(3) },
        () => query[rand(query.length)]
      );
      const pairs = [
        ...required.filter(
          (r) => !picks.some((q) => r.startsWith(q.name + '='))
        ),
        ...picks.map((q) => `${q.name}=${QPOOL[rand(QPOOL.length)]}`),
      ];
      const body = bodySchema ? JSON.stringify(sample(bodySchema, true)) : null;
      add(
        m.toUpperCase(),
        target + '?' + pairs.join('&'),
        body === null ? [COOKIE] : [COOKIE, JSON_CT],
        body,
        'fuzz query'
      );
    }
    if (bodySchema) {
      const valid = sample(bodySchema, true);
      const spots = paths(valid);
      for (let i = 0; i < 25; i++) {
        let v = valid;
        for (let j = 0; j <= rand(2); j++)
          v = setAt(v, spots[rand(spots.length)], POOL[rand(POOL.length)]);
        addJson(
          m.toUpperCase(),
          target + (required.length ? '?' + required.join('&') : ''),
          v,
          [],
          'fuzz body'
        );
      }
    }
  }
}
// header and encoding odds and ends
{
  const t = '/api/v1/request';
  const b = JSON.stringify({ mediaType: 'movie', mediaId: 1 });
  for (const ct of [
    'application/json;charset=utf-8',
    'application/json ; charset=UTF-8',
    'application/json; charset="utf-8"',
    'application/json; foo',
    'application/json; boundary=x',
    'application/json, text/plain',
    'application/json;',
    ' application/json',
    'application/json; charset=utf-16',
    'text/json',
    'application/*',
    '*/*',
  ]) {
    add('POST', t, [COOKIE, ['Content-Type', ct]], b, 'content type ' + ct);
  }
  add('POST', t, [COOKIE, ['Content-Type', '']], b, 'empty content type');
  add('POST', t, [COOKIE, JSON_CT], '\ufeff' + b, 'json bom');
  add('POST', t, [COOKIE, JSON_CT], b + '  \n', 'json trailing space');
  add('POST', t, [COOKIE, JSON_CT], '  ' + b, 'json leading space');
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"mediaType":"movie","mediaId":1,"mediaType":"tv"}',
    'json duplicate key'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"__proto__":{"x":1},"mediaType":"movie","mediaId":1}',
    'json proto key'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"constructor":1,"mediaType":"movie","mediaId":1}',
    'json constructor key'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"mediaType":"movie","mediaId":1e400}',
    'json overflow'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"mediaType":"movie","mediaId":12345678901234567890}',
    'json big int'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"mediaType":"movie","mediaId":1.0}',
    'json 1.0'
  );
  add(
    'POST',
    t,
    [COOKIE, JSON_CT],
    '{"mediaType":"mov\\u0069e","mediaId":1}',
    'json escape'
  );
  for (const c of [
    'connect.sid=x; connect.sid=',
    ' connect.sid = x ',
    'connect.sid',
    'a=b;connect.sid=%',
    'connect.sid="',
    'connect.sid=j:0',
    'Connect.sid=x',
    'connect.sid=x;',
    ';connect.sid=x',
    'a=b=c; connect.sid=x',
  ]) {
    add('GET', '/api/v1/settings/main', [['Cookie', c]], null, 'cookie ' + c);
  }
  add(
    'GET',
    '/api/v1/settings/main',
    [['x-api-key', 'k']],
    null,
    'lower api key'
  );
  add(
    'GET',
    '/api/v1/settings/main',
    [['X-API-KEY', ' ']],
    null,
    'space api key'
  );
  for (const q of [
    '?',
    '?&',
    '?take=1?',
    '?a=1?b',
    '?%74ake=1',
    '?take=%2C',
    '?take=1&take=',
    '?filter=%F0%9F%98%80',
    '?take=+1',
    '?take=1+',
    '?take=%2B1',
    '?take[]=1',
    '?take[0]=1&take[1]=2',
    '?a[b][c]=1',
    '?[x]=1',
    '?take[=1',
    '?take]=1',
    '?take[constructor]=1',
    '?take[x]=1&take[y]=2',
    '?filter[]=all',
    '?skip=1&take[a]=1&sort=x',
  ]) {
    add('GET', '/api/v1/blocklist' + q, [COOKIE], null, 'query ' + q);
    add('GET', '/api/v1/user' + q, [COOKIE], null, 'query ' + q);
  }
  for (const pth of [
    '/api/v1/movie/1%2F2',
    '/api/v1/movie/%2e',
    '/api/v1/movie/..',
    '/api/v1/user/1/settings/main/',
    '/api/v1/USER/1',
    '/api//v1/status',
    '/api/v1/status//',
    '/api/v1/status/?x',
    '/Api/v1/status',
  ]) {
    add('GET', pth, [COOKIE], null, 'path ' + pth);
    add('HEAD', pth, [COOKIE], null, 'head ' + pth);
    add('OPTIONS', pth, [COOKIE], null, 'options ' + pth);
  }
}
// body-parser corner cases: Content-Encoding, charsets, form bodies (qs),
// repeated headers, JSON the strict mode refuses, request targets.
{
  const t = '/api/v1/request';
  const good = Buffer.from(JSON.stringify({ mediaType: 'movie', mediaId: 1 }));
  const J = ['Content-Type', 'application/json'];
  const CE = (e) => ['Content-Encoding', e];
  const gz = zlib.gzipSync(good);
  const encodings = [
    ['gzip', [CE('gzip')], gz],
    ['GZIP', [CE('GZIP')], gz],
    ['gzip corrupt', [CE('gzip')], Buffer.from('notgzipdata')],
    ['gzip truncated', [CE('gzip')], gz.subarray(0, 10)],
    ['gzip trailing', [CE('gzip')], Buffer.concat([gz, Buffer.from('xx')])],
    [
      'gzip members',
      [CE('gzip')],
      Buffer.concat([
        zlib.gzipSync(good.subarray(0, 5)),
        zlib.gzipSync(good.subarray(5)),
      ]),
    ],
    [
      'gzip bad crc',
      [CE('gzip')],
      Buffer.concat([
        gz.subarray(0, gz.length - 8),
        Buffer.from([0, 0, 0, 0]),
        gz.subarray(gz.length - 4),
      ]),
    ],
    ['gzip empty', [CE('gzip')], Buffer.alloc(0)],
    [
      'gzip big',
      [CE('gzip')],
      zlib.gzipSync(
        Buffer.from(
          JSON.stringify({
            mediaType: 'movie',
            mediaId: 1,
            pad: 'x'.repeat(200000),
          })
        )
      ),
    ],
    ['deflate', [CE('deflate')], zlib.deflateSync(good)],
    ['deflate raw', [CE('deflate')], zlib.deflateRawSync(good)],
    [
      'deflate corrupt',
      [CE('deflate')],
      Buffer.concat([
        zlib.deflateSync(good).subarray(0, 2),
        Buffer.from([0xff, 0xff, 0xff]),
      ]),
    ],
    ['br', [CE('br')], zlib.brotliCompressSync(good)],
    ['br corrupt', [CE('br')], Buffer.from('zzzzzz')],
    ['br truncated', [CE('br')], zlib.brotliCompressSync(good).subarray(0, 3)],
    ['compress', [CE('compress')], good],
    ['identity', [CE('identity')], good],
    ['two encodings', [CE('gzip, gzip')], zlib.gzipSync(gz)],
    ['repeated encoding', [CE('gzip'), CE('gzip')], zlib.gzipSync(gz)],
  ];
  for (const [n, h, b] of encodings)
    add('POST', t, [COOKIE, J, ...h], b, 'encoding ' + n);
  const le = (str) => Buffer.from(str, 'utf16le');
  const be = (str) => Buffer.from(str, 'utf16le').swap16();
  const u32 = (str, big) => {
    const cps = [...str].map((c) => c.codePointAt(0));
    const out = Buffer.alloc(cps.length * 4);
    cps.forEach((cp, i) =>
      big ? out.writeUInt32BE(cp, i * 4) : out.writeUInt32LE(cp, i * 4)
    );
    return out;
  };
  const body = JSON.stringify({ mediaType: 'movie', mediaId: 1, x: 'é😀' });
  const charsets = [
    ['utf-16le', le(body)],
    ['utf-16be', be(body)],
    ['utf-16', le(body)],
    ['utf-16', Buffer.concat([Buffer.from([0xfe, 0xff]), be(body)])],
    ['utf-16', Buffer.from(body)],
    ['UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), le(body)])],
    ['utf-16-le', le(body)],
    ['utf-32', u32(body, false)],
    ['utf-32be', u32(body, true)],
    ['utf-32le', u32(body, false)],
    ['utf-7', Buffer.from('{"mediaType":"movie","mediaId":1,"x":"+AOk-"}')],
    [
      'utf-7',
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe9, 0x22, 0x7d]),
    ],
    [
      'utf-7-imap',
      Buffer.from('{"mediaType":"movie","mediaId":1,"x":"&AOk-"}'),
    ],
    ['utf-8:2024', good],
    ['utf-9', good],
    [
      'utf-8',
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ],
    ['utf-16le', le('😀')],
    ['utf-16le', Buffer.from([0x3d, 0xd8])],
  ];
  for (const [cs, b] of charsets)
    add(
      'POST',
      t,
      [COOKIE, ['Content-Type', 'application/json; charset=' + cs]],
      b,
      'charset ' + cs
    );
  const strict = [
    'null',
    '"str"',
    '😀',
    ' \t😀',
    '   ',
    '\n',
    'tv',
    'é',
    '{"a":"\\ud800"}',
    '{"mediaType":"movie","mediaId":1,"x":"\\ud83d\\ude00"}',
    '[😀]',
    '{"\\u12',
    '{"a":"\\😀"}',
    '{"\\uD83Dzz',
    '😀1',
  ];
  for (const b of strict) add('POST', t, [COOKIE, J], b, 'strict ' + b);
  const F = ['Content-Type', 'application/x-www-form-urlencoded'];
  const forms = [
    'a[b][c]=1&a[b][d]=2&x[]=1&x[]=2&y[3]=z&constructor=1&__proto__[q]=1',
    'a' + '[b]'.repeat(33) + '=1',
    'a' + '[b]'.repeat(32) + '=1',
    'b=1&2=x&a=3',
    'a=1&a=2&a',
    'a=&a[x]=1',
    'a%5Bb%5D=1+2&c=%ZZ',
    'a[]=1&a[]=2&a[5]=3&a[x]=4',
    'a[101]=1&a[0]=2',
    'a=1&'.repeat(1000),
    'a=1&'.repeat(999) + 'b=2',
    'mediaType=movie&mediaId=1',
    'mediaType=movie&mediaId=1&mediaType=tv',
    '',
    '&&=&a',
    'a[b]=1&a=2',
    'a=2&a[b]=1',
    'a[0]=x&a[1]=y',
    'hasOwnProperty=1&toString[a]=2',
  ];
  for (const f of forms) {
    add('POST', t, [COOKIE, F], f, 'form ' + f.slice(0, 40));
    add(
      'POST',
      '/api/v1/auth/logout',
      [COOKIE, F],
      f,
      'form on a body-less route ' + f.slice(0, 40)
    );
  }
  add(
    'POST',
    t,
    [
      COOKIE,
      ['Content-Type', 'application/x-www-form-urlencoded; charset=iso-8859-1'],
    ],
    Buffer.from([0x61, 0x3d, 0xe9, 0x26, 0x62, 0x3d, 0x25, 0x45, 0x39]),
    'form latin-1'
  );
  add(
    'POST',
    '/api/v1/auth/logout',
    [
      COOKIE,
      ['Content-Type', 'application/x-www-form-urlencoded; charset=iso-8859-1'],
    ],
    Buffer.from([0x61, 0x3d, 0xe9, 0x26, 0x62, 0x3d, 0x25, 0x45, 0x39]),
    'form latin-1 body-less'
  );
  add(
    'POST',
    t,
    [
      COOKIE,
      ['Content-Type', 'application/x-www-form-urlencoded; charset=utf-16'],
    ],
    'a=1',
    'form utf-16'
  );
  add(
    'POST',
    t,
    [COOKIE, ['Content-Type', 'application/x-www-form-urlencoded'], CE('gzip')],
    zlib.gzipSync(Buffer.from('a=1')),
    'form gzip'
  );
  // repeated headers, as Node joins (or drops) them
  add(
    'GET',
    '/api/v1/settings/main',
    [['Cookie', 'a=1'], COOKIE],
    null,
    'two cookie headers'
  );
  add(
    'GET',
    '/api/v1/settings/main',
    [
      ['Cookie', 'connect.sid='],
      ['Cookie', 'connect.sid=x'],
    ],
    null,
    'two cookie headers, empty first'
  );
  add(
    'GET',
    '/api/v1/settings/main',
    [
      ['X-Api-Key', 'a'],
      ['X-Api-Key', 'b'],
    ],
    null,
    'two api keys'
  );
  add(
    'GET',
    '/api/v1/settings/main',
    [
      ['X-Api-Key', ''],
      ['X-Api-Key', ''],
    ],
    null,
    'two empty api keys'
  );
  add(
    'POST',
    t,
    [COOKIE, J, ['Content-Type', 'text/plain']],
    good,
    'two content types, json first'
  );
  add(
    'POST',
    t,
    [COOKIE, ['Content-Type', 'text/plain'], J],
    good,
    'two content types, text first'
  );
  add(
    'POST',
    t,
    [
      COOKIE,
      J,
      ['Content-Length', String(good.length)],
      ['Content-Length', String(good.length)],
    ],
    good,
    'two content lengths'
  );
  // bracketed query values qs splits again
  for (const q of [
    '?take[a]=1%26b%3D2',
    '?filter[x]=a%3Db',
    '?take[a]=%2541',
    '?take[a]=1&take[a]=2',
    '?constructor[a]=1',
    '?a[toString]=1&a[b]=2',
    '?take[0]=1&take[21]=2',
  ]) {
    add('GET', '/api/v1/blocklist' + q, [COOKIE], null, 'query ' + q);
  }
  // other request targets and methods
  add(
    'GET',
    'http://example.com/api/v1/status',
    [COOKIE],
    null,
    'absolute-form target'
  );
  add(
    'GET',
    'http://example.com/api/v1/blocklist?take=x',
    [COOKIE],
    null,
    'absolute-form target, bad query'
  );
  add(
    'POST',
    'http://example.com/api/v1/request',
    [COOKIE, J],
    good,
    'absolute-form target with body'
  );
  for (const m of [
    'PROPFIND',
    'PURGE',
    'LOCK',
    'MKCOL',
    'SEARCH',
    'REPORT',
    'TRACE',
    'QUERY',
  ]) {
    add(m, '/api/v1/status', [COOKIE], null, 'method ' + m);
    add(
      m,
      '/api/v1/request',
      [COOKIE],
      null,
      'method ' + m + ' on a write route'
    );
  }
}
// paths outside the spec and odd prefixes
for (const t of [
  '/api/v1/does-not-exist',
  '/api/v1',
  '/api/v1/',
  '/api',
  '/api/',
  '/api/v2/status',
  '/api/api/v1/status',
  '/api/api/v1/x',
  '/API/V1/STATUS',
  '/api/v1/status?x=1',
  '/api/v1/status/../status',
  '/api/v1/movie/%E0%A4%A',
  '/apix/v1/status',
  '/api/v1/settings/main?a[b]=1',
  '/api/v1/status?checkUpdateAvailable=true&checkUpdateAvailable=false',
]) {
  add('GET', t, [COOKIE], null, 'odd path');
  add('POST', t, [COOKIE], null, 'odd path post');
}

// ---------------------------------------------------------------- transport
function rawRequest({ method, target, headers, body }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    const chunks = [];
    let head = `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n`;
    const names = headers.map(([k]) => k.toLowerCase());
    for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
    const bytes =
      body === null
        ? null
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body, 'utf8');
    if (bytes && !names.includes('content-length'))
      head += `Content-Length: ${bytes.length}\r\n`;
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('end', () => {
      const all = Buffer.concat(chunks).toString('utf8');
      const split = all.indexOf('\r\n\r\n');
      const lines = all.slice(0, split).split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const hs = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(':');
        hs[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
      }
      resolve({ status, headers: hs, body: all.slice(split + 4) });
    });
    sock.write(head + '\r\n');
    if (bytes) sock.write(bytes);
  });
}

async function main() {
  if (process.env.OPENAPI_DIFF_SERVE) {
    // Only serve the harness (to put the Rust server in front of it).
    app().listen(PORT, '127.0.0.1');
    return;
  }
  const server = app().listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  // Never a fixed path in the shared temp dir: mkdtemp makes an unguessable,
  // owner-only directory, and the files are created owner-only too.
  const OUT =
    OUT_ARG ||
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rs-validator-')),
      'corpus.jsonl'
    );
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const out = fs.createWriteStream(OUT, { mode: 0o600 });
  // Warm the validator (it compiles lazily) so the first answers aren't special.
  await rawRequest({
    method: 'GET',
    target: '/api/v1/status',
    headers: [],
    body: null,
  });
  let i = 0;
  const workers = Array.from({ length: 16 }, async () => {
    while (i < corpus.length) {
      const item = corpus[i++];
      const res = await rawRequest(item);
      const binary = Buffer.isBuffer(item.body);
      out.write(
        JSON.stringify({
          method: item.method,
          target: item.target,
          headers: [
            ['Host', `127.0.0.1:${PORT}`],
            ...item.headers,
            ...(item.body !== null &&
            !item.headers.some(([k]) => k.toLowerCase() === 'content-length')
              ? [['Content-Length', String(Buffer.byteLength(item.body))]]
              : []),
          ],
          body: binary ? null : item.body,
          ...(binary ? { bodyB64: item.body.toString('base64') } : {}),
          note: item.note,
          status: res.status,
          contentType: res.headers['content-type'] || null,
          contentLength: res.headers['content-length'] || null,
          response: res.body,
        }) + '\n'
      );
    }
  });
  await Promise.all(workers);
  await new Promise((r) => out.end(r));
  server.close();
  // The spec as the validator's loader reads it, for the YAML check.
  fs.writeFileSync(
    OUT.replace(/\.jsonl$/, '') + '.spec.json',
    JSON.stringify(doc),
    { mode: 0o600 }
  );
  console.log(`${corpus.length} requests written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
