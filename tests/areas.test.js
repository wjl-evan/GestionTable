// Tests des zones (salle, étage, terrasse…) : règles et API (vrai serveur, base temporaire) : `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaOfTable, autoAssignByPriority, closedTableIds, isAreaOpen } from '../shared/rules.js';

/* ---------- Règles ---------- */

const area = (id, x, y, w, h, extra = {}) => ({ id, type: 'area', label: id, x, y, w, h, ...extra });
const table = (id, seats, x, y = 40) => ({ id, name: id.toUpperCase(), seats, x, y, w: 80, h: 60, shape: 'rect', mergeable: false });

test('une table appartient à la zone qui contient son centre (la plus petite si emboîtées)', () => {
  const zones = [area('salle', 0, 0, 1000, 600), area('coin', 0, 0, 300, 300), { id: 'b', type: 'bar', x: 0, y: 0, w: 900, h: 900 }];
  assert.equal(areaOfTable(table('t1', 2, 100, 100), zones).id, 'coin');
  assert.equal(areaOfTable(table('t2', 2, 500, 100), zones).id, 'salle');
  assert.equal(areaOfTable(table('t3', 2, 1200, 100), zones), null); // hors de toute zone
});

test('horaires d’une zone : jours (0 = lundi) et services', () => {
  const etage = area('etage', 0, 0, 100, 100, { days: [5, 6], services: ['soir'] });
  assert.equal(isAreaOpen(etage, '2030-06-15', 'soir'), true); // samedi
  assert.equal(isAreaOpen(etage, '2030-06-15', 'midi'), false);
  assert.equal(isAreaOpen(etage, '2030-06-17', 'soir'), false); // lundi
  assert.equal(isAreaOpen(area('salle', 0, 0, 1, 1), '2030-06-17', 'midi'), true); // sans réglage : toujours
  const tables = [table('t1', 2, 10, 10), table('t2', 2, 500, 10)];
  assert.deepEqual([...closedTableIds(tables, [etage], '2030-06-17', 'soir')], ['t1']);
});

test('zone « en dernier recours » : utilisée seulement quand le reste est plein', () => {
  const zones = [area('bas', 0, 0, 500, 300), area('haut', 600, 0, 500, 300, { overflow: true })];
  const tables = [table('t1', 4, 700), table('t2', 4, 100)]; // t1 (en haut) d'abord dans la liste
  const r = (id) => ({ id, people: 2, time: '12:00' });
  assert.deepEqual([...autoAssignByPriority(tables, zones, [r('a')]).values()], [['t2']]);
  const both = autoAssignByPriority(tables, zones, [r('a'), r('b')]);
  assert.deepEqual([...both.values()].flat().sort(), ['t1', 't2']); // le 2e groupe monte
  assert.deepEqual([...autoAssignByPriority(tables, zones, [r('a')], new Set(['t2'])).values()], [['t1']]);
});

/* ---------- API ---------- */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3600 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}`;
let dir;
let server;
let cookie = '';

const z = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
/** Prochaine date (à partir de J+2) dont le jour de la semaine est dans `days` (0 = lundi). */
function nextDay(days) {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  while (!days.includes((d.getDay() + 6) % 7)) d.setDate(d.getDate() + 1);
  return iso(d);
}
const WEEKDAY = nextDay([1]); // mardi
const SATURDAY = nextDay([5]);

// Salle : une table de 2 ; Étage (escalier, ouvert le week-end, en dernier recours, accord du client) : une table de 6
const DB = {
  room: { w: 1200, h: 600 },
  zones: [
    area('salle', 0, 0, 500, 300, { label: 'Salle' }),
    area('etage', 600, 0, 500, 300, { label: 'Étage', description: 'Accès par un escalier', days: [5, 6], overflow: true, confirm: true }),
  ],
  tables: [table('t1', 2, 100), table('t2', 6, 700)],
  groups: [],
  reservations: [],
  users: [],
  settings: {
    lastRetention: '2999-01-01',
    services: [{ id: 'midi', label: 'Midi', start: '12:00', end: '13:30', time: '12:30', days: [0, 1, 2, 3, 4, 5, 6] }],
  },
};

async function call(method, url, body) {
  const res = await fetch(URL + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const client = (extra) =>
  call('POST', '/api/public/reservations', { name: 'Client', email: 'c@test.local', phone: '0612345678', time: '12:30', ...extra });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gestiontable-zones-'));
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
  const res = await fetch(`${URL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', email: 'admin@test.local', password: 'motdepasse-test' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  server?.kill();
  await fs.rm(dir, { recursive: true, force: true });
});

