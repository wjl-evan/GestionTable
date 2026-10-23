// Règles métier partagées entre le serveur (Node) et le navigateur.
//
// Des tables peuvent fusionner si :
//  - elles sont toutes "fusionnables" et placées côte à côte (voisinage automatique), ou
//  - elles forment exactement une fusion manuelle, quelle que soit leur distance.
// Une fusion manuelle = un groupe de 2 tables ou plus + un nombre maximum de personnes
// (ex. trois tables de 2 et une de 4 → une grande table de 12). Elle s'utilise en entier :
// une partie seulement de ses tables n'est possible que si elle forme elle-même une fusion.

/** Écart maximal (px) entre deux tables pour qu'elles soient considérées voisines. */
export const LINK_GAP = 24;

/** Nombre maximal de tables combinées librement (une fusion manuelle peut en contenir plus). */
export const MAX_MERGE = 4;

/** Statuts d'une réservation. Une réservation "partie" libère ses tables pour le reste du service. */
export const STATUSES = ['expected', 'arrived', 'left'];
export const statusOf = (r) => r.status || 'expected';
/** Réservation annulée : gardée (historique, catégorie « Annulées »), mais elle ne compte plus nulle part. */
export const isCancelled = (r) => Boolean(r.cancelledAt);
export const isActive = (r) => statusOf(r) !== 'left' && !isCancelled(r);

/* ---------- Services (matin, midi, soir…) ----------
 * Un service = { id, label, start: 'HH:MM', end: 'HH:MM', days: [0..6] (0 = lundi), time: 'HH:MM' (heure proposée) }.
 * Ils découpent la journée : une réservation appartient au dernier service commencé à son heure.
 * start / end : première et dernière heure de réservation acceptées pour ce service.
 * `days` = jours d'ouverture habituels ; une date peut faire exception (service fermé ou ouvert en plus).
 */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DEFAULT_SERVICES = [
  { id: 'matin', label: 'Matin', start: '07:00', end: '10:30', time: '08:30', days: [] }, // fermé d'habitude
  { id: 'midi', label: 'Midi', start: '11:00', end: '14:30', time: '12:30', days: ALL_DAYS },
  { id: 'soir', label: 'Soir', start: '16:00', end: '22:30', time: '20:00', days: ALL_DAYS },
];

let services = DEFAULT_SERVICES;
/** Services utilisés par serviceOf (le serveur et le navigateur y mettent ceux des réglages). */
export function setServices(list) {
  services = (list?.length ? [...list] : DEFAULT_SERVICES).sort((a, b) => a.start.localeCompare(b.start));
}
export const getServices = () => services;
export const serviceById = (id) => services.find((s) => s.id === id);

export function serviceOf(time) {
  let current = services[0];
  for (const s of services) if (time >= s.start) current = s;
  return current.id;
}

/** L'heure est-elle dans les horaires de réservation de son service (de start à end) ? */
export function withinHours(time) {
  const s = serviceById(serviceOf(time));
  return Boolean(s) && time >= s.start && (!s.end || time <= s.end);
}

/** Jour de la semaine d'une date AAAA-MM-JJ (0 = lundi). */
export const weekdayOf = (date) => (new Date(`${date}T12:00:00`).getDay() + 6) % 7;

/** Le service est-il ouvert ce jour-là ? Exception de la date d'abord, sinon les jours habituels. */
export function isServiceOpen(date, id, exceptions = {}) {
  const forced = exceptions[date]?.[id];
  if (forced !== undefined) return forced;
  return Boolean(serviceById(id)?.days.includes(weekdayOf(date)));
}

/** Services ouverts une date donnée, dans l'ordre de la journée. */
export const openServices = (date, exceptions = {}) => services.filter((s) => isServiceOpen(date, s.id, exceptions));

