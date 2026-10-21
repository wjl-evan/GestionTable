import { api, auth, AuthError, CLIENT_ID, setAuthHandler } from './api.js';
import {
  areAdjacent, buildGraph, capacityOf, findCombination, groupOf, isActive, serviceOf, setKey, spanningEdges, statusOf,
  localDate,
} from '/shared/rules.js';

const $ = (sel, el = document) => el.querySelector(sel);
const SNAP = 10;

const state = {
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
  search: '', // recherche dans la liste des réservations
  noteEditing: null, // id de la réservation dont on modifie la note interne dans la liste
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

/**
 * Une réservation correspond-elle à la recherche ?
 *  - un nombre (« 4 », « 4 pers ») → nombre de personnes exact ;
 *  - un long numéro → téléphone ;
 *  - sinon → morceau du nom.
 */
function matchesSearch(r, query) {
  const q = normalize(query).trim();
  if (!q) return true;
  const people = q.match(/^(\d{1,2})\s*(p|pers|personnes?)?\.?$/);
  if (people) return r.people === Number(people[1]);
  const digits = q.replace(/[\s.]/g, '');
  if (/^\d{3,}$/.test(digits)) return normalize(r.phone).replace(/[\s.]/g, '').includes(digits);
  return normalize(r.name).includes(q);
}

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
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
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
  renderPlacingBar();
  renderPlan();
}

function renderControls() {
  els.date.value = state.date;
  for (const b of document.querySelectorAll('#service button')) {
    b.classList.toggle('active', b.dataset.value === state.service);
  }
  for (const b of document.querySelectorAll('#filters button')) {
    b.classList.toggle('active', b.dataset.value === state.filter);
  }
  const toggle = $('#editToggle');
  toggle.textContent = state.editMode ? 'Terminer' : 'Modifier le plan';
  toggle.classList.toggle('active', state.editMode);
  $('#newRes').hidden = state.editMode;
  els.sidebar.hidden = state.editMode;
  els.inspector.hidden = !state.editMode;
  document.body.classList.toggle('editing', state.editMode);
  document.body.classList.toggle('linking', Boolean(state.linking));
}

function renderStats() {
  const list = visibleReservations();
  const covers = list.reduce((s, r) => s + r.people, 0);
  const sum = (rs) => rs.reduce((s, r) => s + r.people, 0);
  const arrived = sum(list.filter((r) => statusOf(r) === 'arrived'));
  const left = sum(list.filter((r) => statusOf(r) === 'left'));
  const todo = list.filter((r) => !r.tableIds.length && isActive(r)).length;
  $('#autoAssign').disabled = todo === 0;
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
};

/** Pastille des tables d'une réservation ; orange si on se serre (moins de places que de personnes). */
function tablesPill(r, status) {
  const capacity = cap(r.tableIds);
  const tight = status !== 'left' && r.people > capacity;
  const cls = status === 'left' ? '' : tight ? 'ok tight' : 'ok';
  const title = tight ? `${capacity} places pour ${r.people} personnes — on se serre` : `Tables : ${tableNames(r)}`;
  return `<span class="pill ${cls}" title="${esc(title)}">${esc(tableNames(r))}${tight ? ' · serré' : ''}</span>`;
}

/** Boutons d'action d'une carte : toujours visibles, avec un libellé. */
function cardActionsHtml(r, status, placed) {
  const btn = (action, icon, label, title, cls = '') =>
    `<button type="button" class="rc-btn ${cls}" data-action="${action}" title="${esc(title)}">${icon}<span>${label}</span></button>`;

  // Action principale selon l'avancement du service
  let main = '';
  if (status === 'expected') main = btn('arrive', ICONS.check, 'Arrivé', 'Les clients sont arrivés', 'primary');
  else if (status === 'arrived' && placed) main = btn('leave', ICONS.door, 'Libérer', 'Les clients sont partis : la table redevient libre', 'primary');
  else if (status === 'left') main = btn('restore', ICONS.undo, 'Rétablir', 'Erreur ou client revenu : la réservation reprend ses tables si elles sont libres');

  const unplace =
    placed && status !== 'left' ? btn('unassign', ICONS.remove, 'Retirer', 'Retirer la réservation du plan (elle repasse « à placer »)', 'icon-only') : '';

  return `<div class="rc-actions">
    ${main}
    <span class="rc-spacer"></span>
    ${btn('note', ICONS.note, 'Note', 'Ajouter ou modifier la note interne', r.internalNote ? 'has-note' : '')}
    ${btn('edit', ICONS.edit, 'Modifier', 'Modifier la réservation')}
    ${unplace}
  </div>`;
}

