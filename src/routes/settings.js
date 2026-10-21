import { Router } from 'express';
import { getDb } from '../store.js';
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

/** Changer les durées : appliqué immédiatement (archivage / anonymisation). */
router.put('/', async (req, res) => {
  const result = await updateRetention(req.body);
  res.json({ ...(await payload()), result });
});

export default router;
