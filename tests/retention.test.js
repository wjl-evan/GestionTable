// Tests de la conservation des données clients : `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, ANONYMOUS_NAME, planRetention, retentionCutoffs } from '../src/retention.js';

const R = (id, date, extra = {}) => ({
  id, date, time: '20:00', name: `Client ${id}`, phone: '06 00 00 00 00', notes: 'Anniversaire',
  internalNote: 'Habitué', people: 4, tableIds: ['t1'], status: 'left', ...extra,
});

test('dates limites : 60 jours pour archiver, 12 mois pour anonymiser', () => {
  const cut = retentionCutoffs({ archiveAfterDays: 60, anonymizeAfterMonths: 12 }, new Date(2026, 9, 22));
  assert.equal(cut.archiveBefore, '2026-08-23');
  assert.equal(cut.anonymizeBefore, '2025-10-22');
});

test('anonymiser efface tout ce qui identifie le client, garde les chiffres', () => {
  const a = anonymize(R('x', '2025-01-01'));
  assert.equal(a.name, ANONYMOUS_NAME);
  assert.equal(a.phone, '');
  assert.equal(a.notes, '');
  assert.equal(a.internalNote, '');
  assert.equal(a.anonymized, true);
  // conservé pour les statistiques
  assert.equal(a.date, '2025-01-01');
  assert.equal(a.people, 4);
  assert.deepEqual(a.tableIds, ['t1']);
});

test('les réservations récentes et à venir restent dans la base, intactes', () => {
  const cut = { archiveBefore: '2026-08-23', anonymizeBefore: '2025-10-22' };
  const recent = R('recent', '2026-10-01');
  const future = R('future', '2026-12-31');
  const plan = planRetention([recent, future], cut);
  assert.deepEqual(plan.keep, [recent, future]);
  assert.equal(plan.archive.length, 0);
  assert.equal(plan.anonymized, 0);
});

test('au-delà de 60 jours : archivée avec son nom (pas encore 12 mois)', () => {
  const cut = { archiveBefore: '2026-08-23', anonymizeBefore: '2025-10-22' };
  const plan = planRetention([R('old', '2026-03-15')], cut);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.archive[0].name, 'Client old');
  assert.equal(plan.anonymized, 0);
});

test('au-delà de 12 mois : archivée et anonymisée', () => {
  const cut = { archiveBefore: '2026-08-23', anonymizeBefore: '2025-10-22' };
  const plan = planRetention([R('veryold', '2025-02-10')], cut);
  assert.equal(plan.archive[0].name, ANONYMOUS_NAME);
  assert.equal(plan.archive[0].phone, '');
  assert.equal(plan.anonymized, 1);
});

test('anonymiser plus tôt qu’archiver est possible (ex. 1 mois / 60 jours)', () => {
  const cut = { archiveBefore: '2026-08-23', anonymizeBefore: '2026-09-22' };
  const plan = planRetention([R('a', '2026-09-01')], cut);
  assert.equal(plan.keep[0].name, ANONYMOUS_NAME); // encore dans la base, mais déjà anonyme
  assert.equal(plan.anonymized, 1);
});

test('une réservation déjà anonymisée n’est pas recomptée', () => {
  const cut = { archiveBefore: '2026-08-23', anonymizeBefore: '2025-10-22' };
  const plan = planRetention([anonymize(R('done', '2025-01-01'))], cut);
  assert.equal(plan.anonymized, 0);
});
