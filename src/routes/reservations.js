import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb, persist, httpError } from '../store.js';
import { archivedBetween, archivedReservations } from '../retention.js';
import { autoAssign, capacityOf, findCombination, isActive, serviceOf, STATUSES, statusOf } from '../../shared/rules.js';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(input, current = {}) {
  const r = { ...current };
  if (input.name !== undefined) r.name = String(input.name).trim().slice(0, 60);
  if (input.people !== undefined) r.people = parseInt(input.people, 10);
  if (input.date !== undefined) r.date = String(input.date);
  if (input.time !== undefined) r.time = String(input.time);
  if (input.phone !== undefined) r.phone = String(input.phone).trim().slice(0, 30);
  if (input.notes !== undefined) r.notes = String(input.notes).trim().slice(0, 300);
  // Note interne : réservée à l'équipe (jamais communiquée au client)
  if (input.internalNote !== undefined) r.internalNote = String(input.internalNote).trim().slice(0, 500);

  if (!r.name) throw httpError(400, 'Le nom est requis');
  if (!Number.isInteger(r.people) || r.people < 1 || r.people > 50) {
    throw httpError(400, 'Nombre de personnes invalide (1 à 50)');
  }
  if (!DATE_RE.test(r.date || '')) throw httpError(400, 'Date invalide');
  if (!TIME_RE.test(r.time || '')) throw httpError(400, 'Heure invalide');
  return r;
}

function findReservation(id) {
  const r = getDb().reservations.find((x) => x.id === id);
  if (!r) throw httpError(404, 'Réservation introuvable');
  return r;
}

/** Tables occupées par les autres réservations du même service (les clients partis les ont libérées). */
function busyTables(reservation) {
  const service = serviceOf(reservation.time);
  return new Set(
    getDb()
      .reservations.filter(
        (r) =>
          r.id !== reservation.id && r.date === reservation.date && serviceOf(r.time) === service && isActive(r)
      )
      .flatMap((r) => r.tableIds)
  );
}

/**
 * Tables d'une réservation. `manual` = regroupement choisi à la main pour ce service
 * (peut avoir moins de places que de personnes, on se serre) — pas une fusion permanente du plan.
 */
function setTables(reservation, tableIds, manual = false) {
  reservation.tableIds = tableIds;
  if (manual && tableIds.length) reservation.manualGroup = true;
  else delete reservation.manualGroup;
  if (!tableIds.length) delete reservation.pinned; // plus de table : plus rien à fixer
}

/** Réservation fixée à ses tables : on ne la déplace pas sans l'avoir libérée d'abord. */
function assertNotPinned(reservation) {
  if (reservation.pinned) {
    throw httpError(409, `${reservation.name} est fixé·e à ses tables. Touchez « Fixée » pour la libérer avant de la déplacer.`);
  }
}

/** Essaie de placer automatiquement une réservation à placer (nouvelle ou changée de service). */
function autoPlace(reservation) {
  if (reservation.tableIds.length || !isActive(reservation)) return false;
  const db = getDb();
  const placement = autoAssign(db.tables, [reservation], busyTables(reservation), db.groups).get(reservation.id);
  if (placement) setTables(reservation, placement);
  return Boolean(placement);
}

const tableNamesOf = (ids) => ids.map((id) => getDb().tables.find((t) => t.id === id)?.name).filter(Boolean).join(' + ');

const RANGE_RE = /^([a-z]*)\s*(\d+)\s*[-–—]\s*([a-z]*)\s*(\d+)$/i; // « 66-70 », « T66 - T70 »
const MAX_RANGE = 40;

/**
 * Tables tapées dans le formulaire (« 12 », « T12 », « 50+51 », « 50, 51 », « 50 51 »,
 * plage « 66-70 » = 66, 67, 68, 69 et 70) → ids.
 * Vide → []. Une table inconnue → erreur 400 qui la nomme.
 */
