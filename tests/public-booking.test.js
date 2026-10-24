// Tests de la réservation en ligne (vrai serveur, base temporaire) : `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3700 + Math.floor(Math.random() * 90);
const URL = `http://localhost:${PORT}`;
let dir;
let server;

const z = (n) => String(n).padStart(2, '0');
const isoIn = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
const DATE = isoIn(3);

// Deux tables de 4, non fusionnables ; un service Midi ouvert tous les jours de 12:00 à 13:30
const table = (id, name, x) => ({ id, name, seats: 4, x, y: 40, w: 80, h: 60, shape: 'rect', mergeable: false });
const DB = {
  room: { w: 1200, h: 600 },
  zones: [],
  tables: [table('t1', 'T1', 40), table('t2', 'T2', 400)],
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
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const CLIENT = { name: 'Claire', email: 'claire@test.local', phone: '06 12 34 56 78', people: 2, date: DATE, time: '12:15' };
const book = (extra = {}) => call('POST', '/api/public/reservations', { ...CLIENT, ...extra });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gestiontable-public-'));
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

test('la page publique est à la racine, l’application de l’équipe sur /gestion', async () => {
  assert.match(await (await fetch(`${URL}/`)).text(), /Réserver une table/);
  assert.match(await (await fetch(`${URL}/gestion`)).text(), /id="authScreen"/);
});

test('créneaux de 15 min du début à la dernière heure du service', async () => {
  const { status, data } = await call('GET', `/api/public/availability?date=${DATE}&people=2`);
  assert.equal(status, 200);
  assert.deepEqual(data.services[0].slots.map((s) => s.time), ['12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30']);
  assert.ok(data.services[0].slots.every((s) => s.available));
});

test('date passée ou trop lointaine refusée', async () => {
  assert.equal((await call('GET', `/api/public/availability?date=${isoIn(-1)}&people=2`)).status, 400);
  assert.equal((await book({ date: isoIn(-1) })).status, 400);
  assert.equal((await book({ date: isoIn(400) })).status, 400);
});

test('heure hors des quarts d’heure ou hors du service refusée', async () => {
  assert.equal((await book({ time: '12:10' })).status, 409);
  assert.equal((await book({ time: '13:45' })).status, 409);
  assert.equal((await book({ time: '19:00' })).status, 409);
});

test('email et téléphone obligatoires', async () => {
  assert.equal((await book({ email: '' })).status, 400);
  assert.equal((await book({ email: 'pas-un-email' })).status, 400);
  assert.equal((await book({ phone: '' })).status, 400);
  assert.equal((await book({ phone: '12' })).status, 400);
  assert.equal((await book({ people: 40 })).status, 400);
});

test('le client ne choisit pas sa table : elle est attribuée automatiquement', async () => {
  const { status, data } = await book({ tables: 'T2', tableIds: ['t2'], notes: 'Anniversaire' });
  assert.equal(status, 201);
  assert.equal(data.tableIds, undefined); // rien d'interne n'est renvoyé au client
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'db.json'), 'utf8')).reservations.find((r) => r.name === 'Claire');
  assert.deepEqual(saved.tableIds, ['t1']); // choisie par le placement automatique, pas « T2 »
  assert.equal(saved.source, 'online');
  assert.equal(saved.email, 'claire@test.local');
  assert.equal(saved.notes, 'Anniversaire');
  assert.equal(saved.history[0].by, 'Réservation en ligne');
});

test('plus de table libre : service complet, réservation refusée', async () => {
  assert.equal((await book({ name: 'Bruno', email: 'bruno@test.local' })).status, 201); // prend T2
  const avail = (await call('GET', `/api/public/availability?date=${DATE}&people=2`)).data;
  assert.equal(avail.services[0].full, true);
  assert.ok(avail.services[0].slots.every((s) => !s.available));
  const { status, data } = await book({ name: 'Denis', email: 'denis@test.local' });
  assert.equal(status, 409);
  assert.equal(data.reason, 'full');
});

test('les routes de l’équipe restent protégées', async () => {
  assert.equal((await call('GET', `/api/reservations?date=${DATE}`)).status, 401);
});

/* ---------- Réglages de la réservation en ligne ---------- */

const DATE2 = isoIn(5);
let cookie = '';
const asStaff = (method, url, body) =>
  fetch(URL + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) })
    .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }));
const slotsOn = async (date, people = 2) => (await call('GET', `/api/public/availability?date=${date}&people=${people}`)).data.services;