export function localDate(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Deux tables sont voisines si elles se font face sur un côté, avec un écart ≤ gap. */
export function areAdjacent(a, b, gap = LINK_GAP) {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const dx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const dy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  return (overlapY > 0 && dx <= gap) || (overlapX > 0 && dy <= gap);
}

/** Clé unique d'un ensemble de tables, indépendante de l'ordre. */
export const setKey = (ids) => [...ids].sort().join('|');

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** Fusion manuelle correspondant exactement à cet ensemble de tables. */
export const groupOf = (groups, ids) => groups.find((g) => sameSet(g.tableIds, ids));

/**
 * Arbre couvrant minimal (Prim) : relie des éléments ({ x, y }) par le chemin total le plus court.
 * Retourne des paires d'éléments.
 */
export function spanningEdges(points) {
  if (points.length < 2) return [];
  const edges = [];
  const done = [points[0]];
  const rest = points.slice(1);
  while (rest.length) {
    let best = null;
    for (const a of done) {
      for (const b of rest) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    edges.push([best.a, best.b]);
    done.push(best.b);
    rest.splice(rest.indexOf(best.b), 1);
  }
  return edges;
}

/**
 * Graphe des voisinages automatiques (tables fusionnables côte à côte).
 * Les fusions manuelles n'y figurent pas : elles ne s'utilisent qu'en entier.
 * `neighbors` : Map<id, Set<id>> ; `auto` : Set de clés des paires voisines.
 */
export function buildGraph(tables) {
  const neighbors = new Map(tables.map((t) => [t.id, new Set()]));
  const auto = new Set();
  const connect = (a, b) => {
    neighbors.get(a).add(b);
    neighbors.get(b).add(a);
  };

  const mergeable = tables.filter((t) => t.mergeable);
  for (let i = 0; i < mergeable.length; i++) {
    for (let j = i + 1; j < mergeable.length; j++) {
      const a = mergeable[i];
      const b = mergeable[j];
      if (areAdjacent(a, b)) {
        connect(a.id, b.id);
        auto.add(setKey([a.id, b.id]));
      }
    }
  }
  return { neighbors, auto };
}

/**
 * Capacité d'un ensemble de tables :
 *  - si c'est exactement une fusion manuelle → sa capacité ;
 *  - sinon la somme des places, plus l'écart (capacité − places) des fusions entièrement incluses
 *    (seulement les plus grandes, pour ne pas compter deux fois une petite fusion incluse dans une grande).
 */
export function capacityOf(tables, ids, groups = []) {
  const seatsById = new Map(tables.map((t) => [t.id, t.seats]));
  const seats = (list) => list.reduce((s, id) => s + (seatsById.get(id) || 0), 0);
  const exact = groupOf(groups, ids);
  if (exact) return exact.capacity;

  const set = new Set(ids);
  const inside = groups.filter((g) => g.tableIds.every((id) => set.has(id)));
  const maximal = inside.filter(
    (g) => !inside.some((o) => o !== g && o.tableIds.length > g.tableIds.length && g.tableIds.every((id) => o.tableIds.includes(id)))
  );
  return seats(ids) + maximal.reduce((s, g) => s + g.capacity - seats(g.tableIds), 0);
}

/* ---------- Recherche de combinaisons ---------- */

// Poids du score d'une combinaison (plus petit = meilleur)
const WASTE_WEIGHT = 10; // par place perdue
const FLEX_WEIGHT = 4; // par place "de réserve" bloquée sur une table polyvalente
const TABLE_WEIGHT = 5; // par table supplémentaire

/**
 * Prépare les calculs pour un plan donné (graphe, capacités, polyvalence),
 * pour enchaîner beaucoup de recherches rapidement.
 */
export function createPlanner(tables, groups = []) {
  const byId = new Map(tables.map((t) => [t.id, t]));
  const { neighbors } = buildGraph(tables);

  const capacityCache = new Map();
  const capacity = (ids) => {
    const key = setKey(ids);
    if (!capacityCache.has(key)) capacityCache.set(key, capacityOf(tables, ids, groups));
    return capacityCache.get(key);
  };

  /**
   * Polyvalence d'une table = places supplémentaires qu'elle permet d'atteindre
   * avec ses fusions ou ses voisines. Ex. T1 (4) dans la fusion T1 + T2 = 10 → 6.
   * Une table isolée vaut 0 : c'est elle qu'on donne en premier.
   */
  const flexibility = new Map();
  for (const t of tables) {
    const viaGroups = Math.max(0, ...groups.filter((g) => g.tableIds.includes(t.id)).map((g) => g.capacity));
    const viaNeighbors = t.seats + [...neighbors.get(t.id)].reduce((s, id) => s + byId.get(id).seats, 0);
    flexibility.set(t.id, Math.max(0, Math.max(viaGroups, viaNeighbors) - t.seats));
  }

  /**
   * Polyvalence "gâchée" par une combinaison : la plus grande table qu'on aurait pu former
   * avec ces tables, moins ce qu'on utilise. T1 (fusion de 10) prise seule pour 4 → 6 ;
   * la fusion T1 + T2 entière pour 10 → 0. Comptée une fois (pas par table), pour ne pas
   * pénaliser deux fois la même grande fusion.
   */
  const lostFlexibility = (ids) => {
    const cap = capacity(ids);
    return Math.max(0, ...ids.map((id) => byId.get(id).seats + flexibility.get(id) - cap));
  };

  /** Score "intelligent" : places perdues, puis polyvalence gâchée, puis nombre de tables. */
  const smartScore = (ids, people) =>
    (capacity(ids) - people) * WASTE_WEIGHT + lostFlexibility(ids) * FLEX_WEIGHT + (ids.length - 1) * TABLE_WEIGHT;

  /** Score simple (dépôt manuel sur une table) : places perdues, puis nombre de tables. */
  const simpleScore = (ids, people) => (capacity(ids) - people) * 10 + ids.length;

  /** Meilleure combinaison de tables libres et reliées contenant `startId` (startId en premier), ou null. */
  function find(startId, people, busy = new Set(), score = simpleScore) {
    const start = byId.get(startId);
    if (!start || busy.has(startId)) return null;
    if (start.seats >= people) return [startId];

    let best = null;
    let bestScore = Infinity;
    const consider = (ids) => {
      if (capacity(ids) < people) return false;
      const s = score(ids, people);
      if (s < bestScore) {
        bestScore = s;
        best = ids;
      }
      return true;
    };

    // Fusions manuelles complètes contenant la table (quelle que soit leur taille)
    for (const g of groups) {
      if (!g.tableIds.includes(startId) || g.tableIds.some((id) => busy.has(id))) continue;
      consider([startId, ...g.tableIds.filter((id) => id !== startId)]);
    }

    // Tables fusionnables côte à côte, jusqu'à MAX_MERGE tables
    const seen = new Set([startId]);
    let frontier = [[startId]];
    while (frontier.length) {
      const next = [];
      for (const group of frontier) {
        for (const id of group) {
          for (const nb of neighbors.get(id) || []) {
            if (group.includes(nb) || busy.has(nb)) continue;
            const ids = [...group, nb];
            const key = setKey(ids);
            if (seen.has(key)) continue;
            seen.add(key);
            if (!consider(ids) && ids.length < MAX_MERGE) next.push(ids);
          }
        }
      }
      frontier = next;
    }
    return best;
  }

  /** Meilleures combinaisons sur toute la salle, triées (les moins "coûteuses" d'abord). */
  function candidates(people, busy = new Set(), limit = Infinity) {
    const seen = new Set();
    const list = [];
    for (const t of tables) {
      const ids = find(t.id, people, busy, smartScore);
      if (!ids) continue;
      const key = setKey(ids);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ ids, score: smartScore(ids, people) });
    }
    list.sort((a, b) => a.score - b.score);
    return list.slice(0, limit).map((c) => c.ids);
  }

  return { find, candidates, capacity, flexibility };
}

