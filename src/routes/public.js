// Réservation en ligne par les clients (page publique, sans compte).
// Le client choisit le nombre de personnes, la date, un créneau d'un service ouvert,
// et laisse ses coordonnées. Il ne choisit pas de table : une table libre lui est attribuée
// automatiquement ; s'il n'y en a plus, le service est « complet ». Les zones « en dernier recours »
// (ex. l'étage) ne servent que si le reste est plein ; si la table tombe dans une zone qui demande
// l'accord du client, il est prévenu (description de la zone) et doit accepter avant de réserver.
// Les règles (délai, jours à l'avance, créneaux, champs obligatoires…) sont réglables : voir src/booking.js.
import crypto from 'node:crypto';
import { Router } from 'express';
import { getDb, persist, httpError } from '../store.js';
import { areaOfTable, autoAssignByPriority, getServices, isActive, isServiceOpen, localDate, serviceOf } from '../../shared/rules.js';
import { serviceExceptions } from '../services.js';
import { broadcast } from '../events.js';
import { bookingSettings } from '../booking.js';
import { addHistory, busyTables } from './reservations.js';

const MAX_PER_HOUR = 5; // réservations en ligne par adresse IP et par heure (anti-abus)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s.()-]+$/;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
};

/** Créneaux d'un service : de son début à sa dernière heure de réservation, selon le pas réglé. */
function slotsOf(service, step) {
  const slots = [];
  for (let m = toMinutes(service.start); m <= toMinutes(service.end ?? service.start); m += step) slots.push(toHhmm(m));
  return slots;
}

/** Le créneau respecte-t-il le délai minimum (ex. au moins 1 h avant) ? */
const farEnough = (date, time, settings) =>
  new Date(`${date}T${time}:00`).getTime() >= Date.now() + settings.minNoticeMinutes * 60_000;

/** Date réservable : ni passée, ni trop lointaine. */
function assertBookableDate(date, settings) {
  if (!DATE_RE.test(date || '')) throw httpError(400, 'Date invalide.');
  const today = localDate();
  if (date < today) throw httpError(400, 'Cette date est passée.');
  if (date > addDays(today, settings.maxDays)) {
    throw httpError(400, `Les réservations en ligne sont ouvertes ${settings.maxDays} jour${settings.maxDays > 1 ? 's' : ''} à l'avance.`);
  }
}

/** Tables que ce groupe aurait à ce service (même règle que pour l'équipe), ou null si c'est complet. */
function placementFor(r) {
  const db = getDb();
  // busyTables : occupées, ou dans une zone fermée ; les zones « en dernier recours » passent après les autres
  return autoAssignByPriority(db.tables, db.zones, [r], busyTables(r), db.groups).get(r.id) ?? null;
}

/** Zone des tables attribuées, si elle demande l'accord du client (ex. l'étage, accès par un escalier). */
function confirmAreaOf(tableIds) {
  const db = getDb();
  const area = tableIds?.length ? areaOfTable(db.tables.find((t) => t.id === tableIds[0]), db.zones) : null;
  return area?.confirm ? area : null;
}
const publicArea = (a) => ({ id: a.id, label: a.label, description: a.description ?? '' });

/** Couverts déjà réservés à cette heure précise (en ligne et par l'équipe). */
function coversAt(date, time) {
  return getDb().reservations.filter((r) => r.date === date && r.time === time && isActive(r)).reduce((n, r) => n + r.people, 0);
}

/**
 * Services ouverts ce jour-là, avec tous leurs créneaux. Indisponible (grisé sur la page) si l'heure est
 * passée ou trop proche (délai minimum : `tooSoon`), si elle a déjà son maximum de couverts, ou si le service
 * n'a plus de table pour ce groupe (`full`).
 * `notice` : la table serait dans une zone qui demande l'accord du client (sa description le prévient).
 */
function availability(date, people, settings) {
  return getServices()
    .filter((s) => isServiceOpen(date, s.id, serviceExceptions()))
    .map((s) => {
      const times = slotsOf(s, settings.step);
      const open = times.filter((time) => farEnough(date, time, settings));
      // Plus aucun créneau réservable (service passé) : on ne cherche pas de table, il n'est pas « complet »
      const placement = open.length ? placementFor({ id: 'probe', date, time: s.start, people, tableIds: [], status: 'expected' }) : null;
      const full = open.length > 0 && !placement;
      const notice = confirmAreaOf(placement);
      return {
        id: s.id,
        label: s.label,
        full,
        notice: notice ? publicArea(notice) : null,
        slots: times.map((time) => {
          const tooSoon = !open.includes(time);
          return {
            time,
            ...(tooSoon ? { tooSoon: true } : {}),
            available: !tooSoon && !full && (!settings.maxCoversPerSlot || coversAt(date, time) + people <= settings.maxCoversPerSlot),
          };
        }),
      };
    });
}

const parsePeople = (value, settings) => {
  const people = parseInt(value, 10);
  if (!Number.isInteger(people) || people < 1 || people > settings.maxPeople) {
    const contact = settings.restaurantPhone ? ` au ${settings.restaurantPhone}` : '';
    throw httpError(400, `Réservation en ligne de 1 à ${settings.maxPeople} personnes. Pour un groupe plus grand, contactez le restaurant${contact}.`);
  }
  return people;
};

function assertEnabled(settings) {
  if (!settings.enabled) throw httpError(403, settings.closedMessage || 'La réservation en ligne est fermée pour le moment.', 'closed');
}

const router = Router();

