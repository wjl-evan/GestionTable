// Réglages de la réservation en ligne (page publique), stockés dans db.settings.booking.
import { getDb, httpError } from './store.js';

export const BOOKING_DEFAULTS = {
  enabled: true, // réservation en ligne ouverte
  restaurantName: '', // affiché en haut de la page publique
  restaurantPhone: '', // pour les grands groupes, les empêchements…
  message: '', // informations affichées aux clients (ex. « Terrasse fermée en hiver »)
  closedMessage: '', // affiché quand la réservation en ligne est fermée
  minNoticeMinutes: 60, // délai minimum entre la réservation et le créneau
  maxDays: 60, // jusqu'à combien de jours à l'avance
  maxPeople: 12, // au-delà : contacter le restaurant
  step: 15, // créneaux toutes les 15, 30 ou 60 minutes
  maxCoversPerSlot: 0, // couverts en ligne + équipe à la même heure (0 = sans limite)
  requireEmail: true,
  requirePhone: true,
};

/** Bornes des réglages numériques (aussi envoyées à l'interface). */
export const BOOKING_LIMITS = {
  minNoticeMinutes: [0, 7 * 24 * 60],
  maxDays: [1, 365],
  maxPeople: [1, 50],
  maxCoversPerSlot: [0, 500],
};
const STEPS = [15, 30, 60];
const TEXT_MAX = { restaurantName: 60, restaurantPhone: 30, message: 400, closedMessage: 300 };

export const bookingSettings = () => ({ ...BOOKING_DEFAULTS, ...(getDb().settings.booking ?? {}) });

/** Change les réglages (seuls les champs fournis) après vérification. */
export function updateBookingSettings(input = {}) {
  const next = bookingSettings();
  for (const key of ['enabled', 'requireEmail', 'requirePhone']) {
    if (input[key] !== undefined) next[key] = Boolean(input[key]);
  }
  for (const [key, max] of Object.entries(TEXT_MAX)) {
    if (input[key] !== undefined) next[key] = String(input[key]).trim().slice(0, max);
  }
  if (next.restaurantPhone && !/^\+?[\d\s.()-]+$/.test(next.restaurantPhone)) throw httpError(400, 'Numéro de téléphone du restaurant invalide.');
  const labels = {
    minNoticeMinutes: 'Le délai minimum',
    maxDays: 'Le nombre de jours à l’avance',
    maxPeople: 'Le nombre maximum de personnes',
    maxCoversPerSlot: 'Le nombre de couverts par créneau',
  };
  for (const [key, [min, max]] of Object.entries(BOOKING_LIMITS)) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${labels[key]} doit être compris entre ${min} et ${max}.`);
    next[key] = n;
  }
  if (input.step !== undefined) {
    if (!STEPS.includes(Number(input.step))) throw httpError(400, 'Créneaux de 15, 30 ou 60 minutes.');
    next.step = Number(input.step);
  }
  getDb().settings.booking = next;
  return next;
}