/**
 * Trouve la meilleure combinaison de tables libres et reliées contenant `startId`
 * pour accueillir `people` personnes. Privilégie le moins de places perdues,
 * puis le moins de tables. Retourne un tableau d'ids (startId en premier) ou null.
 */
export function findCombination(tables, startId, people, busy = new Set(), groups = []) {
  return createPlanner(tables, groups).find(startId, people, busy);
}

/**
 * Meilleure combinaison sur toute la salle pour `people` personnes :
 * le moins de places perdues, en gardant libres les tables polyvalentes.
 */
export function bestPlacement(tables, people, busy = new Set(), groups = []) {
  return createPlanner(tables, groups).candidates(people, busy, 1)[0] ?? null;
}

/** Nombre d'alternatives essayées par réservation quand l'anticipation est nécessaire. */
const LOOKAHEAD_CHOICES = 5;

/**
 * Place automatiquement les réservations données (les plus grandes d'abord).
 * 1. Choix "intelligent" : on donne d'abord les tables les moins polyvalentes.
 * 2. Si des réservations restent sans table, on recommence en anticipant : pour chaque
 *    réservation, on garde l'alternative qui permet de placer le plus de réservations suivantes.
 * Retourne Map<reservationId, tableIds[]> pour celles qui ont pu être placées.
 */
export function autoAssign(tables, reservations, busy = new Set(), groups = []) {
  const planner = createPlanner(tables, groups);
  const queue = [...reservations].sort((a, b) => b.people - a.people || a.time.localeCompare(b.time));

  const greedy = (list, taken) => {
    const result = new Map();
    const used = new Set(taken);
    for (const r of list) {
      const [ids] = planner.candidates(r.people, used, 1);
      if (!ids) continue;
      ids.forEach((id) => used.add(id));
      result.set(r.id, ids);
    }
    return result;
  };

  const first = greedy(queue, busy);
  if (first.size === queue.length) return first;

  // Anticipation : chaque choix est jugé sur ce qu'il laisse pour la suite
  const result = new Map();
  const taken = new Set(busy);
  queue.forEach((r, i) => {
    const rest = queue.slice(i + 1);
    let chosen = null;
    let chosenCount = -1;
    for (const ids of planner.candidates(r.people, taken, LOOKAHEAD_CHOICES)) {
      const count = greedy(rest, new Set([...taken, ...ids])).size;
      if (count > chosenCount) {
        chosen = ids;
        chosenCount = count;
        if (count === rest.length) break;
      }
    }
    if (!chosen) return;
    chosen.forEach((id) => taken.add(id));
    result.set(r.id, chosen);
  });
  return result.size > first.size ? result : first;
}
