/**
 * Sélecteurs de date et d'heure maison (à la place de ceux du navigateur, différents partout).
 * - Date : calendrier du mois, toucher un jour le choisit.
 * - Heure : cadran façon Android — d'abord l'heure (1-12 à l'extérieur, 13-00 à l'intérieur),
 *   puis les minutes (par 5) ; on peut toucher ou faire glisser le doigt sur le cadran.
 * Chaque bouton `[data-picker]` affiche la valeur d'un champ caché (`data-for`) et l'ouvre au clic ;
 * le choix met à jour le champ et déclenche son événement « change ».
 */

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(`${s}T12:00:00`) : null);

/** Texte du bouton : date courte (« sam. 24 oct. ») ou longue (« samedi 24 octobre 2026 »), ou heure. */
function label(kind, value, format) {
  if (kind === 'time') return value || '--:--';
  const d = parseIso(value);
  if (!d) return 'Choisir…';
  if (format === 'long') {
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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

// Remplissage des services, fourni par l'application : (from, to) → { date: { midi, soir } }
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
      const cls = [value === selected ? 'selected' : '', value === today ? 'today' : '', out ? 'out' : ''].filter(Boolean).join(' ');
      // Deux points : midi à gauche, soir à droite, couleur selon le remplissage
      const day = info?.[value];
      const dots = info
        ? `<span class="pk-dots"><i class="lvl-${level(day?.midi)}"></i><i class="lvl-${level(day?.soir)}"></i></span>`
        : withDots ? '<span class="pk-dots"></span>' : '';
      const title = info ? ` — midi : ${pct(day?.midi)}, soir : ${pct(day?.soir)}` : '';
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
          <span class="pk-legend-pos"><i class="lvl-low"></i><i class="lvl-low"></i> point gauche : midi · droit : soir</span>
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

/* ---------- Horloge façon Android ---------- */

const SIZE = 256;
const C = SIZE / 2;
const R_OUT = 100; // anneau extérieur (1-12, et minutes)
const R_IN = 64; // anneau intérieur (13-00)

const polar = (index, r) => {
  const a = (index * 30 - 90) * (Math.PI / 180);
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
};

function openTime(input) {
  const dlg = getDialog();
  const [h0, m0] = (input.value || '20:00').split(':').map(Number);
  let hour = Number.isFinite(h0) ? h0 : 20;
  let minute = Number.isFinite(m0) ? m0 : 0;
  let mode = 'hour';

  // Position du curseur sur le cadran pour la valeur actuelle
  const handOf = () => {
    if (mode === 'minute') return { ...polar(minute / 5, R_OUT), r: R_OUT };
    const inner = hour === 0 || hour > 12;
    return { ...polar(hour % 12, inner ? R_IN : R_OUT), r: inner ? R_IN : R_OUT };
  };

  const faceSvg = () => {
    const labels = [];
    if (mode === 'hour') {
      for (let i = 0; i < 12; i++) {
        const outer = i === 0 ? 12 : i;
        const inner = i === 0 ? 0 : i + 12;
        const po = polar(i, R_OUT);
        const pi = polar(i, R_IN);
        labels.push(`<text x="${po.x}" y="${po.y}" class="${outer === hour ? 'on' : ''}">${outer}</text>`);
        labels.push(`<text x="${pi.x}" y="${pi.y}" class="inner ${inner === hour ? 'on' : ''}">${pad(inner)}</text>`);
      }
    } else {
      for (let i = 0; i < 12; i++) {
        const p = polar(i, R_OUT);
        labels.push(`<text x="${p.x}" y="${p.y}" class="${i * 5 === minute ? 'on' : ''}">${pad(i * 5)}</text>`);
      }
    }
    const hand = handOf();
    return `<svg class="pk-dial" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Cadran">
      <circle cx="${C}" cy="${C}" r="${C - 4}" class="face" />
      <line x1="${C}" y1="${C}" x2="${hand.x}" y2="${hand.y}" class="hand" />
      <circle cx="${C}" cy="${C}" r="4" class="pivot" />
      <circle cx="${hand.x}" cy="${hand.y}" r="18" class="knob" />
      ${labels.join('')}
    </svg>`;
  };

  const draw = () => {
    dlg.innerHTML = `
      <div class="pk-head pk-time">
        <button type="button" class="pk-seg ${mode === 'hour' ? 'on' : ''}" data-mode="hour" aria-label="Heures">${pad(hour)}</button>
        <span>:</span>
        <button type="button" class="pk-seg ${mode === 'minute' ? 'on' : ''}" data-mode="minute" aria-label="Minutes">${pad(minute)}</button>
      </div>
      <div class="pk-body pk-dial-wrap">${faceSvg()}
        <p class="pk-hint">${mode === 'hour' ? 'Choisissez l’heure — 13 h à 00 h sur le cercle intérieur' : 'Choisissez les minutes'}</p>
      </div>
      <div class="pk-foot">
        <span class="spacer"></span>
        <button type="button" class="btn ghost small" data-cancel>Annuler</button>
        <button type="button" class="btn primary small" data-ok>OK</button>
      </div>`;
    bindDial();
  };

  // Valeur sous le doigt / la souris
  const pick = (e, svg) => {
    const box = svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * SIZE - C;
    const y = ((e.clientY - box.top) / box.height) * SIZE - C;
    const angle = (Math.atan2(x, -y) * 180) / Math.PI;
    const deg = (angle + 360) % 360;
    if (mode === 'hour') {
      const i = Math.round(deg / 30) % 12;
      const inner = Math.hypot(x, y) < (R_IN + R_OUT) / 2;
      hour = inner ? (i === 0 ? 0 : i + 12) : i === 0 ? 12 : i;
    } else {
      minute = (Math.round(deg / 30) * 5) % 60; // par 5 minutes
    }
  };

  let dragging = false;
  const bindDial = () => {
    const svg = dlg.querySelector('.pk-dial');
    svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      try {
        svg.setPointerCapture(e.pointerId); // le glisser continue même si le doigt sort du cadran
      } catch {
        /* pointeur déjà relâché : sans importance */
      }
      pick(e, svg);
      redrawDial();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      pick(e, svg);
      redrawDial();
    });
    svg.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      // Heure choisie : on passe tout de suite aux minutes (comme Android)
      if (mode === 'hour') {
        mode = 'minute';
        draw();
      }
    });
  };
  // Pendant le glisser : on redessine le cadran sans recréer la fenêtre (le doigt garde la main)
  const redrawDial = () => {
    const svg = dlg.querySelector('.pk-dial');
    const tmp = document.createElement('div');
    tmp.innerHTML = faceSvg();
    svg.innerHTML = tmp.firstElementChild.innerHTML;
    dlg.querySelector('[data-mode="hour"]').textContent = pad(hour);
    dlg.querySelector('[data-mode="minute"]').textContent = pad(minute);
  };

  dlg.onclick = (e) => {
    if (e.target === dlg) return dlg.close();
    const seg = e.target.closest('[data-mode]');
    if (seg) {
      mode = seg.dataset.mode;
      return draw();
    }
    if (e.target.closest('[data-cancel]')) return dlg.close();
    if (e.target.closest('[data-ok]')) {
      dlg.close();
      commit(input, `${pad(hour)}:${pad(minute)}`);
    }
  };
  // Clavier : flèches pour ajuster, Entrée pour valider
  dlg.onkeydown = (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      if (mode === 'hour') hour = (hour + step + 24) % 24;
      else minute = (minute + step * 5 + 60) % 60;
      return redrawDial();
    }
    if (e.key === 'Enter' && !e.target.closest('[data-cancel]')) {
      e.preventDefault();
      dlg.close();
      commit(input, `${pad(hour)}:${pad(minute)}`);
    }
  };
  draw();
  dlg.showModal();
  dlg.querySelector('[data-ok]').focus();
}

/**
 * Branche tous les boutons `[data-picker]` de la page.
 * `options.dayInfo(from, to)` : remplissage des services, pour les points des calendriers `data-dots`.
 */
export function initPickers(options = {}) {
  dayInfo = options.dayInfo ?? null;
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
