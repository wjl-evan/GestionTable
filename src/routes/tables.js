import { Router } from 'express';
import { getDb, persist, httpError } from '../store.js';

const router = Router();

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const CHAIR_SIDES = ['auto', 'tb', 'lr', 'top', 'bottom', 'left', 'right'];

function sanitize(input, current = {}) {
  const { room } = getDb();
  const t = { ...current };
  if (input.name !== undefined) t.name = String(input.name).trim().slice(0, 12) || current.name;
  if (input.seats !== undefined) t.seats = clamp(parseInt(input.seats, 10) || 1, 1, 20);
  // Minimum de personnes pour le placement automatique (et la réservation en ligne) : de 1 (aucun) au nombre de places
  if (input.minPeople !== undefined) {
    const min = parseInt(input.minPeople, 10) || 1;
    if (min > 1) t.minPeople = min;
    else delete t.minPeople;
  }
  if (t.minPeople) t.minPeople = clamp(t.minPeople, 1, t.seats || 1);
  if (t.minPeople === 1) delete t.minPeople;
  if (input.shape !== undefined) t.shape = input.shape === 'round' ? 'round' : 'rect';
  if (input.mergeable !== undefined) t.mergeable = Boolean(input.mergeable);
  // Côtés des chaises (tables rectangulaires) ; 'auto' = sur les deux grands côtés
  if (input.chairs !== undefined) {
    if (CHAIR_SIDES.includes(input.chairs) && input.chairs !== 'auto') t.chairs = input.chairs;
    else delete t.chairs;
  }
  for (const k of ['w', 'h']) {
    if (input[k] !== undefined) t[k] = clamp(Math.round(Number(input[k]) || 80), 40, 400);
  }
  if (t.shape === 'round') t.h = t.w;
  if (input.x !== undefined) t.x = clamp(Math.round(Number(input.x) || 0), 0, room.w - (t.w || 40));
  if (input.y !== undefined) t.y = clamp(Math.round(Number(input.y) || 0), 0, room.h - (t.h || 40));
  if (!t.name) throw httpError(400, 'Nom de table requis');
  return t;
}

router.get('/', (req, res) => res.json(getDb().tables));

router.post('/', async (req, res) => {
  const db = getDb();
  const base = { shape: 'rect', seats: 4, w: 120, h: 80, x: 40, y: 40, mergeable: true };
  const table = sanitize({ ...base, ...req.body }, { id: `t${Date.now().toString(36)}` });
  db.tables.push(table);
  await persist();
  res.status(201).json(table);
});

router.put('/:id', async (req, res) => {
  const db = getDb();
  const idx = db.tables.findIndex((t) => t.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Table introuvable');
  db.tables[idx] = sanitize(req.body, db.tables[idx]);
  await persist();
  res.json(db.tables[idx]);
});

router.delete('/:id', async (req, res) => {
  const db = getDb();
  const idx = db.tables.findIndex((t) => t.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Table introuvable');
  const [removed] = db.tables.splice(idx, 1);
  // Les réservations qui utilisaient cette table repassent "à placer"
  for (const r of db.reservations) {
    if (r.tableIds.includes(removed.id)) {
      r.tableIds = [];
      delete r.manualGroup;
      delete r.pinned;
    }
  }
  // La table quitte ses fusions ; une fusion de moins de 2 tables disparaît
  for (const g of db.groups) g.tableIds = g.tableIds.filter((id) => id !== removed.id);
  db.groups = db.groups.filter((g) => g.tableIds.length >= 2);
  await persist();
  res.status(204).end();
});

export default router;
