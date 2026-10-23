// Tests de l'API des réservations (vrai serveur, base temporaire) : `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}/api`;
const DATE = '2030-06-15';
let dir;
let server;
let cookie = '';

// Trois tables éloignées les unes des autres, non fusionnables : chacune ne sert qu'à une réservation
const table = (id, name, seats, x) => ({ id, name, seats, x, y: 40, w: 80, h: 60, shape: 'rect', mergeable: false });
const DB = {
  room: { w: 1200, h: 600 },
  zones: [],
  tables: [table('t1', 'T1', 2, 40), table('t2', 'T2', 4, 400), table('t3', 'T3', 4, 800)],
  groups: [],
  reservations: [],
  settings: { lastRetention: '2999-01-01' },
};

async function api(method, url, body) {
  const res = await fetch(URL + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}
const book = (name, extra = {}) => api('POST', '/reservations', { name, people: 2, date: DATE, time: '20:00', ...extra });
const names = (ids) => ids.map((id) => DB.tables.find((t) => t.id === id).name).join('+');

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gestiontable-test-'));
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
  // Code d'accès de test (base temporaire uniquement)
  const res = await fetch(`${URL}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '2468' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('table tapée à la main (« 1 » = T1), et fixée dès la réservation', async () => {
  const { status, data } = await book('Alice', { tables: '1', pinned: true });
  assert.equal(status, 201);
  assert.equal(names(data.tableIds), 'T1');
  assert.equal(data.pinned, true);
  assert.deepEqual(data.notices, []);
});

test('table déjà prise par une réservation fixée : refusé, rien n’est enregistré', async () => {
  const { status, data } = await book('Bruno', { tables: 'T1' });
  assert.equal(status, 409);
  assert.match(data.error, /Alice/);
  const list = (await api('GET', `/reservations?date=${DATE}`)).data;
  assert.ok(!list.some((r) => r.name === 'Bruno'));
});

test('table occupée (non fixée) : l’autre réservation est déplacée sur une table libre', async () => {
  const claire = (await book('Claire', { tables: 't2' })).data;
  assert.equal(names(claire.tableIds), 'T2');
  const { data: denis } = await book('Denis', { tables: 'T2' });
  assert.equal(names(denis.tableIds), 'T2');
  assert.match(denis.notices[0], /Claire était en T2 : déplacé·e en T3/);
  const list = (await api('GET', `/reservations?date=${DATE}`)).data;
  assert.equal(names(list.find((r) => r.name === 'Claire').tableIds), 'T3');
});

test('plus aucune table libre : la réservation délogée passe « à placer », avec un message', async () => {
  const { data: emma } = await book('Emma', { tables: '3' }); // T3 était à Claire
  assert.equal(names(emma.tableIds), 'T3');
  assert.match(emma.notices[0], /Aucune autre table n'est libre .*Claire est maintenant « à placer »/);
  const list = (await api('GET', `/reservations?date=${DATE}`)).data;
  assert.deepEqual(list.find((r) => r.name === 'Claire').tableIds, []);
});

test('plage « 1-3 » : toutes les tables entre les deux numéros (aussi « T3 - T1 », à l’envers)', async () => {
  const other = { date: '2030-06-16', time: '20:00' };
  const { data: hugo } = await book('Hugo', { ...other, people: 10, tables: '1-3' });
  assert.equal(names(hugo.tableIds), 'T1+T2+T3');
  const { data: ines } = await book('Inès', { ...other, time: '12:00', people: 10, tables: 'T3 - T1' });
  assert.equal(names(ines.tableIds), 'T1+T2+T3');
});

test('plage sans aucune table : erreur claire', async () => {
  const { status, data } = await book('Jules', { tables: '7-9' });
  assert.equal(status, 400);
  assert.match(data.error, /Aucune table entre 7 et 9/);
});

test('aucune table libre : réservation refusée (rien d’enregistré), sauf « enregistrer sans table »', async () => {
  // T1, T2 et T3 sont prises au service du soir (Alice, Denis, Emma)
  const refused = await book('Karim');
  assert.equal(refused.status, 409);
  assert.equal(refused.data.reason, 'no_table');
  assert.match(refused.data.error, /Aucune table libre pour 2 personnes/);
  let list = (await api('GET', `/reservations?date=${DATE}`)).data;
  assert.ok(!list.some((r) => r.name === 'Karim'));

  const accepted = await book('Karim', { allowUnplaced: true });
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted.data.tableIds, []);
  list = (await api('GET', `/reservations?date=${DATE}`)).data;
  assert.ok(list.some((r) => r.name === 'Karim'));
});

test('remplissage par service (points du calendrier) : vide, partiel, complet', async () => {
  // 17 juin à midi : 2 personnes sur T1 seule (1 table sur 3, 2 couverts sur 10) → partiel
  await book('Léa', { date: '2030-06-17', time: '12:00', tables: '1' });
  const { status, data } = await api('GET', `/reservations/summary?from=2030-06-14&to=2030-06-17`);
  assert.equal(status, 200);
  assert.equal(data['2030-06-14'], undefined); // aucune réservation ce jour-là
  // 15 juin au soir : T1, T2, T3 prises (toutes les tables) → complet
  assert.equal(data['2030-06-15'].soir.ratio, 1);
  assert.ok(data['2030-06-17'].midi.ratio > 0.3 && data['2030-06-17'].midi.ratio < 0.34);
  assert.equal(data['2030-06-17'].soir, undefined);
  assert.equal(data['2030-06-16'].soir.count, 1);
  assert.equal((await api('GET', '/reservations/summary?from=2030-06-16&to=2030-06-01')).status, 400);
});

test('table inconnue : erreur claire', async () => {
  const { status, data } = await book('Félix', { tables: '99' });
  assert.equal(status, 400);
  assert.match(data.error, /« 99 » introuvable/);
});

test('modifier : changer de table, puis libérer la fixation', async () => {
  const { data: gina } = await api('POST', '/reservations', { name: 'Gina', people: 3, date: DATE, time: '12:30', tables: '2+3' });
  assert.equal(names(gina.tableIds), 'T2+T3');
  const { data: moved } = await api('PUT', `/reservations/${gina.id}`, { tables: 'T1', pinned: true });
  assert.equal(names(moved.tableIds), 'T1');
  assert.equal(moved.pinned, true);
  const { data: unpinned } = await api('PUT', `/reservations/${gina.id}`, { tables: 'T1', pinned: false });
  assert.equal(unpinned.pinned, undefined);
  assert.equal(names(unpinned.tableIds), 'T1');
});