/** Éditeur rapide de la note interne, directement dans la carte. */
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
  const phone = r.phone
    ? `<a class="rc-phone" href="tel:${esc(r.phone.replace(/\s/g, ''))}" title="Appeler">${ICONS.phone}${esc(r.phone)}</a>`
    : '';
  // À placer : orange ; rouge si les clients sont déjà là sans table
  const todo = status === 'left' ? '' : `<span class="pill todo${status === 'arrived' ? ' urgent' : ''}">À placer</span>`;

  // Ligne 1 : ce qu'on cherche du regard (nom, nombre de personnes, table). Ligne 2 : le reste, plus discret.
  return `
    <div class="rc-head">
      <span class="rc-name">${highlight(r.name, state.search)}</span>
      <span class="rc-people" title="${r.people} personne${r.people > 1 ? 's' : ''}">${r.people}<small>pers.</small></span>
      <div class="rc-tables">${placed ? tablesPill(r, status) : todo}</div>
      <span class="rc-sub">
        ${statusTag}
        ${phone}
      </span>
    </div>
    ${r.notes ? `<p class="rc-note client" title="Demande du client">${ICONS.quote}<span>${esc(r.notes)}</span></p>` : ''}
    ${
      state.noteEditing === r.id
        ? noteEditorHtml(r)
        : r.internalNote
          ? `<p class="rc-note internal" title="Note interne (équipe)">${ICONS.pin}<span>${esc(r.internalNote)}</span></p>`
          : ''
    }
    ${cardActionsHtml(r, status, placed)}`;
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
  const byFilter = all.filter((r) =>
    state.filter === 'todo'
      ? !r.tableIds.length && isActive(r)
      : state.filter === 'placed'
        ? r.tableIds.length && isActive(r)
        : true
  );
  const list = byFilter.filter((r) => matchesSearch(r, state.search));

  $('#searchClear').hidden = !state.search;
  els.resList.innerHTML = '';
  if (!list.length) {
    els.resList.innerHTML = `<li class="empty">${emptyListMessage(all, byFilter)}</li>`;
    $('#showOtherService', els.resList)?.addEventListener('click', () => {
      state.service = state.service === 'midi' ? 'soir' : 'midi';
      render();
    });
    return;
  }
  if (state.search) {
    const count = document.createElement('li');
    count.className = 'list-count';
    count.textContent = `${list.length} résultat${list.length > 1 ? 's' : ''}`;
    els.resList.append(count);
  }

  let currentTime = null;
  for (const r of list) {
    // Nouvelle heure : en-tête du créneau (la liste est déjà triée par heure)
    if (r.time !== currentTime) {
      currentTime = r.time;
      els.resList.append(timeHeader(r.time, list.filter((x) => x.time === r.time)));
    }
    const status = statusOf(r);
    const editing = state.noteEditing === r.id;
    const li = document.createElement('li');
    li.className = `res-card status-${status}${r.tableIds.length ? ' placed' : ''}${state.selectedRes === r.id ? ' selected' : ''}`;
    li.draggable = status !== 'left' && !editing; // pas de glisser pendant la saisie de la note
    li.dataset.id = r.id;
    li.innerHTML = cardHtml(r);

    li.addEventListener('dragstart', (e) => startDrag(e, r.id));
    li.addEventListener('dragend', endDrag);
    // Au doigt : appui long puis glisser vers une table
    li.addEventListener('pointerdown', (e) => {
      if (status !== 'left' && !editing && !e.target.closest('button, a, textarea')) armTouchDrag(e, r.id, li);
    });
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, textarea')) return; // lien téléphone, saisie de la note
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'edit') return openDialog(r);
      if (action === 'unassign') return unassign(r.id);
      if (action === 'arrive') return setStatus(r, 'arrived');
      if (action === 'unarrive') return setStatus(r, 'expected');
      if (action === 'leave') return setStatus(r, 'left');
      if (action === 'restore') return setStatus(r, 'arrived');
      if (action === 'note') {
        state.noteEditing = editing ? null : r.id;
        renderList();
        $(`[data-id="${r.id}"] textarea`, els.resList)?.focus();
        return;
      }
      if (action === 'note-cancel') {
        state.noteEditing = null;
        return renderList();
      }
      if (action === 'note-save') return saveInternalNote(r, $('textarea', li).value);
      if (e.target.closest('.rc-note-editor')) return;
      // Toucher une carte = « où la placer ? » ; la retoucher pendant ce mode l'annule
      const cancelling = state.placing === r.id || (!isActive(r) && state.selectedRes === r.id);
      state.selectedRes = cancelling ? null : r.id;
      state.placing = !cancelling && isActive(r) ? r.id : null;
      render();
    });
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button, a, .rc-note-editor')) openDialog(r);
    });
    els.resList.append(li);
  }
}

