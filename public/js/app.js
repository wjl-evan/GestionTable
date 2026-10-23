import { api, auth, AuthError, CLIENT_ID, setAuthHandler } from './api.js';
import { initPickers, refreshPickers } from './pickers.js';
import {
  areAdjacent, buildGraph, capacityOf, findCombination, groupOf, isActive, serviceOf, setKey, spanningEdges, statusOf,
  localDate,
} from '/shared/rules.js';

const $ = (sel, el = document) => el.querySelector(sel);
const SNAP = 10;

const state = {
  formPick: null, // choix des tables sur le plan depuis le formulaire : { tableIds, name, people }
  room: { w: 1000, h: 620 },
  zones: [],
  tables: [],
  groups: [], // fusions manuelles : { id, tableIds, capacity }
  reservations: [],
  date: localDate(),
  service: new Date().getHours() < 16 ? 'midi' : 'soir',
  filter: 'all',
  editMode: false,
  selectedRes: null,
  selection: [], // éléments sélectionnés en mode édition : [{ kind: 'table' | 'zone', id }]
  drag: null, // { resId }
  hover: null,
  scale: 1,
  zoom: null, // null = ajusté à l'écran
  offset: { x: 0, y: 0 },
  linking: null, // id de la table en attente d'un lien (mode édition)
  grouping: null, // regroupement manuel en cours : { resId, tableIds, target, proposed }
  placing: null, // réservation à placer en touchant une table (tablette : remplace le glisser-déposer)
  returnToList: false, // téléphone : revenir à la liste une fois la réservation placée
  view: 'list', // téléphone : vue affichée ('list' ou 'plan')
  sheetTable: null, // téléphone : table dont la fiche est ouverte
  search: '', // recherche dans la liste des réservations
  noteEditing: null, // id de la réservation dont on modifie la note interne (dans sa fiche)
  multiSelect: false, // mode "Sélection multiple" (= Ctrl+clic sans clavier)
  panMode: false, // mode "Déplacer la vue" en édition (glisser le fond déplace au lieu de sélectionner)
};

// `state.selected` = l'élément sélectionné quand il est seul (panneau de détail, poignée, liens).
// L'affecter remplace toute la sélection.
Object.defineProperty(state, 'selected', {
  get() {
    return this.selection.length === 1 ? this.selection[0] : null;
  },
  set(value) {
    this.selection = value ? [value] : [];
  },
});

const TABLE_PRESETS = [
  { label: '2 places', seats: 2, w: 80, h: 80, shape: 'rect', mergeable: true },
  { label: '4 places', seats: 4, w: 120, h: 80, shape: 'rect', mergeable: true },
  { label: '6 places', seats: 6, w: 160, h: 90, shape: 'rect', mergeable: true },
  { label: 'Ronde 4', seats: 4, w: 100, h: 100, shape: 'round', mergeable: false },
];

const ZONE_TYPES = {
  bar: { label: 'Bar', w: 200, h: 80 },
  door: { label: 'Entrée', w: 120, h: 30 },
  window: { label: 'Fenêtre', w: 240, h: 12 },
  wall: { label: 'Mur', w: 200, h: 12 },
  kitchen: { label: 'Cuisine', w: 220, h: 160 },
  wc: { label: 'Toilettes', w: 120, h: 100 },
  area: { label: 'Zone', w: 240, h: 160 },
};

const els = {
  plan: $('#plan'),
  planWrap: $('#planWrap'),
  planStage: $('#planStage'),
  resList: $('#resList'),
  sidebar: $('#sidebar'),
  inspector: $('#inspector'),
  stats: $('#stats'),
  date: $('#date'),
  dialog: $('#resDialog'),
  form: $('#resForm'),
  toasts: $('#toasts'),
};

/* ---------- Helpers ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const tableById = (id) => state.tables.find((t) => t.id === id);
const zoneById = (id) => state.zones.find((z) => z.id === id);
const isPicked = (kind, id) => state.selection.some((s) => s.kind === kind && s.id === id);
const itemOf = (kind, id) => (kind === 'table' ? tableById(id) : zoneById(id));
const itemNode = (kind, id) => els.plan.querySelector(`.${kind}[data-id="${id}"]`);
const snap = (v) => Math.round(v / SNAP) * SNAP;
const resById = (id) => state.reservations.find((r) => r.id === id);
const tableNode = (id) => els.plan.querySelector(`.table[data-id="${id}"]`);

/** Tri de la liste : par heure, puis par nom (ordre alphabétique français, sans tenir compte des accents). */
const byTimeThenName = (a, b) =>
  a.time.localeCompare(b.time) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base', numeric: true });

function visibleReservations() {
  return state.reservations.filter((r) => serviceOf(r.time) === state.service).sort(byTimeThenName);
}

/* ---------- Recherche ---------- */

/** Texte en minuscules, sans accents : « Lefèvre » est trouvé en tapant « lefevre ». */
const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Table désignée par la recherche : « T12 », « t12 », « table 12 », ou le nom exact d'une table. */
function searchedTable(q) {
  const short = q.match(/^(?:t|table\s*)(\w+)$/);
  const wanted = short ? `t${short[1]}` : q;
  return state.tables.find((t) => normalize(t.name).replace(/\s+/g, '') === wanted.replace(/\s+/g, ''));
}

/**
 * Une réservation correspond-elle à la recherche ?
 *  - un nombre (« 4 », « 4 pers ») → nombre de personnes exact ;
 *  - une table (« T12 », « table 12 ») → qui est à cette table ;
 *  - un long numéro → téléphone ;
 *  - sinon → morceau du nom.
 */
function matchesSearch(r, query) {
  const q = normalize(query).trim();
  if (!q) return true;
  const people = q.match(/^(\d{1,2})\s*(p|pers|personnes?)?\.?$/);
  if (people) return r.people === Number(people[1]);
  const table = searchedTable(q);
  if (table) return r.tableIds.includes(table.id);
  const digits = q.replace(/[\s.]/g, '');
  if (/^\d{3,}$/.test(digits)) return normalize(r.phone).replace(/[\s.]/g, '').includes(digits);
  return normalize(r.name).includes(q);
}

/** Filtres de la liste (puces avec compteur). */
const FILTERS = [
  { id: 'all', label: 'Toutes', test: () => true },
  { id: 'todo', label: 'À placer', test: (r) => !r.tableIds.length && isActive(r) },
  { id: 'expected', label: 'Attendues', test: (r) => statusOf(r) === 'expected' },
  { id: 'arrived', label: 'En salle', test: (r) => statusOf(r) === 'arrived' },
  { id: 'left', label: 'Parties', test: (r) => statusOf(r) === 'left' },
];
const currentFilter = () => FILTERS.find((f) => f.id === state.filter) ?? FILTERS[0];

/** Met en évidence la partie du nom qui correspond à la recherche. */
function highlight(name, query) {
  const q = normalize(query).trim();
  const i = q && !/^\d/.test(q) ? normalize(name).indexOf(q) : -1;
  if (i < 0) return esc(name);
  return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}

/** Réservations qui occupent encore leurs tables (les clients partis les ont libérées). */
const activeReservations = () => visibleReservations().filter(isActive);

/** Map<tableId, reservation> pour le service affiché. */
function occupancy() {
  const map = new Map();
  for (const r of activeReservations()) for (const id of r.tableIds) map.set(id, r);
  return map;
}

function busyExcept(resId) {
  const set = new Set();
  for (const r of activeReservations()) if (r.id !== resId) r.tableIds.forEach((id) => set.add(id));
  return set;
}

const hhmm = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');

/** Capacité d'un groupe de tables, bonus des liens compris. */
const cap = (ids) => capacityOf(state.tables, ids, state.groups);
const groupsOfTable = (id) => state.groups.filter((g) => g.tableIds.includes(id));

const tableNames = (r) => r.tableIds.map((id) => tableById(id)?.name).filter(Boolean).join(' + ');

