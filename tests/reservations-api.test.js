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
  // Réservation déjà passée (pour vérifier qu'on peut encore la corriger, sans la déplacer dans le passé)
  reservations: [{ id: 'old', name: 'Ancien', people: 2, date: new Date(Date.now() - 2 * 86400000).toLocaleDateString('sv'), time: '20:00', phone: '', notes: '', internalNote: '', tableIds: [], status: 'left' }],
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
  // Compte administrateur de test (base temporaire uniquement)
  const res = await fetch(`${URL}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Admin', email: 'admin@test.local', password: 'motdepasse-test' }) });
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
  // T3 est à Claire et plus aucune table n'est libre pour elle : on prévient d'abord
  const warned = await book('Emma', { tables: '3' });
  assert.equal(warned.status, 409);
  assert.equal(warned.data.reason, 'displace');
  assert.match(warned.data.error, /aucune autre table n'est libre pour Claire .*Claire passera « à placer »/);
  // « Placer quand même »
  const { data: emma } = await book('Emma', { tables: '3', allowDisplace: true });
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
  const svc = (date, id) => data[date].find((s) => s.id === id);
  // Un élément par service ouvert (midi et soir ; le matin est fermé d'habitude), dans l'ordre
  assert.deepEqual(data['2030-06-14'].map((s) => s.id), ['midi', 'soir']);
  assert.equal(svc('2030-06-14', 'midi').count, 0); // aucune réservation ce jour-là
  // 15 juin au soir : T1, T2, T3 prises (toutes les tables) → complet
  assert.equal(svc('2030-06-15', 'soir').ratio, 1);
  assert.ok(svc('2030-06-17', 'midi').ratio > 0.3 && svc('2030-06-17', 'midi').ratio < 0.34);
  assert.equal(svc('2030-06-17', 'soir').count, 0);
  assert.equal(svc('2030-06-16', 'soir').count, 1);
  assert.equal((await api('GET', '/reservations/summary?from=2030-06-16&to=2030-06-01')).status, 400);
});

test('table choisie trop petite : refusée, sauf « placer quand même »', async () => {
  const other = { date: '2030-06-18', time: '20:00' };
  const refused = await book('Max', { ...other, people: 8, tables: 'T2' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.reason, 'too_small');
  assert.match(refused.data.error, /T2 n'a que 4 places pour 8 personnes/);
  let list = (await api('GET', '/reservations?date=2030-06-18')).data;
  assert.ok(!list.some((r) => r.name === 'Max'));

  const accepted = await book('Max', { ...other, people: 8, tables: 'T2', allowTight: true });
  assert.equal(accepted.status, 201);
  assert.equal(names(accepted.data.tableIds), 'T2');
});

test('services : fermer un midi, ouvrir un matin exceptionnel', async () => {
  const day = '2030-07-01';
  // Midi fermé ce jour-là : réservation refusée…
  await api('PUT', `/services/day/${day}`, { id: 'midi', open: false });
  const refused = await book('Nina', { date: day, time: '12:30' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.reason, 'closed');
  assert.match(refused.data.error, /Le service du midi est fermé le 01\/07\/2030/);
  // … le soir reste ouvert
  assert.equal((await book('Oscar', { date: day, time: '20:00', allowUnplaced: true })).status, 201);
  // Matin : fermé d'habitude, ouvert exceptionnellement
  assert.equal((await book('Paul', { date: day, time: '08:30' })).data.reason, 'closed');
  await api('PUT', `/services/day/${day}`, { id: 'matin', open: true });
  assert.equal((await book('Paul', { date: day, time: '08:30', allowUnplaced: true })).status, 201);
  const summary = (await api('GET', `/reservations/summary?from=${day}&to=${day}`)).data[day];
  assert.deepEqual(summary.map((s) => s.id), ['matin', 'soir']);
  // « Ouvrir ce service et enregistrer » : le midi se rouvre pour la journée
  assert.equal((await book('Nina', { date: day, time: '12:30', allowClosed: true, allowUnplaced: true })).status, 201);
  const { serviceExceptions } = (await api('GET', '/services')).data;
  assert.deepEqual(serviceExceptions[day], { matin: true }); // midi : revenu à l'habitude (ouvert)
});

test('services : réglages (ajout, suppression, validation)', async () => {
  const { data } = await api('GET', '/services');
  const brunch = { label: 'Brunch', start: '10:40', end: '10:55', days: [6] };
  const saved = await api('PUT', '/services', { services: [...data.services, brunch] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.services.map((s) => s.label), ['Matin', 'Brunch', 'Midi', 'Soir']);
  // Même heure de début : refusé
  const dup = await api('PUT', '/services', { services: [...data.services, { label: 'Autre', start: '11:00', end: '12:00', days: [] }] });
  assert.equal(dup.status, 400);
  // Fin après le début du service suivant : refusé (ces réservations iraient au service suivant)
  const overlap = await api('PUT', '/services', { services: [...data.services, { label: 'Goûter', start: '15:00', end: '16:30', days: [] }] });
  assert.equal(overlap.status, 400);
  assert.match(overlap.data.error, /« Goûter » doit finir avant le début de « Soir »/);
  // Sans heure de fin : refusé
  assert.equal((await api('PUT', '/services', { services: [...data.services, { label: 'X', start: '15:00', days: [] }] })).status, 400);
  // Retour à la liste d'origine
  assert.equal((await api('PUT', '/services', { services: data.services })).data.services.length, 3);
});

test('services : heure en dehors des horaires de réservation (après la dernière heure du midi)', async () => {
  // Midi : réservations de 11:00 à 14:30
  const late = await book('Rémi', { date: '2030-07-02', time: '15:00' });
  assert.equal(late.status, 409);
  assert.equal(late.data.reason, 'hours');
  assert.match(late.data.error, /Le service du midi prend les réservations de 11:00 à 14:30/);
  const ok = await book('Rémi', { date: '2030-07-02', time: '15:00', allowLate: true, allowUnplaced: true });
  assert.equal(ok.status, 201);
  // Déplacer une réservation à une heure hors horaires : demandé aussi
  const moved = await api('PUT', `/reservations/${ok.data.id}`, { time: '14:45' });
  assert.equal(moved.data.reason, 'hours');
});

test('historique : création, modifications (pas les tables), changements d’état', async () => {
  const { data: r } = await book('Sam', { date: '2030-08-01', time: '20:00', people: 4, allowUnplaced: true });
  await api('PUT', `/reservations/${r.id}`, { people: 6, time: '20:30' });
  await api('PUT', `/reservations/${r.id}`, { tables: 'T2', allowTight: true, allowDisplace: true }); // tables : non noté
  await api('POST', `/reservations/${r.id}/status`, { status: 'arrived' });
  await api('POST', `/reservations/${r.id}/status`, { status: 'left' });
  const saved = (await api('GET', '/reservations?date=2030-08-01')).data.find((x) => x.id === r.id);
  const types = saved.history.map((h) => h.type);
  assert.deepEqual(types, ['created', 'edited', 'status', 'status']);
  assert.deepEqual(saved.history[0], { ...saved.history[0], people: 4, time: '20:00' });
  assert.deepEqual(saved.history[1].changes, { people: [4, 6], time: ['20:00', '20:30'] });
  assert.ok(saved.history.every((h) => h.by === 'Admin')); // auteur de chaque changement
  assert.deepEqual([saved.history[2].from, saved.history[2].to], ['expected', 'arrived']);
  assert.deepEqual([saved.history[3].from, saved.history[3].to], ['arrived', 'left']);
});

test('annuler : la réservation reste (catégorie « Annulées »), libère sa table, ne compte plus ; rétablir', async () => {
  const day = '2030-08-02';
  const { data: r } = await book('Tom', { date: day, time: '20:00', tables: '1' });
  const cancelled = await api('POST', `/reservations/${r.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.ok(cancelled.data.cancelledAt);
  assert.deepEqual(cancelled.data.tableIds, []); // table libérée
  // Toujours là, mais plus comptée dans le remplissage
  assert.ok((await api('GET', `/reservations?date=${day}`)).data.some((x) => x.id === r.id));
  const soir = (await api('GET', `/reservations/summary?from=${day}&to=${day}`)).data[day].find((s) => s.id === 'soir');
  assert.equal(soir.count, 0);
  // Plus d'arrivée ni de placement tant qu'elle est annulée
  assert.equal((await api('POST', `/reservations/${r.id}/status`, { status: 'arrived' })).status, 409);
  assert.equal((await api('POST', `/reservations/${r.id}/assign`, { tableId: 't1' })).status, 409);
  // Rétablie : une table lui est cherchée
  const restored = (await api('POST', `/reservations/${r.id}/uncancel`)).data;
  assert.equal(restored.cancelledAt, undefined);
  assert.equal(restored.tableIds.length, 1);
  assert.deepEqual(restored.history.map((h) => h.type), ['created', 'cancelled', 'restored']);
});

