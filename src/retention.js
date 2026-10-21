// Conservation des données clients :
// - archivage : les réservations passées depuis plus de N jours quittent db.json pour
//   data/archives/reservations-AAAA.json (un fichier par année, non chargé pendant le service) ;
// - anonymisation : après M mois, nom, téléphone, demande du client et note interne sont effacés
//   (date, heure, nombre de personnes et tables sont gardés pour les statistiques).
// Lancé au démarrage puis une fois par jour.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDb, persist, writeJsonAtomic, httpError, DATA_DIR, BACKUP_DIR } from './store.js';
import { localDate } from '../shared/rules.js';

const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');
const ARCHIVE_RE = /^reservations-(\d{4})\.json$/;

export const RETENTION_DEFAULTS = { archiveAfterDays: 60, anonymizeAfterMonths: 12 };
export const RETENTION_LIMITS = { archiveAfterDays: [14, 365], anonymizeAfterMonths: [1, 36] };

export function retentionSettings() {
  const s = getDb().settings;
  return {
    archiveAfterDays: s.archiveAfterDays ?? RETENTION_DEFAULTS.archiveAfterDays,
    anonymizeAfterMonths: s.anonymizeAfterMonths ?? RETENTION_DEFAULTS.anonymizeAfterMonths,
  };
}

/** Dates limites (AAAA-MM-JJ) : avant `archiveBefore` on archive, avant `anonymizeBefore` on anonymise. */
export function retentionCutoffs({ archiveAfterDays, anonymizeAfterMonths }, now = new Date()) {
  const archive = new Date(now);
  archive.setDate(archive.getDate() - archiveAfterDays);
  const anonymize = new Date(now);
  anonymize.setMonth(anonymize.getMonth() - anonymizeAfterMonths);
  return { archiveBefore: localDate(archive), anonymizeBefore: localDate(anonymize) };
}

export const ANONYMOUS_NAME = 'Client anonymisé';

/** Version anonymisée d'une réservation : plus rien qui identifie le client. */
export function anonymize(r) {
  return { ...r, name: ANONYMOUS_NAME, phone: '', notes: '', internalNote: '', anonymized: true };
}

/**
 * Décide, sans rien écrire, ce qu'il faut faire des réservations actives :
 * `keep` restent dans db.json, `archive` partent aux archives (déjà anonymisées si besoin),
 * `anonymized` = combien viennent d'être anonymisées.
 */
export function planRetention(reservations, { archiveBefore, anonymizeBefore }) {
  const keep = [];
  const archive = [];
  let anonymized = 0;
  for (const r of reservations) {
    const expired = r.date < anonymizeBefore && !r.anonymized;
    if (expired) anonymized++;
    (r.date < archiveBefore ? archive : keep).push(expired ? anonymize(r) : r);
  }
  return { keep, archive, anonymized };
}

/* ---------- Fichiers d'archives ---------- */

const archiveFile = (year) => path.join(ARCHIVE_DIR, `reservations-${year}.json`);

async function readArchive(year) {
  try {
    return JSON.parse(await fs.readFile(archiveFile(year), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Écrit une archive, et sa copie de secours dans data/backups/archives. */
async function writeArchive(year, list) {
  list.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  await writeJsonAtomic(archiveFile(year), list);
  await writeJsonAtomic(path.join(BACKUP_DIR, 'archives', `reservations-${year}.json`), list);
}

async function archiveYears() {
  try {
    return (await fs.readdir(ARCHIVE_DIR)).map((f) => f.match(ARCHIVE_RE)?.[1]).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** Réservations archivées d'une date (consultation, lecture seule). */
export async function archivedReservations(date) {
  return (await readArchive(date.slice(0, 4))).filter((r) => r.date === date).map((r) => ({ ...r, archived: true }));
}

/** Nombre de réservations par année d'archive (pour l'écran des réglages). */
export async function archiveStats() {
  const years = await archiveYears();
  return Promise.all(years.map(async (year) => ({ year, count: (await readArchive(year)).length })));
}

/* ---------- Passage d'archivage ---------- */

let running = null;

/** Archive et anonymise ce qui doit l'être. Retourne { archived, anonymized }. */
export function runRetention() {
  running ??= doRetention().finally(() => (running = null));
  return running;
}

async function doRetention() {
  const db = getDb();
  const cut = retentionCutoffs(retentionSettings());
  const { keep, archive, anonymized: anonymizedNow } = planRetention(db.reservations, cut);
  let anonymized = anonymizedNow;

  // 1. Écrire d'abord dans les archives (fusion par id : un passage interrompu ne crée pas de doublon)
  const byYear = new Map();
  for (const r of archive) {
    const year = r.date.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(r);
  }
  for (const [year, list] of byYear) {
    const existing = await readArchive(year);
    const merged = new Map(existing.map((r) => [r.id, r]));
    for (const r of list) merged.set(r.id, r);
    await writeArchive(year, [...merged.values()]);
  }

  // 2. Anonymiser ce qui, dans les archives, a dépassé la durée de conservation
  for (const year of await archiveYears()) {
    if (year > cut.anonymizeBefore.slice(0, 4)) continue;
    const list = await readArchive(year);
    let changed = 0;
    const updated = list.map((r) => (r.date < cut.anonymizeBefore && !r.anonymized ? (changed++, anonymize(r)) : r));
    if (changed) {
      anonymized += changed;
      await writeArchive(year, updated);
    }
  }

  // 3. Seulement ensuite, alléger db.json
  db.reservations = keep;
  db.settings.lastRetention = localDate();
  await persist();
  if (archive.length || anonymized) {
    console.log(`Conservation des données : ${archive.length} réservation(s) archivée(s), ${anonymized} anonymisée(s).`);
  }
  return { archived: archive.length, anonymized };
}

/** Passage au démarrage, puis vérification toutes les heures (un passage par jour). */
export function scheduleRetention() {
  const run = () => {
    if (getDb().settings.lastRetention === localDate()) return;
    runRetention().catch((err) => console.error('Archivage impossible :', err.message));
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

/** Valide et enregistre les durées de conservation, puis applique immédiatement. */
export async function updateRetention(input) {
  const s = getDb().settings;
  for (const key of Object.keys(RETENTION_LIMITS)) {
    if (input[key] === undefined) continue;
    const [min, max] = RETENTION_LIMITS[key];
    const v = Number(input[key]);
    if (!Number.isInteger(v) || v < min || v > max) {
      throw httpError(400, key === 'archiveAfterDays'
        ? `L’archivage doit se faire entre ${min} et ${max} jours.`
        : `L’anonymisation doit se faire entre ${min} et ${max} mois.`);
    }
    s[key] = v;
  }
  return runRetention();
}
