// GET /api/export/v1: off without a token, token only, never through the proxy, and a fixed shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'export-test-token';
const uid = 'u_exp_1';

const state = {
  _rev: 7, unit: 'kg', secretSetting: 'x', coach: { consent: true },
  customEx: [{ id: 'c1', n: 'My lift' }],
  bodyweight: [{ d: '2026-10-01', w: 80.5, t: 1 }],
  deleted: { workouts: { gone: 1700000000000, back: -1700000000000 } },
  workouts: [
    { id: 'w1', d: '2026-10-02', start: 1000, end: 2000, name: 'Pull', bw: 80, vol: 1, prs: ['0001'], media: [{ hash: 'h' }],
      entries: [{ id: '0001', topW: 100, sets: [{ w: 100, r: 5, rpe: 8, done: true }, { w: 90, r: 5, done: false }] }, { id: 'c1', sets: [{ w: 10, r: 10, rir: 2, done: true }] }] },
    { id: 'w2', d: '2026-09-01', name: 'Imported', entries: [] }
  ]
};

async function boot(t, env = {}, users = [{ id: uid, name: 'E' }]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-export-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'test-secret-export', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify(state));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return `http://127.0.0.1:${await boundPort(child, () => log)}/api/export/v1`;
}
const auth = { authorization: `Bearer ${TOKEN}` };

test('off (404) when no token is configured', async t => {
  const url = await boot(t);
  assert.equal((await fetch(url, { headers: auth })).status, 404);
});

test('401 without the right bearer; a cookie opens nothing', async t => {
  const url = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(url, { headers: { cookie: 'gymsid=anything' } })).status, 401);
});

test('404 for a request that came through the proxy, even with the token', async t => {
  const url = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN });
  assert.equal((await fetch(url, { headers: { ...auth, 'x-forwarded-for': '1.2.3.4' } })).status, 404);
  assert.equal((await fetch(url, { headers: { ...auth, 'x-real-ip': '1.2.3.4' } })).status, 404);
});

test('exports the contract shape and nothing else', async t => {
  const url = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN });
  const r = await fetch(url, { headers: auth });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ['bodyweight', 'deleted', 'exercises', 'rev', 'unit', 'version', 'workouts']);
  assert.equal(j.version, 1);
  assert.equal(j.rev, 7);
  const [w1, w2] = j.workouts;
  assert.deepEqual(w1, {
    id: 'w1', date: '2026-10-02', start: 1000, end: 2000, name: 'Pull', routine_id: null, body_weight: 80, edited_at: null,
    entries: [
      { exercise_id: '0001', sets: [{ weight: 100, reps: 5, rpe: 8, rir: null, done: true }, { weight: 90, reps: 5, rpe: null, rir: null, done: false }] },
      { exercise_id: 'c1', sets: [{ weight: 10, reps: 10, rpe: null, rir: 2, done: true }] }
    ]
  });
  assert.equal(w2.start, null, 'an imported workout has no times');
  assert.equal(w2.end, null);
  assert.deepEqual(j.bodyweight, [{ date: '2026-10-01', weight: 80.5 }]);
  const names = Object.fromEntries(j.exercises.map(e => [e.id, e.name]));
  assert.equal(names.c1, 'My lift');
  assert.equal(typeof names['0001'], 'string', 'a built-in exercise is named from the catalogue');
  assert.deepEqual(j.deleted.workouts, [{ id: 'gone', at: 1700000000000 }], 'an add-back is not a deletion');
  assert.ok(!JSON.stringify(j).includes('secretSetting') && !JSON.stringify(j).includes('"h"'));
});

test('since_rev equal to the current rev answers 304', async t => {
  const url = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN });
  assert.equal((await fetch(`${url}?since_rev=7`, { headers: auth })).status, 304);
  assert.equal((await fetch(`${url}?since_rev=6`, { headers: auth })).status, 200);
});

test('503 with several profiles and no OPENGYM_EXPORT_UID; the uid picks one', async t => {
  const users = [{ id: uid, name: 'E' }, { id: 'u_other', name: 'O' }];
  const url = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN }, users);
  assert.equal((await fetch(url, { headers: auth })).status, 503);
  const url2 = await boot(t, { OPENGYM_EXPORT_TOKEN: TOKEN, OPENGYM_EXPORT_UID: uid }, users);
  assert.equal((await fetch(url2, { headers: auth })).status, 200);
});