function toast(message, type = 'info') {
  if (document.body.classList.contains('locked')) return; // l'écran du code d'accès est affiché
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  els.toasts.append(el);
  // Le temps de lire : plus long pour un long message (ex. réservation déplacée)
  const ms = Math.min(9000, Math.max(3200, message.length * 55));
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

function nextTableName() {
  const max = state.tables.reduce((m, t) => Math.max(m, parseInt(t.name.replace(/\D/g, ''), 10) || 0), 0);
  return `T${max + 1}`;
}

/* ---------- Chargement ---------- */

async function loadPlan() {
  const { room, zones, tables, groups } = await api.plan();
  Object.assign(state, { room, zones, tables, groups });
}

async function loadReservations() {
  state.reservations = await api.reservations(state.date);
}

/* ---------- Rendu ---------- */

function render() {
  renderControls();
  renderStats();
  if (state.editMode) renderInspector();
  else renderList();
  renderGroupingBar(); // avant le plan : il peut annuler un regroupement devenu invalide
  renderPickBar();
  renderPlacingBar();
  renderPlan();
  renderSheet();
  renderDetail();
}

function renderControls() {
  els.date.value = state.date;
  refreshPickers($('.date-nav'));
  for (const b of document.querySelectorAll('#service button')) {
    b.classList.toggle('active', b.dataset.value === state.service);
  }
  const toggle = $('#editToggle');
  toggle.textContent = state.editMode ? 'Terminer' : 'Modifier le plan';
  toggle.classList.toggle('active', state.editMode);
  $('#newRes').hidden = state.editMode;
  $('#topMenu [data-top="edit"] span').textContent = state.editMode ? 'Terminer la modification du plan' : 'Modifier le plan';
  els.sidebar.hidden = state.editMode;
  els.inspector.hidden = !state.editMode;
  document.body.classList.toggle('editing', state.editMode);
  document.body.classList.toggle('linking', Boolean(state.linking));
  document.body.dataset.view = state.view;
  for (const b of document.querySelectorAll('#bottomNav [data-view]')) b.classList.toggle('active', b.dataset.view === state.view);
  $('#navListLabel').textContent = state.editMode ? 'Réglages' : 'Réservations';
}

function renderStats() {
  const list = visibleReservations();
  const covers = list.reduce((s, r) => s + r.people, 0);
  const sum = (rs) => rs.reduce((s, r) => s + r.people, 0);
  const arrived = sum(list.filter((r) => statusOf(r) === 'arrived'));
  const left = sum(list.filter((r) => statusOf(r) === 'left'));
  const todo = list.filter((r) => !r.tableIds.length && isActive(r) && !r.archived).length;
  $('#autoAssign').disabled = todo === 0;
  $('#unassignAll').disabled = !list.some((r) => r.tableIds.length && isActive(r) && !r.archived);
  $('#navTodo').hidden = !todo || state.editMode;
  $('#navTodo').textContent = todo;
  const capacity = state.tables.reduce((s, t) => s + t.seats, 0);
  els.stats.innerHTML = `
    <div class="stat"><strong>${covers}</strong><span>couverts / ${capacity}</span></div>
    <div class="stat"><strong>${arrived}</strong><span>en salle</span></div>
    <div class="stat"><strong>${left}</strong><span>partis</span></div>
    <div class="stat ${todo ? 'warn' : ''}"><strong>${todo}</strong><span>à placer</span></div>
    <div class="meter" title="${left} partis · ${arrived} en salle · ${covers - left - arrived} attendus (couverts)">
      <i class="left" style="width:${covers ? (left / covers) * 100 : 0}%"></i>
      <i style="width:${covers ? (arrived / covers) * 100 : 0}%"></i>
    </div>`;
}

const STATUS_LABEL = { expected: 'Attendu', arrived: 'Arrivé', left: 'Parti' };

const LOCK = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';

/** Petites icônes (traits fins, couleur du texte). */
const svg = (d, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  people: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>', 13),
  phone: svg('<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>', 12),
  quote: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>', 12),
  pin: svg('<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>', 12),
  check: svg('<path d="M4 12.5l5 5L20 6.5"/>'),
  door: svg('<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  note: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  remove: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: svg(LOCK),
  table: svg('<rect x="3" y="8" width="18" height="8" rx="2"/><path d="M7 4.5h3M14 4.5h3M7 19.5h3M14 19.5h3"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 13),
  unlock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
};

/** Petit cadenas des réservations fixées (carte, plan). */
const pinMark = (size = 11) => `<span class="pin-mark" title="Fixée à cette table">${svg(LOCK, size)}</span>`;
/** Pastille violette au coin d'une table fixée (plan) : visible même en vue d'ensemble. */
const pinBadge = (cls = '') => `<span class="pin-badge${cls}" title="Fixée à cette table">${svg(LOCK, 12)}</span>`;

/** Pastille des tables d'une réservation ; orange si on se serre (moins de places que de personnes). */
function tablesPill(r, status) {
  const capacity = cap(r.tableIds);
  const tight = status !== 'left' && r.people > capacity;
  const cls = status === 'left' ? '' : tight ? 'ok tight' : status === 'expected' ? 'ok resv' : 'ok';
  const pinned = r.pinned && status !== 'left';
  const title = `${tight ? `${capacity} places pour ${r.people} personnes — on se serre` : `Tables : ${tableNames(r)}`}${pinned ? ' — fixée' : ''}`;
  return `<span class="pill ${cls}${pinned ? ' pinned' : ''}" title="${esc(title)}">${pinned ? pinMark() : ''}${esc(tableNames(r))}${tight ? ' · serré' : ''}</span>`;
}

const actionBtn = (action, icon, label, title, cls = '') =>
  `<button type="button" class="rc-btn ${cls}" data-action="${action}" title="${esc(title)}">${icon}<span>${label}</span></button>`;

/** Action principale selon l'avancement du service (sur la carte et dans la fiche). */
function mainActionHtml(r, status) {
  if (status === 'expected') return actionBtn('arrive', ICONS.check, 'Arrivé', 'Les clients sont arrivés', 'primary');
  if (status === 'left') return actionBtn('restore', ICONS.undo, 'Rétablir', 'Erreur ou client revenu : la réservation reprend ses tables si elles sont libres');
  if (r.tableIds.length) return actionBtn('leave', ICONS.door, 'Libérer', 'Les clients sont partis : la table redevient libre', 'primary');
  return actionBtn('place', ICONS.table, 'Placer', 'Choisir une table sur le plan', 'primary');
}

/** Éditeur de la note interne (dans la fiche de la réservation). */
function noteEditorHtml(r) {
  return `<div class="rc-note-editor">
    <label>${ICONS.pin} Note interne <em>— visible uniquement par l'équipe</em></label>
    <textarea rows="2" maxlength="500" placeholder="Habitué, client exigeant, acompte versé…">${esc(r.internalNote ?? '')}</textarea>
    <div class="rc-note-buttons">
      <button type="button" class="btn ghost small" data-action="note-cancel">Annuler</button>
      <button type="button" class="btn primary small" data-action="note-save">Enregistrer</button>
    </div>
  </div>`;
}

function cardHtml(r) {
  const placed = r.tableIds.length > 0;
  const status = statusOf(r);
  const statusTime = status === 'arrived' ? hhmm(r.arrivedAt) : status === 'left' ? hhmm(r.leftAt) : '';
  // Statut : petit point de couleur + libellé. Arrivé : un ↶ juste à côté annule une arrivée cochée par erreur.
  const statusTag = `<span class="rc-status ${status}"><i class="rc-dot"></i>${STATUS_LABEL[status]}${statusTime ? ` ${statusTime}` : ''}${
    status === 'arrived' ? `<button type="button" class="rc-undo" data-action="unarrive" title="Annuler l’arrivée">${ICONS.undo}</button>` : ''
  }</span>`;
  // À placer : orange ; rouge si les clients sont déjà là sans table
  const todo = status === 'left' ? '' : `<span class="pill todo${status === 'arrived' ? ' urgent' : ''}">À placer</span>`;

  // Ligne 1 : nom, nombre de personnes, action principale. Ligne 2 : statut, table. Puis les notes, s'il y en a.
  return `
    <div class="rc-head">
      <span class="rc-name">${highlight(r.name, state.search)}</span>
      <span class="rc-people" title="${r.people} personne${r.people > 1 ? 's' : ''}">${r.people}<small>pers.</small></span>
      ${r.archived ? '' : `<span class="rc-main">${mainActionHtml(r, status)}</span>`}
      <span class="rc-sub">
        ${statusTag}
        <span class="rc-tables">${placed ? tablesPill(r, status) : todo}</span>
      </span>
    </div>
    ${r.notes ? `<p class="rc-note client" title="Demande du client">${ICONS.quote}<span>${esc(r.notes)}</span></p>` : ''}
    ${r.internalNote ? `<p class="rc-note internal" title="Note interne (équipe)">${ICONS.pin}<span>${esc(r.internalNote)}</span></p>` : ''}`;
}

async function saveInternalNote(r, text) {
  try {
    replaceReservation(await api.updateReservation(r.id, { internalNote: text }));
    state.noteEditing = null;
    toast(text.trim() ? 'Note interne enregistrée' : 'Note interne supprimée', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

function renderList() {
  const all = visibleReservations();
  const filter = currentFilter();
  const byFilter = all.filter(filter.test);
  const list = byFilter.filter((r) => matchesSearch(r, state.search));

  renderFilters(all);
  $('#searchClear').hidden = !state.search;
  renderTimeStrip(list);
  // La liste est reconstruite d'un coup (fragment) et garde sa position : une mise à jour
  // (synchronisation, bouton « Arrivé »…) ne la fait pas sauter ni ne coupe un défilement en cours
  const scroll = els.resList.scrollTop;
  const frag = document.createDocumentFragment();
  if (!list.length) {
    els.resList.innerHTML = `<li class="empty">${emptyListMessage(all, byFilter)}</li>`;
    $('#showOtherService', els.resList)?.addEventListener('click', () => {
      state.service = state.service === 'midi' ? 'soir' : 'midi';
      render();
    });
    $('#showAllFilter', els.resList)?.addEventListener('click', () => {
      state.filter = 'all';
      render();
    });
    return;
  }
  if (all.some((r) => r.archived)) {
    const note = document.createElement('li');
    note.className = 'archived-note';
    note.textContent = 'Service archivé : consultation seule. Les noms et téléphones sont effacés au bout de la durée de conservation (réglable dans « Modifier le plan »).';
    frag.append(note);
  }
  if (state.search) {
    const count = document.createElement('li');
    count.className = 'list-count';
    count.textContent = `${list.length} résultat${list.length > 1 ? 's' : ''}`;
    frag.append(count);
  }

  let currentTime = null;
  for (const r of list) {
    // Nouvelle heure : en-tête du créneau (la liste est déjà triée par heure)
    if (r.time !== currentTime) {
      currentTime = r.time;
      frag.append(timeHeader(r.time, list.filter((x) => x.time === r.time)));
    }
    frag.append(buildCard(r));
  }
  els.resList.replaceChildren(frag);
  if (els.resList.scrollTop !== scroll) els.resList.scrollTop = scroll;
  syncTimeStrip();
}

/** Carte d'une réservation (utilisée dans la liste et dans la fiche du plan sur téléphone). */
function buildCard(r) {
  const status = statusOf(r);
  const li = document.createElement('li');
  li.className = `res-card status-${status}${r.tableIds.length ? ' placed' : ''}${state.selectedRes === r.id ? ' selected' : ''}`;
  // pas de glisser pour une réservation fixée
  const movable = status !== 'left' && !r.archived && !r.pinned;
  li.draggable = movable;
  li.dataset.id = r.id;
  li.innerHTML = cardHtml(r);

  li.addEventListener('dragstart', (e) => startDrag(e, r.id));
  li.addEventListener('dragend', endDrag);
  // Au doigt : appui long puis glisser vers une table
  li.addEventListener('pointerdown', (e) => {
    if (movable && !e.target.closest('button, a')) armTouchDrag(e, r.id, li);
  });
  li.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // lien téléphone
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action) return resAction(r, action);
    openDetail(r); // toucher la carte : fiche avec les détails et toutes les actions
  });
  return li;
}

/* ---------- Fiche d'une réservation ---------- */

const detailEl = $('#resDetail');
let detailId = null;
let keepSelectionOnClose = false;

/** Téléphone : le plan est sur un autre écran ; on y va, centré sur la table mise en évidence. */
function showOnPlan(r) {
  keepSelectionOnClose = true;
  closeDetail();
  state.selectedRes = r.id;
  setView('plan');
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => revealTables(r.tableIds)));
}

const longDate = (iso) =>
  new Date(`${iso}T12:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

/** Ouvre la fiche : détails + actions. Sa table s'allume sur le plan. */
function openDetail(r) {
  detailId = r.id;
  state.noteEditing = null;
  state.placing = null;
  state.selectedRes = r.id;
  if (!detailEl.open) detailEl.showModal();
  render(); // dessine aussi la fiche (elle doit déjà être ouverte)
  // Ordinateur / tablette : on amène aussi sa table à l'écran
  if (r.tableIds.length && !isPhone()) requestAnimationFrame(() => revealTables(r.tableIds));
}

function closeDetail() {
  if (detailEl.open) detailEl.close();
}

detailEl.addEventListener('close', () => {
  const id = detailId;
  detailId = null;
  state.noteEditing = null;
  detailEl.innerHTML = '';
  // Fiche fermée : le plan redevient normal (sauf si on enchaîne sur « Placer » ou « Voir sur le plan »)
  if (keepSelectionOnClose) {
    keepSelectionOnClose = false;
    return;
  }
  if (state.selectedRes === id && !state.placing && !state.grouping) {
    state.selectedRes = null;
    render();
  }
});
// Toucher en dehors de la fiche la ferme
detailEl.addEventListener('click', (e) => {
  if (e.target === detailEl) return closeDetail();
  if (e.target.closest('[data-detail="close"]')) return closeDetail();
  const action = e.target.closest('[data-action]')?.dataset.action;
  const r = resById(detailId);
  if (action && r) resAction(r, action);
});

function renderDetail() {
  if (!detailEl.open) return;
  const r = resById(detailId);
  if (!r) return closeDetail(); // supprimée (ou changée de jour) entre-temps
  const status = statusOf(r);
  const placed = r.tableIds.length > 0;
  const active = isActive(r) && !r.archived;
  const statusTime = status === 'arrived' ? hhmm(r.arrivedAt) : status === 'left' ? hhmm(r.leftAt) : '';
  const tables = placed
    ? tablesPill(r, status)
    : status === 'left' ? '<span class="muted">Aucune table</span>' : `<span class="pill todo${status === 'arrived' ? ' urgent' : ''}">À placer</span>`;
  const capacity = cap(r.tableIds);

  const row = (icon, label, value) => `<div class="dt-row"><span class="dt-label">${icon}${label}</span><span class="dt-value">${value}</span></div>`;
  const rows = [
    row(ICONS.clock, 'Quand', `${esc(longDate(r.date))} · <b>${esc(r.time)}</b>`),
    row(ICONS.table, 'Tables', `${tables}${placed && status !== 'left' ? ` <span class="muted">${capacity} places</span>` : ''}`),
    r.phone ? row(ICONS.phone, 'Téléphone', `<a class="rc-phone" href="tel:${esc(r.phone.replace(/\s/g, ''))}">${esc(r.phone)}</a>`) : '',
    r.notes ? row(ICONS.quote, 'Demande', esc(r.notes)) : '',
  ].join('');

  const note = state.noteEditing === r.id
    ? noteEditorHtml(r)
    : r.internalNote
      ? `<p class="rc-note internal" title="Note interne (équipe)">${ICONS.pin}<span>${esc(r.internalNote)}</span></p>`
      : '';

  // Toutes les actions, avec leur libellé
  const actions = active
    ? [
        placed && isPhone() ? actionBtn('show', ICONS.table, 'Voir sur le plan', 'Ouvrir le plan, sa table mise en évidence', 'primary') : '',
        r.pinned ? '' : actionBtn('place', ICONS.table, placed ? 'Changer de table' : 'Placer sur une table', 'Toucher ensuite une table du plan'),
        placed
          ? r.pinned
            ? actionBtn('unpin', ICONS.lock, 'Fixée — libérer', 'Elle pourra de nouveau être déplacée ou retirée', 'pinned')
            : actionBtn('pin', ICONS.unlock, 'Fixer à cette table', 'Elle ne sera plus déplacée ni retirée par « Auto » ou « Tout retirer »')
          : '',
        placed && !r.pinned ? actionBtn('unassign', ICONS.remove, 'Retirer du plan', 'La réservation repasse « à placer »') : '',
        actionBtn('note', ICONS.note, r.internalNote ? 'Modifier la note' : 'Note interne', 'Note visible uniquement par l’équipe', r.internalNote ? 'has-note' : ''),
        actionBtn('edit', ICONS.edit, 'Modifier', 'Nom, nombre de personnes, heure, téléphone… (et supprimer)'),
      ].join('')
    : '';

  detailEl.innerHTML = `
    <div class="dt">
      <header class="dt-head">
        <div class="dt-title">
          <h2 id="detailName">${esc(r.name)}</h2>
          <span class="rc-status ${status}"><i class="rc-dot"></i>${STATUS_LABEL[status]}${statusTime ? ` ${statusTime}` : ''}${r.archived ? ' · archivée' : ''}</span>
        </div>
        <span class="dt-people"><b>${r.people}</b> pers.</span>
        <button type="button" class="icon-btn" data-detail="close" aria-label="Fermer">✕</button>
      </header>
      <div class="dt-rows">${rows}</div>
      ${note}
      ${active || status === 'left' ? `<div class="dt-main">${mainActionHtml(r, status)}${
        status === 'arrived' ? actionBtn('unarrive', ICONS.undo, 'Annuler l’arrivée', 'Arrivée cochée par erreur') : ''}</div>` : ''}
      ${actions ? `<div class="dt-actions">${actions}</div>` : ''}
    </div>`;
}

/** Actions d'une réservation (boutons de la carte et de la fiche). */
function resAction(r, action) {
  if (action === 'arrive') return setStatus(r, 'arrived');
  if (action === 'unarrive') return setStatus(r, 'expected');
  if (action === 'leave') return setStatus(r, 'left');
  if (action === 'restore') return setStatus(r, 'arrived');
  if (action === 'place') {
    closeDetail();
    return startPlacing(r);
  }
  if (action === 'show') return showOnPlan(r);
  if (action === 'edit') {
    closeDetail();
    return openDialog(r);
  }
  if (action === 'unassign') return unassign(r.id);
  if (action === 'pin') return setPinned(r, true);
  if (action === 'unpin') return setPinned(r, false);
  if (action === 'note') {
    state.noteEditing = state.noteEditing === r.id ? null : r.id;
    renderDetail();
    $('#resDetail textarea')?.focus();
    return;
  }
  if (action === 'note-cancel') {
    state.noteEditing = null;
    return renderDetail();
  }
  if (action === 'note-save') return saveInternalNote(r, $('#resDetail textarea').value);
}

/**
 * Mode placement : toucher ensuite une table du plan pour y installer la réservation.
 * Sur téléphone, le plan s'ouvre pour choisir la table, puis on revient à la liste.
 */
function startPlacing(r) {
  if (!isActive(r) || r.pinned || r.archived) return;
  state.selectedRes = r.id;
  state.placing = r.id;
  state.returnToList = isPhone() && state.view === 'list';
  closeSheet();
  if (isPhone()) setView('plan');
  render();
  // Déjà placée : on amène sa table à l'écran (après le recadrage du plan, d'où le double rAF)
  if (r.tableIds.length) requestAnimationFrame(() => requestAnimationFrame(() => revealTables(r.tableIds)));
}

/** Fait défiler le plan (sans changer le zoom) pour que ces tables soient bien visibles. */
function revealTables(ids) {
  const ts = ids.map(tableById).filter(Boolean);
  const wrap = els.planWrap;
  if (!ts.length || !wrap.clientWidth) return;
  const b = boxOf(ts);
  const { scale: s, offset: o } = state;
  const left = o.x + b.x * s;
  const top = o.y + b.y * s;
  const right = left + b.w * s;
  const bottom = top + b.h * s;
  const m = 48; // marge : le halo et les chaises doivent être visibles aussi
  const fullyVisible =
    left >= wrap.scrollLeft + m && right <= wrap.scrollLeft + wrap.clientWidth - m &&
    top >= wrap.scrollTop + m && bottom <= wrap.scrollTop + wrap.clientHeight - m;
  if (fullyVisible) return;
  wrap.scrollTo({
    left: (left + right) / 2 - wrap.clientWidth / 2,
    top: (top + bottom) / 2 - wrap.clientHeight / 2,
    behavior: 'smooth',
  });
}

/** Puces de filtre avec le nombre de réservations de chaque catégorie. */
function renderFilters(all) {
  const box = $('#filters');
  box.innerHTML = FILTERS.map((f) => {
    const n = all.filter(f.test).length;
    const active = f.id === currentFilter().id;
    const warn = f.id === 'todo' && n > 0 ? ' warn' : '';
    return `<button type="button" role="tab" aria-selected="${active}" class="fchip${active ? ' active' : ''}${n ? '' : ' empty'}${warn}" data-value="${f.id}">
      ${f.label}<b>${n}</b></button>`;
  }).join('');
}

/** Bande des créneaux horaires : un toucher amène la liste au créneau voulu. */
function renderTimeStrip(list) {
  const strip = $('#timeStrip');
  const times = [...new Set(list.map((r) => r.time))];
  strip.hidden = times.length < 3; // inutile pour 1 ou 2 créneaux
  if (strip.hidden) return (strip.innerHTML = '');
  const now = localDate() === state.date ? new Date().toTimeString().slice(0, 5) : null;
  strip.innerHTML = times
    .map((t) => {
      const todo = list.some((r) => r.time === t && !r.tableIds.length && isActive(r));
      return `<button type="button" class="tchip${todo ? ' todo' : ''}${now && t <= now ? ' past' : ''}" data-time="${esc(t)}">${esc(t)}</button>`;
    })
    .join('');
}

/** Met en évidence, dans la bande, le créneau affiché en haut de la liste. */
function syncTimeStrip() {
  const strip = $('#timeStrip');
  if (strip.hidden) return;
  // Les en-têtes restent collés en haut : on se repère à la première carte de chaque créneau, qui elle défile
  const top = els.resList.getBoundingClientRect().top;
  let current = null;
  for (const h of els.resList.querySelectorAll('.time-group')) {
    const first = h.nextElementSibling;
    if (first && first.getBoundingClientRect().top <= top + h.offsetHeight + 16) current = h.dataset.time;
  }
  current ??= els.resList.querySelector('.time-group')?.dataset.time;
  for (const c of strip.querySelectorAll('.tchip')) {
    const on = c.dataset.time === current;
    c.classList.toggle('active', on);
    if (on && strip.dataset.current !== current) {
      strip.scrollTo({ left: c.offsetLeft - (strip.clientWidth - c.offsetWidth) / 2, behavior: 'smooth' });
    }
  }
  strip.dataset.current = current ?? '';
}

function scrollToTime(time) {
  const header = els.resList.querySelector(`.time-group[data-time="${time}"]`);
  const first = header?.nextElementSibling;
  if (!first) return;
  // Première carte du créneau juste sous l'en-tête (qui, lui, reste collé en haut)
  const list = els.resList.getBoundingClientRect();
  const delta = first.getBoundingClientRect().top - list.top - header.offsetHeight - 6;
  els.resList.scrollTo({ top: els.resList.scrollTop + delta, behavior: 'smooth' });
}

/** Fait défiler la liste seule (jamais la page) pour montrer `el` en haut ou au centre. */
function scrollListTo(el, where = 'start', smooth = true) {
  const list = els.resList.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const delta = where === 'center' ? box.top - list.top - (list.height - box.height) / 2 : box.top - list.top - 2;
  els.resList.scrollTo({ top: els.resList.scrollTop + delta, behavior: smooth ? 'smooth' : 'auto' });
}

/** En-tête d'un créneau horaire : heure, nombre de réservations et de couverts, combien restent à placer. */
function timeHeader(time, group) {
  const covers = group.reduce((s, r) => s + r.people, 0);
  const todo = group.filter((r) => !r.tableIds.length && isActive(r)).length;
  const li = document.createElement('li');
  li.className = 'time-group';
  li.dataset.time = time;
  li.innerHTML = `
    <span class="tg-time">${esc(time)}</span>
    <span class="tg-meta">${group.length} rés. · ${covers} couv.${todo ? ` · <b>${todo} à placer</b>` : ''}</span>
    <span class="tg-line"></span>`;
  return li;
}

/** Liste vide : explique pourquoi, et propose l'autre service si la recherche y trouve quelqu'un. */
function emptyListMessage(all, byFilter) {
  if (!all.length) return 'Aucune réservation pour ce service.';
  if (!state.search) return `Aucune réservation « ${esc(currentFilter().label)} ».<br><button type="button" class="link-btn" id="showAllFilter">Voir toutes les réservations →</button>`;
  const other = state.service === 'midi' ? 'soir' : 'midi';
  const elsewhere = state.reservations.filter((r) => serviceOf(r.time) === other && matchesSearch(r, state.search)).length;
  const hidden = all.filter((r) => matchesSearch(r, state.search)).length - byFilter.filter((r) => matchesSearch(r, state.search)).length;
  let msg = `Aucun résultat pour « ${esc(state.search)} »`;
  if (hidden > 0) msg += ` dans ce filtre (${hidden} dans « Toutes »)`;
  msg += '.';
  if (elsewhere) msg += `<br><button type="button" class="link-btn" id="showOtherService">${elsewhere} résultat${elsewhere > 1 ? 's' : ''} au service du ${other} →</button>`;
  return msg;
}

function tableFormHtml(t) {
  return `<div class="section-label">Table sélectionnée</div>
    <form class="item-form" id="itemForm">
      <div class="row">
        <label class="field"><span>Nom</span><input name="name" value="${esc(t.name)}" maxlength="12" /></label>
        <label class="field"><span>Places</span><input name="seats" type="number" min="1" max="20" value="${t.seats}" /></label>
      </div>
      <div class="row">
        <label class="field"><span>Forme</span>
          <select name="shape">
            <option value="rect" ${t.shape === 'rect' ? 'selected' : ''}>Rectangle</option>
            <option value="round" ${t.shape === 'round' ? 'selected' : ''}>Ronde</option>
          </select>
        </label>
        <label class="field"><span>Largeur</span><input name="w" type="number" min="40" max="400" step="10" value="${t.w}" /></label>
        <label class="field"><span>Hauteur</span><input name="h" type="number" min="40" max="400" step="10" value="${t.h}" ${t.shape === 'round' ? 'disabled' : ''} /></label>
      </div>
      ${t.shape === 'round' ? '' : chairSelectHtml(t.chairs ?? 'auto')}
      <label class="switch"><input type="checkbox" name="mergeable" ${t.mergeable ? 'checked' : ''} /><span></span>Fusionnable avec les tables voisines</label>
      <button type="button" class="btn danger ghost" data-action="delete">Supprimer la table</button>
    </form>`;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true });
const namesOf = (ids) => ids.map(tableById).filter(Boolean).sort(byName).map((t) => t.name).join(' + ');

function capInput(value, attr) {
  return `<label class="link-cap" title="Nombre maximum de personnes une fois les tables réunies">
    <input type="number" min="1" max="200" value="${value}" ${attr} /> pers.
  </label>`;
}

/** Fusions de la table `t` : fusions manuelles (2 tables ou plus) et voisines automatiques. */
function linksHtml(t) {
  const groupRows = groupsOfTable(t.id).map(
    (g) => `<li class="link-row">
      <span class="link-name" title="${esc(namesOf(g.tableIds))}">${esc(namesOf(g.tableIds))}</span>
      <span class="pill ok">${g.tableIds.length} tables</span>
      ${capInput(g.capacity, `data-group="${g.id}"`)}
      <button type="button" class="icon-btn small" data-ungroup="${g.id}" title="Supprimer cette fusion">✕</button>
    </li>`
  );
  // Voisines automatiques qui n'ont pas déjà leur propre fusion à 2
  const { neighbors, auto } = buildGraph(state.tables);
  const autoRows = [...neighbors.get(t.id)]
    .filter((id) => auto.has(setKey([t.id, id])) && !groupOf(state.groups, [t.id, id]))
    .map(tableById)
    .sort(byName)
    .map(
      (o) => `<li class="link-row">
        <span class="link-name">${esc(t.name)} + ${esc(o.name)}</span>
        <span class="pill" title="Tables fusionnables côte à côte">voisine</span>
        ${capInput(cap([t.id, o.id]), `data-pair="${o.id}"`)}
        <span class="icon-gap"></span>
      </li>`
    );

  return `<div class="section-label">Fusions</div>
    <ul class="link-list">${[...groupRows, ...autoRows].join('') || '<li class="muted">Aucune fusion pour l’instant.</li>'}</ul>
    <button type="button" class="btn ghost small ${state.linking ? 'active' : ''}" id="startLink">
      ${state.linking ? 'Cliquez sur la table à lier… (cliquer ici pour annuler)' : '+ Lier à une autre table'}
    </button>
    <p class="muted small-note">Pour réunir 3 tables ou plus : sélectionnez-les (« Sélection multiple » ou rectangle)
    puis « Créer une fusion ».</p>`;
}

function zoneFormHtml(z) {
  return `<div class="section-label">Élément sélectionné</div>
    <form class="item-form" id="itemForm">
      <div class="row">
        <label class="field"><span>Nom</span><input name="label" value="${esc(z.label)}" maxlength="30" /></label>
        <label class="field"><span>Type</span>
          <select name="type">
            ${Object.entries(ZONE_TYPES).map(([k, v]) => `<option value="${k}" ${z.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="row">
        <label class="field"><span>Largeur</span><input name="w" type="number" min="10" step="10" value="${z.w}" /></label>
        <label class="field"><span>Hauteur</span><input name="h" type="number" min="10" step="10" value="${z.h}" /></label>
      </div>
      <button type="button" class="btn danger ghost" data-action="delete">Supprimer l'élément</button>
    </form>`;
}

/** Bloc "fusion" de la sélection : créer une grande table, ou régler celle qui existe déjà. */
function selectionGroupHtml(tableIds) {
  if (tableIds.length < 2) return '';
  const existing = groupOf(state.groups, tableIds);
  const names = esc(namesOf(tableIds));
  if (existing) {
    return `<div class="group-box">
      <div><strong>Fusion ${names}</strong></div>
      <div class="row group-row">
        ${capInput(existing.capacity, `id="groupCapacity" data-group="${existing.id}"`)}
        <button type="button" class="btn danger ghost small" data-ungroup="${existing.id}">Supprimer la fusion</button>
      </div>
    </div>`;
  }
  return `<div class="group-box">
    <div><strong>Réunir ${names}</strong></div>
    <span class="muted">Ces tables pourront accueillir une seule réservation, même si elles sont éloignées.</span>
    <div class="row group-row">
      ${capInput(cap(tableIds), 'id="newGroupCapacity"')}
      <button type="button" class="btn primary small" id="createGroup">Créer une fusion</button>
    </div>
  </div>`;
}

/** Barre d'outils du mode édition : tout se fait à la souris (les raccourcis clavier restent en bonus). */
function toolbarHtml() {
  const has = state.selection.length > 0;
  const btn = (id, label, title, { disabled = false, active = false, danger = false } = {}) =>
    `<button type="button" class="tool${active ? ' active' : ''}${danger ? ' danger' : ''}" id="${id}" title="${title}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  return `<div class="edit-toolbar">
    ${btn('toolMulti', `${state.multiSelect ? '☑' : '☐'} Sélection multiple`, 'Chaque clic ajoute ou retire un élément de la sélection (Ctrl+clic)', { active: state.multiSelect })}
    ${btn('toolAll', 'Tout sélectionner', 'Ctrl+A')}
    ${btn('toolCopy', 'Copier', 'Ctrl+C', { disabled: !has })}
    ${btn('toolPaste', 'Coller', 'Ctrl+V', { disabled: !clipboard })}
    ${btn('toolDup', 'Dupliquer', 'Ctrl+D', { disabled: !has })}
    ${btn('toolDelete', 'Supprimer', 'Suppr', { disabled: !has, danger: true })}
  </div>`;
}

function selectAll() {
  setSelection([
    ...state.tables.map((t) => ({ kind: 'table', id: t.id })),
    ...state.zones.map((z) => ({ kind: 'zone', id: z.id })),
  ]);
}

function bindToolbar() {
  const on = (id, fn) => $(`#${id}`, els.inspector)?.addEventListener('click', fn);
  on('toolMulti', () => {
    state.multiSelect = !state.multiSelect;
    renderInspector();
  });
  on('toolAll', selectAll);
  on('toolCopy', copySelection);
  on('toolPaste', pasteClipboard);
  on('toolDup', () => copySelection() && pasteClipboard());
  on('toolDelete', removeSelection);
}

function multiHtml() {
  const items = selectedItems();
  const tableIds = items.filter((i) => i.kind === 'table').map((i) => i.item.id);
  const seats = items.filter((i) => i.kind === 'table').reduce((s, i) => s + i.item.seats, 0);
  return `<div class="section-label">Sélection</div>
    <div class="multi-box">
      <strong>${describe(items)}</strong>
      ${seats ? `<span class="muted">${seats} places au total</span>` : ''}
      <span class="muted">Glissez l'un d'eux pour tout déplacer. Avec « Sélection multiple », chaque clic ajoute ou retire un élément.</span>
    </div>
    ${multiChairsHtml(items)}
    ${selectionGroupHtml(tableIds)}`;
}

/** Changer d'un coup le côté des chaises de toutes les tables rectangulaires sélectionnées. */
function multiChairsHtml(items) {
  const rects = items.filter((i) => i.kind === 'table' && i.item.shape !== 'round').map((i) => i.item);
  if (!rects.length) return '';
  const values = new Set(rects.map((t) => t.chairs ?? 'auto'));
  const value = values.size === 1 ? [...values][0] : '';
  return `<form class="item-form" id="multiChairsForm">
    ${chairSelectHtml(value, 'id="multiChairs"')}
  </form>`;
}

async function setChairsOfSelection(chairs) {
  const rects = selectedItems().filter((i) => i.kind === 'table' && i.item.shape !== 'round');
  await Promise.all(rects.map((i) => saveTable(i.item.id, { chairs })));
  render();
  toast(`Chaises modifiées sur ${rects.length} table${rects.length > 1 ? 's' : ''}`);
}

/* ---------- Conservation des données clients (réglages) ---------- */

let retentionCache = null;

const frDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

/** Remplit le formulaire « Données des clients » (depuis le cache, ou en le chargeant). */
async function fillRetentionForm(refresh = false) {
  const form = $('#retentionForm', els.inspector);
  if (!form) return;
  try {
    if (refresh || !retentionCache) retentionCache = await api.settings();
  } catch (err) {
    $('#retentionInfo', form).textContent = err.message;
    return;
  }
  const s = retentionCache;
  if (document.activeElement?.form !== form) {
    form.archiveAfterDays.value = s.archiveAfterDays;
    form.anonymizeAfterMonths.value = s.anonymizeAfterMonths;
  }
  const archived = s.archives.reduce((n, a) => n + a.count, 0);
  const years = s.archives.map((a) => `${a.year} : ${a.count}`).join(', ');
  $('#retentionInfo', form).textContent =
    `Les services de plus de ${s.archiveAfterDays} jours sont archivés (consultables, non modifiables). ` +
    `Au-delà de ${s.anonymizeAfterMonths} mois, nom, téléphone et notes sont effacés ; ` +
    `dates et couverts restent pour les statistiques. — Base : ${s.activeReservations} réservation(s) ; ` +
    `archives : ${archived}${years ? ` (${years})` : ''} ; dernier passage : ${frDate(s.lastRetention)}.`;
}

function bindRetentionForm() {
  const form = $('#retentionForm', els.inspector);
  fillRetentionForm();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api.updateSettings({
        archiveAfterDays: Number(form.archiveAfterDays.value),
        anonymizeAfterMonths: Number(form.anonymizeAfterMonths.value),
      });
      retentionCache = data;
      const { archived, anonymized } = data.result;
      toast(`Durées enregistrées — ${archived} réservation(s) archivée(s), ${anonymized} anonymisée(s)`, 'success');
      document.activeElement?.blur();
      fillRetentionForm();
      await loadReservations();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function renderInspector() {
  const t = state.selected?.kind === 'table' ? tableById(state.selected.id) : null;
  const z = state.selected?.kind === 'zone' ? zoneById(state.selected.id) : null;

  els.inspector.innerHTML = `
    <div class="panel-head">
      <h3>Édition du plan</h3>
      <p class="muted">Déplacez les éléments à la souris et redimensionnez-les avec la poignée en bas à droite.
      Glissez sur le fond pour sélectionner plusieurs éléments.
      Deux tables fusionnables placées côte à côte sont reliées et pourront être combinées.</p>
      ${toolbarHtml()}
    </div>
    <div class="inspector-body">
      ${t ? tableFormHtml(t) + linksHtml(t) : z ? zoneFormHtml(z) : state.selection.length > 1 ? multiHtml() : ''}

      <div class="section-label">Salle</div>
      <form class="item-form" id="roomForm">
        <div class="row">
          <label class="field"><span>Largeur</span><input name="w" type="number" min="300" max="4000" step="20" value="${state.room.w}" /></label>
          <label class="field"><span>Hauteur</span><input name="h" type="number" min="300" max="4000" step="20" value="${state.room.h}" /></label>
        </div>
      </form>

      <div class="section-label">Ajouter une table</div>
      <div class="preset-grid">
        ${TABLE_PRESETS.map((p, i) => `<button class="preset" data-table="${i}">
          <i class="${p.shape}" style="width:${p.w / 4}px;height:${p.h / 4}px"></i>${p.label}</button>`).join('')}
      </div>

      <div class="section-label">Ajouter un élément</div>
      <div class="chip-grid">
        ${Object.entries(ZONE_TYPES).map(([k, v]) => `<button class="chip" data-zone="${k}"><i class="swatch zone-${k}"></i>${v.label}</button>`).join('')}
      </div>

      <button class="btn danger ghost small clear-plan" id="clearPlan">Repartir d'un plan vierge</button>

      <div class="section-label">Données des clients</div>
      <form class="item-form" id="retentionForm" novalidate>
        <div class="row">
          <label class="field"><span>Archiver après</span>
            <span class="unit-input"><input name="archiveAfterDays" type="number" min="14" max="365" inputmode="numeric" /><em>jours</em></span></label>
          <label class="field"><span>Effacer nom et tél. après</span>
            <span class="unit-input"><input name="anonymizeAfterMonths" type="number" min="1" max="36" inputmode="numeric" /><em>mois</em></span></label>
        </div>
        <button type="submit" class="btn ghost small">Enregistrer</button>
        <p class="muted small-note" id="retentionInfo">Chargement…</p>
      </form>

      <div class="section-label">Code d'accès</div>
      <form class="item-form" id="pinForm" novalidate>
        <div class="row">
          <label class="field"><span>Code actuel</span><input name="current" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" /></label>
          <label class="field"><span>Nouveau code</span><input name="pin" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" /></label>
        </div>
        <button type="submit" class="btn ghost small">Changer le code</button>
        <p class="muted small-note">4 à 8 chiffres. Les autres appareils devront saisir le nouveau code.</p>
      </form>
    </div>`;

  bindRetentionForm();

  $('#pinForm', els.inspector).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await auth.change(form.current.value, form.pin.value);
      form.reset();
      toast('Code d’accès changé — les autres appareils devront saisir le nouveau code', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  els.inspector.querySelectorAll('[data-table]').forEach((b) =>
    b.addEventListener('click', () => addTable(TABLE_PRESETS[b.dataset.table]))
  );
  els.inspector.querySelectorAll('[data-zone]').forEach((b) =>
    b.addEventListener('click', () => addZone(b.dataset.zone))
  );
  $('#clearPlan', els.inspector).addEventListener('click', clearPlan);
  bindToolbar();

  if (t) {
    $('#startLink', els.inspector).addEventListener('click', () => {
      state.linking = state.linking ? null : t.id;
      render();
    });
    // Capacité d'une voisine automatique → crée une fusion à 2 avec cette capacité
    els.inspector.querySelectorAll('input[data-pair]').forEach((input) =>
      input.addEventListener('change', () => createGroup([t.id, input.dataset.pair], Number(input.value)))
    );
  }
  els.inspector.querySelectorAll('input[data-group]').forEach((input) =>
    input.addEventListener('change', () => setGroupCapacity(input.dataset.group, Number(input.value)))
  );
  els.inspector.querySelectorAll('[data-ungroup]').forEach((b) =>
    b.addEventListener('click', () => removeGroup(b.dataset.ungroup))
  );
  $('#multiChairs', els.inspector)?.addEventListener('change', (e) => setChairsOfSelection(e.target.value));
  $('#createGroup', els.inspector)?.addEventListener('click', () => {
    const tableIds = selectedItems().filter((i) => i.kind === 'table').map((i) => i.item.id);
    createGroup(tableIds, Number($('#newGroupCapacity', els.inspector).value));
  });

  const roomForm = $('#roomForm', els.inspector);
  roomForm.addEventListener('submit', (e) => e.preventDefault());
  roomForm.addEventListener('change', () => {
    const fd = new FormData(roomForm);
    updateRoom({ w: fd.get('w'), h: fd.get('h') });
  });

  const form = $('#itemForm', els.inspector);
  if (!form) return;
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('change', async () => {
    const fd = new FormData(form);
    if (t) {
      await saveTable(t.id, {
        name: fd.get('name'),
        seats: fd.get('seats'),
        shape: fd.get('shape'),
        w: fd.get('w'),
        h: fd.get('h') ?? t.h,
        ...(fd.has('chairs') ? { chairs: fd.get('chairs') } : {}),
        mergeable: fd.get('mergeable') === 'on',
      });
    } else {
      const type = fd.get('type');
      // Nom par défaut → suit le changement de type
      const label = type !== z.type && z.label === ZONE_TYPES[z.type]?.label ? ZONE_TYPES[type].label : fd.get('label');
      await saveZone(z.id, { label, type, w: fd.get('w'), h: fd.get('h') });
    }
    render();
  });
  $('[data-action="delete"]', form).addEventListener('click', () => (t ? removeTable(t) : removeZone(z)));
}

function chairPositions(t) {
  const out = [];
  const off = 10;
  const n = t.seats;
  if (t.shape === 'round') {
    const r = t.w / 2 + off;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      out.push({ x: t.w / 2 + r * Math.cos(a), y: t.h / 2 + r * Math.sin(a), rot: (a * 180) / Math.PI + 90 });
    }
    return out;
  }
  // Un ou deux côtés : le premier reçoit la moitié arrondie au-dessus, le second le reste
  const sides = chairSides(t);
  const counts = sides.length === 1 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
  sides.forEach((side, s) => {
    const k = counts[s];
    const along = side === 'top' || side === 'bottom';
    const len = along ? t.w : t.h;
    for (let i = 0; i < k; i++) {
      const p = (len * (i + 1)) / (k + 1);
      if (side === 'top') out.push({ x: p, y: -off, rot: 0 });
      if (side === 'bottom') out.push({ x: p, y: t.h + off, rot: 0 });
      if (side === 'left') out.push({ x: -off, y: p, rot: 90 });
      if (side === 'right') out.push({ x: t.w + off, y: p, rot: 90 });
    }
  });
  return out;
}

/** Côtés où sont les chaises d'une table rectangulaire (par défaut : les deux grands côtés). */
function chairSides(t) {
  const mode = t.chairs && t.chairs !== 'auto' ? t.chairs : t.w >= t.h ? 'tb' : 'lr';
  if (mode === 'tb') return ['top', 'bottom'];
  if (mode === 'lr') return ['left', 'right'];
  return [mode];
}

const CHAIR_OPTIONS = [
  ['auto', 'Automatique (grands côtés)'],
  ['tb', 'Haut et bas'],
  ['lr', 'Gauche et droite'],
  ['top', 'En haut seulement'],
  ['bottom', 'En bas seulement'],
  ['left', 'À gauche seulement'],
  ['right', 'À droite seulement'],
];

/** `value` vide = tables sélectionnées réglées différemment. */
function chairSelectHtml(value, attrs = '') {
  return `<label class="field"><span>Chaises</span>
    <select name="chairs" ${attrs}>
      ${value ? '' : '<option value="" selected disabled>Différentes</option>'}
      ${CHAIR_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
  </label>`;
}

const chairLayouts = new Map(); // disposition des chaises par réservation, pour ce dessin du plan
let lastSpot = null; // réservation mise en évidence au dernier rendu
let pulseNow = false;

function renderPlan() {
  const { plan } = els;
  const { room } = state;
  plan.innerHTML = '';
  plan.style.width = `${room.w}px`;
  plan.style.height = `${room.h}px`;

  for (const z of state.zones) plan.append(zoneElement(z));

  // Deux calques : les traits sous les tables, les capacités au-dessus
  for (const cls of ['links', 'link-badges']) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add(cls);
    svg.setAttribute('viewBox', `0 0 ${room.w} ${room.h}`);
    plan.append(svg);
  }
  renderLinks();

  const occ = occupancy();
  chairLayouts.clear();

  // Projecteur : la réservation sélectionnée a une table sur le plan → les autres tables s'effacent.
  // (Pas pendant un placement ou un regroupement : ces modes ont leur propre mise en évidence.)
  const spot = !state.editMode && !state.placing && !state.grouping && !state.formPick &&
    [...occ.values()].some((r) => r.id === state.selectedRes);
  document.body.classList.toggle('spotlight', spot);
  // Le halo ne pulse qu'au moment où l'on sélectionne, pas à chaque rafraîchissement
  pulseNow = spot && state.selectedRes !== lastSpot;
  lastSpot = spot ? state.selectedRes : null;

  if (!state.editMode) {
    for (const r of activeReservations()) if (r.tableIds.length > 1) renderMergedGroup(r);
  }

  for (const t of state.tables) plan.append(tableElement(t, state.editMode ? null : occ.get(t.id)));
  updateScale();
}

const center = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });

/**
 * Tables espacées mais dans la continuité l'une de l'autre :
 * - même ligne (ou même colonne) : sur l'autre axe, elles occupent quasiment la même bande
 *   (chevauchement ≥ 80 % de la plus grande) ;
 * - et dans le sens des chaises : pas de chaises entre les deux. Deux tables avec chaises en haut et
 *   en bas se prolongent côte à côte, pas l'une au-dessus de l'autre.
 * Sinon elles restent deux blocs reliés par un trait.
 */
function aligned(a, b) {
  if (a.shape === 'round' || b.shape === 'round') return false; // chaises tout autour
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  // Chaises entre les deux : le côté de `first` tourné vers `second`, et inversement
  const between = (first, second, toward, back) =>
    chairSides(first).includes(toward) || chairSides(second).includes(back);
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const [upper, lower] = a.y <= b.y ? [a, b] : [b, a];
  const sameRow = overlap(a.y, a.y + a.h, b.y, b.y + b.h) >= Math.max(a.h, b.h) * 0.8;
  const sameCol = overlap(a.x, a.x + a.w, b.x, b.x + b.w) >= Math.max(a.w, b.w) * 0.8;
  return (
    (sameRow && !between(left, right, 'right', 'left')) ||
    (sameCol && !between(upper, lower, 'bottom', 'top'))
  );
}

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Regroupe les tables d'une fusion en blocs (un seul fond par bloc) : tables qui se touchent,
 * ou alignées sur la même ligne / colonne même si elles sont espacées — tant que le bloc
 * ne recouvre pas une autre table.
 */
function mergeClusters(ts) {
  const others = state.tables.filter((t) => !ts.includes(t));
  const free = (c) => !others.some((o) => intersects(o, boxOf(c)));
  const clusters = [];
  for (const t of ts) {
    const joining = clusters.filter((c) => c.some((o) => areAdjacent(o, t) || (aligned(o, t) && free([o, t]))));
    const merged = [t, ...joining.flat()];
    if (joining.length && !free(merged)) {
      clusters.push([t]);
      continue;
    }
    for (const c of joining) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }
  return clusters;
}

const boxOf = (ts) => {
  const x = Math.min(...ts.map((t) => t.x));
  const y = Math.min(...ts.map((t) => t.y));
  const w = Math.max(...ts.map((t) => t.x + t.w)) - x;
  const h = Math.max(...ts.map((t) => t.y + t.h)) - y;
  return { x, y, w, h };
};

const boxStyle = (b) => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });

