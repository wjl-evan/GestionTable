import { Router } from 'express';
import { getDb, persist } from '../store.js';
import { BOOKING_LIMITS, bookingSettings, updateBookingSettings } from '../booking.js';
import { archiveStats, retentionCutoffs, retentionSettings, RETENTION_LIMITS, updateRetention } from '../retention.js';

const router = Router();

async function payload() {
  const settings = retentionSettings();
  return {
    ...settings,
    limits: RETENTION_LIMITS,
    cutoffs: retentionCutoffs(settings),
    lastRetention: getDb().settings.lastRetention ?? null,
    activeReservations: getDb().reservations.length,
    archives: await archiveStats(),
  };
}

/** Durées de conservation des données clients + état des archives. */
router.get('/', async (req, res) => res.json(await payload()));

/** Réservation en ligne : réglages de la page publique. */
router.get('/booking', (req, res) => res.json({ ...bookingSettings(), limits: BOOKING_LIMITS }));

router.put('/booking', async (req, res) => {
  const settings = updateBookingSettings(req.body);
  await persist();
  res.json({ ...settings, limits: BOOKING_LIMITS });
});

/** Changer les durées : appliqué immédiatement (archivage / anonymisation). */
router.put('/', async (req, res) => {
  const result = await updateRetention(req.body);
  res.json({ ...(await payload()), result });
});

export default router;
