import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore, scheduleBackups } from './src/store.js';
import authRouter, { requireAuth, isConfigured } from './src/auth.js';
import { eventsHandler, notifyChanges } from './src/events.js';
import planRouter from './src/routes/plan.js';
import tablesRouter from './src/routes/tables.js';
import reservationsRouter from './src/routes/reservations.js';
import settingsRouter from './src/routes/settings.js';
import servicesRouter from './src/routes/services.js';
import { loadServices } from './src/services.js';
import { scheduleRetention } from './src/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// En-têtes de sécurité de base
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Front-end + code partagé entre client et serveur (règles de fusion)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// Code d'accès : tout le reste de l'API est réservé aux appareils connectés
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);

// Synchronisation en direct entre appareils
app.get('/api/events', eventsHandler);
app.use('/api', notifyChanges);

app.use('/api/plan', planRouter);
app.use('/api/tables', tablesRouter);
app.use('/api/reservations', reservationsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/services', servicesRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use((err, req, res, next) => {
  if (!err.expose) console.error(err);
  // `reason` : code lisible par l'interface pour proposer la bonne suite (ex. « no_table »)
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erreur serveur', ...(err.reason ? { reason: err.reason } : {}) });
});

/** Adresses à taper sur les tablettes du même réseau. */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

await initStore();
loadServices(); // services (matin, midi, soir…) des réglages
scheduleBackups();
scheduleRetention(); // archivage + anonymisation des anciennes réservations, une fois par jour
app.listen(PORT, () => {
  console.log(`\nGestion des tables — démarrée`);
  console.log(`  Sur cet ordinateur : http://localhost:${PORT}`);
  for (const url of lanAddresses()) console.log(`  Sur les tablettes   : ${url}`);
  if (!isConfigured()) console.log(`\n  ⚠ Ouvrez d'abord http://localhost:${PORT} sur cet ordinateur pour créer le code d'accès.`);
  console.log('');
});