/**
 * Groupe fusionné : un fond commun par bloc de tables qui se touchent ;
 * si les tables sont éloignées (lien manuel), un trait relie les blocs.
 */
function renderMergedGroup(r) {
  const { plan } = els;
  const ts = r.tableIds.map(tableById).filter(Boolean);
  const clusters = mergeClusters(ts);
  const selected = state.selectedRes === r.id ? ` selected${pulseNow ? ' pulse' : ''}` : '';

  // Blocs éloignés : reliés par le chemin le plus court
  if (clusters.length > 1) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `connectors${selected}`);
    svg.setAttribute('viewBox', `0 0 ${state.room.w} ${state.room.h}`);
    svg.innerHTML = spanningEdges(clusters.map((c) => center(boxOf(c))))
      .map(([a, b]) => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`)
      .join('');
    plan.append(svg);
  }

  // Chaises de la rangée (plus de personnes que de chaises) : réparties sur tout le bloc
  for (const c of layoutOf(r).rows) {
    const chair = document.createElement('span');
    chair.className = `chair plan-chair taken ${statusOf(r)}${c.extra ? ' extra' : ''}${selected}`;
    Object.assign(chair.style, { left: `${c.x}px`, top: `${c.y}px`, transform: `translate(-50%, -50%) rotate(${c.rot}deg)` });
    plan.append(chair);
  }

  for (const c of clusters) {
    const merge = document.createElement('div');
    merge.className = `merge ${statusOf(r)}${r.pinned ? ' pinned' : ''}${selected}`;
    merge.dataset.table = c[0].id; // table « représentante » du bloc
    Object.assign(merge.style, boxStyle(boxOf(c)));
    bindMergeBlock(merge, r, c[0]);
    plan.append(merge);
  }

  // Le nom s'affiche sur le plus grand bloc
  const main = boxOf(clusters.reduce((big, c) => {
    const b = boxOf(c);
    const bb = boxOf(big);
    return b.w * b.h > bb.w * bb.h ? c : big;
  }));
  const label = document.createElement('div');
  label.className = `merge-label ${statusOf(r)}${selected}`;
  Object.assign(label.style, boxStyle(main));
  label.innerHTML = `<span class="t-guest">${esc(r.name)}</span>
    <span class="t-meta">${tableMeta(r, cap(r.tableIds))}</span>`;
  plan.append(label);
  if (r.pinned) {
    plan.insertAdjacentHTML('beforeend', pinBadge(` plan-badge${selected}`));
    Object.assign(plan.lastElementChild.style, { left: `${main.x + main.w}px`, top: `${main.y}px` });
  }
}

/**
 * Toute la zone colorée d'une fusion (espaces entre les tables compris) se comporte comme ses tables :
 * on la glisse (souris ou appui long au doigt) pour déplacer la réservation, un toucher la sélectionne,
 * et on peut y déposer une réservation. Les actions sont relayées à une table du bloc.
 */
function bindMergeBlock(merge, r, t) {
  const tableEl = () => els.plan.querySelector(`.table[data-id="${t.id}"]`);
  if (!r.archived && !r.pinned) {
    merge.draggable = true;
    merge.addEventListener('dragstart', (e) => startDrag(e, r.id));
    merge.addEventListener('dragend', endDrag);
    merge.addEventListener('pointerdown', (e) => armTouchDrag(e, r.id, merge));
  }
  merge.addEventListener('dragover', (e) => onTableDragOver(e, t));
  merge.addEventListener('dragleave', (e) => {
    if (!merge.contains(e.relatedTarget)) clearPreview();
  });
  merge.addEventListener('drop', (e) => {
    e.preventDefault();
    const resId = state.drag?.resId;
    clearPreview();
    if (resId) assign(resId, t.id);
  });
  merge.addEventListener('click', () => tableEl()?.click());
  merge.addEventListener('dblclick', () => tableEl()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
}

/** Voisinages et fusions manuelles (visibles en édition et pendant un glisser-déposer). */
function renderLinks() {
  const svg = els.plan.querySelector('svg.links');
  const badgeLayer = els.plan.querySelector('svg.link-badges');
  if (!svg) return;
  const pickedIds = new Set(state.selection.filter((s) => s.kind === 'table').map((s) => s.id));
  let lines = '';
  let badges = '';

  // Voisines automatiques : pointillé + point au milieu
  const { auto } = buildGraph(state.tables);
  for (const key of auto) {
    const [a, b] = key.split('|').map(tableById).map(center);
    lines += `<line class="auto" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />
      <circle cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" r="4" />`;
  }

  // Fusions manuelles : tables reliées + capacité au centre du groupe
  for (const g of state.groups) {
    const pts = g.tableIds.map(tableById).filter(Boolean).map(center);
    if (pts.length < 2) continue;
    const picked = g.tableIds.some((id) => pickedIds.has(id)) ? ' picked' : '';
    for (const [a, b] of spanningEdges(pts)) {
      lines += `<line class="manual${picked}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
    }
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const text = `${g.tableIds.length > 2 ? `${g.tableIds.length} tables · ` : ''}${g.capacity} pers.`;
    const w = text.length * 6.6 + 16;
    badges += `<g class="badge${picked}" transform="translate(${mx} ${my})">
      <rect x="${-w / 2}" y="-11" width="${w}" height="22" rx="11" />
      <text text-anchor="middle" dy="4">${text}</text></g>`;
  }
  svg.innerHTML = lines;
  badgeLayer.innerHTML = badges;
}

function zoneElement(z) {
  const el = document.createElement('div');
  el.className = `zone zone-${z.type || 'area'}${z.w < 40 || z.h < 30 ? ' thin' : ''}`;
  el.dataset.id = z.id;
  el.title = z.label;
  Object.assign(el.style, { left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px` });
  el.innerHTML = `<span>${esc(z.label)}</span>`;
  if (state.editMode) {
    if (isPicked('zone', z.id)) decoratePicked(el, z, 'zone');
    el.addEventListener('pointerdown', (e) => startMove(e, z, el, 'zone'));
  }
  return el;
}

