/**
 * Sélecteurs de date et d'heure maison (à la place de ceux du navigateur, différents partout).
 * - Date : calendrier du mois, toucher un jour le choisit.
 * - Heure : liste des créneaux (ceux proposés aux clients, par service), et un champ pour taper
 *   n'importe quelle autre heure au clavier.
 * Chaque bouton `[data-picker]` affiche la valeur d'un champ caché (`data-for`) et l'ouvre au clic ;
 * le choix met à jour le champ et déclenche son événement « change ».
 */

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(`${s}T12:00:00`) : null);

/** Texte du bouton : date courte (« sam. 24 oct. »), moyenne (« dim. 25 oct. 2026 »), longue (« samedi 24 octobre 2026 »), ou heure. */
function label(kind, value, format) {
  if (kind === 'time') return value || '--:--';
  const d = parseIso(value);
  if (!d) return 'Choisir…';
  if (format === 'long') {
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  if (format === 'medium') {
    return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Met à jour le texte des boutons (après un changement de valeur fait par le code). */
export function refreshPickers(root = document) {
  for (const btn of root.querySelectorAll('[data-picker]')) {
    const input = document.getElementById(btn.dataset.for);
    btn.querySelector('span').textContent = label(btn.dataset.picker, input?.value, btn.dataset.format);
  }
}

/* ---------- Fenêtre commune ---------- */

let dialog;
function getDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'picker';
  document.body.append(dialog);
  // Toucher en dehors : on ferme sans rien changer
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  return dialog;
}

function commit(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  refreshPickers();
}

/* ---------- Calendrier ---------- */

// Remplissage des services, fourni par l'application :
// (from, to) → { date: [{ id, label, open, count, ratio }, …] } (services du jour, dans l'ordre)
let dayInfo = null;

/** Niveau de remplissage d'un service → couleur du point. */
function level(s) {
  if (!s || !s.count) return 'empty';
  if (s.ratio >= 1) return 'full';
  if (s.ratio > 0.8) return 'high';
  if (s.ratio > 0.5) return 'mid';
  return 'low';
}
const LEVELS = [
  ['empty', 'Aucune réservation'],
  ['low', 'Moins de 50 %'],
  ['mid', '51 à 80 %'],
  ['high', '81 à 99 %'],
  ['full', 'Complet'],
];
const pct = (s) => (s?.count ? `${Math.round(s.ratio * 100)} %` : 'aucune réservation');

function openDate(input, withDots) {
  const dlg = getDialog();
  const selected = input.value;
  const today = iso(new Date());
  const base = parseIso(selected) ?? new Date();
  let year = base.getFullYear();
  let month = base.getMonth();
  const loaded = new Map(); // 'AAAA-MM' → remplissage des jours affichés (chargé à la demande)

  // Toujours 6 semaines affichées (42 jours, du lundi) : le calendrier garde la même hauteur
  // quel que soit le mois ; les jours des mois voisins complètent la grille, en plus pâle.
  const gridStart = () => {
    const first = new Date(year, month, 1);
    return new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  };
  const GRID = 42;

  // Charge le remplissage des jours affichés, puis redessine avec les points
  const loadMonth = async () => {
    const key = `${year}-${pad(month + 1)}`;
    if (!withDots || !dayInfo || loaded.has(key)) return;
    loaded.set(key, null);
    try {
      const start = gridStart();
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + GRID - 1);
      loaded.set(key, await dayInfo(iso(start), iso(end)));
      if (dlg.open && key === `${year}-${pad(month + 1)}`) draw();
    } catch {
      loaded.delete(key); // hors ligne : pas de points, on réessaiera
    }
  };

  const draw = () => {
    const info = loaded.get(`${year}-${pad(month + 1)}`);
    const start = gridStart();
    const cells = [];
    for (let i = 0; i < GRID; i++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const value = iso(date);
      const d = date.getDate();
      const out = date.getMonth() !== month; // jour du mois précédent / suivant
      // Un point par service du jour (dans l'ordre : matin, midi, soir…), couleur selon le remplissage ;
      // aucun service ouvert : jour « fermé »
      const day = info?.[value];
      const closed = Boolean(info) && !day?.length;
      const cls = [value === selected ? 'selected' : '', value === today ? 'today' : '', out ? 'out' : '', closed ? 'closed' : ''].filter(Boolean).join(' ');
      const dots = info
        ? `<span class="pk-dots">${(day ?? []).map((s) => `<i class="lvl-${level(s)}${s.open ? '' : ' shut'}"></i>`).join('')}</span>`
        : withDots ? '<span class="pk-dots"></span>' : '';
      const title = !info ? '' : closed ? ' — fermé' : ` — ${day.map((s) => `${s.label.toLowerCase()} : ${s.open ? pct(s) : 'fermé'}`).join(', ')}`;
      cells.push(`<button type="button" class="${cls}" data-day="${value}" aria-label="${label('date', value, 'long')}${title}" title="${title.slice(3)}"><span class="pk-num">${d}</span>${dots}</button>`);
    }
    const head = parseIso(selected);
    dlg.innerHTML = `
      <div class="pk-head">
        <span class="pk-year">${head ? head.getFullYear() : year}</span>
        <strong>${head ? head.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Choisir une date'}</strong>
      </div>
      <div class="pk-body">
        <div class="pk-month">
          <button type="button" class="icon-btn small" data-nav="-1" aria-label="Mois précédent">‹</button>
          <span>${MONTHS[month]} ${year}</span>
          <button type="button" class="icon-btn small" data-nav="1" aria-label="Mois suivant">›</button>
        </div>
        <div class="pk-weekdays">${DAYS.map((d) => `<span>${d}</span>`).join('')}</div>
        <div class="pk-days">${cells.join('')}</div>
        ${withDots ? `<div class="pk-legend">
          <span class="pk-legend-pos"><i class="lvl-low"></i><i class="lvl-low"></i> un point par service ouvert, dans l'ordre de la journée</span>
          <span>${LEVELS.map(([k, t]) => `<span><i class="lvl-${k}"></i>${t}</span>`).join('')}</span>
        </div>` : ''}
      </div>
      <div class="pk-foot">
        <button type="button" class="btn ghost small" data-today>Aujourd'hui</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost small" data-cancel>Annuler</button>
      </div>`;
  };

  dlg.onclick = (e) => {
    if (e.target === dlg) return dlg.close();
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      month += Number(nav.dataset.nav);
      if (month < 0) (month = 11), year--;
      if (month > 11) (month = 0), year++;
      draw();
      return loadMonth();
    }
    const day = e.target.closest('[data-day]')?.dataset.day ?? (e.target.closest('[data-today]') ? today : null);
    if (day) {
      dlg.close();
      return commit(input, day);
    }
    if (e.target.closest('[data-cancel]')) dlg.close();
  };
  dlg.onkeydown = null;
  draw();
  dlg.showModal();
  loadMonth();
  dlg.querySelector('.selected, .today, [data-day]')?.focus();
}

