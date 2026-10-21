import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSeed } from './seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || path.join(root, 'data', 'db.json');
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
const BACKUP_KEEP_DAYS = 30;
const BACKUP_EVERY_MS = 5 * 60 * 1000; // après une modification, la sauvegarde du jour a au plus 5 min de retard

let db = null;
let queue = Promise.resolve();
let lastBackup = 0;

export async function initStore() {
  let raw;
  try {
    raw = await fs.readFile(DB_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    db = createSeed();
    migrate(db);
    await persist();
    console.log('Base initialisée avec des données de démonstration.');
    return;
  }
  try {
    db = JSON.parse(raw);
  } catch {
    // Fichier abîmé : on le met de côté et on repart de la dernière sauvegarde
    const aside = `${DB_PATH}.corrompu-${Date.now()}`;
    await fs.rename(DB_PATH, aside);
    db = await loadLatestBackup();
    if (!db) throw new Error(`Base illisible (mise de côté : ${aside}) et aucune sauvegarde disponible.`);
    console.warn(`⚠ Base illisible, mise de côté dans ${aside}. Restauration de la dernière sauvegarde.`);
    await persist();
  }
  migrate(db);
}

/* ---------- Sauvegardes ---------- */

const backupName = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0');
  return `db-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}.json`;
};

async function loadLatestBackup() {
  try {
    const files = (await fs.readdir(BACKUP_DIR)).filter((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.reverse()) {
      try {
        return JSON.parse(await fs.readFile(path.join(BACKUP_DIR, f), 'utf8'));
      } catch {
        /* sauvegarde abîmée : on essaie la précédente */
      }
    }
  } catch {
    /* pas de dossier de sauvegardes */
  }
  return null;
}

/**
 * Une sauvegarde par jour (data/backups/db-AAAA-MM-JJ.json), gardée 30 jours.
 * La copie du jour est mise à jour tant que la journée dure : elle reflète toujours l'état récent.
 */
export async function backup() {
  if (!db) return;
  lastBackup = Date.now();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, backupName());
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, file);
  const limit = backupName(new Date(Date.now() - BACKUP_KEEP_DAYS * 86400000));
  for (const f of await fs.readdir(BACKUP_DIR)) {
    if (/^db-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < limit) await fs.unlink(path.join(BACKUP_DIR, f));
  }
}

/** Sauvegarde au démarrage puis toutes les heures. */
export function scheduleBackups() {
  const run = () => backup().catch((err) => console.error('Sauvegarde impossible :', err.message));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

/** Met à niveau une base créée par une version précédente. */
function migrate(data) {
  data.groups ??= [];
  data.settings ??= {};
  // Anciens liens de 2 tables { a, b, bonus } → fusions { tableIds, capacity }
  if (Array.isArray(data.links)) {
    const seats = new Map(data.tables.map((t) => [t.id, t.seats]));
    for (const l of data.links) {
      if (!seats.has(l.a) || !seats.has(l.b)) continue;
      data.groups.push({
        id: l.id.replace(/^l/, 'g'),
        tableIds: [l.a, l.b],
        capacity: seats.get(l.a) + seats.get(l.b) + (l.bonus || 0),
      });
    }
    delete data.links;
  }
}

export function getDb() {
  return db;
}

// Écritures sérialisées et atomiques (fichier temporaire puis renommage)
export function persist() {
  queue = queue
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
      const tmp = `${DB_PATH}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(db, null, 2));
      await fs.rename(tmp, DB_PATH);
      if (Date.now() - lastBackup > BACKUP_EVERY_MS) {
        await backup().catch((err) => console.error('Sauvegarde impossible :', err.message));
      }
    });
  return queue;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}