/** Sous-titre d'une table occupée : heure prévue, ou ✓ si les clients sont là. */
const tableMeta = (res, seats) => {
  // Plus de monde que de places (regroupement à la main) : affiché en orange
  const count = res.people > seats ? `<b class="tight" title="On se serre">${res.people}/${seats}</b>` : `${res.people}/${seats}`;
  return statusOf(res) === 'arrived' ? `✓ ${count} · ${hhmm(res.arrivedAt)}` : `${count} · ${esc(res.time)}`;
};

/**
 * Chaises occupées par la réservation `res` sur la table `t` (indices dans chairPositions).
 * Tables fusionnées : on remplit table après table, dans l'ordre de la fusion.
 * Placement naturel : les convives se font face (côtés alternés) ; autour d'une table ronde,
 * ils sont répartis régulièrement.
 */
function takenChairs(t, res) {
  let before = 0;
  for (const id of res.tableIds) {
    if (id === t.id) break;
    before += tableById(id)?.seats ?? 0;
  }
  const n = t.seats;
  const k = Math.max(0, Math.min(n, res.people - before));
  if (k >= n) return new Set([...Array(n).keys()]);
  if (t.shape === 'round') return new Set([...Array(k).keys()].map((i) => Math.floor((i * n) / k)));
  // Chaises d'un seul côté : à la suite
  if (chairSides(t).length === 1) return new Set([...Array(k).keys()]);
  // Rectangle : chairPositions donne d'abord un côté (a chaises) puis l'autre ; on alterne les côtés
  const a = Math.ceil(n / 2);
  const order = [];
  for (let i = 0; i < a; i++) {
    order.push(i);
    if (a + i < n) order.push(a + i);
  }
  return new Set(order.slice(0, k));
}

/* ---------- Plus de personnes que de chaises : chaises ajoutées ---------- */

const CHAIR_ROOM = 26; // place d'une chaise le long d'un côté (22 px + un peu d'air)
const CHAIR_OFF = 10; // distance chaise ↔ bord de la table

/** Bande où irait une chaise, le long d'un côté d'un rectangle (table ou bloc de tables). */
function chairStrip(b, side, depth) {
  if (side === 'top') return { x: b.x, y: b.y - depth, w: b.w, h: depth };
  if (side === 'bottom') return { x: b.x, y: b.y + b.h, w: b.w, h: depth };
  if (side === 'left') return { x: b.x - depth, y: b.y, w: depth, h: b.h };
  return { x: b.x + b.w, y: b.y, w: depth, h: b.h };
}

/**
 * Côté impossible pour une chaise : mur, bar, cuisine… (pas une simple « Zone » de sol),
 * une autre table juste à côté, ou une table de la même réservation (`own`) un peu plus loin :
 * pas de chaise coincée entre deux tables réunies.
 */
function chairSideBlocked(b, side, own) {
  if (state.zones.some((z) => z.type !== 'area' && intersects(chairStrip(b, side, 20), z))) return true;
  return state.tables.some((o) => o !== b && !(b.id === undefined && own.includes(o)) &&
    intersects(chairStrip(b, side, own.includes(o) ? 40 : 20), o));
}

/**
 * Tables réunies en rangée (fusion) : comme une seule grande table.
 * Les chaises (prévues + ajoutées) sont réparties sur toute la longueur du bloc, espaces compris,
 * en deux rangées face à face ; si les rangées sont pleines, on utilise les bouts du bloc.
 * Renvoie les chaises en coordonnées du plan, ou null si le bloc n'est pas une rangée simple.
 */
function rowChairs(cluster, extra) {
  if (cluster.length < 2 || cluster.some((t) => t.shape === 'round')) return null;
  const box = boxOf(cluster);
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  const [first] = cluster;
  const horizontal = cluster.every((t) => overlap(t.y, t.y + t.h, first.y, first.y + first.h) >= Math.max(t.h, first.h) * 0.8);
  const vertical = !horizontal && cluster.every((t) => overlap(t.x, t.x + t.w, first.x, first.x + first.w) >= Math.max(t.w, first.w) * 0.8);
  if (!horizontal && !vertical) return null;

  // Côtés longs qui ont des chaises sur toutes les tables du bloc
  const rows = (horizontal ? ['top', 'bottom'] : ['left', 'right']).filter((side) => cluster.every((t) => chairSides(t).includes(side)));
  if (!rows.length) return null;
  // Bouts du bloc (box n'a pas d'id : ses propres tables ne le bloquent pas)
  const ends = (horizontal ? ['left', 'right'] : ['top', 'bottom']).filter((side) => !chairSideBlocked(box, side, cluster));

  const total = cluster.reduce((sum, t) => sum + t.seats, 0) + extra;
  const rowCap = Math.max(1, Math.floor((horizontal ? box.w : box.h) / CHAIR_ROOM));
  const endCap = Math.max(1, Math.floor((horizontal ? box.h : box.w) / CHAIR_ROOM));
  const counts = {};
  rows.forEach((side, i) => (counts[side] = rows.length === 1 ? total : i === 0 ? Math.ceil(total / 2) : Math.floor(total / 2)));
  // Rangées trop pleines : le surplus va aux bouts ; s'il n'y a plus de place, on serre dans les rangées
  let over = 0;
  for (const side of rows) {
    if (counts[side] > rowCap) {
      over += counts[side] - rowCap;
      counts[side] = rowCap;
    }
  }
  for (let i = 0; over > 0 && ends.some((e) => (counts[e] ?? 0) < endCap); i++) {
    const side = ends[i % ends.length];
    if ((counts[side] ?? 0) < endCap) {
      counts[side] = (counts[side] ?? 0) + 1;
      over--;
    }
  }
  for (let i = 0; over > 0; i++, over--) counts[rows[i % rows.length]]++;

  // Une chaise face à un espace entre deux tables, ou en bout de bloc, est une chaise ajoutée
  const overTable = (c) => cluster.some((t) => (horizontal ? c.x >= t.x && c.x <= t.x + t.w : c.y >= t.y && c.y <= t.y + t.h));
  const out = [];
  for (const [side, k] of Object.entries(counts)) {
    const len = side === 'top' || side === 'bottom' ? box.w : box.h;
    for (let i = 0; i < k; i++) {
      const p = (len * (i + 1)) / (k + 1);
      const c = side === 'top' ? { x: box.x + p, y: box.y - CHAIR_OFF, rot: 0 }
        : side === 'bottom' ? { x: box.x + p, y: box.y + box.h + CHAIR_OFF, rot: 0 }
        : side === 'left' ? { x: box.x - CHAIR_OFF, y: box.y + p, rot: 90 }
        : { x: box.x + box.w + CHAIR_OFF, y: box.y + p, rot: 90 };
      out.push({ ...c, extra: !rows.includes(side) || !overTable(c) });
    }
  }
  return out;
}

/**
 * Où mettre les chaises d'une réservation qui a plus de personnes que de chaises :
 * - `rows` : chaises dessinées sur le plan pour les blocs de tables en rangée (`skip` : leurs tables) ;
 * - `perTable` : chaises ajoutées table par table pour le reste (voir extraChairsFor).
 * Les chaises en plus sont partagées entre les blocs de la réservation, à tour de rôle.
 */
function chairLayout(res) {
  const tables = res.tableIds.map(tableById).filter(Boolean);
  const layout = { rows: [], skip: new Set(), perTable: new Map() };
  let extra = res.people - tables.reduce((s, t) => s + t.seats, 0);
  if (extra <= 0 || !tables.length) return layout;
  const shares = mergeClusters(tables)
    .map((c) => ({ c, extra: 0, seats: c.reduce((s, t) => s + t.seats, 0) }))
    .sort((a, b) => b.seats - a.seats);
  for (let i = 0; extra > 0; i++, extra--) shares[i % shares.length].extra++;
  for (const { c, extra: e } of shares) {
    if (!e) continue;
    const row = rowChairs(c, e);
    if (row) {
      layout.rows.push(...row);
      c.forEach((t) => layout.skip.add(t.id));
    } else {
      for (const [id, entry] of extraChairsFor(c, e, tables)) layout.perTable.set(id, entry);
    }
  }
  return layout;
}

// Calculé une fois par réservation à chaque dessin du plan (cache vidé par renderPlan)
const layoutOf = (res) => {
  if (!chairLayouts.has(res.id)) chairLayouts.set(res.id, chairLayout(res));
  return chairLayouts.get(res.id);
};

/**
 * Chaises ajoutées table par table (table seule, ronde, ou bloc qui n'est pas une rangée) :
 * table id → { sides: { top: 1, … } } pour une table rectangulaire, ou { ring: n } pour une ronde.
 * Elles vont d'abord sur les côtés libres (souvent les bouts de table), jamais sur un mur
 * ni entre deux tables réunies, à tour de rôle sur les tables.
 */
function extraChairsFor(tables, extra, own) {
  const out = new Map();
  const blocked = (t, side) => chairSideBlocked(t, side, own);
  const room = (t, side) => Math.max(1, Math.floor((side === 'top' || side === 'bottom' ? t.w : t.h) / CHAIR_ROOM));
  const baseCount = (t, side) => {
    const sides = chairSides(t);
    if (!sides.includes(side)) return 0;
    return sides.length === 1 ? t.seats : side === sides[0] ? Math.ceil(t.seats / 2) : Math.floor(t.seats / 2);
  };

  // D'abord les côtés libres (bouts de table), puis, s'ils sont pleins, les côtés qui ont déjà des chaises
  const free = [];
  const used = [];
  for (const t of tables) {
    if (t.shape === 'round') free.push({ t, ring: true, left: Infinity });
    else {
      for (const side of ['left', 'right', 'top', 'bottom']) {
        if (blocked(t, side)) continue;
        const has = baseCount(t, side);
        (has ? used : free).push({ t, side, left: room(t, side) - has });
      }
    }
  }
  const place = (slot) => {
    const entry = out.get(slot.t.id) ?? (slot.ring ? { ring: 0 } : { sides: {} });
    if (slot.ring) entry.ring++;
    else entry.sides[slot.side] = (entry.sides[slot.side] ?? 0) + 1;
    out.set(slot.t.id, entry);
    slot.left--;
    extra--;
  };
  // À tour de rôle sur les côtés qui ont encore de la place
  for (const group of [free, used]) {
    while (extra > 0 && group.some((sl) => sl.left > 0)) {
      for (const slot of group) if (extra > 0 && slot.left > 0) place(slot);
    }
  }
  // Vraiment plus de place : on serre quand même, sur le premier côté disponible
  const last = free[0] ?? used[0] ?? (tables[0] && { t: tables[0], side: chairSides(tables[0])[0] ?? 'top', left: 0 });
  while (extra > 0 && last) place(last);
  return out;
}

/**
 * Chaises d'une table qui a des chaises ajoutées : chaque côté concerné est réparti à nouveau
 * (prévues + ajoutées, toutes occupées) ; les ajoutées sont en bout de rangée, marquées `extra`.
 */
function chairsWithExtra(t, entry) {
  const off = 10;
  const sides = chairSides(t);
  const counts = {};
  sides.forEach((side, i) => (counts[side] = sides.length === 1 ? t.seats : i === 0 ? Math.ceil(t.seats / 2) : Math.floor(t.seats / 2)));
  const out = [];
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const base = counts[side] ?? 0;
    const k = base + (entry.sides[side] ?? 0);
    const len = side === 'top' || side === 'bottom' ? t.w : t.h;
    for (let i = 0; i < k; i++) {
      const p = (len * (i + 1)) / (k + 1);
      const c = side === 'top' ? { x: p, y: -off, rot: 0 }
        : side === 'bottom' ? { x: p, y: t.h + off, rot: 0 }
        : side === 'left' ? { x: -off, y: p, rot: 90 }
        : { x: t.w + off, y: p, rot: 90 };
      out.push({ ...c, extra: i >= base });
    }
  }
  return out;
}

