import { Router } from 'express';
import { persist } from '../store.js';
import { servicesPayload, setServiceDay, updateServices } from '../services.js';

const router = Router();

/** Services et exceptions par date. */
router.get('/', (req, res) => res.json(servicesPayload()));

/** Réglages : nouvelle liste de services (nom, début, jours d'ouverture). */
router.put('/', async (req, res) => {
  updateServices(req.body.services);
  await persist();
  res.json(servicesPayload());
});

/** Une date : ouvrir / fermer un service ({ id, open: true | false | null = comme d'habitude }). */
router.put('/day/:date', async (req, res) => {
  setServiceDay(req.params.date, req.body.id, req.body.open);
  await persist();
  res.json(servicesPayload());
});

export default router;