test('zone fermée : ses tables ne sont proposées ni aux clients ni par le placement automatique', async () => {
  // 4 personnes : seule la table de l'étage convient, fermé en semaine
  const avail = (await call('GET', `/api/public/availability?date=${WEEKDAY}&people=4`)).data;
  assert.equal(avail.services[0].full, true);
  assert.equal((await client({ people: 4, date: WEEKDAY })).status, 409);
  const staff = await call('POST', '/api/reservations', { name: 'Équipe', people: 4, date: WEEKDAY, time: '12:30' });
  assert.equal(staff.status, 409);
  assert.equal(staff.data.reason, 'no_table');
});

test('déposer sur une table d’une zone fermée : refusé avec la raison ; à la main : possible', async () => {
  const r = (await call('POST', '/api/reservations', { name: 'Hugo', people: 4, date: WEEKDAY, time: '12:30', allowUnplaced: true })).data;
  const drop = await call('POST', `/api/reservations/${r.id}/assign`, { tableId: 't2' });
  assert.equal(drop.status, 409);
  assert.match(drop.data.error, /Étage.*fermée/);
  assert.equal((await call('POST', `/api/reservations/${r.id}/assign-manual`, { tableIds: ['t2'] })).status, 200);
});

test('le week-end, en ligne : le bas d’abord, sans avertissement', async () => {
  const avail = (await call('GET', `/api/public/availability?date=${SATURDAY}&people=2`)).data;
  assert.equal(avail.services[0].notice, null);
  const res = await client({ people: 2, date: SATURDAY });
  assert.equal(res.status, 201);
  assert.equal(res.data.area, null);
});

test('plus de place en bas : le client est prévenu et doit accepter l’étage', async () => {
  const avail = (await call('GET', `/api/public/availability?date=${SATURDAY}&people=2`)).data;
  assert.deepEqual(avail.services[0].notice, { id: 'etage', label: 'Étage', description: 'Accès par un escalier' });
  const refused = await client({ name: 'Inès', people: 2, date: SATURDAY });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.reason, 'area_confirm');
  assert.match(refused.data.error, /Étage.*escalier/);
  const ok = await client({ name: 'Inès', people: 2, date: SATURDAY, acceptArea: 'etage' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.area.id, 'etage');
  const saved = (await call('GET', `/api/reservations?date=${SATURDAY}`)).data.find((r) => r.name === 'Inès');
  assert.deepEqual(saved.tableIds, ['t2']);
  assert.equal(saved.areaAccepted, 'etage');
});

test('équipe : une réservation va d’abord en bas, l’étage seulement s’il le faut', async () => {
  const SUNDAY = nextDay([6]);
  const first = (await call('POST', '/api/reservations', { name: 'Jade', people: 2, date: SUNDAY, time: '12:30' })).data;
  assert.deepEqual(first.tableIds, ['t1']);
  const second = (await call('POST', '/api/reservations', { name: 'Karim', people: 2, date: SUNDAY, time: '12:30' })).data;
  assert.deepEqual(second.tableIds, ['t2']);
});

test('réglages d’une zone enregistrés (description, jours, services, dernier recours, accord) ; ignorés pour un autre élément', async () => {
  const put = await call('PUT', '/api/plan/zones/salle', { description: 'Rez-de-chaussée', days: [4, 5, 6], services: ['midi', 'inconnu'], overflow: true, confirm: true });
  assert.equal(put.status, 200);
  assert.equal(put.data.overflow, true);
  assert.equal(put.data.confirm, true);
  assert.equal((await call('PUT', '/api/plan/zones/salle', { overflow: false })).data.overflow, undefined);
  assert.equal((await call('PUT', '/api/plan/zones/salle', { hideTag: true })).data.hideTag, true);
  assert.equal((await call('PUT', '/api/plan/zones/salle', { hideTag: false })).data.hideTag, undefined);
  assert.equal((await call('PUT', '/api/plan/zones/salle', { color: '#10B981' })).data.color, '#10b981');
  assert.equal((await call('PUT', '/api/plan/zones/salle', { color: 'red;}' })).data.color, undefined); // invalide : retirée
  assert.equal(put.data.description, 'Rez-de-chaussée');
  assert.deepEqual(put.data.days, [4, 5, 6]);
  assert.deepEqual(put.data.services, ['midi']);
  const all = await call('PUT', '/api/plan/zones/salle', { days: null, services: [] });
  assert.equal(all.data.days, undefined); // tous les jours
  assert.equal(all.data.services, undefined); // tous les services
  const bar = (await call('POST', '/api/plan/zones', { type: 'bar', description: 'x', days: [1], overflow: true })).data;
  assert.equal(bar.overflow, undefined);
  assert.equal(bar.description, undefined);
  assert.equal(bar.days, undefined);
});