/** En-tête d'un créneau horaire : heure, nombre de réservations et de couverts, combien restent à placer. */
function timeHeader(time, group) {
  const covers = group.reduce((s, r) => s + r.people, 0);
  const todo = group.filter((r) => !r.tableIds.length && isActive(r)).length;
  const li = document.createElement('li');
  li.className = 'time-group';
  li.innerHTML = `
    <span class="tg-time">${esc(time)}</span>
    <span class="tg-meta">${group.length} rés. · ${covers} couv.${todo ? ` · <b>${todo} à placer</b>` : ''}</span>
    <span class="tg-line"></span>`;
  return li;
}

/** Liste vide : explique pourquoi, et propose l'autre service si la recherche y trouve quelqu'un. */
function emptyListMessage(all, byFilter) {
  if (!all.length) return 'Aucune réservation pour ce service.';
  if (!state.search) return 'Aucune réservation dans ce filtre.';
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
    ${selectionGroupHtml(tableIds)}`;
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
  const horizontal = t.w >= t.h;
  const len = horizontal ? t.w : t.h;
  const a = Math.ceil(n / 2);
  const b = n - a;
  for (let i = 0; i < a; i++) {
    const p = (len * (i + 1)) / (a + 1);
    out.push(horizontal ? { x: p, y: -off, rot: 0 } : { x: -off, y: p, rot: 90 });
  }
  for (let i = 0; i < b; i++) {
    const p = (len * (i + 1)) / (b + 1);
    out.push(horizontal ? { x: p, y: t.h + off, rot: 0 } : { x: t.w + off, y: p, rot: 90 });
  }
  return out;
}

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

  if (!state.editMode) {
    for (const r of activeReservations()) if (r.tableIds.length > 1) renderMergedGroup(r);
  }

  for (const t of state.tables) plan.append(tableElement(t, state.editMode ? null : occ.get(t.id)));
  updateScale();
}

const center = (t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });

/** Regroupe les tables qui se touchent (pour dessiner un seul fond par bloc). */
function adjacentClusters(ts) {
  const clusters = [];
  for (const t of ts) {
    const touching = clusters.filter((c) => c.some((o) => areAdjacent(o, t)));
    const merged = [t, ...touching.flat()];
    for (const c of touching) clusters.splice(clusters.indexOf(c), 1);
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
  const clusters = adjacentClusters(ts);
  const selected = state.selectedRes === r.id ? ' selected' : '';

  // Blocs éloignés : reliés par le chemin le plus court
  if (clusters.length > 1) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('connectors');
    svg.setAttribute('viewBox', `0 0 ${state.room.w} ${state.room.h}`);
    svg.innerHTML = spanningEdges(clusters.map((c) => center(boxOf(c))))
      .map(([a, b]) => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`)
      .join('');
    plan.append(svg);
  }

  for (const c of clusters) {
    const merge = document.createElement('div');
    merge.className = `merge ${statusOf(r)}${selected}`;
    Object.assign(merge.style, boxStyle(boxOf(c)));
    plan.append(merge);
  }

  // Le nom s'affiche sur le plus grand bloc
  const main = boxOf(clusters.reduce((big, c) => {
    const b = boxOf(c);
    const bb = boxOf(big);
    return b.w * b.h > bb.w * bb.h ? c : big;
  }));
  const label = document.createElement('div');
  label.className = 'merge-label';
  Object.assign(label.style, boxStyle(main));
  label.innerHTML = `<span class="t-guest">${esc(r.name)}</span>
    <span class="t-meta">${tableMeta(r, cap(r.tableIds))}</span>`;
  plan.append(label);
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

