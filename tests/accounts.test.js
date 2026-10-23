// Tests des comptes (vrai serveur, base temporaire) : `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3800 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}/api`;
let dir;
let server;

const DB = { room: { w: 800, h: 600 }, zones: [], tables: [], groups: [], reservations: [], settings: { lastRetention: '2999-01-01' } };
const ADMIN = { name: 'Admin', email: 'admin@test.local', password: 'motdepasse-admin' };

async function call(method, url, body, cookie = '') {
  const res = await fetch(URL + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
}

let admin = '';
let staffId = '';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gestiontable-comptes-'));
  await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify(DB));
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('démarrée') && resolve());
    server.on('exit', (code) => reject(new Error(`serveur arrêté (${code})`)));
  });
});

after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('premier lancement : sans compte, l’API demande la création de l’admin', async () => {
  const status = (await call('GET', '/auth/status')).data;
  assert.equal(status.configured, false);
  assert.equal(status.canSetup, true);
  const { status: code, data } = await call('GET', '/plan');
  assert.equal(code, 401);
  assert.equal(data.auth, 'setup');
});

test('création de l’admin : mot de passe trop court refusé, puis compte créé et connecté', async () => {
  assert.equal((await call('POST', '/auth/setup', { ...ADMIN, password: 'court' })).status, 400);
  const res = await call('POST', '/auth/setup', ADMIN);
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, 'admin');
  assert.equal(res.data.user.passwordHash, undefined);
  admin = res.cookie;
  assert.equal((await call('GET', '/plan', null, admin)).status, 200);
  // Un seul premier compte
  assert.equal((await call('POST', '/auth/setup', { ...ADMIN, email: 'autre@test.local' })).status, 409);
});

test('mot de passe haché dans la base, jamais en clair', async () => {
  const raw = await fs.readFile(path.join(dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(ADMIN.password));
  assert.match(raw, /"passwordHash"/);
});

test('l’admin crée un compte équipe ; email en double refusé', async () => {
  const res = await call('POST', '/users', { name: 'Sam', email: 'Sam@Test.local', password: 'motdepasse-sam' }, admin);
  assert.equal(res.status, 201);
  assert.equal(res.data.role, 'staff');
  assert.equal(res.data.email, 'sam@test.local');
  staffId = res.data.id;
  assert.equal((await call('POST', '/users', { name: 'Sam 2', email: 'sam@test.local', password: 'motdepasse-sam' }, admin)).status, 409);
  assert.equal((await call('POST', '/users', { name: '', email: 'x@test.local', password: 'motdepasse-x' }, admin)).status, 400);
});

test('connexion : email + mot de passe ; mauvais mot de passe refusé', async () => {
  assert.equal((await call('POST', '/auth/login', { email: 'sam@test.local', password: 'faux-mot-de-passe' })).status, 401);
  const res = await call('POST', '/auth/login', { email: 'SAM@test.local', password: 'motdepasse-sam' });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.name, 'Sam');
  const staff = res.cookie;
  assert.equal((await call('GET', '/plan', null, staff)).status, 200);
  // Un compte équipe ne gère pas les comptes
  assert.equal((await call('GET', '/users', null, staff)).status, 403);
  assert.equal((await call('POST', '/users', { name: 'X', email: 'x@test.local', password: 'motdepasse-x' }, staff)).status, 403);
});

test('mot de passe changé par l’admin : les anciennes sessions du compte sont annulées', async () => {
  const old = (await call('POST', '/auth/login', { email: 'sam@test.local', password: 'motdepasse-sam' })).cookie;
  assert.equal((await call('PUT', `/users/${staffId}`, { password: 'nouveau-mdp-sam' }, admin)).status, 200);
  assert.equal((await call('GET', '/plan', null, old)).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'sam@test.local', password: 'nouveau-mdp-sam' })).status, 200);
});

test('il reste toujours un administrateur, et on ne supprime pas son propre compte', async () => {
  const me = (await call('GET', '/auth/status', null, admin)).data.user;
  assert.equal((await call('PUT', `/users/${me.id}`, { role: 'staff' }, admin)).status, 400);
  assert.equal((await call('DELETE', `/users/${me.id}`, null, admin)).status, 400);
});

test('compte supprimé : il ne peut plus rien faire', async () => {
  const staff = (await call('POST', '/auth/login', { email: 'sam@test.local', password: 'nouveau-mdp-sam' })).cookie;
  assert.equal((await call('DELETE', `/users/${staffId}`, null, admin)).status, 204);
  assert.equal((await call('GET', '/plan', null, staff)).status, 401);
  assert.equal((await call('POST', '/auth/login', { email: 'sam@test.local', password: 'nouveau-mdp-sam' })).status, 401);
  assert.deepEqual((await call('GET', '/users', null, admin)).data.map((u) => u.email), ['admin@test.local']);
});

test('changer son propre mot de passe exige l’actuel', async () => {
  assert.equal((await call('POST', '/auth/password', { current: 'faux', password: 'nouveau-admin-1' }, admin)).status, 401);
  const res = await call('POST', '/auth/password', { current: ADMIN.password, password: 'nouveau-admin-1' }, admin);
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/plan', null, admin)).status, 401); // ancien cookie annulé
  assert.equal((await call('GET', '/plan', null, res.cookie)).status, 200); // cet appareil reste connecté
});
