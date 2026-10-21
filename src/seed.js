import crypto from 'node:crypto';
import { localDate } from '../shared/rules.js';

// Plan de démonstration. Les tables "mergeable" posées côte à côte
// (écart < LINK_GAP) peuvent fusionner automatiquement.
const tables = [
  // Rangée fenêtre : 2 + 2 + 4
  { id: 't1', name: 'T1', seats: 2, shape: 'rect', x: 60, y: 70, w: 80, h: 80, mergeable: true },
  { id: 't2', name: 'T2', seats: 2, shape: 'rect', x: 150, y: 70, w: 80, h: 80, mergeable: true },
  { id: 't3', name: 'T3', seats: 4, shape: 'rect', x: 240, y: 70, w: 120, h: 80, mergeable: true },
  // Duo 2 + 4 = 6
  { id: 't4', name: 'T4', seats: 2, shape: 'rect', x: 450, y: 70, w: 80, h: 80, mergeable: true },
  { id: 't5', name: 'T5', seats: 4, shape: 'rect', x: 540, y: 70, w: 120, h: 80, mergeable: true },
  // Tables rondes (non fusionnables)
  { id: 't6', name: 'T6', seats: 4, shape: 'round', x: 90, y: 270, w: 100, h: 100, mergeable: false },
  { id: 't7', name: 'T7', seats: 4, shape: 'round', x: 280, y: 270, w: 100, h: 100, mergeable: false },
  // Centre : 4 au-dessus de 4
  { id: 't8', name: 'T8', seats: 4, shape: 'rect', x: 480, y: 250, w: 120, h: 80, mergeable: true },
  { id: 't9', name: 'T9', seats: 4, shape: 'rect', x: 480, y: 340, w: 120, h: 80, mergeable: true },
  // Banquette
  { id: 't10', name: 'T10', seats: 6, shape: 'rect', x: 760, y: 70, w: 180, h: 90, mergeable: false },
  // Rangée du fond : 4 × 2
  { id: 't11', name: 'T11', seats: 2, shape: 'rect', x: 60, y: 480, w: 80, h: 80, mergeable: true },
  { id: 't12', name: 'T12', seats: 2, shape: 'rect', x: 150, y: 480, w: 80, h: 80, mergeable: true },
  { id: 't13', name: 'T13', seats: 2, shape: 'rect', x: 240, y: 480, w: 80, h: 80, mergeable: true },
  { id: 't14', name: 'T14', seats: 2, shape: 'rect', x: 330, y: 480, w: 80, h: 80, mergeable: true },
  // Grande table
  { id: 't15', name: 'T15', seats: 8, shape: 'rect', x: 520, y: 480, w: 200, h: 90, mergeable: false },
];

const zones = [
  { id: 'z1', label: 'Bar', type: 'bar', x: 780, y: 240, w: 180, h: 200 },
  { id: 'z2', label: 'Entrée', type: 'door', x: 800, y: 580, w: 140, h: 40 },
  { id: 'z3', label: 'Fenêtres', type: 'window', x: 40, y: 0, w: 640, h: 14 },
];

export function createSeed() {
  const today = localDate();
  const r = (name, people, time, tableIds = [], extra = {}) => ({
    id: crypto.randomUUID(),
    name,
    people,
    date: today,
    time,
    phone: extra.phone || '',
    notes: extra.notes || '',
    tableIds,
    createdAt: new Date().toISOString(),
  });

  return {
    room: { w: 1000, h: 620 },
    zones,
    tables,
    // Fusions manuelles : les deux rondes de 4, espacées, forment une table de 10
    groups: [{ id: 'g1', tableIds: ['t6', 't7'], capacity: 10 }],
    reservations: [
      r('Martin', 2, '12:00', ['t1']),
      r('Durand', 3, '12:15', [], { phone: '06 12 34 56 78' }),
      r('Bernard', 4, '12:30'),
      r('Petit', 6, '13:00', [], { notes: 'Anniversaire' }),
      r('Dubois', 2, '19:00'),
      r('Moreau', 6, '19:30', [], { notes: 'Chaise bébé' }),
      r('Laurent', 4, '20:00', ['t7']),
      r('Michel', 5, '20:00'),
      r('Garcia', 7, '20:15', [], { phone: '07 98 76 54 32' }),
      r('Simon', 8, '20:30', ['t8', 't9']),
      r('Lefebvre', 2, '21:00', [], { notes: 'En terrasse si possible' }),
    ],
  };
}