/* ---------- Heure : liste des créneaux + saisie au clavier ---------- */

// Créneaux proposés, fournis par l'application : input → [{ label, range, slots: [{ time, disabled, note }] }]
// (ou null : liste générique, toutes les 30 minutes)
let timeSlots = null;

/** Liste générique (réglages des services…) : toute la journée, par 30 minutes. */
function genericSlots() {
  const slots = [];
  for (let m = 0; m < 24 * 60; m += 30) slots.push({ time: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` });
  return [{ label: 'Toute la journée', range: '', slots }];
}

/**
 * Heure tapée au clavier → « HH:MM », ou null si elle n'est pas valable.
 * Accepte « 19:45 », « 19h45 », « 19h », « 19 », « 1945 », « 945 », « 9.45 »…
 */
export function parseTime(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  let m = t.match(/^(\d{1,2})(?:[h:.](\d{2})?)?$/);
  let h;
  let min;
  if (m) {
    h = Number(m[1]);
    min = m[2] === undefined ? 0 : Number(m[2]);
  } else if ((m = t.match(/^(\d{1,2})(\d{2})$/))) {
    h = Number(m[1]);
    min = Number(m[2]);
  } else return null;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function openTime(input) {
  const dlg = getDialog();
  const current = input.value;
  const groups = timeSlots?.(input) ?? genericSlots();
  const known = new Set(groups.flatMap((g) => g.slots.map((s) => s.time)));

  const slotBtn = (s) => {
    const on = s.time === current;
    // Un créneau passé reste choisissable s'il est déjà celui de la réservation
    const disabled = s.disabled && !on;
    return `<button type="button" class="pk-slot${on ? ' selected' : ''}" data-time="${s.time}"${disabled ? ' disabled' : ''}${s.title ? ` title="${s.title}"` : ''}>
      <span>${s.time}</span>${s.note ? `<small>${s.note}</small>` : ''}</button>`;
  };
  const groupHtml = (g) => `
    <section class="pk-group">
      <h3>${g.label}${g.range ? ` <span>${g.range}</span>` : ''}</h3>
      ${g.slots.length ? `<div class="pk-slots">${g.slots.map(slotBtn).join('')}</div>` : `<p class="pk-none">${g.empty ?? 'Aucun créneau'}</p>`}
    </section>`;

  dlg.innerHTML = `
    <div class="pk-head">
      <span class="pk-year">Heure</span>
      <strong>${current || '--:--'}</strong>
    </div>
    <form class="pk-manual" novalidate>
      <label for="pkTimeInput">Autre heure, au clavier</label>
      <div class="pk-manual-row">
        <input id="pkTimeInput" inputmode="numeric" autocomplete="off" placeholder="ex. 19h45" value="${current && !known.has(current) ? current : ''}" />
        <button type="submit" class="btn primary small">OK</button>
      </div>
      <p class="pk-error" role="alert"></p>
    </form>
    <div class="pk-body pk-time-list">${groups.map(groupHtml).join('')}</div>
    <div class="pk-foot">
      <span class="spacer"></span>
      <button type="button" class="btn ghost small" data-cancel>Annuler</button>
    </div>`;

  const field = dlg.querySelector('#pkTimeInput');
  const error = dlg.querySelector('.pk-error');
  const choose = (value) => {
    dlg.close();
    commit(input, value);
  };
  dlg.querySelector('.pk-manual').onsubmit = (e) => {
    e.preventDefault();
    const value = parseTime(field.value);
    if (value) return choose(value);
    error.textContent = field.value.trim() ? 'Heure non reconnue : tapez par exemple 19h45, 19:45 ou 1945.' : 'Tapez une heure, ou touchez un créneau.';
    field.focus();
  };
  field.oninput = () => (error.textContent = '');

  dlg.onclick = (e) => {
    if (e.target === dlg) return dlg.close();
    const slot = e.target.closest('[data-time]');
    if (slot && !slot.disabled) return choose(slot.dataset.time);
    if (e.target.closest('[data-cancel]')) dlg.close();
  };
  dlg.onkeydown = null;
  dlg.showModal();
  // Le créneau choisi au milieu de la liste ; sinon le premier encore possible
  const target = dlg.querySelector('.pk-slot.selected') ?? dlg.querySelector('.pk-slot:not(:disabled)');
  target?.scrollIntoView({ block: 'center' });
  // Au doigt, pas de clavier qui s'ouvre tout seul : on montre d'abord les créneaux
  if (matchMedia('(pointer: coarse)').matches) target?.focus({ preventScroll: true });
  else field.focus();
}

/**
 * Branche tous les boutons `[data-picker]` de la page.
 * `options.dayInfo(from, to)` : remplissage des services, pour les points des calendriers `data-dots`.
 * `options.timeSlots(input)` : créneaux à proposer pour ce champ d'heure (null : liste générique).
 */
export function initPickers(options = {}) {
  dayInfo = options.dayInfo ?? null;
  timeSlots = options.timeSlots ?? null;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-picker]');
    if (!btn) return;
    e.preventDefault();
    const input = document.getElementById(btn.dataset.for);
    if (btn.dataset.picker === 'time') openTime(input);
    else openDate(input, 'dots' in btn.dataset);
  });
  refreshPickers();
}