/** Ce que la page publique doit savoir : réglages visibles par les clients et jours ouverts (calendrier). */
router.get('/info', (req, res) => {
  const s = bookingSettings();
  const today = localDate();
  const openDays = [];
  if (s.enabled) {
    for (let i = 0; i <= s.maxDays; i++) {
      const date = addDays(today, i);
      if (getServices().some((sv) => isServiceOpen(date, sv.id, serviceExceptions()))) openDays.push(date);
    }
  }
  res.json({
    enabled: s.enabled,
    restaurantName: s.restaurantName,
    restaurantPhone: s.restaurantPhone,
    message: s.message,
    closedMessage: s.closedMessage,
    maxDays: s.maxDays,
    maxPeople: s.maxPeople,
    requireEmail: s.requireEmail,
    requirePhone: s.requirePhone,
    today,
    openDays,
  });
});

/** Créneaux d'une date pour un groupe : GET /api/public/availability?date=AAAA-MM-JJ&people=2 */
router.get('/availability', (req, res) => {
  const settings = bookingSettings();
  assertEnabled(settings);
  const date = String(req.query.date ?? '');
  assertBookableDate(date, settings);
  res.json({ date, services: availability(date, parsePeople(req.query.people, settings), settings) });
});

const attempts = new Map(); // adresse IP → horodatages des réservations de la dernière heure

router.post('/reservations', async (req, res) => {
  const settings = bookingSettings();
  assertEnabled(settings);
  const b = req.body ?? {};
  // Champ caché que seuls les robots remplissent : on fait comme si tout allait bien
  if (b.website) return res.status(201).json({ ok: true });

  const ip = req.socket.remoteAddress;
  const recent = (attempts.get(ip) ?? []).filter((t) => t > Date.now() - 3600_000);
  if (recent.length >= MAX_PER_HOUR) throw httpError(429, 'Trop de réservations envoyées. Réessayez plus tard ou contactez le restaurant.');

  const name = String(b.name ?? '').trim().slice(0, 60);
  const email = String(b.email ?? '').trim().toLowerCase().slice(0, 120);
  const phone = String(b.phone ?? '').trim().slice(0, 30);
  const notes = String(b.notes ?? '').trim().slice(0, 300);
  const date = String(b.date ?? '');
  const time = String(b.time ?? '');
  const people = parsePeople(b.people, settings);
  if (!name) throw httpError(400, 'Indiquez votre nom.');
  // Email / téléphone : obligatoires selon les réglages ; s'ils sont donnés, ils doivent être valides
  if ((email || settings.requireEmail) && !EMAIL_RE.test(email)) throw httpError(400, 'Indiquez une adresse email valide.');
  if ((phone || settings.requirePhone) && (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 8)) {
    throw httpError(400, 'Indiquez un numéro de téléphone valide.');
  }
  assertBookableDate(date, settings);
  if (!TIME_RE.test(time)) throw httpError(400, 'Choisissez un horaire.');

  // Le créneau doit être proposé ce jour-là (service ouvert, bon pas, délai respecté)
  const service = availability(date, people, settings).find((s) => s.id === serviceOf(time));
  const slot = service?.slots.find((s) => s.time === time);
  if (!slot) throw httpError(409, 'Cet horaire n’est pas disponible. Choisissez-en un autre.', 'slot');
  if (slot.tooSoon) {
    const notice = settings.minNoticeMinutes;
    const delay = notice >= 1440 ? `${notice / 1440} jour${notice >= 2880 ? 's' : ''}` : notice >= 60 ? `${notice / 60} h` : `${notice} min`;
    throw httpError(409, notice
      ? `Cet horaire est trop proche : les réservations en ligne se font au moins ${delay} à l'avance.`
      : 'Cet horaire est déjà passé.', 'slot');
  }
  if (!slot.available) {
    throw httpError(
      409,
      service.full
        ? `Le service « ${service.label} » est complet pour ${people} personne${people > 1 ? 's' : ''}. Choisissez un autre service ou une autre date.`
        : 'Cet horaire est complet. Choisissez-en un autre.',
      'full'
    );
  }

  const r = {
    id: crypto.randomUUID(),
    name,
    people,
    date,
    time,
    phone,
    email,
    notes,
    internalNote: '',
    tableIds: [],
    status: 'expected',
    source: 'online',
    createdAt: new Date().toISOString(),
  };
  // Une table libre lui est attribuée tout de suite. Dans une zone qui demande son accord (ex. l'étage) :
  // il doit l'avoir accepté (la place a pu changer depuis l'affichage des horaires : on le revérifie ici)
  r.tableIds = placementFor(r) ?? [];
  const confirmArea = confirmAreaOf(r.tableIds);
  if (confirmArea && b.acceptArea !== confirmArea.id) {
    throw httpError(
      409,
      `Il ne reste de la place que dans la zone « ${confirmArea.label} »${confirmArea.description ? ` (${confirmArea.description})` : ''}. Merci de confirmer que cela vous convient.`,
      'area_confirm'
    );
  }
  if (confirmArea) r.areaAccepted = confirmArea.id; // noté pour l'équipe
  addHistory(r, req, { type: 'created', by: 'Réservation en ligne', people, date, time });
  getDb().reservations.push(r);
  await persist();
  attempts.set(ip, [...recent, Date.now()]);
  broadcast({ scope: 'reservations', origin: null }); // les appareils de l'équipe la voient aussitôt
  // Au client : seulement ce qu'il a réservé (jamais la table ni les autres réservations)
  res.status(201).json({ ok: true, name, people, date, time, service: service.label, area: confirmArea ? publicArea(confirmArea) : null });
});

router.use((req, res) => res.status(404).json({ error: 'Route inconnue' }));

export default router;