test('réglages : réservés à l’équipe connectée, valeurs vérifiées', async () => {
  assert.equal((await call('PUT', '/api/settings/booking', { maxDays: 5 })).status, 401);
  const res = await fetch(`${URL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', email: 'admin@test.local', password: 'motdepasse-test' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await asStaff('PUT', '/api/settings/booking', { step: 20 })).status, 400);
  assert.equal((await asStaff('PUT', '/api/settings/booking', { maxDays: 0 })).status, 400);
  assert.equal((await asStaff('PUT', '/api/settings/booking', { restaurantPhone: 'abc' })).status, 400);
});

test('nom et téléphone du restaurant visibles sur la page publique', async () => {
  await asStaff('PUT', '/api/settings/booking', { restaurantName: 'Chez Test', restaurantPhone: '01 23 45 67 89', message: 'Terrasse fermée' });
  const info = (await call('GET', '/api/public/info')).data;
  assert.equal(info.restaurantName, 'Chez Test');
  assert.equal(info.restaurantPhone, '01 23 45 67 89');
  assert.equal(info.message, 'Terrasse fermée');
  assert.equal(info.maxCoversPerSlot, undefined); // les réglages internes ne sont pas publiés
});

test('créneaux toutes les 30 min, et jours à l’avance limités', async () => {
  await asStaff('PUT', '/api/settings/booking', { step: 30, maxDays: 2 });
  assert.equal((await call('GET', `/api/public/availability?date=${DATE}&people=2`)).status, 400); // J+3 > 2 jours
  await asStaff('PUT', '/api/settings/booking', { maxDays: 60 });
  assert.deepEqual((await slotsOn(DATE2))[0].slots.map((s) => s.time), ['12:00', '12:30', '13:00', '13:30']);
  assert.equal((await book({ date: DATE2, time: '12:15' })).status, 409); // plus un créneau proposé
  await asStaff('PUT', '/api/settings/booking', { step: 15 });
});

test('email facultatif : accepté vide, mais vérifié s’il est donné', async () => {
  await asStaff('PUT', '/api/settings/booking', { requireEmail: false });
  assert.equal((await call('GET', '/api/public/info')).data.requireEmail, false);
  assert.equal((await book({ name: 'Émile', email: 'pas-un-email', date: DATE2, time: '12:00' })).status, 400);
  assert.equal((await book({ name: 'Émile', email: '', date: DATE2, time: '12:00' })).status, 201);
  assert.equal((await book({ name: 'Fanny', phone: '', date: DATE2, time: '12:30' })).status, 400); // téléphone toujours obligatoire
});

test('couverts par créneau : l’heure pleine n’est plus proposée', async () => {
  await asStaff('PUT', '/api/settings/booking', { maxCoversPerSlot: 3 });
  const slots = (await slotsOn(DATE2))[0].slots;
  assert.equal(slots.find((s) => s.time === '12:00').available, false); // Émile (2) + 2 > 3
  assert.equal(slots.find((s) => s.time === '12:15').available, true);
  assert.equal((await book({ name: 'Gilles', date: DATE2, time: '12:00' })).status, 409);
  await asStaff('PUT', '/api/settings/booking', { maxCoversPerSlot: 0 });
});

test('délai minimum : les créneaux trop proches restent affichés mais grisés, et sont refusés', async () => {
  await asStaff('PUT', '/api/settings/booking', { minNoticeMinutes: 7 * 24 * 60 });
  const slots = (await slotsOn(DATE2))[0].slots; // J+5 : moins de 7 jours
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.tooSoon && !s.available));
  const res = await book({ name: 'Trop tôt', date: DATE2, time: '13:00' });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /trop proche.*7 jours/);
  await asStaff('PUT', '/api/settings/booking', { minNoticeMinutes: 60 });
});

test('réservation en ligne fermée : page et API refusent, avec le message choisi', async () => {
  await asStaff('PUT', '/api/settings/booking', { enabled: false, closedMessage: 'Fermé pour travaux' });
  const info = (await call('GET', '/api/public/info')).data;
  assert.equal(info.enabled, false);
  assert.deepEqual(info.openDays, []);
  const res = await book({ date: DATE2, time: '13:00' });
  assert.equal(res.status, 403);
  assert.equal(res.data.error, 'Fermé pour travaux');
  assert.equal((await call('GET', `/api/public/availability?date=${DATE2}&people=2`)).status, 403);
  await asStaff('PUT', '/api/settings/booking', { enabled: true });
});

test('minimum de personnes par table : un groupe plus petit ne l’a pas, en ligne non plus', async () => {
  const date = isoIn(6);
  for (const id of ['t1', 't2']) {
    const { status, data } = await asStaff('PUT', `/api/tables/${id}`, { minPeople: 3 });
    assert.equal(status, 200);
    assert.equal(data.minPeople, 3);
  }
  assert.equal((await slotsOn(date, 2))[0].full, true); // 2 personnes : aucune table pour eux
  assert.equal((await slotsOn(date, 3))[0].full, false);
  const small = await book({ name: 'Petit groupe', date, time: '12:30' });
  assert.equal(small.status, 409);
  assert.equal(small.data.reason, 'full');
  assert.equal((await book({ name: 'Groupe de 3', people: 3, date, time: '12:30' })).status, 201);
  // Minimum plafonné au nombre de places ; 1 = aucun minimum
  assert.equal((await asStaff('PUT', '/api/tables/t1', { minPeople: 9 })).data.minPeople, 4);
  for (const id of ['t1', 't2']) assert.equal((await asStaff('PUT', `/api/tables/${id}`, { minPeople: 1 })).data.minPeople, undefined);
});
