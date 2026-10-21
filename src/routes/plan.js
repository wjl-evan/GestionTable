import { Router } from 'express';
import { getDb, persist, httpError } from '../store.js';

const router = Router();

export const ZONE_TYPES = {
  bar: 'Bar',
  door: 'Entrée',
  window: 'Fenêtre',
  wall: 'Mur',
  kitchen: 'Cuisine',
  wc: 'Toilettes',
  area: 'Zone',
};

const ROOM_MIN = 300;
const ROOM_MAX = 4000;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Ramène un élément à l'intérieur de la salle (taille puis position). */
function fitInRoom(item, room) {
  item.w = Math.min(item.w, room.w);
  item.h = Math.min(item.h, room.h);
  if (item.shape === 'round') item.w = item.h = Math.min(item.w, item.h);
  item.x = clamp(item.x, 0, room.w - item.w);
  item.y = clamp(item.y, 0, room.h - item.h);
  return item;
}

function sanitizeZone(input, current = {}) {
  const { room } = getDb();
  const z = { ...current };
  if (input.type !== undefined) z.type = ZONE_TYPES[input.type] ? input.type : 'area';
  if (input.label !== undefined) z.label = String(input.label).trim().slice(0, 30);
  if (!z.label) z.label = ZONE_TYPES[z.type] || 'Zone';
  for (const k of ['w', 'h']) {
    if (input[k] !== undefined) z[k] = clamp(Math.round(Number(input[k]) || 10), 10, ROOM_MAX);
  }
  for (const k of ['x', 'y']) {
    if (input[k] !== undefined) z[k] = Math.round(Number(input[k]) || 0);
  }
  return fitInRoom(z, room);
}

const planPayload = () => {
  const { room, zones, tables, groups } = getDb();
  return { room, zones, tables, groups };
};

router.get('/', (req, res) => res.json(planPayload()));

/** Redimensionne la salle ; les éléments hors limites sont ramenés à l'intérieur. */
router.put('/room', async (req, res) => {
  const db = getDb();
  const w = Math.round(Number(req.body.w));
  const h = Math.round(Number(req.body.h));
  if (!w || !h) throw httpError(400, 'Dimensions invalides');
  db.room = { w: clamp(w, ROOM_MIN, ROOM_MAX), h: clamp(h, ROOM_MIN, ROOM_MAX) };
  db.tables.forEach((t) => fitInRoom(t, db.room));
  db.zones.forEach((z) => fitInRoom(z, db.room));
  await persist();
  res.json(planPayload());
});

/** Plan vierge : supprime tables et éléments, les réservations repassent "à placer". */
router.delete('/', async (req, res) => {
  const db = getDb();
  db.tables = [];
  db.zones = [];
  db.groups = [];
  db.reservations.forEach((r) => {
    r.tableIds = [];
    delete r.manualGroup;
  });
  await persist();
  res.json(planPayload());
});

router.post('/zones', async (req, res) => {
  const base = { type: 'area', x: 40, y: 40, w: 160, h: 100 };
  const zone = sanitizeZone({ ...base, ...req.body }, { id: `z${Date.now().toString(36)}` });
  getDb().zones.push(zone);
  await persist();
  res.status(201).json(zone);
});

router.put('/zones/:id', async (req, res) => {
  const db = getDb();
  const idx = db.zones.findIndex((z) => z.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Élément introuvable');
  db.zones[idx] = sanitizeZone(req.body, db.zones[idx]);
  await persist();
  res.json(db.zones[idx]);
});

router.delete('/zones/:id', async (req, res) => {
  const db = getDb();
  const idx = db.zones.findIndex((z) => z.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Élément introuvable');
  db.zones.splice(idx, 1);
  await persist();
  res.status(204).end();
});

/* ---------- Fusions manuelles (groupes de tables) ---------- */

const MAX_CAPACITY = 200;
const parseCapacity = (v, fallback) => clamp(Math.round(Number(v) || fallback), 1, MAX_CAPACITY);
const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Crée une fusion de 2 tables ou plus `{ tableIds, capacity }`.
 * Si une fusion des mêmes tables existe déjà, sa capacité est mise à jour.
 * Sans capacité, on prend le total des places.
 */
router.post('/groups', async (req, res) => {
  const db = getDb();
  const tableIds = [...new Set(Array.isArray(req.body.tableIds) ? req.body.tableIds : [])];
  if (tableIds.length < 2) throw httpError(400, 'Choisissez au moins deux tables');
  if (!tableIds.every((id) => db.tables.some((t) => t.id === id))) throw httpError(404, 'Table introuvable');

  const seats = db.tables.filter((t) => tableIds.includes(t.id)).reduce((s, t) => s + t.seats, 0);
  let group = db.groups.find((g) => sameSet(g.tableIds, tableIds));
  if (group) {
    group.capacity = parseCapacity(req.body.capacity, group.capacity);
  } else {
    group = { id: `g${Date.now().toString(36)}`, tableIds, capacity: parseCapacity(req.body.capacity, seats) };
    db.groups.push(group);
  }
  await persist();
  res.status(201).json(group);
});

router.put('/groups/:id', async (req, res) => {
  const group = getDb().groups.find((g) => g.id === req.params.id);
  if (!group) throw httpError(404, 'Fusion introuvable');
  group.capacity = parseCapacity(req.body.capacity, group.capacity);
  await persist();
  res.json(group);
});

router.delete('/groups/:id', async (req, res) => {
  const db = getDb();
  const idx = db.groups.findIndex((g) => g.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Fusion introuvable');
  db.groups.splice(idx, 1);
  await persist();
  res.status(204).end();
});

export default router;