function tableElement(t, res) {
  const grouped = res && res.tableIds.length > 1;
  const el = document.createElement('div');
  el.className = ['table', t.shape, res ? `busy ${statusOf(res)}` : 'free', grouped ? 'grouped' : '',
    res && state.selectedRes === res.id ? 'selected' : '',
    state.grouping?.tableIds.includes(t.id) ? 'grouping-pick' : '',
    t.mergeable ? 'mergeable' : ''].filter(Boolean).join(' ');
  el.dataset.id = t.id;
  Object.assign(el.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` });

  for (const c of chairPositions(t)) {
    const chair = document.createElement('span');
    chair.className = 'chair';
    chair.style.left = `${c.x}px`;
    chair.style.top = `${c.y}px`;
    chair.style.transform = `translate(-50%, -50%) rotate(${c.rot}deg)`;
    el.append(chair);
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

  if (state.editMode) {
    if (isPicked('table', t.id)) decoratePicked(el, t, 'table');
    el.addEventListener('pointerdown', (e) => startMove(e, t, el, 'table'));
    return el;
  }

  // Une table occupée se déplace en glissant la réservation
  if (res) {
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
    if (state.grouping) return toggleGroupingTable(t, res);
    if (state.placing) return placeOnTable(t, res);
    state.selectedRes = res ? (state.selectedRes === res.id ? null : res.id) : null;
    render();
    if (res) els.resList.querySelector(`[data-id="${res.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  el.addEventListener('dblclick', () => res && openDialog(res));
  return el;
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2;
const PLAN_PAD = 32;

function fitScale() {
  const { planWrap } = els;
  const { room } = state;
  const s = Math.min((planWrap.clientWidth - PLAN_PAD * 2) / room.w, (planWrap.clientHeight - PLAN_PAD * 2) / room.h, 1.5);
  return Math.max(ZOOM_MIN, s);
}

/** Échelle ajustée à l'écran, ou zoom manuel avec défilement si la salle dépasse. */
function updateScale() {
  const { planWrap, planStage, plan } = els;
  const { room } = state;
  const s = state.zoom ?? fitScale();
  state.scale = s;
  const w = planWrap.clientWidth;
  const h = planWrap.clientHeight;
  const sw = room.w * s;
  const sh = room.h * s;
  planStage.style.width = `${Math.max(w, sw + PLAN_PAD * 2)}px`;
  planStage.style.height = `${Math.max(h, sh + PLAN_PAD * 2)}px`;
  const ox = Math.max(PLAN_PAD, (w - sw) / 2);
  const oy = Math.max(PLAN_PAD, (h - sh) / 2);
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
  state.drag = { resId };
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

const LONG_PRESS_MS = 260;
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

  function begin() {
    const res = resById(resId);
    if (!res || !isActive(res) || pinch) return cleanup();
    const ghost = document.createElement('div');
    ghost.className = 'touch-ghost';
    ghost.textContent = `${res.name} · ${res.people} pers.`;
    document.body.append(ghost);
    touchDrag = { resId, ghost, source };
    state.drag = { resId }; // même aperçu que le glisser à la souris
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
  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}

/** Ce qui se trouve sous le doigt : une table du plan, ou la liste (pour retirer du plan). */
function touchTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  const tableEl = el?.closest('.table');
  if (tableEl) return { table: tableById(tableEl.dataset.id) };
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
}

/** Déposer sur la liste retire du plan, seulement si on a pris la réservation depuis une table du plan. */
const canUnassignByDrop = (target, res) =>
  Boolean(target.list && res?.tableIds.length && touchDrag?.source.classList.contains('table'));

function dropTouchDrag(x, y) {
  const { resId } = touchDrag;
  const target = touchTarget(x, y);
  const unassignIt = canUnassignByDrop(target, resById(resId));
  finishTouchDrag();
  if (target.table) assign(resId, target.table.id);
  else if (unassignIt) unassign(resId);
}

function finishTouchDrag() {
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

// Déposer sur la liste = retirer la réservation du plan
els.sidebar.addEventListener('dragover', (e) => {
  const res = state.drag && resById(state.drag.resId);
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
  const res = state.drag && resById(state.drag.resId);
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
  if (before.tableIds.length === 1 && before.tableIds[0] === tableId) return;
  const busy = busyExcept(resId);
  const table = tableById(tableId);
  if (!busy.has(tableId) && table.seats < before.people) {
    const combo = findCombination(state.tables, tableId, before.people, busy, state.groups);
    return startGrouping(resId, combo || [tableId], { proposed: Boolean(combo) });
  }
  try {
    const { reservation } = await api.assign(resId, tableId);
    replaceReservation(reservation);
    state.selectedRes = reservation.id;
    toast(`${reservation.name} placé·e en ${tableNames(reservation)}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
}

/* ---------- Placement en touchant une table (tablette) ---------- */

/** Toucher une table pendant le mode placement : y place la réservation (fusion ou choix des tables si besoin). */
function placeOnTable(t, occupant) {
  const resId = state.placing;
  if (occupant && occupant.id !== resId) {
    toast(`${t.name} est occupée par ${occupant.name}`, 'error');
    return;
  }
  state.placing = null;
  if (occupant) return render(); // déjà sur cette table
  assign(resId, t.id);
}

function cancelPlacing() {
  state.placing = null;
  state.selectedRes = null;
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
  try {
    const { reservation, capacity } = await api.assignManual(resId, tableIds);
    replaceReservation(reservation);
    state.grouping = null;
    state.selectedRes = reservation.id;
    const tight = reservation.people > capacity ? ` — ${capacity} places pour ${reservation.people}, on se serre` : '';
    toast(`${reservation.name} placé·e en ${tableNames(reservation)}${tight}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
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

/* ---------- Dialogue réservation ---------- */

let editingId = null;

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
  $('#formError').textContent = '';
  $('#deleteRes').hidden = !r;
  els.dialog.showModal();
  f.name.focus();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(els.form));
  try {
    const saved = editingId
      ? await api.updateReservation(editingId, data)
      : await api.createReservation(data);
    const hadTables = editingId && resById(editingId)?.tableIds.length;
    els.dialog.close();
    if (saved.date !== state.date) {
      state.date = saved.date;
      await loadReservations();
    } else if (editingId) replaceReservation(saved);
    else state.reservations.push(saved);
    state.service = serviceOf(saved.time);
    if (hadTables && !saved.tableIds.length) toast(`${saved.name} est à replacer sur le plan`);
    else toast(editingId ? 'Réservation mise à jour' : 'Réservation ajoutée', 'success');
    render();
  } catch (err) {
    $('#formError').textContent = err.message;
  }
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

document.querySelectorAll('#filters button').forEach((b) =>
  b.addEventListener('click', () => {
    state.filter = b.dataset.value;
    renderList();
    renderControls();
  })
);

$('#editToggle').addEventListener('click', () => {
  state.editMode = !state.editMode;
  state.selected = null;
  state.linking = null;
  state.selectedRes = null;
  render();
});
$('#newRes').addEventListener('click', () => openDialog());
$('#autoAssign').addEventListener('click', autoAssignAll);

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
  if (!e.target.closest('.table, .zone')) clearSelection();
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

// Fond du plan : rectangle de sélection en mode édition (clic gauche),
// sinon glisser pour se déplacer dans le plan (clic gauche, molette enfoncée, ou un doigt — même sur une table)
els.planWrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  // Au doigt, hors édition, on peut faire glisser le plan en partant d'une table (le plan en est rempli)
  const fingerOnTable = e.pointerType !== 'mouse' && !state.editMode && !e.target.closest('.handle');
  if (e.target.closest('.table, .zone, .handle') && !fingerOnTable) return;
  if (pinch) return;
  if (state.editMode && e.button === 0 && !state.linking && !state.panMode) return startMarquee(e);
  const wrap = els.planWrap;
  const start = { x: e.clientX, y: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
  panned = false;
  if (e.button === 1) e.preventDefault(); // pas de défilement automatique du navigateur

  const onMove = (ev) => {
    if (pinch || touchDrag) return; // deux doigts : zoom ; appui long : glisser une réservation
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!panned && Math.hypot(dx, dy) < 4) return;
    panned = true;
    wrap.classList.add('panning');
    wrap.scrollLeft = start.left - dx;
    wrap.scrollTop = start.top - dy;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    wrap.classList.remove('panning');
    setTimeout(() => (panned = false)); // après l'événement click qui suit
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
});

document.addEventListener('keydown', (e) => {
  if (els.dialog.open || e.target.closest('input, select, textarea')) return;
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
    if (scope === 'all') await loadPlan();
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