test('table inconnue : erreur claire', async () => {
  const { status, data } = await book('Félix', { tables: '99' });
  assert.equal(status, 400);
  assert.match(data.error, /« 99 » introuvable/);
});

test('modifier : changer de table, puis libérer la fixation', async () => {
  const { data: gina } = await api('POST', '/reservations', { name: 'Gina', people: 3, date: DATE, time: '12:30', tables: '2+3' });
  assert.equal(names(gina.tableIds), 'T2+T3');
  // T1 n'a que 2 places pour 3 : il faut confirmer (« Placer quand même »)
  const refused = await api('PUT', `/reservations/${gina.id}`, { tables: 'T1', pinned: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.reason, 'too_small');
  assert.match(refused.data.error, /T1 n'a que 2 places pour 3 personnes/);
  const { data: moved } = await api('PUT', `/reservations/${gina.id}`, { tables: 'T1', pinned: true, allowTight: true });
  assert.equal(names(moved.tableIds), 'T1');
  assert.equal(moved.pinned, true);
  const { data: unpinned } = await api('PUT', `/reservations/${gina.id}`, { tables: 'T1', pinned: false });
  assert.equal(unpinned.pinned, undefined);
  assert.equal(names(unpinned.tableIds), 'T1');
});

test('pas de réservation dans le passé (date ou heure passée) ; corriger une réservation passée reste possible', async () => {
  const yesterday = new Date(Date.now() - 86400000);
  const z = (n) => String(n).padStart(2, '0');
  const past = `${yesterday.getFullYear()}-${z(yesterday.getMonth() + 1)}-${z(yesterday.getDate())}`;
  const created = await book('Passé', { date: past, allowClosed: true, allowLate: true, allowUnplaced: true });
  assert.equal(created.status, 400);
  assert.equal(created.data.reason, 'past');
  const future = (await book('Futur', { allowUnplaced: true })).data;
  const moved = await api('PUT', `/reservations/${future.id}`, { date: past });
  assert.equal(moved.status, 400);
  assert.equal(moved.data.reason, 'past');
  assert.equal((await api('PUT', '/reservations/old', { name: 'Ancien client' })).status, 200);
});

test('déposer sur une table occupée : confirmation, puis l’autre réservation est déplacée (ou « à placer »)', async () => {
  const D = '2030-06-20';
  const anna = (await book('Anna', { date: D, people: 4, tables: 'T2' })).data;
  const ben = (await book('Ben', { date: D, people: 4, allowUnplaced: true, tables: 'T3' })).data;
  const carl = (await book('Carl', { date: D, people: 4, allowUnplaced: true })).data;
  assert.deepEqual(carl.tableIds, []); // T2 et T3 prises, T1 trop petite

  // 1. Sans confirmation : refusé, avec ce qui arrivera à Anna
  await api('POST', `/reservations/${ben.id}/unassign`);
  const ask = await api('POST', `/reservations/${ben.id}/assign`, { tableId: 't2' });
  assert.equal(ask.status, 409);
  assert.equal(ask.data.reason, 'occupied');
  assert.match(ask.data.error, /T2 est occupée par Anna[\s\S]*Anna \(4 pers\.\) sera déplacé·e en T3/);
  // 2. Confirmé : Ben prend T2, Anna part en T3
  const ok = await api('POST', `/reservations/${ben.id}/assign`, { tableId: 't2', allowDisplace: true });
  assert.equal(ok.status, 200);
  assert.equal(names(ok.data.reservation.tableIds), 'T2');
  let list = (await api('GET', `/reservations?date=${D}`)).data;
  assert.equal(names(list.find((r) => r.name === 'Anna').tableIds), 'T3');

  // 3. Plus aucune table libre pour la réservation délogée : on prévient, puis elle passe « à placer »
  const ask2 = await api('POST', `/reservations/${carl.id}/assign`, { tableId: 't3' });
  assert.match(ask2.data.error, /Aucune autre table libre n'a été trouvée pour Anna/);
  await api('POST', `/reservations/${carl.id}/assign`, { tableId: 't3', allowDisplace: true });
  list = (await api('GET', `/reservations?date=${D}`)).data;
  assert.equal(names(list.find((r) => r.name === 'Carl').tableIds), 'T3');
  assert.deepEqual(list.find((r) => r.name === 'Anna').tableIds, []);

  // 4. Réservation fixée : on ne la déloge pas
  await api('POST', `/reservations/${carl.id}/pin`, { pinned: true });
  const pinned = await api('POST', `/reservations/${anna.id}/assign`, { tableId: 't3', allowDisplace: true });
  assert.equal(pinned.status, 409);
  assert.match(pinned.data.error, /fixé/);
});

test('clients sans réservation : créés à la table choisie, déjà arrivés', async () => {
  const D = '2030-06-21';
  const { status, data } = await book('Sans réservation', { date: D, people: 3, tables: 'T2', arrived: true, allowTight: true, allowLate: true, allowClosed: true });
  assert.equal(status, 201);
  assert.equal(names(data.tableIds), 'T2');
  assert.equal(data.status, 'arrived');
  assert.ok(data.arrivedAt);
  assert.equal(data.walkIn, true);
  assert.deepEqual(data.history.map((h) => h.type), ['created', 'status']);
});
