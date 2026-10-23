// Services du restaurant (matin, midi, soir…) : liste réglable + exceptions par date.
// Stockés dans db.settings : `services` (liste) et `serviceExceptions` ({ date: { id: true|false } }).
// Les règles partagées (serviceOf, isServiceOpen…) sont tenues à jour avec setServices.
import crypto from 'node:crypto';
import { getDb, httpError } from './store.js';
import { DEFAULT_SERVICES, getServices, isServiceOpen, serviceById, serviceOf, setServices, withinHours } from '../shared/rules.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** À appeler au démarrage : les règles partagées utilisent les services des réglages. */
export function loadServices() {
  const list = getDb().settings.services ?? DEFAULT_SERVICES;
  // Services enregistrés avant l'heure de fin : fin par défaut (ou juste avant le service suivant)
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
  sorted.forEach((s, i) => {
    if (s.end) return;
    const next = sorted[i + 1]?.start;
    const fallback = DEFAULT_SERVICES.find((d) => d.id === s.id)?.end ?? '23:30';
    s.end = next && fallback >= next ? minusMinutes(next, 30) : fallback;
  });
  setServices(sorted);
}

const minusMinutes = (hhmm, m) => {
  const t = Math.max(0, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) - m);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export const serviceExceptions = () => getDb().settings.serviceExceptions ?? {};

/** Ce que l'interface reçoit avec le plan. */
export const servicesPayload = () => ({ services: getServices(), serviceExceptions: serviceExceptions() });

const dayLabel = (date) => date.split('-').reverse().join('/');
const nameOf = (id) => getServices().find((s) => s.id === id)?.label.toLowerCase() ?? id;

/** Phrase « le service du midi » / « le service Brunch », selon le nom. */
export const serviceName = (id) => {
  const label = nameOf(id);
  return ['matin', 'midi', 'soir'].includes(label) ? `le service du ${label}` : `le service « ${label} »`;
};

/**
 * Réservation dans un service fermé ce jour-là : refusée (code « closed »), sauf si on a choisi
 * d'ouvrir ce service pour la journée (`allowClosed`). Renvoie alors l'id du service à ouvrir
 * — à ouvrir seulement une fois la réservation acceptée (voir setServiceDay).
 */
export function assertServiceOpen(date, time, allowClosed) {
  const id = serviceOf(time);
  if (isServiceOpen(date, id, serviceExceptions())) return null;
  if (allowClosed) return id;
  throw httpError(409, `${serviceName(id).replace(/^l/, 'L')} est fermé le ${dayLabel(date)}.`, 'closed');
}

/**
 * Heure hors des horaires de réservation du service (avant son début ou après sa dernière heure) :
 * refusée (code « hours »), sauf « enregistrer quand même » (`allowLate`).
 */
export function assertWithinHours(time, allowLate) {
  if (allowLate || withinHours(time)) return;
  const s = serviceById(serviceOf(time));
  const name = serviceName(s.id).replace(/^l/, 'L');
  throw httpError(409, `${name} prend les réservations de ${s.start} à ${s.end ?? '—'} (${time} demandé).`, 'hours');
}

/** Ouvre / ferme un service pour une date (`open` = null : retour aux jours habituels). */
export function setServiceDay(date, id, open) {
  if (!DATE_RE.test(date || '')) throw httpError(400, 'Date invalide');
  if (!getServices().some((s) => s.id === id)) throw httpError(404, 'Service introuvable');
  const settings = getDb().settings;
  const exceptions = (settings.serviceExceptions ??= {});
  const day = { ...(exceptions[date] ?? {}) };
  const usual = isServiceOpen(date, id, {}); // ce que donnent les jours habituels
  if (open === null || open === undefined || Boolean(open) === usual) delete day[id];
  else day[id] = Boolean(open);
  if (Object.keys(day).length) exceptions[date] = day;
  else delete exceptions[date];
}

/**
 * Remplace la liste des services (réglages). Les ids existants sont gardés (les exceptions
 * et réservations s'y rattachent) ; un nouveau service reçoit un id.
 */
export function updateServices(input) {
  if (!Array.isArray(input) || !input.length) throw httpError(400, 'Il faut au moins un service.');
  if (input.length > 8) throw httpError(400, '8 services au plus.');
  const known = new Set(getServices().map((s) => s.id));
  const list = input.map((s) => {
    const label = String(s.label ?? '').trim().slice(0, 20);
    if (!label) throw httpError(400, 'Chaque service doit avoir un nom.');
    if (!TIME_RE.test(s.start ?? '')) throw httpError(400, `Heure de début invalide pour « ${label} ».`);
    if (!TIME_RE.test(s.end ?? '')) throw httpError(400, `Heure de fin invalide pour « ${label} ».`);
    if (s.end < s.start) throw httpError(400, `« ${label} » : l'heure de fin doit être après le début.`);
    // Heure proposée à la réservation : dans les horaires du service
    const time = TIME_RE.test(s.time ?? '') && s.time >= s.start && s.time <= s.end ? s.time : s.start;
    const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    const id = known.has(s.id) ? s.id : `s${crypto.randomUUID().slice(0, 8)}`;
    return { id, label, start: s.start, end: s.end, time, days };
  });
  const starts = list.map((s) => s.start);
  if (new Set(starts).size !== starts.length) throw httpError(400, 'Deux services ne peuvent pas commencer à la même heure.');
  const ids = list.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw httpError(400, 'Service en double.');
  // La dernière heure d'un service doit précéder le début du suivant (sinon ces réservations iraient au suivant)
  const sorted = [...list].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i].end >= sorted[i + 1].start) {
      throw httpError(400, `« ${sorted[i].label} » doit finir avant le début de « ${sorted[i + 1].label} » (${sorted[i + 1].start}).`);
    }
  }

  const settings = getDb().settings;
  settings.services = list.sort((a, b) => a.start.localeCompare(b.start));
  // Exceptions de services supprimés : plus d'objet
  for (const [date, day] of Object.entries(settings.serviceExceptions ?? {})) {
    for (const id of Object.keys(day)) if (!ids.includes(id)) delete day[id];
    if (!Object.keys(day).length) delete settings.serviceExceptions[date];
  }
  loadServices();
}