function tableElement(t, res) {
  const grouped = res && res.tableIds.length > 1;
  const el = document.createElement('div');
  el.className = ['table', t.shape, res ? `busy ${statusOf(res)}` : 'free', grouped ? 'grouped' : '', res?.pinned ? 'pinned' : '',
    res && state.selectedRes === res.id ? `selected${pulseNow ? ' pulse' : ''}` : '',
    state.grouping?.tableIds.includes(t.id) || state.formPick?.tableIds.includes(t.id) ? 'grouping-pick' : '',
    t.mergeable ? 'mergeable' : ''].filter(Boolean).join(' ');
  el.dataset.id = t.id;
  Object.assign(el.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` });

  // Plus de personnes que de chaises : on ajoute les chaises qui manquent (style « ajoutée »).
  // Tables réunies en rangée : leurs chaises sont dessinées pour tout le bloc (voir rowChairs).
  const layout = res ? layoutOf(res) : null;
  const inRow = layout?.skip.has(t.id);
  const extra = layout?.perTable.get(t.id) ?? null;
  const ring = extra?.ring ?? 0;
  const addChair = (c, cls) => {
    const chair = document.createElement('span');
    chair.className = cls;
    chair.style.left = `${c.x}px`;
    chair.style.top = `${c.y}px`;
    chair.style.transform = `translate(-50%, -50%) rotate(${c.rot}deg)`;
    el.append(chair);
  };
  if (inRow) {
    // rien ici : chaises du bloc, dessinées avec la fusion
  } else if (extra && !ring) {
    chairsWithExtra(t, extra).forEach((c) => addChair(c, c.extra ? 'chair taken extra' : 'chair taken'));
  } else {
    // Table ronde : toutes les chaises (prévues + ajoutées) sont réparties à nouveau autour ; les dernières sont les ajoutées
    const all = chairPositions(ring ? { ...t, seats: t.seats + ring } : t);
    const taken = ring ? new Set(all.keys()) : res ? takenChairs(t, res) : new Set();
    all.forEach((c, i) => addChair(c, taken.has(i) ? `chair taken${i >= t.seats ? ' extra' : ''}` : 'chair'));
  }

  const top = document.createElement('div');
  top.className = 'top';
  if (res && !grouped) {
    top.innerHTML = `<span class="t-tag">${esc(t.name)}</span>
      <span class="t-guest">${esc(res.name)}</span>
      <span class="t-meta">${tableMeta(res, t.seats)}</span>`;
  } else if (grouped) {
    top.innerHTML = `<span class="t-tag">${esc(t.name)}</span>`;
  } else {
    top.innerHTML = `<span class="t-name">${esc(t.name)}</span><span class="t-seats">${t.seats} pl.</span>`;
  }
  el.append(top);
  if (res?.pinned && !grouped) el.insertAdjacentHTML('beforeend', pinBadge());

  if (state.editMode) {
    if (isPicked('table', t.id)) decoratePicked(el, t, 'table');
    el.addEventListener('pointerdown', (e) => startMove(e, t, el, 'table'));
    return el;
  }

  // Une table occupée se déplace en glissant la réservation (sauf si elle est fixée)
  if (res && !res.archived && !res.pinned) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => startDrag(e, res.id));
    el.addEventListener('dragend', endDrag);
    el.addEventListener('pointerdown', (e) => armTouchDrag(e, res.id, el)); // au doigt : appui long puis glisser
  }
  el.addEventListener('dragover', (e) => onTableDragOver(e, t));
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) clearPreview();
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const resId = state.drag?.resId;
    clearPreview();
    if (resId) assign(resId, t.id);
  });
  // Mode « touchez une table » : aperçu au survol de la souris (sur tablette, le toucher place directement)
  el.addEventListener('pointerenter', (e) => {
    if (state.placing && !state.grouping && e.pointerType === 'mouse') previewTable(t, resById(state.placing));
  });
  el.addEventListener('pointerleave', () => {
    if (state.placing) clearPreview();
  });
  el.addEventListener('click', () => {
    if (panned) return; // fin d'un glisser du plan au doigt, pas un toucher
    if (state.grouping) return toggleGroupingTable(t, res); // (prioritaire : déplacement en cours)
    if (state.formPick) return toggleFormPick(t, res);
    if (state.placing) return placeOnTable(t, res);
    if (isPhone()) return openSheet(t.id); // téléphone : fiche de la table en bas de l'écran
    state.selectedRes = res ? (state.selectedRes === res.id ? null : res.id) : null;
    render();
    const card = res && els.resList.querySelector(`.res-card[data-id="${res.id}"]`);
    if (card) scrollListTo(card, 'center');
  });
  el.addEventListener('dblclick', () => res && !res.archived && !state.formPick && openDialog(res));
  return el;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2;
const PLAN_PAD = 32;

/**
 * Zone à cadrer quand on « ajuste » : les tables et éléments (avec une marge pour les chaises),
 * plutôt que toute la salle, souvent bien plus grande et vide sur les bords.
 * En mode édition, toute la salle (pour pouvoir placer des éléments partout).
 */
function fitBounds() {
  const { room } = state;
  const items = [...state.tables, ...state.zones];
  if (state.editMode || !items.length) return { x: 0, y: 0, w: room.w, h: room.h };
  const m = 40;
  const x1 = Math.max(0, Math.min(...items.map((i) => i.x)) - m);
  const y1 = Math.max(0, Math.min(...items.map((i) => i.y)) - m);
  const x2 = Math.min(room.w, Math.max(...items.map((i) => i.x + i.w)) + m);
  const y2 = Math.min(room.h, Math.max(...items.map((i) => i.y + i.h)) + m);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Facteur max entre « tout voir en largeur » et l'échelle retenue sur téléphone (on défile alors de côté). */
const PHONE_FIT_BOOST = 2.5;

function fitScale(b = fitBounds()) {
  const { planWrap } = els;
  const byWidth = (planWrap.clientWidth - PLAN_PAD * 2) / b.w;
  const byHeight = (planWrap.clientHeight - PLAN_PAD * 2) / b.h;
  let s = Math.min(byWidth, byHeight, 1.5);
  // Écran en hauteur (téléphone, tablette en portrait) et salle tout en largeur : tout faire tenir
  // rendrait les tables minuscules, avec un grand vide dessous. On privilégie la taille (tables
  // qu'on peut toucher) et on fait glisser le plan de côté.
  // (Sur un grand écran avec souris, on garde la vue d'ensemble de toute la salle.)
  const touchOrNarrow = isPhone() || matchMedia('(pointer: coarse), (max-width: 1100px)').matches;
  if (touchOrNarrow && byHeight > byWidth * 1.5) {
    const boost = isPhone() ? PHONE_FIT_BOOST : 2.2;
    s = Math.min(byHeight * 0.92, byWidth * boost, 1.5);
  }
  return Math.max(ZOOM_MIN, s);
}

let lastFitKey = '';

/** Échelle ajustée à l'écran, ou zoom manuel avec défilement si la salle dépasse. */
function updateScale() {
  const { planWrap, planStage, plan } = els;
  const { room } = state;
  const w = planWrap.clientWidth;
  const h = planWrap.clientHeight;
  if (!w || !h) return; // plan masqué (vue « Réservations » sur téléphone)
  let s, ox, oy;
  if (state.zoom === null) {
    // Ajusté : les tables remplissent l'écran, centrées
    const b = fitBounds();
    s = fitScale(b);
    const sw = b.w * s;
    const sh = b.h * s;
    const stageW = Math.max(w, sw + PLAN_PAD * 2);
    const stageH = Math.max(h, sh + PLAN_PAD * 2);
    planStage.style.width = `${stageW}px`;
    planStage.style.height = `${stageH}px`;
    ox = Math.max(PLAN_PAD, (w - sw) / 2) - b.x * s;
    oy = Math.max(PLAN_PAD, (h - sh) / 2) - b.y * s;
    // Nouveau cadrage (écran redimensionné, retour à « Ajuster »…) : on centre la vue ;
    // sinon on garde l'endroit où l'utilisateur a fait glisser le plan
    const key = `${w}x${h}:${s.toFixed(4)}:${b.x},${b.y},${b.w},${b.h}`;
    if (key !== lastFitKey) {
      lastFitKey = key;
      planWrap.scrollLeft = (stageW - w) / 2;
      planWrap.scrollTop = (stageH - h) / 2;
    }
  } else {
    s = state.zoom;
    lastFitKey = '';
    const sw = room.w * s;
    const sh = room.h * s;
    planStage.style.width = `${Math.max(w, sw + PLAN_PAD * 2)}px`;
    planStage.style.height = `${Math.max(h, sh + PLAN_PAD * 2)}px`;
    ox = Math.max(PLAN_PAD, (w - sw) / 2);
    oy = Math.max(PLAN_PAD, (h - sh) / 2);
  }
  state.scale = s;
  plan.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
  state.offset = { x: ox, y: oy };
  $('#zoomFit').textContent = `${Math.round(s * 100)}%`;
  $('#zoomFit').classList.toggle('active', state.zoom === null);
}

/** Change le zoom en gardant le point (cx, cy) de la vue à la même place. */
function setZoom(next, cx = els.planWrap.clientWidth / 2, cy = els.planWrap.clientHeight / 2) {
  const { planWrap } = els;
  // Point du plan (en unités de la salle) sous le curseur
  const px = (planWrap.scrollLeft + cx - state.offset.x) / state.scale;
  const py = (planWrap.scrollTop + cy - state.offset.y) / state.scale;
  state.zoom = next === null ? null : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  updateScale();
  planWrap.scrollLeft = px * state.scale + state.offset.x - cx;
  planWrap.scrollTop = py * state.scale + state.offset.y - cy;
}

/* ---------- Glisser-déposer des réservations ---------- */

function startDrag(e, resId) {
  // fromPlan : pris sur une table du plan (le lâcher sur la liste le retire du plan) ou depuis une carte de la liste
  state.drag = { resId, fromPlan: Boolean(e.currentTarget?.closest?.('.table, .merge')) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', resId);
  dragFrame = requestAnimationFrame(() => document.body.classList.add('dragging'));
}

let dragFrame = 0;

function endDrag() {
  cancelAnimationFrame(dragFrame);
  state.drag = null;
  clearPreview();
  document.body.classList.remove('dragging');
}

/* ---------- Glisser-déposer au doigt (tablette) ----------
 * Le glisser-déposer du navigateur ne marche pas au doigt : on le refait avec les événements "pointer".
 * Appui de ~¼ s sur une carte ou une table occupée, puis glisser ; un glissé immédiat garde son rôle
 * habituel (faire défiler la liste ou le plan).
 */

// Assez long pour qu'un doigt posé un instant avant de faire défiler ne lance pas un glisser
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 8; // px de tremblement tolérés pendant l'appui
let touchDrag = null; // { resId, ghost, source }
let suppressClickUntil = 0;

/** Pendant le glisser, le doigt ne doit pas faire défiler la page ou la liste. */
document.addEventListener('touchmove', (e) => touchDrag && e.preventDefault(), { passive: false });
/** Le relâchement ne doit pas être pris pour un toucher (sélection, mode placement…). */
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);
/** Pas de menu contextuel sur l'appui long d'une carte ou d'une table. */
document.addEventListener('contextmenu', (e) => {
  if (touchDrag || (matchMedia('(pointer: coarse)').matches && e.target.closest('.res-card, .table'))) e.preventDefault();
});

/** Prépare un glisser au doigt depuis `source` (carte ou table occupée). */
function armTouchDrag(e, resId, source) {
  if (e.pointerType === 'mouse' || state.editMode || touchDrag) return;
  source.draggable = false; // évite que le glisser natif (iPad) ne s'en mêle
  const id = e.pointerId;
  const start = { x: e.clientX, y: e.clientY };
  const timer = setTimeout(begin, LONG_PRESS_MS);
  // Après un court instant (pas pour un simple toucher), l'élément montre qu'il va se soulever
  const hintTimer = setTimeout(() => source.classList.add('pressing'), 120);

  function begin() {
    const res = resById(resId);
    if (!res || !isActive(res) || pinch) return cleanup();
    const ghost = document.createElement('div');
    ghost.className = 'touch-ghost';
    ghost.textContent = `${res.name} · ${res.people} pers.`;
    document.body.append(ghost);
    touchDrag = { resId, ghost, source };
    state.drag = { resId }; // même aperçu que le glisser à la souris
    source.classList.remove('pressing');
    source.classList.add('drag-source');
    document.body.classList.add('dragging', 'touch-dragging');
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(12); // petit retour haptique (Android)
    moveTouchDrag(start.x, start.y);
  }
  function onMove(ev) {
    if (ev.pointerId !== id) return;
    if (touchDrag) return moveTouchDrag(ev.clientX, ev.clientY);
    // Le doigt bouge avant la fin de l'appui (ou deux doigts) : c'est un défilement / un zoom
    if (pinch || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_TOLERANCE) cleanup();
  }
  function onUp(ev) {
    if (ev.pointerId !== id) return;
    if (touchDrag) dropTouchDrag(ev.clientX, ev.clientY);
    cleanup();
  }
  function onCancel(ev) {
    if (ev.pointerId !== id) return;
    if (touchDrag) finishTouchDrag();
    cleanup();
  }
  // La liste (ou le plan) défile : c'était un défilement, pas un appui long
  function onScroll() {
    if (!touchDrag) cleanup();
  }
  function cleanup() {
    clearTimeout(timer);
    clearTimeout(hintTimer);
    source.classList.remove('pressing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('scroll', onScroll, true);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
}

/** Ce qui se trouve sous le doigt : une table du plan, ou la liste (pour retirer du plan). */
function touchTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  const tableEl = el?.closest('.table');
  if (tableEl) return { table: tableById(tableEl.dataset.id) };
  const mergeEl = el?.closest('.merge');
  if (mergeEl) return { table: tableById(mergeEl.dataset.table) };
  if (el?.closest('#sidebar')) return { list: true };
  return {};
}

function moveTouchDrag(x, y) {
  const { ghost, resId } = touchDrag;
  // Étiquette au-dessus du doigt, pour qu'il ne la cache pas
  ghost.style.transform = `translate(${x}px, ${y - 56}px) translateX(-50%)`;
  const res = resById(resId);
  const target = touchTarget(x, y);
  if (target.table) previewTable(target.table, res);
  else clearPreview();
  els.sidebar.classList.toggle('drop-target', canUnassignByDrop(target, res));

  // Téléphone : la liste et le plan ne tiennent pas ensemble ; survoler « Plan » l'ouvre
  const overPlanTab = isPhone() && state.view === 'list' && document.elementFromPoint(x, y)?.closest('#bottomNav [data-view="plan"]');
  $('#bottomNav [data-view="plan"]').classList.toggle('drop-hover', Boolean(overPlanTab));
  if (overPlanTab && !touchDrag.navTimer) {
    touchDrag.navTimer = setTimeout(() => {
      if (!touchDrag) return;
      touchDrag.navTimer = null;
      state.returnToList = true;
      setView('plan');
    }, 350);
  } else if (!overPlanTab && touchDrag.navTimer) {
    clearTimeout(touchDrag.navTimer);
    touchDrag.navTimer = null;
  }
}

/** Déposer sur la liste retire du plan, seulement si on a pris la réservation depuis une table du plan. */
const canUnassignByDrop = (target, res) =>
  Boolean(target.list && res?.tableIds.length && touchDrag?.source.matches('.table, .merge'));

function dropTouchDrag(x, y) {
  const { resId } = touchDrag;
  const target = touchTarget(x, y);
  const unassignIt = canUnassignByDrop(target, resById(resId));
  finishTouchDrag();
  if (target.table) return assign(resId, target.table.id);
  if (unassignIt) unassign(resId);
  backToListIfNeeded(); // lâché à côté : on revient là où on était
  render();
}

function finishTouchDrag() {
  clearTimeout(touchDrag.navTimer);
  $('#bottomNav [data-view="plan"]').classList.remove('drop-hover');
  touchDrag.ghost.remove();
  touchDrag.source.classList.remove('drag-source');
  touchDrag = null;
  suppressClickUntil = Date.now() + 400;
  els.sidebar.classList.remove('drop-target');
  document.body.classList.remove('touch-dragging');
  endDrag();
}

function onTableDragOver(e, t) {
  if (!state.drag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  previewTable(t, resById(state.drag.resId));
}

/** Aperçu de ce que donnerait le placement de `res` sur la table `t`. */
function previewTable(t, res) {
  if (!res || state.hover === t.id) return;
  clearPreview();
  state.hover = t.id;

  const busy = busyExcept(res.id);
  const combo = findCombination(state.tables, t.id, res.people, busy, state.groups);
  if (combo) {
    combo.forEach((id) => tableNode(id)?.classList.add('drop-ok'));
    if (combo.length > 1) showDropHint(combo, `Proposé : ${namesOf(combo)} · ${cap(combo)} pl. — vous pourrez choisir`);
  } else if (!busy.has(t.id)) {
    // Trop petite mais libre : le dépôt proposera de choisir des tables
    tableNode(t.id)?.classList.add('drop-ask');
    showDropHint([t.id], `${t.seats} pl. pour ${res.people} — déposer pour choisir les tables`);
  } else {
    tableNode(t.id)?.classList.add('drop-bad');
  }
}

function showDropHint(ids, text) {
  const ts = ids.map(tableById);
  const x = Math.min(...ts.map((t) => t.x));
  const y = Math.min(...ts.map((t) => t.y));
  const x2 = Math.max(...ts.map((t) => t.x + t.w));
  const hint = document.createElement('div');
  hint.className = 'drop-hint';
  hint.textContent = text;
  hint.style.left = `${(x + x2) / 2}px`;
  hint.style.top = `${y - 30}px`;
  els.plan.append(hint);
}

function clearPreview() {
  state.hover = null;
  els.plan.querySelectorAll('.drop-ok, .drop-bad, .drop-ask').forEach((n) => n.classList.remove('drop-ok', 'drop-bad', 'drop-ask'));
  els.plan.querySelectorAll('.drop-hint').forEach((n) => n.remove());
}

// Déposer sur la liste = retirer la réservation du plan — seulement si on l'a prise sur le plan
// (une carte glissée puis relâchée dans la liste ne perd pas sa table)
els.sidebar.addEventListener('dragover', (e) => {
  const res = state.drag?.fromPlan && resById(state.drag.resId);
  if (!res?.tableIds.length) return;
  e.preventDefault();
  els.sidebar.classList.add('drop-target');
});
els.sidebar.addEventListener('dragleave', (e) => {
  if (!els.sidebar.contains(e.relatedTarget)) els.sidebar.classList.remove('drop-target');
});
els.sidebar.addEventListener('drop', (e) => {
  e.preventDefault();
  els.sidebar.classList.remove('drop-target');
  const res = state.drag?.fromPlan && resById(state.drag.resId);
  if (res?.tableIds.length) unassign(res.id);
});

/* ---------- Édition du plan : déplacer / redimensionner ---------- */

/** Marque l'élément comme sélectionné ; poignée de redimensionnement s'il est seul. */
function decoratePicked(el, item, kind) {
  el.classList.add('picked');
  if (state.selection.length !== 1) return;
  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.addEventListener('pointerdown', (e) => startResize(e, item, el, kind));
  el.append(handle);
}

/** Met à jour l'affichage de la sélection sans tout redessiner (garde le geste en cours). */
function refreshPicks() {
  els.plan.querySelectorAll('.picked').forEach((n) => n.classList.remove('picked'));
  els.plan.querySelectorAll('.handle').forEach((n) => n.remove());
  for (const { kind, id } of state.selection) {
    const el = itemNode(kind, id);
    const item = itemOf(kind, id);
    if (el && item) decoratePicked(el, item, kind);
  }
  renderLinks();
}

function setSelection(selection) {
  state.selection = selection;
  refreshPicks();
  renderInspector();
}

/** Suivi d'un geste au pointeur ; `apply(dx, dy)` reçoit le déplacement en unités du plan. */
function track(e, el, apply, done, tap) {
  const start = { x: e.clientX, y: e.clientY };
  let moved = false;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* pointeur déjà relâché */
  }
  const onMove = (ev) => {
    const dx = (ev.clientX - start.x) / state.scale;
    const dy = (ev.clientY - start.y) / state.scale;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    el.classList.add('moving');
    apply(dx, dy);
  };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.classList.remove('moving');
    if (moved) done();
    else tap?.();
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

function placeNode(el, item) {
  Object.assign(el.style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` });
}

