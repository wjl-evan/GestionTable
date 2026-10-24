// Tests des règles de placement : `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areAdjacent, autoAssign, bestPlacement, capacityOf, findCombination, isActive, serviceOf,
} from '../shared/rules.js';

/** Table rectangulaire 80×80 ; `x` en px, fusionnable par défaut. */
const T = (id, seats, x, y = 0, mergeable = true) => ({ id, seats, x, y, w: 80, h: 80, shape: 'rect', mergeable });

test('services : midi avant 16 h, soir après', () => {
  assert.equal(serviceOf('12:30'), 'midi');
  assert.equal(serviceOf('15:59'), 'midi');
  assert.equal(serviceOf('16:00'), 'soir');
});

test('un client parti libère ses tables', () => {
  assert.equal(isActive({ status: 'arrived' }), true);
  assert.equal(isActive({}), true);
  assert.equal(isActive({ status: 'left' }), false);
});

test('voisinage : côte à côte (écart ≤ 24 px), pas en diagonale', () => {
  assert.ok(areAdjacent(T('a', 2, 0), T('b', 2, 90)));
  assert.ok(!areAdjacent(T('a', 2, 0), T('b', 2, 200)));
  assert.ok(!areAdjacent(T('a', 2, 0, 0), T('b', 2, 90, 90))); // diagonale
});

test('table assez grande : pas de fusion', () => {
  const tables = [T('a', 4, 0), T('b', 2, 90)];
  assert.deepEqual(findCombination(tables, 'a', 4), ['a']);
});

test('fusion automatique de tables voisines : 2 + 4 = 6', () => {
  const tables = [T('a', 2, 0), T('b', 4, 90)];
  assert.deepEqual(findCombination(tables, 'a', 6), ['a', 'b']);
  assert.equal(findCombination(tables, 'a', 7), null);
});

test('tables non fusionnables : pas de fusion automatique', () => {
  const tables = [T('a', 2, 0, 0, false), T('b', 4, 90, 0, false)];
  assert.equal(findCombination(tables, 'a', 6), null);
});

test('une table occupée ne peut pas servir', () => {
  const tables = [T('a', 2, 0), T('b', 4, 90)];
  assert.equal(findCombination(tables, 'a', 6, new Set(['b'])), null);
  assert.equal(findCombination(tables, 'b', 4, new Set(['b'])), null);
});

test('fusion manuelle de tables éloignées, avec sa propre capacité (4 + 4 → 10)', () => {
  const tables = [T('a', 4, 0, 0, false), T('b', 4, 600, 0, false)];
  const groups = [{ id: 'g', tableIds: ['a', 'b'], capacity: 10 }];
  assert.equal(capacityOf(tables, ['a', 'b'], groups), 10);
  assert.deepEqual(findCombination(tables, 'a', 10, new Set(), groups), ['a', 'b']);
  assert.equal(findCombination(tables, 'a', 11, new Set(), groups), null);
});

test('fusion de plus de 4 tables (3 × 2 + 4 → 12)', () => {
  const tables = [T('a', 2, 0, 0, false), T('b', 2, 300, 0, false), T('c', 2, 600, 0, false), T('d', 4, 900, 0, false)];
  const groups = [{ id: 'g', tableIds: ['a', 'b', 'c', 'd'], capacity: 12 }];
  assert.deepEqual(findCombination(tables, 'b', 12, new Set(), groups).sort(), ['a', 'b', 'c', 'd']);
});

test('une fusion manuelle ne s’utilise qu’en entier (bug T71 + T72 sans T73)', () => {
  const tables = [T('t71', 10, 0, 0, false), T('t72', 12, 300, 0, false), T('t73', 4, 600, 0, false)];
  const groups = [{ id: 'g', tableIds: ['t71', 't72', 't73'], capacity: 28 }];
  // 22 personnes : T71 + T72 feraient 22 pile, mais cette paire n'existe pas comme fusion
  assert.deepEqual(findCombination(tables, 't71', 22, new Set(), groups).sort(), ['t71', 't72', 't73']);
});

test('placement auto : préfère la combinaison qui ne gaspille pas de places', () => {
  const tables = [
    ...[T('t66', 4, 0, 0, false), T('t67', 4, 300, 0, false), T('t70', 6, 600, 0, false), T('t68', 4, 900, 0, false), T('t69', 4, 1200, 0, false)],
    T('t71', 10, 0, 500, false), T('t72', 12, 300, 500, false), T('t73', 4, 600, 500, false),
  ];
  const groups = [
    { id: 'big22', tableIds: ['t66', 't67', 't68', 't69', 't70'], capacity: 22 },
    { id: 'big28', tableIds: ['t71', 't72', 't73'], capacity: 28 },
  ];
  assert.deepEqual(bestPlacement(tables, 22, new Set(), groups).sort(), ['t66', 't67', 't68', 't69', 't70']);
});

test('placement auto : garde libres les tables polyvalentes (T1 + T2 = 10)', () => {
  const tables = [T('t1', 4, 0, 0, false), T('t2', 4, 300, 0, false), T('iso', 4, 600, 0, false)];
  const groups = [{ id: 'g', tableIds: ['t1', 't2'], capacity: 10 }];
  assert.deepEqual(bestPlacement(tables, 4, new Set(), groups), ['iso']);
});

test('placement auto : anticipe pour placer tout le monde', () => {
  // 4 collée à une 2, et une 4 isolée ; réservations 6, 4, 2
  const tables = [T('A', 4, 0), T('B', 2, 90), T('C', 4, 500, 0, false)];
  const res = [
    { id: 'six', people: 6, time: '20:00' },
    { id: 'quatre', people: 4, time: '20:00' },
    { id: 'deux', people: 2, time: '20:00' },
  ];
  const result = autoAssign(tables, res);
  assert.deepEqual(result.get('six').sort(), ['A', 'B']);
  assert.deepEqual(result.get('quatre'), ['C']);
});

test('minimum de personnes : la grande table est gardée aux groupes, même au prix d’une fusion', () => {
  const tables = [{ ...T('big', 8, 0, 300, false), minPeople: 5 }, T('a', 2, 0), T('b', 2, 90)];
  assert.deepEqual(bestPlacement(tables, 2), ['a']);
  assert.deepEqual(new Set(bestPlacement(tables, 4)), new Set(['a', 'b'])); // fusion plutôt que la grande table
  assert.deepEqual(bestPlacement(tables, 5), ['big']);
  // Plus de petite table libre : un groupe de 2 reste à placer, la grande table n'est pas proposée
  assert.equal(bestPlacement(tables, 2, new Set(['a', 'b'])), null);
  const placed = autoAssign(tables, [{ id: 'r1', people: 2, time: '20:00' }, { id: 'r2', people: 6, time: '20:00' }]);
  assert.deepEqual(placed.get('r2'), ['big']);
  assert.deepEqual(placed.get('r1'), ['a']);
  // À la main (dépôt sur la table), elle reste possible
  assert.deepEqual(findCombination(tables, 'big', 2), ['big']);
});