function resolveTableInput(input) {
  const { tables } = getDb();
  const byName = (token) => {
    const key = token.trim().toLowerCase();
    if (!key) return null;
    return tables.find((t) => t.name.toLowerCase() === key) ?? tables.find((t) => t.name.toLowerCase() === `t${key}`);
  };
  // Plage : toutes les tables entre les deux numéros (celles qui n'existent pas sont ignorées)
  const byRange = (token) => {
    const m = token.trim().match(RANGE_RE);
    if (!m) return null;
    const prefix = m[1] || m[3];
    let [from, to] = [Number(m[2]), Number(m[4])];
    if (from > to) [from, to] = [to, from];
    if (to - from + 1 > MAX_RANGE) throw httpError(400, `Plage « ${token.trim()} » trop grande (${MAX_RANGE} tables au plus).`);
    const found = [];
    for (let n = from; n <= to; n++) {
      const t = byName(`${prefix}${n}`);
      if (t) found.push(t);
    }
    if (!found.length) throw httpError(400, `Aucune table entre ${from} et ${to} sur le plan.`);
    return found;
  };
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[,+;]/);
  const ids = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    // « T12 » ou « Bar 1 » tel quel ; une plage « 66-70 » ; sinon « 50 51 » séparés par des espaces
    const found = byName(part) ? [byName(part)] : byRange(part) ?? part.trim().split(/\s+/).map(byName);
    if (found.some((t) => !t)) throw httpError(400, `Table « ${part.trim()} » introuvable sur le plan.`);
    for (const t of found) if (!ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

/** Réservations du même service qui occupent l'une de ces tables. */
function occupantsOf(reservation, tableIds) {
  const service = serviceOf(reservation.time);
  return getDb().reservations.filter(
    (o) =>
      o.id !== reservation.id && o.date === reservation.date && serviceOf(o.time) === service &&
      isActive(o) && o.tableIds.some((id) => tableIds.includes(id))
  );
}

/** Vérifie, avant tout changement, qu'on peut libérer ces tables (ni réservation fixée, ni clients installés). */
function assertTablesFreeable(reservation, tableIds) {
  for (const o of occupantsOf(reservation, tableIds)) {
    const why = o.pinned ? 'qui y est fixé·e' : statusOf(o) === 'arrived' ? 'déjà installé·e' : null;
    if (why) throw httpError(409, `${tableNamesOf(o.tableIds)} est déjà prise par ${o.name}, ${why} : choisissez une autre table.`);
  }
}

/**
 * Place la réservation sur les tables choisies à la main (on peut se serrer). Les réservations
 * qui y étaient sont déplacées sur une autre table libre ; s'il n'y en a pas, elles repassent
 * « à placer ». Renvoie les messages à afficher.
 */
function placeOnChosenTables(reservation, tableIds) {
  const notices = [];
  const occupants = occupantsOf(reservation, tableIds);
  setTables(reservation, tableIds, true);
  for (const o of occupants) {
    const before = tableNamesOf(o.tableIds);
    setTables(o, []);
    if (autoPlace(o)) notices.push(`${o.name} était en ${before} : déplacé·e en ${tableNamesOf(o.tableIds)}.`);
    else notices.push(`${before} était occupée par ${o.name}. Aucune autre table n'est libre pour ${o.people} personne${o.people > 1 ? 's' : ''} : ${o.name} est maintenant « à placer ».`);
  }
  return notices;
}

/**
 * Tables choisies à la main trop petites : on demande confirmation (« Placer quand même »,
 * on se serre) au lieu d'enregistrer directement.
 */
/**
 * Tables choisies déjà prises : on vérifie, sans rien changer, que les réservations délogées
 * retrouveront une table libre. Sinon on prévient (elles passeraient « à placer ») et on attend
 * la confirmation (« Placer quand même »).
 */
function assertDisplaceable(reservation, tableIds, allowDisplace) {
  if (allowDisplace) return;
  const occupants = occupantsOf(reservation, tableIds);
  if (!occupants.length) return;
  const db = getDb();
  const service = serviceOf(reservation.time);
  const moving = new Set([reservation.id, ...occupants.map((o) => o.id)]);
  // Tables occupées une fois la nouvelle réservation installée (sans les réservations à déplacer)
  const busy = new Set([
    ...tableIds,
    ...db.reservations
      .filter((o) => !moving.has(o.id) && o.date === reservation.date && serviceOf(o.time) === service && isActive(o))
      .flatMap((o) => o.tableIds),
  ]);
  const placed = autoAssign(db.tables, occupants, busy, db.groups);
  const stranded = occupants.filter((o) => !placed.has(o.id));
  if (!stranded.length) return;
  const who = stranded.map((o) => `${o.name} (${o.people} pers., ${tableNamesOf(o.tableIds)})`).join(', ');
  throw httpError(
    409,
    `${tableNamesOf(tableIds)} est déjà prise et aucune autre table n'est libre pour ${who}. Si vous continuez, ${stranded.length > 1 ? 'ces réservations passeront' : `${stranded[0].name} passera`} « à placer ».`,
    'displace'
  );
}

function assertBigEnough(reservation, tableIds, allowTight) {
  if (allowTight) return;
  const db = getDb();
  const capacity = capacityOf(db.tables, tableIds, db.groups);
  if (capacity >= reservation.people) return;
  const names = tableNamesOf(tableIds);
  throw httpError(
    409,
    `${names} n'${tableIds.length > 1 ? 'ont' : 'a'} que ${capacity} place${capacity > 1 ? 's' : ''} pour ${reservation.people} personnes.`,
    'too_small'
  );
}

/** Fixe la réservation si on l'a demandé (et si elle a une table). */
function applyPinned(reservation, wanted, notices) {
  if (wanted === undefined) return;
  if (wanted && reservation.tableIds.length) reservation.pinned = true;
  else delete reservation.pinned;
  if (wanted && !reservation.tableIds.length) notices.push(`Aucune table libre : ${reservation.name} n'a pas pu être fixé·e.`);
}

/**
 * Remplissage de chaque service sur une période (pour les points du calendrier) :
 * { 'AAAA-MM-JJ': { midi: { count, covers, ratio }, soir: { … } } }.
 * `ratio` = la plus forte des deux proportions : tables prises / tables du plan, couverts / places
 * (une réservation pas encore placée compte donc aussi). Les clients partis comptent : c'est
 * le remplissage du service, pas l'occupation à l'instant.
 */
router.get('/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from > to) throw httpError(400, 'Période invalide');
  if ((new Date(to) - new Date(from)) / 864e5 > 62) throw httpError(400, 'Période trop longue (2 mois au plus)');
  const db = getDb();
  const ids = new Set(db.reservations.map((r) => r.id));
  const list = [
    ...db.reservations.filter((r) => r.date >= from && r.date <= to),
    ...(await archivedBetween(from, to)).filter((r) => !ids.has(r.id)),
  ];
  const tableCount = db.tables.length || 1;
  const seatCount = db.tables.reduce((s, t) => s + t.seats, 0) || 1;
  const days = {};
  for (const r of list) {
    const day = (days[r.date] ??= {});
    const s = (day[serviceOf(r.time)] ??= { count: 0, covers: 0, tables: new Set() });
    s.count++;
    s.covers += r.people;
    for (const id of r.tableIds) s.tables.add(id);
  }
  for (const day of Object.values(days)) {
    for (const [service, s] of Object.entries(day)) {
      const ratio = Math.max(s.tables.size / tableCount, s.covers / seatCount);
      day[service] = { count: s.count, covers: s.covers, ratio: Math.min(ratio, 1) }; // 1 = complet
    }
  }
  res.json(days);
});