const saveItem = (kind, item, data) => (kind === 'table' ? saveTable(item.id, data) : saveZone(item.id, data));

function startMove(e, item, el, kind) {
  if (e.button !== 0 || e.target.classList.contains('handle')) return;
  e.preventDefault();
  if (state.linking) {
    const from = state.linking;
    state.linking = null;
    if (kind === 'table' && item.id !== from) createGroup([from, item.id]);
    else render();
    return;
  }

  // Ctrl/Maj + clic, ou mode "Sélection multiple" : ajoute ou retire l'élément de la sélection
  const additive = e.ctrlKey || e.metaKey || e.shiftKey || state.multiSelect;
  const wasPicked = isPicked(kind, item.id);
  if (additive) {
    setSelection(
      wasPicked
        ? state.selection.filter((s) => !(s.kind === kind && s.id === item.id))
        : [...state.selection, { kind, id: item.id }]
    );
    if (wasPicked) return; // retiré : pas de déplacement
  } else if (!wasPicked) {
    setSelection([{ kind, id: item.id }]);
  }

  // Déplacement de toute la sélection d'un bloc
  const group = state.selection
    .map((s) => ({ ...s, item: itemOf(s.kind, s.id), el: itemNode(s.kind, s.id) }))
    .filter((g) => g.item && g.el)
    .map((g) => ({ ...g, ox: g.item.x, oy: g.item.y }));
  const minX = Math.min(...group.map((g) => g.ox));
  const minY = Math.min(...group.map((g) => g.oy));
  const maxX = Math.max(...group.map((g) => g.ox + g.item.w));
  const maxY = Math.max(...group.map((g) => g.oy + g.item.h));
  const ox = item.x;
  const oy = item.y;

  track(
    e,
    el,
    (dx, dy) => {
      // L'élément saisi s'aligne sur la grille, les autres suivent ; le bloc reste dans la salle
      const ddx = Math.max(-minX, Math.min(state.room.w - maxX, snap(ox + dx) - ox));
      const ddy = Math.max(-minY, Math.min(state.room.h - maxY, snap(oy + dy) - oy));
      for (const g of group) {
        g.item.x = g.ox + ddx;
        g.item.y = g.oy + ddy;
        placeNode(g.el, g.item);
        g.el.classList.add('moving');
      }
      renderLinks();
    },
    async () => {
      group.forEach((g) => g.el.classList.remove('moving'));
      await Promise.all(group.map((g) => saveItem(g.kind, g.item, { x: g.item.x, y: g.item.y })));
    },
    // Simple clic sur un élément d'une sélection multiple : ne garder que lui
    () => {
      if (!additive && wasPicked && state.selection.length > 1) setSelection([{ kind, id: item.id }]);
    }
  );
}

function startResize(e, item, el, kind) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const ow = item.w;
  const oh = item.h;
  const min = kind === 'table' ? 40 : 10;
  const max = kind === 'table' ? 400 : Infinity;
  const handle = e.currentTarget;
  track(
    e,
    handle,
    (dx, dy) => {
      item.w = Math.min(max, state.room.w - item.x, Math.max(min, snap(ow + dx)));
      item.h = Math.min(max, state.room.h - item.y, Math.max(min, snap(oh + dy)));
      if (item.shape === 'round') item.w = item.h = Math.max(item.w, item.h);
      placeNode(el, item);
      if (kind === 'table') renderLinks();
    },
    async () => {
      await saveItem(kind, item, { w: item.w, h: item.h });
      render(); // rafraîchit chaises, champs de l'inspecteur…
    }
  );
}

async function saveZone(id, data) {
  try {
    const updated = await api.updateZone(id, data);
    state.zones = state.zones.map((z) => (z.id === id ? updated : z));
  } catch (err) {
    toast(err.message, 'error');
    await loadPlan();
    render();
  }
}

/** Position libre proche du centre de la vue pour un nouvel élément. */
function spawnPoint(w, h) {
  const { planWrap } = els;
  const cx = (planWrap.scrollLeft + planWrap.clientWidth / 2 - state.offset.x) / state.scale;
  const cy = (planWrap.scrollTop + planWrap.clientHeight / 2 - state.offset.y) / state.scale;
  return {
    x: Math.max(0, Math.min(state.room.w - w, snap(cx - w / 2))),
    y: Math.max(0, Math.min(state.room.h - h, snap(cy - h / 2))),
  };
}