router.get('/', async (req, res) => {
  const { date } = req.query;
  let list = getDb().reservations;
  if (date) {
    if (!DATE_RE.test(date)) throw httpError(400, 'Date invalide');
    list = list.filter((r) => r.date === date);
    // Date ancienne : on ajoute ce qui est aux archives (consultation seule, marqué « archived »)
    const ids = new Set(list.map((r) => r.id));
    list = [...list, ...(await archivedReservations(date)).filter((r) => !ids.has(r.id))];
  }
  res.json([...list].sort((a, b) => a.time.localeCompare(b.time)));
});

router.post('/', async (req, res) => {
  const r = validate(req.body, {
    id: crypto.randomUUID(),
    phone: '',
    notes: '',
    internalNote: '',
    tableIds: [],
    status: 'expected',
    createdAt: new Date().toISOString(),
  });
  // Tables choisies dans le formulaire : vérifiées avant d'enregistrer quoi que ce soit
  const chosen = resolveTableInput(req.body.tables);
  if (chosen.length) {
    assertTablesFreeable(r, chosen);
    assertBigEnough(r, chosen, req.body.allowTight);
    assertDisplaceable(r, chosen, req.body.allowDisplace);
  }
  // Aucune table libre : on n'enregistre pas, sauf si on a choisi de la prendre quand même (« à placer »)
  if (!chosen.length && !req.body.allowUnplaced) {
    const db = getDb();
    const placement = autoAssign(db.tables, [r], busyTables(r), db.groups).get(r.id);
    if (!placement) {
      throw httpError(
        409,
        `Aucune table libre pour ${r.people} personne${r.people > 1 ? 's' : ''} au service du ${serviceOf(r.time)} du ${r.date.split('-').reverse().join('/')}.`,
        'no_table'
      );
    }
  }

  getDb().reservations.push(r);
  const notices = chosen.length
    ? placeOnChosenTables(r, chosen)
    : (autoPlace(r), []); // sinon une table libre lui est attribuée tout de suite (ou « à placer »)
  applyPinned(r, req.body.pinned === undefined ? undefined : Boolean(req.body.pinned), notices);
  await persist();
  // `notices` : messages pour l'écran (non enregistrés)
  res.status(201).json({ ...r, notices });
});

router.put('/:id', async (req, res) => {
  const db = getDb();
  const current = findReservation(req.params.id);
  const next = validate(req.body, current);
  // Tables du formulaire : prises en compte seulement si on les a changées
  const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
  const chosen = req.body.tables === undefined ? null : resolveTableInput(req.body.tables);
  const changeTables = chosen !== null && !sameSet(chosen, current.tableIds);
  if (changeTables && chosen.length) {
    assertTablesFreeable(next, chosen);
    assertBigEnough(next, chosen, req.body.allowTight);
    assertDisplaceable(next, chosen, req.body.allowDisplace);
  }

  // Changement de service ou table devenue trop petite → la réservation repasse "à placer"
  // (sauf regroupement choisi à la main ou réservation fixée : on a déjà accepté de se serrer)
  const moved = next.date !== current.date || serviceOf(next.time) !== serviceOf(current.time);
  const tooSmall = !current.manualGroup && !current.pinned && capacityOf(db.tables, next.tableIds, db.groups) < next.people;
  Object.assign(current, next);
  let notices = [];
  if (changeTables && chosen.length) {
    notices = placeOnChosenTables(current, chosen);
  } else if (changeTables || moved || tooSmall) {
    setTables(current, []);
    autoPlace(current); // nouvelle table cherchée automatiquement
  }
  applyPinned(current, req.body.pinned === undefined ? undefined : Boolean(req.body.pinned), notices);
  await persist();
  res.json({ ...current, notices });
});

router.delete('/:id', async (req, res) => {
  const db = getDb();
  const idx = db.reservations.findIndex((r) => r.id === req.params.id);
  if (idx === -1) throw httpError(404, 'Réservation introuvable');
  db.reservations.splice(idx, 1);
  await persist();
  res.status(204).end();
});

/**
 * Attribue une table. Si elle est trop petite, les tables voisines libres
 * et fusionnables sont combinées automatiquement.
 */
router.post('/:id/assign', async (req, res) => {
  const db = getDb();
  const reservation = findReservation(req.params.id);
  assertNotPinned(reservation);
  const table = db.tables.find((t) => t.id === req.body.tableId);
  if (!table) throw httpError(404, 'Table introuvable');
  if (!isActive(reservation)) throw httpError(409, `${reservation.name} est déjà parti·e. Rétablissez la réservation d'abord.`);

  const busy = busyTables(reservation);
  if (busy.has(table.id)) throw httpError(409, `${table.name} est déjà occupée sur ce service.`);

  const combo = findCombination(db.tables, table.id, reservation.people, busy, db.groups);
  if (!combo) {
    const canMerge = table.mergeable || db.groups.some((g) => g.tableIds.includes(table.id));
    const reason = canMerge
      ? `Pas assez de tables liées libres autour de ${table.name} pour ${reservation.people} personnes.`
      : `${table.name} (${table.seats} places) est trop petite et ne peut pas être fusionnée.`;
    throw httpError(409, reason);
  }

  setTables(reservation, combo);
  await persist();
  res.json({ reservation, merged: combo.length > 1 });
});

/**
 * Place la réservation sur des tables choisies à la main, pour ce service uniquement.
 * Accepté même si le total de places est inférieur au nombre de personnes.
 */