async function addZone(type) {
  const { label, w, h } = ZONE_TYPES[type];
  try {
    const z = await api.createZone({ type, label, w, h, ...spawnPoint(w, h) });
    state.zones.push(z);
    state.selected = { kind: 'zone', id: z.id };
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Copier / coller (mode édition) ---------- */

const PASTE_OFFSET = 20;
let clipboard = null; // { items: [{ kind, data }], pastes }
let pasteQueue = Promise.resolve();

/** Éléments sélectionnés : [{ kind, item }]. */
const selectedItems = () =>
  state.selection.map((s) => ({ kind: s.kind, item: itemOf(s.kind, s.id) })).filter((s) => s.item);

const itemLabel = ({ kind, item }) => (kind === 'table' ? item.name : item.label);

function describe(items) {
  if (items.length === 1) return itemLabel(items[0]);
  const tables = items.filter((i) => i.kind === 'table').length;
  const others = items.length - tables;
  return [tables && `${tables} table${tables > 1 ? 's' : ''}`, others && `${others} élément${others > 1 ? 's' : ''}`]
    .filter(Boolean)
    .join(' et ');
}

function copySelection() {
  const items = selectedItems();
  if (!items.length) return false;
  clipboard = { items: items.map(({ kind, item }) => ({ kind, data: { ...item } })), pastes: 0 };
  toast(`${describe(items)} copié${items.length > 1 ? 's' : '·e'} — « Coller » pour placer la copie`);
  renderInspector(); // active le bouton "Coller"
  return true;
}

/**
 * Colle une copie décalée de tout le presse-papiers (disposition conservée).
 * Les collages s'enchaînent dans une file pour que la numérotation des tables reste correcte.
 */
function pasteClipboard() {
  pasteQueue = pasteQueue.then(doPaste);
  return pasteQueue;
}

async function doPaste() {
  if (!clipboard) return;
  clipboard.pastes += 1;
  const { items } = clipboard;
  const offset = PASTE_OFFSET * clipboard.pastes;
  const minX = Math.min(...items.map((i) => i.data.x));
  const minY = Math.min(...items.map((i) => i.data.y));
  const maxX = Math.max(...items.map((i) => i.data.x + i.data.w));
  const maxY = Math.max(...items.map((i) => i.data.y + i.data.h));
  const dx = Math.max(-minX, Math.min(state.room.w - maxX, offset));
  const dy = Math.max(-minY, Math.min(state.room.h - maxY, offset));

  const created = [];
  try {
    for (const { kind, data } of items) {
      const { id, ...copy } = data;
      copy.x = data.x + dx;
      copy.y = data.y + dy;
      if (kind === 'table') {
        const t = await api.createTable({ ...copy, name: nextTableName() });
        state.tables.push(t);
        created.push({ kind, id: t.id });
      } else {
        const z = await api.createZone(copy);
        state.zones.push(z);
        created.push({ kind, id: z.id });
      }
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  state.selection = created;
  render();
}

/** Supprime toute la sélection (avec confirmation si des tables sont concernées). */
async function removeSelection() {
  const items = selectedItems();
  if (!items.length) return;
  if (items.length === 1) {
    const [{ kind, item }] = items;
    return kind === 'table' ? removeTable(item) : removeZone(item);
  }
  const hasTables = items.some((i) => i.kind === 'table');
  const warning = hasTables ? ' Les réservations qui utilisent ces tables seront à replacer.' : '';
  if (!confirm(`Supprimer ${describe(items)} ?${warning}`)) return;
  try {
    for (const { kind, item } of items) {
      if (kind === 'table') {
        await api.deleteTable(item.id);
        state.tables = state.tables.filter((t) => t.id !== item.id);
        dropTableFromGroups(item.id);
      } else {
        await api.deleteZone(item.id);
        state.zones = state.zones.filter((z) => z.id !== item.id);
      }
    }
    if (hasTables) await loadReservations();
  } catch (err) {
    toast(err.message, 'error');
  }
  state.selection = [];
  render();
}

async function removeZone(z) {
  try {
    await api.deleteZone(z.id);
    state.zones = state.zones.filter((x) => x.id !== z.id);
    state.selected = null;
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function updateRoom(size) {
  try {
    Object.assign(state, await api.updateRoom(size));
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function clearPlan() {
  if (!confirm('Supprimer toutes les tables et tous les éléments ? Les réservations placées seront à replacer.')) return;
  try {
    Object.assign(state, await api.clearPlan());
    state.selected = null;
    await loadReservations();
    render();
    toast('Plan vierge — ajoutez vos tables et éléments');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Fusions manuelles ---------- */

function upsertGroup(group) {
  state.groups = [...state.groups.filter((g) => g.id !== group.id), group];
}

/** Même règle que le serveur : une table supprimée quitte ses fusions. */
function dropTableFromGroups(tableId) {
  state.groups = state.groups
    .map((g) => ({ ...g, tableIds: g.tableIds.filter((id) => id !== tableId) }))
    .filter((g) => g.tableIds.length >= 2);
}

/** Crée (ou met à jour) la fusion de ces tables ; sans capacité, le serveur prend le total des places. */
async function createGroup(tableIds, capacity) {
  if (capacity !== undefined && (!Number.isFinite(capacity) || capacity < 1)) return render();
  try {
    const group = await api.saveGroup(tableIds, capacity);
    upsertGroup(group);
    toast(`Fusion ${namesOf(group.tableIds)} : ${group.capacity} pers. max`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

async function setGroupCapacity(id, capacity) {
  if (!Number.isFinite(capacity) || capacity < 1) return render();
  try {
    upsertGroup(await api.updateGroup(id, capacity));
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

async function removeGroup(id) {
  try {
    await api.deleteGroup(id);
    state.groups = state.groups.filter((g) => g.id !== id);
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

async function saveTable(id, data) {
  try {
    const updated = await api.updateTable(id, data);
    state.tables = state.tables.map((t) => (t.id === id ? updated : t));
  } catch (err) {
    toast(err.message, 'error');
    await loadPlan();
    render();
  }
}

async function addTable(preset) {
  const { label, ...data } = preset;
  try {
    const t = await api.createTable({ ...data, name: nextTableName(), ...spawnPoint(data.w, data.h) });
    state.tables.push(t);
    state.selected = { kind: 'table', id: t.id };
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeTable(t) {
  if (!confirm(`Supprimer la table ${t.name} ? Les réservations qui l'utilisent seront à replacer.`)) return;
  try {
    await api.deleteTable(t.id);
    state.tables = state.tables.filter((x) => x.id !== t.id);
    dropTableFromGroups(t.id);
    state.selected = null;
    await loadReservations();
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- Actions réservations ---------- */

function replaceReservation(r) {
  state.reservations = state.reservations.map((x) => (x.id === r.id ? r : x));
}

/**
 * Dépôt d'une réservation sur une table.
 * Table assez grande → placée directement. Sinon, la barre de choix s'ouvre, pré-remplie avec la
 * meilleure fusion libre s'il y en a une : on valide, on ajoute ou on retire des tables (on peut se serrer).
 */
async function assign(resId, tableId) {
  const before = resById(resId);
  if (before.tableIds.length === 1 && before.tableIds[0] === tableId) {
    backToListIfNeeded(); // déjà sur cette table
    return render();
  }
  const busy = busyExcept(resId);
  const table = tableById(tableId);
  if (!busy.has(tableId) && table.seats < before.people) {
    const combo = findCombination(state.tables, tableId, before.people, busy, state.groups);
    return startGrouping(resId, combo || [tableId], { proposed: Boolean(combo) });
  }
  let placed = false;
  try {
    const { reservation } = await api.assign(resId, tableId);
    replaceReservation(reservation);
    state.selectedRes = reservation.id;
    placed = true;
    toast(`${reservation.name} placé·e en ${tableNames(reservation)}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
  if (placed) afterPlaced(resId);
}

/* ---------- Téléphone : deux vues (Réservations / Plan) ---------- */

const phoneMQ = matchMedia('(max-width: 700px)');

/**
 * Hauteur réellement visible (sans les barres du navigateur, même placées en bas) :
 * l'application s'y cale, pour que la barre de navigation ne passe jamais dessous.
 */
function fitToVisibleArea() {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  // Bande cachée en bas (barre du navigateur posée par-dessus la page) : les éléments
  // collés en bas de l'écran (fiche, menu, messages) remontent d'autant
  const hidden = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  document.documentElement.style.setProperty('--vv-bottom', `${Math.round(hidden)}px`);
}
fitToVisibleArea();

/**
 * Statistiques du service : dans l'en-tête sur ordinateur et tablette (la liste garde toute sa hauteur),
 * en haut de la liste sur téléphone (l'en-tête n'a la place que pour la date et le service).
 */
const statsHome = els.stats.parentElement;
function placeStats() {
  const target = phoneMQ.matches ? statsHome : $('#topStats');
  if (els.stats.parentElement !== target) target.prepend(els.stats);
}
placeStats();
phoneMQ.addEventListener('change', placeStats);
window.visualViewport?.addEventListener('resize', fitToVisibleArea);
window.addEventListener('resize', fitToVisibleArea);
window.addEventListener('orientationchange', () => setTimeout(fitToVisibleArea, 300));
const isPhone = () => phoneMQ.matches;

/** Affiche la liste ou le plan (sur téléphone, un seul des deux tient à l'écran). */
function setView(view) {
  if (state.view === view) return;
  state.view = view;
  if (view === 'list') closeSheet();
  renderControls();
  // Le plan était masqué : on recalcule son cadrage une fois affiché
  requestAnimationFrame(updateScale);
}

/** Après un placement lancé depuis la liste sur téléphone : retour à la liste, sur la carte. */
function afterPlaced(resId) {
  if (!state.returnToList) return;
  state.returnToList = false;
  if (!isPhone()) return;
  setView('list');
  requestAnimationFrame(() => {
    const card = els.resList.querySelector(`.res-card[data-id="${resId}"]`);
    if (!card) return;
    scrollListTo(card, 'center');
    card.classList.add('flash');
  });
}

function backToListIfNeeded() {
  if (state.returnToList && isPhone()) setView('list');
  state.returnToList = false;
}

$('#bottomNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.view) {
    setView(btn.dataset.view);
    render();
  } else if (btn.id === 'navNew') {
    openDialog();
  } else if (btn.id === 'navMore') {
    toggleMoreMenu();
  }
});

/* Menu « Plus » : actions moins fréquentes, rangées pour libérer l'en-tête */
function toggleMoreMenu(open = $('#moreMenu').hidden) {
  $('#moreMenu').hidden = !open;
  $('#navMore').setAttribute('aria-expanded', String(open));
  const edit = $('#moreMenu [data-more="edit"]');
  edit.textContent = state.editMode ? 'Terminer la modification du plan' : 'Modifier le plan';
}
$('#moreMenu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-more]')?.dataset.more;
  toggleMoreMenu(false);
  if (action === 'today') setDate(localDate());
  if (action === 'edit') $('#editToggle').click();
  if (action === 'lock') $('#lockBtn').click();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('#moreMenu').hidden && !e.target.closest('#moreMenu, #navMore')) toggleMoreMenu(false);
});

phoneMQ.addEventListener('change', () => {
  closeSheet();
  toggleMoreMenu(false);
  render();
});

/* ---------- Téléphone : fiche de la table touchée ---------- */

function openSheet(tableId) {
  state.sheetTable = tableId;
  renderSheet();
}

function closeSheet() {
  if (!state.sheetTable) return;
  state.sheetTable = null;
  renderSheet();
}

/**
 * Fiche en bas de l'écran : la réservation de la table (avec ses boutons),
 * ou, si la table est libre, les réservations à placer pour l'y installer en un toucher.
 */
function renderSheet() {
  const sheet = $('#tableSheet');
  const t = state.sheetTable && tableById(state.sheetTable);
  const show = Boolean(t) && isPhone() && !state.editMode && state.view === 'plan';
  sheet.hidden = $('#sheetBackdrop').hidden = !show;
  if (!show) {
    state.sheetTable = null;
    sheet.innerHTML = '';
    return;
  }
  const res = occupancy().get(t.id);
  const groupNames = res && res.tableIds.length > 1 ? ` · ${esc(tableNames(res))}` : '';
  sheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <header class="sheet-head">
      <div><strong>${esc(t.name)}</strong> <span class="muted">${t.seats} places${groupNames}</span></div>
      <button type="button" class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </header>`;

  if (res) {
    const list = document.createElement('ul');
    list.className = 'sheet-list';
    list.append(buildCard(res));
    sheet.append(list);
  } else {
    const todo = activeReservations().filter((r) => !r.tableIds.length && !r.archived);
    sheet.insertAdjacentHTML(
      'beforeend',
      todo.length
        ? `<p class="sheet-label">Table libre — installer une réservation à placer :</p>
           <div class="sheet-picks">${todo
             .map((r) => `<button type="button" class="pick${r.people > t.seats ? ' tight' : ''}" data-pick="${r.id}">
                 <span class="pick-time">${esc(r.time)}</span><span class="pick-name">${esc(r.name)}</span><b>${r.people} pers.</b></button>`)
             .join('')}</div>`
        : '<p class="sheet-label">Table libre. Aucune réservation à placer pour ce service.</p>'
    );
  }
}

$('#tableSheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-sheet="close"]')) return closeSheet();
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const tableId = state.sheetTable;
    closeSheet();
    assign(pick.dataset.pick, tableId);
  }
});
$('#sheetBackdrop').addEventListener('click', closeSheet);

/* ---------- Placement en touchant une table (tablette) ---------- */

/** Toucher une table pendant le mode placement : y place la réservation (fusion ou choix des tables si besoin). */
function placeOnTable(t, occupant) {
  const resId = state.placing;
  if (occupant && occupant.id !== resId) {
    toast(`${t.name} est occupée par ${occupant.name}`, 'error');
    return;
  }
  state.placing = null;
  if (occupant) {
    // déjà sur cette table : rien à changer, on revient simplement là où on était
    backToListIfNeeded();
    return render();
  }
  assign(resId, t.id);
}

function cancelPlacing() {
  state.placing = null;
  state.selectedRes = null;
  backToListIfNeeded();
  render();
}

function renderPlacingBar() {
  const bar = $('#placingBar');
  let res = state.placing && resById(state.placing);
  if (!res || !isActive(res) || state.editMode || serviceOf(res.time) !== state.service) {
    state.placing = null;
    res = null;
  }
  const show = Boolean(res) && !state.grouping;
  document.body.classList.toggle('placing', show);
  bar.hidden = !show;
  if (!show) return;

  const placed = res.tableIds.length > 0;
  bar.innerHTML = `
    <div class="grouping-info">
      <strong>${esc(res.name)} · ${res.people} pers.</strong>
      <span>${placed ? `Actuellement ${esc(tableNames(res))} — touchez une autre table pour la déplacer.` : 'Touchez une table libre pour la placer.'}</span>
    </div>
    <div class="grouping-actions">
      <button class="btn ghost small" id="cancelPlacing">Annuler</button>
    </div>`;
  $('#cancelPlacing', bar).addEventListener('click', cancelPlacing);
}

/* ---------- Regroupement manuel pour un service ---------- */

/** Ouvre la barre "ajouter des tables" pour cette réservation, avec les tables proposées. */
function startGrouping(resId, tableIds, { proposed = false } = {}) {
  // target = table sur laquelle on a déposé ; proposed = tables pré-remplies avec une fusion qui suffit
  state.grouping = { resId, tableIds: [...tableIds], target: tableIds[0], proposed };
  state.selectedRes = resId;
  render();
}

function cancelGrouping() {
  if (!state.grouping) return;
  state.grouping = null;
  backToListIfNeeded();
  render();
}

/** Clic sur une table pendant le regroupement : l'ajoute ou la retire. */
function toggleGroupingTable(t, occupant) {
  const g = state.grouping;
  if (occupant && occupant.id !== g.resId) {
    toast(`${t.name} est occupée par ${occupant.name}`, 'error');
    return;
  }
  g.tableIds = g.tableIds.includes(t.id) ? g.tableIds.filter((id) => id !== t.id) : [...g.tableIds, t.id];
  render();
}

async function confirmGrouping() {
  const { resId, tableIds } = state.grouping;
  let placed = false;
  try {
    const { reservation, capacity } = await api.assignManual(resId, tableIds);
    replaceReservation(reservation);
    state.grouping = null;
    state.selectedRes = reservation.id;
    const tight = reservation.people > capacity ? ` — ${capacity} places pour ${reservation.people}, on se serre` : '';
    toast(`${reservation.name} placé·e en ${tableNames(reservation)}${tight}`, 'success');
    placed = true;
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
  if (placed) afterPlaced(resId);
}

function renderGroupingBar() {
  const bar = $('#groupingBar');
  let res = state.grouping && resById(state.grouping.resId);
  // Changement de jour, de service ou passage en édition : on abandonne le regroupement
  if (!res || state.editMode || serviceOf(res.time) !== state.service) {
    state.grouping = null;
    res = null;
  }
  const g = state.grouping;
  document.body.classList.toggle('grouping', Boolean(res));
  bar.hidden = !res;
  if (!res) return;

  const capacity = cap(g.tableIds);
  const missing = res.people - capacity;
  const target = tableById(g.target);
  const names = g.tableIds.length ? esc(namesOf(g.tableIds)) : 'aucune table';
  const status =
    missing > 0
      ? `<b class="short">${capacity} place${capacity > 1 ? 's' : ''}</b> <span class="muted">— il manque ${missing} place${missing > 1 ? 's' : ''}</span>`
      : `<b class="enough">✓ ${capacity} places</b> <span class="muted">— c'est suffisant</span>`;
  const tableName = esc(target?.name ?? 'La table');
  const help =
    g.proposed && g.tableIds.length > 1
      ? `${tableName} a ${target?.seats ?? '?'} places : une fusion est proposée. Cliquez sur les tables du plan pour en ajouter ou en retirer.`
      : g.proposed
        ? 'Cliquez sur des tables libres du plan pour en ajouter ou en retirer.'
        : `${tableName} a ${target?.seats ?? '?'} places et aucune fusion libre ne suffit. Cliquez sur des tables libres pour les ajouter.`;
  const onlyTarget = target && !(g.tableIds.length === 1 && g.tableIds[0] === target.id);

  bar.innerHTML = `
    <div class="grouping-info">
      <strong>${esc(res.name)} · ${res.people} pers. — choisissez les tables</strong>
      <span>${names} : ${status}</span>
      <span class="muted">${help} Valable pour ce service uniquement.</span>
    </div>
    <div class="grouping-actions">
      ${onlyTarget ? `<button class="btn ghost small" id="onlyTarget" title="Ne garder que la table visée (on se serre)">${esc(target.name)} seule</button>` : ''}
      <button class="btn ghost small" id="cancelGrouping">Annuler</button>
      <button class="btn primary small" id="confirmGrouping" ${g.tableIds.length ? '' : 'disabled'}>
        ${missing > 0 ? 'Placer quand même' : 'Placer'}
      </button>
    </div>`;
  $('#onlyTarget', bar)?.addEventListener('click', () => {
    g.tableIds = [target.id];
    render();
  });
  $('#cancelGrouping', bar).addEventListener('click', cancelGrouping);
  $('#confirmGrouping', bar).addEventListener('click', confirmGrouping);
}

async function autoAssignAll() {
  const btn = $('#autoAssign');
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    const { placed, unplaced, reservations } = await api.autoAssign(state.date, state.service);
    reservations.forEach(replaceReservation);
    state.selectedRes = null;
    if (!placed) toast('Aucune table disponible pour les réservations restantes', 'error');
    else if (unplaced.length) toast(`${placed} placée(s) · sans table : ${unplaced.join(', ')}`, 'error');
    else toast(`${placed} réservation(s) placée(s) automatiquement`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.classList.remove('busy');
  }
  render();
}

async function setStatus(r, status) {
  try {
    const { reservation, conflict } = await api.setStatus(r.id, status);
    replaceReservation(reservation);
    const tables = tableNames(r);
    if (status === 'left') {
      if (state.selectedRes === r.id) state.selectedRes = null;
      toast(tables ? `${r.name} est parti·e — ${tables} libérée${r.tableIds.length > 1 ? 's' : ''}` : `${r.name} est parti·e`, 'success');
    } else if (conflict) {
      toast(`${r.name} rétabli·e, mais ses tables ont été redonnées entre-temps : à replacer`, 'error');
    } else if (status === 'arrived') {
      toast(`${r.name} est arrivé·e${tables ? ` — ${tables}` : ' — à placer'}`, 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

async function unassign(resId) {
  try {
    replaceReservation(await api.unassign(resId));
    toast('Réservation retirée du plan');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

async function setPinned(r, pinned) {
  try {
    replaceReservation(await api.setPinned(r.id, pinned));
    toast(pinned ? `${r.name} fixé·e en ${tableNames(r)}` : `${r.name} n’est plus fixé·e : elle peut être déplacée`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

/** Retire du plan toutes les réservations attendues du service (sauf celles fixées) pour recommencer. */
async function unassignAll() {
  const placed = visibleReservations().filter((r) => r.tableIds.length && isActive(r) && !r.archived);
  const removable = placed.filter((r) => !r.pinned && statusOf(r) === 'expected');
  if (!removable.length) {
    toast(placed.length ? 'Rien à retirer : les réservations placées sont fixées ou déjà installées' : 'Aucune réservation placée sur ce service');
    return;
  }
  const kept = placed.length - removable.length;
  const msg = `Retirer ${removable.length} réservation${removable.length > 1 ? 's' : ''} du plan (service du ${state.service}) ?` +
    `${kept ? `\n${kept} restent en place : fixées ou clients déjà installés.` : ''}`;
  if (!confirm(msg)) return;
  try {
    const { cleared, reservations } = await api.unassignAll(state.date, state.service);
    reservations.forEach(replaceReservation);
    state.selectedRes = null;
    state.placing = null;
    toast(`${cleared} réservation${cleared > 1 ? 's' : ''} retirée${cleared > 1 ? 's' : ''} du plan`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

/* ---------- Dialogue réservation ---------- */

let editingId = null;

/* ---------- Choisir les tables sur le plan, depuis le formulaire ---------- */

/**
 * Lit le champ « Tables » comme le serveur (« 12 », « T12 », « 50+51 », « 66-70 »…).
 * Les noms inconnus sont ignorés ici (le serveur les signalera à l'enregistrement).
 */
function parseTableField(text) {
  const byName = (token) => {
    const key = token.trim().toLowerCase();
    return key ? state.tables.find((t) => t.name.toLowerCase() === key || t.name.toLowerCase() === `t${key}`) : null;
  };
  const ids = [];
  for (const part of String(text).split(/[,+;]/)) {
    if (!part.trim()) continue;
    let found;
    const m = part.trim().match(/^([a-z]*)\s*(\d+)\s*[-–—]\s*([a-z]*)\s*(\d+)$/i);
    if (byName(part)) found = [byName(part)];
    else if (m) {
      const [from, to] = [Number(m[2]), Number(m[4])].sort((a, b) => a - b);
      found = [];
      for (let n = from; n <= to && n - from < 40; n++) found.push(byName(`${m[1] || m[3]}${n}`));
    } else found = part.trim().split(/\s+/).map(byName);
    for (const t of found) if (t && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

/**
 * « Sur le plan » : le formulaire se met de côté (rien n'est perdu), le plan du service de la
 * réservation s'affiche ; on touche les tables à attribuer, on peut aussi déplacer les autres
 * réservations comme d'habitude, puis « Valider » revient au formulaire avec les tables remplies.
 */
async function startFormPick() {
  const f = els.form;
  if (!f.date.value || !f.time.value) {
    $('#formError').textContent = 'Indiquez d’abord la date et l’heure : le plan dépend du service.';
    return;
  }
  state.formPick = {
    tableIds: parseTableField(f.tables.value),
    name: f.name.value.trim() || 'Nouvelle réservation',
    people: Number(f.people.value) || 0,
  };
  state.placing = null;
  state.grouping = null;
  state.selectedRes = null;
  closeSheet();
  els.dialog.close();
  // Le plan affiché est celui du jour et du service de la réservation
  if (f.date.value !== state.date) {
    state.date = f.date.value;
    await loadReservations();
  }
  state.service = serviceOf(f.time.value);
  if (isPhone()) setView('plan');
  render();
}

function finishFormPick(apply) {
  const pick = state.formPick;
  if (!pick) return;
  state.formPick = null;
  if (apply) els.form.tables.value = namesOf(pick.tableIds);
  render();
  els.dialog.showModal(); // le formulaire revient tel qu'on l'avait laissé
  $('#formError').textContent = '';
  if (apply) $('#noTableBox').hidden = true;
}

/** Toucher une table pendant le choix : l'ajoute ou la retire (sauf si elle ne peut pas être libérée). */
function toggleFormPick(t, occupant) {
  const pick = state.formPick;
  const own = occupant && occupant.id === editingId;
  if (occupant && !own && !pick.tableIds.includes(t.id)) {
    if (occupant.pinned) return toast(`${t.name} : ${occupant.name} y est fixé·e`, 'error');
    if (statusOf(occupant) === 'arrived') return toast(`${t.name} : ${occupant.name} est déjà installé·e`, 'error');
  }
  pick.tableIds = pick.tableIds.includes(t.id) ? pick.tableIds.filter((id) => id !== t.id) : [...pick.tableIds, t.id];
  render();
}

function renderPickBar() {
  const bar = $('#pickBar');
  const pick = state.formPick;
  if (pick && state.editMode) state.formPick = null; // passage en « Modifier le plan » : on abandonne
  document.body.classList.toggle('form-picking', Boolean(state.formPick));
  // Un déplacement de réservation demande le choix de ses tables : sa barre passe devant
  bar.hidden = !state.formPick || Boolean(state.grouping);
  if (!state.formPick) return (bar.innerHTML = '');

  const capacity = cap(pick.tableIds);
  const occ = occupancy();
  // Réservations qui devront changer de table (le serveur leur en cherchera une autre)
  const displaced = [...new Set(pick.tableIds.map((id) => occ.get(id)).filter((r) => r && r.id !== editingId))];
  const status = !pick.tableIds.length
    ? '<span class="muted">Touchez les tables à attribuer</span>'
    : `<b>${esc(namesOf(pick.tableIds))}</b> · ${
        pick.people > capacity
          ? `<b class="short">${capacity} places pour ${pick.people}</b>`
          : `<b class="enough">${capacity} places</b>`}`;
  bar.innerHTML = `
    <div class="grouping-info">
      <strong>${esc(pick.name)} · ${pick.people} pers. — ${esc(state.service === 'midi' ? 'midi' : 'soir')} du ${esc(frDate(state.date))}</strong>
      <span>${status}</span>
      ${displaced.length ? `<span class="muted">${esc(displaced.map((r) => r.name).join(', '))} ${displaced.length > 1 ? 'seront déplacé·es' : 'sera déplacé·e'} sur une autre table libre.</span>` : ''}
      <span class="muted">Vous pouvez aussi glisser les autres réservations pour faire de la place.</span>
    </div>
    <div class="grouping-actions">
      <button class="btn ghost small" id="pickCancel">Annuler</button>
      <button class="btn primary small" id="pickApply">Valider</button>
    </div>`;
  $('#pickCancel', bar).addEventListener('click', () => finishFormPick(false));
  $('#pickApply', bar).addEventListener('click', () => finishFormPick(true));
}

$('#pickOnPlan').addEventListener('click', startFormPick);
// Calendriers : un point par service (midi, soir), coloré selon le remplissage
initPickers({ dayInfo: (from, to) => api.summary(from, to) });

function openDialog(r = null) {
  editingId = r?.id ?? null;
  const f = els.form;
  $('#resDialogTitle').textContent = r ? 'Modifier la réservation' : 'Nouvelle réservation';
  f.name.value = r?.name ?? '';
  f.people.value = r?.people ?? 2;
  f.date.value = r?.date ?? state.date;
  f.time.value = r?.time ?? (state.service === 'midi' ? '12:30' : '20:00');
  f.phone.value = r?.phone ?? '';
  f.notes.value = r?.notes ?? '';
  f.internalNote.value = r?.internalNote ?? '';
  f.tables.value = r ? tableNames(r) : '';
  f.pinned.checked = Boolean(r?.pinned);
  refreshPickers(f); // boutons date / heure (sélecteurs maison)
  $('#formError').textContent = '';
  $('#noTableBox').hidden = true;
  $('#deleteRes').hidden = !r;
  els.dialog.showModal();
  f.name.focus();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(els.form));
  data.pinned = els.form.pinned.checked; // case décochée : absente du formulaire, mais on veut « false »
  // « Enregistrer sans table » : on accepte qu'elle reste « à placer »
  if (els.form.dataset.allowUnplaced) data.allowUnplaced = true;
  delete els.form.dataset.allowUnplaced;
  $('#noTableBox').hidden = true;
  $('#formError').textContent = '';
  try {
    // `notices` : ce qui s'est passé pour les autres réservations (déplacées, à placer…)
    const { notices = [], ...saved } = editingId
      ? await api.updateReservation(editingId, data)
      : await api.createReservation(data);
    const oldTables = editingId ? resById(editingId)?.tableIds.join() ?? '' : '';
    els.dialog.close();
    // Rechargement : d'autres réservations ont pu être déplacées pour libérer la table choisie
    state.date = saved.date;
    await loadReservations();
    state.service = serviceOf(saved.time);
    // Nouvelle réservation (ou changée de service) : une table libre lui est attribuée automatiquement
    const placedNow = saved.tableIds.length > 0 && saved.tableIds.join() !== oldTables;
    if (!editingId) {
      if (placedNow) toast(`Réservation ajoutée — placée en ${tableNames(saved)}`, 'success');
      else toast('Réservation ajoutée — aucune table libre : à placer', 'error');
    } else if (oldTables && !saved.tableIds.length) toast(`${saved.name} est à replacer sur le plan`);
    else if (placedNow) toast(`Réservation mise à jour — placée en ${tableNames(saved)}`, 'success');
    else toast('Réservation mise à jour', 'success');
    // Une réservation déplacée : info ; une réservation restée sans table ou non fixée : à surveiller
    for (const n of notices) toast(n, /à placer|pas pu/.test(n) ? 'error' : 'success');
    render();
  } catch (err) {
    if (err.reason === 'no_table') {
      // Rien n'est enregistré : on explique et on propose de choisir une table, ou de la prendre quand même
      $('#noTableText').textContent = `${err.message} La réservation n'est pas enregistrée.`;
      $('#noTableBox').hidden = false;
      $('#noTableBox').scrollIntoView({ block: 'nearest' });
    } else {
      $('#formError').textContent = err.message;
    }
  }
});

$('#noTablePick').addEventListener('click', startFormPick);
$('#noTableSave').addEventListener('click', () => {
  els.form.dataset.allowUnplaced = '1';
  els.form.requestSubmit();
});

$('#cancelRes').addEventListener('click', () => els.dialog.close());
$('#deleteRes').addEventListener('click', async () => {
  const r = resById(editingId);
  if (!r || !confirm(`Supprimer la réservation de ${r.name} ?`)) return;
  try {
    await api.deleteReservation(r.id);
    state.reservations = state.reservations.filter((x) => x.id !== r.id);
    if (state.selectedRes === r.id) state.selectedRes = null;
    els.dialog.close();
    toast('Réservation supprimée');
    render();
  } catch (err) {
    $('#formError').textContent = err.message;
  }
});

/* ---------- Contrôles ---------- */

async function setDate(date) {
  if (!date) return;
  state.date = date;
  state.selectedRes = null;
  await loadReservations();
  render();
}

els.date.addEventListener('change', () => setDate(els.date.value));
$('#prevDay').addEventListener('click', () => setDate(shiftDate(state.date, -1)));
$('#nextDay').addEventListener('click', () => setDate(shiftDate(state.date, 1)));
$('#today').addEventListener('click', () => setDate(localDate()));

document.querySelectorAll('#service button').forEach((b) =>
  b.addEventListener('click', () => {
    state.service = b.dataset.value;
    state.selectedRes = null;
    render();
  })
);
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderList();
});
$('#searchClear').addEventListener('click', () => {
  state.search = '';
  $('#search').value = '';
  renderList();
  $('#search').focus();
});

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-value]');
  if (!chip) return;
  state.filter = chip.dataset.value;
  renderList();
  els.resList.scrollTop = 0;
});
$('#timeStrip').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-time]');
  if (chip) scrollToTime(chip.dataset.time);
});

/**
 * Barres horizontales (filtres, créneaux) à la souris : la molette les fait défiler de côté,
 * et on peut aussi les attraper et les faire glisser. Au doigt, le défilement natif suffit.
 */
function mouseScrollable(bar) {
  bar.addEventListener(
    'wheel',
    (e) => {
      if (bar.scrollWidth <= bar.clientWidth) return; // tout est visible : la molette garde son rôle
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const max = bar.scrollWidth - bar.clientWidth;
      // Déjà au bout dans ce sens : on laisse la page / la liste défiler normalement
      if ((delta < 0 && bar.scrollLeft <= 0) || (delta > 0 && bar.scrollLeft >= max)) return;
      e.preventDefault();
      bar.scrollLeft += delta * (e.deltaMode === 1 ? 30 : 1); // molette « par lignes » (Firefox)
    },
    { passive: false }
  );

  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || bar.scrollWidth <= bar.clientWidth) return;
    drag = { x: e.clientX, left: bar.scrollLeft, moved: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return; // petit tremblement : c'est un clic
    drag.moved = true;
    bar.classList.add('grabbing');
    bar.scrollLeft = drag.left - dx;
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    // Fin d'un glisser : le relâchement ne doit pas activer la puce sous la souris
    if (drag.moved) bar.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true });
    bar.classList.remove('grabbing');
    drag = null;
  });
}
mouseScrollable($('#filters'));
mouseScrollable($('#timeStrip'));
let stripFrame = 0;
els.resList.addEventListener('scroll', () => {
  cancelAnimationFrame(stripFrame);
  stripFrame = requestAnimationFrame(syncTimeStrip);
  autoCompactHead();
});

/*
 * Téléphone : en descendant dans la liste, statistiques et filtres s'effacent pour montrer plus de
 * réservations ; ils reviennent dès qu'on remonte un peu, ou en haut de la liste.
 * Seuils différents pour descendre / remonter : pas de clignotement sur un petit mouvement du doigt.
 */
let lastListScroll = 0;
function autoCompactHead() {
  const top = els.resList.scrollTop;
  const delta = top - lastListScroll;
  lastListScroll = top;
  if (!isPhone() || top < 30) return setCompactHead(false);
  if (delta > 8) setCompactHead(true);
  else if (delta < -14) setCompactHead(false);
}
function setCompactHead(on) {
  els.sidebar.classList.toggle('compact-head', on);
}
// On cherche ou on filtre : tout réapparaît
$('#search').addEventListener('focus', () => setCompactHead(false));

$('#editToggle').addEventListener('click', () => {
  state.editMode = !state.editMode;
  retentionCache = null; // chiffres à jour à chaque ouverture des réglages
  state.selected = null;
  state.linking = null;
  state.selectedRes = null;
  render();
});
$('#newRes').addEventListener('click', () => openDialog());
$('#planNewRes').addEventListener('click', () => openDialog());

/* Tablette : menu en haut à gauche (Modifier le plan, Verrouiller) */
function toggleTopMenu(open = $('#topMenu').hidden) {
  $('#topMenu').hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}
$('#menuBtn').addEventListener('click', () => toggleTopMenu());
$('#topMenu').addEventListener('click', (e) => {
  const action = e.target.closest('[data-top]')?.dataset.top;
  if (!action) return;
  toggleTopMenu(false);
  if (action === 'edit') $('#editToggle').click();
  if (action === 'lock') $('#lockBtn').click();
});
document.addEventListener('pointerdown', (e) => {
  if (!$('#topMenu').hidden && !e.target.closest('#topMenu, #menuBtn')) toggleTopMenu(false);
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#topMenu').hidden && toggleTopMenu(false));
$('#autoAssign').addEventListener('click', autoAssignAll);
$('#unassignAll').addEventListener('click', unassignAll);

function clearSelection() {
  if (!state.selectedRes && !state.selection.length && !state.linking && !state.placing) return;
  state.linking = null;
  state.placing = null;
  state.selectedRes = null;
  state.selected = null;
  render();
}

let panned = false;

els.planWrap.addEventListener('click', (e) => {
  if (panned) return; // fin d'un déplacement du plan, pas un clic
  if (!e.target.closest('.table, .merge, .zone')) clearSelection(); // (le bloc d'une fusion compte comme ses tables)
});

/**
 * Rectangle de sélection (mode édition, glisser sur le fond).
 * Sélectionne les tables touchées et les éléments entièrement inclus ;
 * Ctrl/Maj ou le mode "Sélection multiple" ajoute à la sélection.
 */
function startMarquee(e) {
  const additive = e.ctrlKey || e.metaKey || e.shiftKey || state.multiSelect;
  const base = additive ? [...state.selection] : [];
  const toPlan = (cx, cy) => {
    const r = els.plan.getBoundingClientRect();
    return { x: (cx - r.left) / state.scale, y: (cy - r.top) / state.scale };
  };
  const start = toPlan(e.clientX, e.clientY);
  const startScreen = { x: e.clientX, y: e.clientY };
  const box = document.createElement('div');
  box.className = 'marquee';
  panned = false;

  const onMove = (ev) => {
    if (pinch) return box.remove(); // deux doigts : zoom, on abandonne la sélection
    if (!panned && Math.hypot(ev.clientX - startScreen.x, ev.clientY - startScreen.y) < 4) return;
    if (!panned) {
      panned = true; // empêche le clic de fin de tout désélectionner
      els.plan.append(box);
    }
    const p = toPlan(ev.clientX, ev.clientY);
    const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, borderWidth: `${1.5 / state.scale}px` });

    const touches = (o) => o.x < r.x + r.w && o.x + o.w > r.x && o.y < r.y + r.h && o.y + o.h > r.y;
    const inside = (o) => o.x >= r.x && o.x + o.w <= r.x + r.w && o.y >= r.y && o.y + o.h <= r.y + r.h;
    const hits = [
      ...state.tables.filter(touches).map((t) => ({ kind: 'table', id: t.id })),
      ...state.zones.filter(inside).map((z) => ({ kind: 'zone', id: z.id })),
    ];
    state.selection = [...base, ...hits.filter((h) => !base.some((b) => b.kind === h.kind && b.id === h.id))];
    refreshPicks();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    box.remove();
    if (panned) renderInspector();
    setTimeout(() => (panned = false)); // après l'événement click qui suit
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/* ---------- Gestes tactiles : double-toucher pour zoomer ---------- */

// Double-toucher le fond du plan : zoom sur cet endroit ; une fois bien zoomé, retour à « Ajuster »
let lastTap = null;
els.planWrap.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch' || panned || pinch || touchDrag) return;
  if (e.target.closest('.table, .zone, .handle')) return (lastTap = null);
  const now = Date.now();
  if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    lastTap = null;
    const rect = els.planWrap.getBoundingClientRect();
    const zoomedIn = state.scale > fitScale() * 1.6;
    setZoom(zoomedIn ? null : state.scale * 2.2, e.clientX - rect.left, e.clientY - rect.top);
  } else {
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
});

/* ---------- Gestes tactiles : pincer pour zoomer ---------- */

const touches = new Map(); // doigts posés sur le plan : pointerId → { x, y }
let pinch = null; // { dist, scale } pendant un zoom à deux doigts

const touchDistance = () => {
  const [a, b] = [...touches.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

els.planWrap.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      pinch = { dist: touchDistance(), scale: state.scale };
      panned = true; // le geste n'est pas un toucher : pas de sélection à la fin
    }
  },
  true // avant les autres gestionnaires (déplacement, rectangle de sélection)
);
window.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || touches.size < 2) return;
  const [a, b] = [...touches.values()];
  const rect = els.planWrap.getBoundingClientRect();
  setZoom(pinch.scale * (touchDistance() / pinch.dist), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
});
const releaseTouch = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
};
window.addEventListener('pointerup', releaseTouch);
window.addEventListener('pointercancel', releaseTouch);

/* Élan après un glisser du plan au doigt */
let glideFrame = 0;
const stopPlanGlide = () => cancelAnimationFrame(glideFrame);

function glidePlan(recent) {
  const now = performance.now();
  const pts = recent.filter((p) => now - p.t < 100); // seulement le geste final
  if (pts.length < 2) return;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dt = Math.max(b.t - a.t, 1);
  let vx = (b.x - a.x) / dt; // px par ms
  let vy = (b.y - a.y) / dt;
  if (Math.hypot(vx, vy) < 0.2) return; // doigt quasi arrêté : pas d'élan
  let last = now;
  const step = (t) => {
    const dtf = Math.min(t - last, 32);
    last = t;
    els.planWrap.scrollLeft -= vx * dtf;
    els.planWrap.scrollTop -= vy * dtf;
    const decay = Math.pow(0.995, dtf); // ralentit en douceur
    vx *= decay;
    vy *= decay;
    if (Math.hypot(vx, vy) > 0.02) glideFrame = requestAnimationFrame(step);
  };
  glideFrame = requestAnimationFrame(step);
}

// Fond du plan : rectangle de sélection en mode édition (clic gauche),
// sinon glisser pour se déplacer dans le plan (clic gauche, molette enfoncée, ou un doigt — même sur une table)
els.planWrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  // Au doigt, hors édition, on peut faire glisser le plan en partant d'une table (le plan en est rempli)
  const fingerOnTable = e.pointerType !== 'mouse' && !state.editMode && !e.target.closest('.handle');
  if (e.target.closest('.table, .merge, .zone, .handle') && !fingerOnTable) return;
  if (pinch) return;
  if (state.editMode && e.button === 0 && !state.linking && !state.panMode) return startMarquee(e);
  const wrap = els.planWrap;
  const pressOnTable = e.pointerType !== 'mouse' && Boolean(e.target.closest('.table.busy, .merge'));
  stopPlanGlide();
  const start = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
  const recent = []; // dernières positions du doigt, pour l'élan au relâchement
  panned = false;
  if (e.button === 1) e.preventDefault(); // pas de défilement automatique du navigateur

  const onMove = (ev) => {
    if (pinch || touchDrag) return (recent.length = 0); // deux doigts : zoom ; appui long : glisser une réservation
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    // Doigt posé sur une table occupée : on tolère le tremblement de l'appui long (sinon le plan
    // bougerait de quelques pixels et annulerait le glisser de la réservation)
    if (!panned && Math.hypot(dx, dy) < (pressOnTable ? MOVE_TOLERANCE : 4)) return;
    panned = true;
    wrap.classList.add('panning');
    wrap.scrollLeft = start.left - dx;
    wrap.scrollTop = start.top - dy;
    recent.push({ x: ev.clientX, y: ev.clientY, t: performance.now() });
    if (recent.length > 6) recent.shift();
  };
  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    wrap.classList.remove('panning');
    // Au doigt : le plan continue sur sa lancée puis ralentit, comme un défilement normal
    if (e.pointerType === 'touch' && ev.type === 'pointerup' && panned && !pinch) glidePlan(recent);
    setTimeout(() => (panned = false)); // après l'événement click qui suit
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
});

document.addEventListener('keydown', (e) => {
  if (els.dialog.open || detailEl.open || e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape' && state.formPick) return finishFormPick(false);
  if (e.key === 'Escape' && state.grouping) return cancelGrouping();
  if (e.key === 'Escape' && state.placing) return cancelPlacing();
  if (e.key === 'Escape' && state.linking) {
    state.linking = null;
    return render();
  }
  if (e.key === 'Escape') clearSelection();

  // Ctrl+C / Ctrl+V / Ctrl+D : copier, coller, dupliquer en mode édition
  if (state.editMode && (e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'c' && window.getSelection()?.toString()) return; // copie de texte normale
    if (key === 'c' && copySelection()) e.preventDefault();
    if (key === 'v' && clipboard) {
      e.preventDefault();
      pasteClipboard();
    }
    if (key === 'd') {
      e.preventDefault(); // sinon : ajout aux favoris
      if (copySelection()) pasteClipboard();
    }
    if (key === 'a') {
      e.preventDefault();
      selectAll();
    }
    return;
  }

  // Suppr : retire la sélection en mode édition
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.editMode && state.selection.length) {
    removeSelection();
  }
});

$('#zoomIn').addEventListener('click', () => setZoom(state.scale * 1.25));
$('#zoomOut').addEventListener('click', () => setZoom(state.scale / 1.25));
$('#zoomFit').addEventListener('click', () => setZoom(null));
$('#panToggle').addEventListener('click', () => {
  state.panMode = !state.panMode;
  $('#panToggle').classList.toggle('active', state.panMode);
  els.planWrap.classList.toggle('pan-mode', state.panMode);
});
els.planWrap.addEventListener(
  'wheel',
  (e) => {
    // Molette = zoom centré sur le curseur (Maj + molette garde le défilement horizontal)
    if (e.shiftKey) return;
    e.preventDefault();
    const rect = els.planWrap.getBoundingClientRect();
    // Pas proportionnel au mouvement : une molette donne ~12 % par cran, un pavé tactile reste fluide
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const factor = Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.0012);
    setZoom(state.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
  },
  { passive: false }
);

new ResizeObserver(updateScale).observe(els.planWrap);

/* ---------- Synchronisation en direct entre appareils ---------- */

let live = null; // connexion EventSource
let refreshPending = null; // 'all' | 'reservations'
let refreshTimer = 0;
let offlineTimer = 0;
let wasOffline = false;

/** L'utilisateur est en train de faire quelque chose : on ne recharge pas sous ses doigts. */
const isBusy = () =>
  els.dialog.open ||
  Boolean(state.noteEditing || state.drag || touchDrag || state.grouping) ||
  Boolean(document.querySelector('.table.moving, .zone.moving, .marquee')) ||
  Boolean(document.activeElement?.closest?.('#inspector input, #inspector select, #inspector textarea'));

function queueRefresh(scope) {
  refreshPending = refreshPending === 'all' || scope === 'all' ? 'all' : 'reservations';
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(flushRefresh, 150);
}

async function flushRefresh() {
  if (!refreshPending) return;
  if (isBusy()) {
    refreshTimer = setTimeout(flushRefresh, 1000); // on réessaie dès que l'action en cours est finie
    return;
  }
  const scope = refreshPending;
  refreshPending = null;
  try {
    if (scope === 'all') {
      await loadPlan();
      retentionCache = null;
    }
    await loadReservations();
    // Ce qui a été supprimé ailleurs ne reste pas sélectionné ici
    if (state.selectedRes && !resById(state.selectedRes)) state.selectedRes = null;
    state.selection = state.selection.filter((s) => itemOf(s.kind, s.id));
    render();
  } catch {
    /* hors ligne : la reconnexion relancera un rechargement complet */
  }
}

function setOnline(online) {
  clearTimeout(offlineTimer);
  if (online) {
    $('#offlineBanner').hidden = true;
    if (wasOffline) queueRefresh('all'); // rattraper ce qui a changé pendant la coupure
    wasOffline = false;
  } else {
    // Petite attente pour ne pas clignoter lors d'une micro-coupure
    offlineTimer = setTimeout(() => {
      wasOffline = true;
      $('#offlineBanner').hidden = false;
    }, 2500);
  }
}

function connectLive() {
  live?.close();
  live = new EventSource('/api/events');
  live.onopen = () => setOnline(true);
  live.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.origin !== CLIENT_ID) queueRefresh(msg.scope);
  };
  live.onerror = async () => {
    setOnline(false);
    if (live.readyState !== EventSource.CLOSED) return; // le navigateur se reconnecte tout seul
    // Connexion refusée (session expirée ?) : on vérifie, sinon on réessaie un peu plus tard
    try {
      const s = await auth.status();
      if (!s.authenticated) return showAuth(s.configured ? 'login' : s.canSetup ? 'setup' : 'setup-remote');
    } catch {
      /* serveur injoignable */
    }
    setTimeout(connectLive, 3000);
  };
}

/* ---------- Code d'accès ---------- */

const authEls = {
  screen: $('#authScreen'),
  form: $('#authForm'),
  title: $('#authTitle'),
  text: $('#authText'),
  pin: $('#authPin'),
  pin2: $('#authPin2'),
  error: $('#authError'),
  submit: $('#authSubmit'),
};
let authMode = null;

function showAuth(mode) {
  live?.close();
  live = null;
  authMode = mode;
  const { screen, title, text, pin, pin2, error, submit } = authEls;
  document.body.classList.add('locked');
  screen.hidden = false;
  error.textContent = '';
  pin.value = '';
  pin2.value = '';
  title.textContent = mode === 'login' ? 'Plan de salle' : 'Créer le code d’accès';
  text.textContent =
    mode === 'login'
      ? 'Entrez le code d’accès de l’équipe.'
      : mode === 'setup'
        ? 'Choisissez un code de 4 à 8 chiffres. Il sera demandé sur chaque appareil (tablettes, ordinateurs) pour protéger les données des clients.'
        : 'Le code d’accès doit d’abord être créé sur l’ordinateur qui fait tourner l’application (adresse http://localhost:3000).';
  pin.hidden = submit.hidden = mode === 'setup-remote';
  pin2.hidden = mode !== 'setup';
  submit.textContent = mode === 'setup' ? 'Créer le code' : 'Entrer';
  setTimeout(() => pin.focus(), 50);
}

authEls.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { pin, pin2, error, submit } = authEls;
  error.textContent = '';
  if (authMode === 'setup') {
    if (!/^\d{4,8}$/.test(pin.value)) return (error.textContent = 'Le code doit contenir de 4 à 8 chiffres.');
    if (pin.value !== pin2.value) return (error.textContent = 'Les deux codes ne sont pas identiques.');
  }
  submit.disabled = true;
  try {
    if (authMode === 'setup') await auth.setup(pin.value);
    else await auth.login(pin.value);
    authEls.screen.hidden = true;
    document.body.classList.remove('locked');
    await start();
  } catch (err) {
    error.textContent = err.message;
    pin.select();
  } finally {
    submit.disabled = false;
  }
});

setAuthHandler((mode) => {
  if (authEls.screen.hidden) showAuth(mode);
});

$('#lockBtn').addEventListener('click', async () => {
  try {
    await auth.logout();
  } catch {
    /* déjà déconnecté */
  }
  showAuth('login');
});

/* ---------- Démarrage ---------- */

async function start() {
  try {
    await Promise.all([loadPlan(), loadReservations()]);
    render();
    connectLive();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(`Impossible de charger les données : ${err.message}`, 'error');
  }
}

try {
  const s = await auth.status();
  if (s.authenticated) await start();
  else showAuth(s.configured ? 'login' : s.canSetup ? 'setup' : 'setup-remote');
} catch (err) {
  toast(`Impossible de joindre le serveur : ${err.message}`, 'error');
}