router.post('/:id/assign-manual', async (req, res) => {
  const db = getDb();
  const reservation = findReservation(req.params.id);
  if (!isActive(reservation)) throw httpError(409, `${reservation.name} est déjà parti·e. Rétablissez la réservation d'abord.`);
  assertNotPinned(reservation);

  const tableIds =[...new Set(Array.isArray(req.body.tableIds) ? req.body.tableIds : [])];
  if (!tableIds.length) throw httpError(400, 'Choisissez au moins une table');
  const tables = tableIds.map((id) => db.tables.find((t) => t.id === id));
  if (tables.some((t) => !t)) throw httpError(404, 'Table introuvable');

  const busy = busyTables(reservation);
  const taken = tables.filter((t) => busy.has(t.id)).map((t) => t.name);
  if (taken.length) throw httpError(409, `${taken.join(', ')} ${taken.length > 1 ? 'sont déjà occupées' : 'est déjà occupée'} sur ce service.`);

  setTables(reservation, tableIds, true);
  await persist();
  res.json({ reservation, capacity: capacityOf(db.tables, tableIds, db.groups) });
});

/** Place automatiquement toutes les réservations non placées d'un service. */
router.post('/auto-assign', async (req, res) => {
  const { date, service } = req.body;
  if (!DATE_RE.test(date || '')) throw httpError(400, 'Date invalide');
  if (!['midi', 'soir'].includes(service)) throw httpError(400, 'Service invalide');

  const db = getDb();
  const sameService = db.reservations.filter((r) => r.date === date && serviceOf(r.time) === service);
  const busy = new Set(sameService.filter(isActive).flatMap((r) => r.tableIds));
  const pending = sameService.filter((r) => !r.tableIds.length && isActive(r));

  const placements = autoAssign(db.tables, pending, busy, db.groups);
  for (const r of pending) {
    if (placements.has(r.id)) setTables(r, placements.get(r.id));
  }
  if (placements.size) await persist();

  res.json({
    placed: placements.size,
    unplaced: pending.filter((r) => !placements.has(r.id)).map((r) => r.name),
    reservations: sameService,
  });
});

/**
 * Change le statut : attendu → arrivé → parti.
 * "Parti" libère les tables pour le reste du service (elles restent notées pour l'historique).
 * Si on rétablit un client parti alors que ses tables ont été redonnées, il repasse "à placer".
 */
router.post('/:id/status', async (req, res) => {
  const reservation = findReservation(req.params.id);
  const { status } = req.body;
  if (!STATUSES.includes(status)) throw httpError(400, 'Statut invalide');

  let conflict = false;
  if (!isActive(reservation) && status !== 'left' && reservation.tableIds.length) {
    const busy = busyTables(reservation);
    if (reservation.tableIds.some((id) => busy.has(id))) {
      setTables(reservation, []);
      conflict = true;
    }
  }

  const now = new Date().toISOString();
  if (status === 'expected') delete reservation.arrivedAt;
  if (status !== 'expected' && statusOf(reservation) === 'expected') reservation.arrivedAt = now;
  if (status === 'left') reservation.leftAt = now;
  else delete reservation.leftAt;
  reservation.status = status;

  await persist();
  res.json({ reservation, conflict });
});

router.post('/:id/unassign', async (req, res) => {
  const reservation = findReservation(req.params.id);
  assertNotPinned(reservation);
  setTables(reservation, []);
  await persist();
  res.json(reservation);
});

/** Fixe (ou libère) une réservation à ses tables : ni « Auto », ni « Tout retirer » n'y touchent. */
router.post('/:id/pin', async (req, res) => {
  const reservation = findReservation(req.params.id);
  const pinned = Boolean(req.body.pinned);
  if (pinned && !reservation.tableIds.length) throw httpError(409, 'Placez d’abord la réservation sur une table pour la fixer.');
  if (pinned) reservation.pinned = true;
  else delete reservation.pinned;
  await persist();
  res.json(reservation);
});

/**
 * Retire du plan toutes les réservations d'un service pour recommencer à zéro.
 * Gardées : les réservations fixées, et les clients déjà installés (arrivés) ou partis.
 */
router.post('/unassign-all', async (req, res) => {
  const { date, service } = req.body;
  if (!DATE_RE.test(date || '')) throw httpError(400, 'Date invalide');
  if (!['midi', 'soir'].includes(service)) throw httpError(400, 'Service invalide');

  const sameService = getDb().reservations.filter((r) => r.date === date && serviceOf(r.time) === service);
  const cleared = sameService.filter((r) => r.tableIds.length && !r.pinned && statusOf(r) === 'expected');
  for (const r of cleared) setTables(r, []);
  if (cleared.length) await persist();
  res.json({
    cleared: cleared.length,
    kept: sameService.filter((r) => r.tableIds.length && isActive(r)).length,
    reservations: sameService,
  });
});

export default router;
