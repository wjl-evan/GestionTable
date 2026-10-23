// Page publique : le client choisit personnes → jour → créneau, puis laisse ses coordonnées.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const form = $('#bookingForm');
const state = {
  info: null, // { maxPeople, maxDays, today, openDays }
  people: 2,
  date: null,
  time: null,
  month: null, // 'AAAA-MM' affiché dans le calendrier
  services: [], // créneaux du jour choisi
};

async function getJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new Error('Connexion impossible. Vérifiez votre connexion internet et réessayez.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Erreur ${res.status}`), { reason: data?.reason });
  return data;
}

const longDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const frTime = (t) => t.replace(':', 'h');
const phoneLink = (phone) => `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>`;

/* ---------- 1. Personnes ---------- */

function renderPeople() {
  $('#peopleNum').textContent = state.people;
  $('#peopleWord').textContent = state.people > 1 ? 'personnes' : 'personne';
  $('#peopleLess').disabled = state.people <= 1;
  $('#peopleMore').disabled = state.people >= state.info.maxPeople;
  const phone = state.info.restaurantPhone;
  $('#peopleHint').innerHTML =
    state.people >= state.info.maxPeople
      ? `Plus de ${state.info.maxPeople} personnes ? Contactez-nous directement${phone ? ` au ${phoneLink(phone)}` : ''}.`
      : '';
}

function setPeople(n) {
  state.people = Math.min(state.info.maxPeople, Math.max(1, n));
  renderPeople();
  if (state.date) loadSlots(); // la place disponible dépend du nombre de personnes
}
$('#peopleLess').addEventListener('click', () => setPeople(state.people - 1));
$('#peopleMore').addEventListener('click', () => setPeople(state.people + 1));

/* ---------- 2. Calendrier ---------- */

const z = (n) => String(n).padStart(2, '0');
const lastDay = () => {
  const d = new Date(`${state.info.today}T12:00:00`);
  d.setDate(d.getDate() + state.info.maxDays);
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

function renderCalendar() {
  const [y, m] = state.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // semaine commençant le lundi
  const open = new Set(state.info.openDays);
  const max = lastDay();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<span class="bk-day empty"></span>');
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${z(m)}-${z(d)}`;
    const past = iso < state.info.today;
    const closed = !past && iso <= max && !open.has(iso);
    const disabled = past || iso > max || closed;
    const cls = ['bk-day', iso === state.info.today ? 'today' : '', iso === state.date ? 'selected' : '', closed ? 'closed' : ''].filter(Boolean).join(' ');
    const label = `${longDate(iso)}${closed ? ' — fermé' : ''}`;
    cells.push(`<button type="button" class="${cls}" data-date="${iso}" ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"${iso === state.date ? ' aria-pressed="true"' : ''}>${d}</button>`);
  }
  const title = first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  $('#calendar').innerHTML = `
    <div class="bk-cal-head">
      <button type="button" class="bk-cal-nav" data-month="-1" aria-label="Mois précédent" ${state.month <= state.info.today.slice(0, 7) ? 'disabled' : ''}>‹</button>
      <strong>${esc(title)}</strong>
      <button type="button" class="bk-cal-nav" data-month="1" aria-label="Mois suivant" ${state.month >= max.slice(0, 7) ? 'disabled' : ''}>›</button>
    </div>
    <div class="bk-cal-grid">
      ${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span class="bk-cal-dow" aria-hidden="true">${d}</span>`).join('')}
      ${cells.join('')}
    </div>
    <p class="bk-legend">Les jours barrés sont fermés.</p>`;
}

$('#calendar').addEventListener('click', (e) => {
  const nav = e.target.closest('[data-month]');
  if (nav && !nav.disabled) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(nav.dataset.month), 1);
    state.month = `${d.getFullYear()}-${z(d.getMonth() + 1)}`;
    return renderCalendar();
  }
  const day = e.target.closest('[data-date]');
  if (!day || day.disabled) return;
  state.date = day.dataset.date;
  renderCalendar();
  loadSlots();
});

/* ---------- 3. Créneaux ---------- */

let slotsRequest = 0;

async function loadSlots() {
  const request = ++slotsRequest;
  $('#slots').innerHTML = '<p class="bk-hint">Recherche des horaires…</p>';
  try {
    const data = await getJson(`/api/public/availability?date=${state.date}&people=${state.people}`);
    if (request !== slotsRequest) return; // une autre recherche a été lancée entre-temps
    state.services = data.services;
  } catch (err) {
    if (request === slotsRequest) $('#slots').innerHTML = `<p class="bk-error">${esc(err.message)}</p>`;
    return;
  }
  // L'heure choisie n'est plus libre (autre jour, groupe plus grand…) : on la retire
  const still = state.services.some((s) => s.slots.some((sl) => sl.time === state.time && sl.available));
  if (!still) state.time = null;
  renderSlots();
  renderSummary();
}

function renderSlots() {
  if (!state.services.length) {
    $('#slots').innerHTML = '<p class="bk-full">Aucun service ouvert ce jour-là. Choisissez un autre jour.</p>';
    return;
  }
  $('#slots').innerHTML = state.services
    .map((s) => {
      const first = s.slots[0]?.time;
      const last = s.slots.at(-1)?.time;
      const body = s.full
        ? `<p class="bk-full">Complet pour ${state.people} personne${state.people > 1 ? 's' : ''}.</p>`
        : `<div class="bk-slot-grid">${s.slots
            .map((sl) => `<button type="button" class="bk-slot${sl.time === state.time ? ' selected' : ''}" data-time="${sl.time}" ${sl.available ? '' : 'disabled'}${sl.time === state.time ? ' aria-pressed="true"' : ''}>${frTime(sl.time)}</button>`)
            .join('')}</div>`;
      return `<div class="bk-service"><h3>${esc(s.label)} <small>${frTime(first)} – ${frTime(last)}</small></h3>${body}</div>`;
    })
    .join('');
}

$('#slots').addEventListener('click', (e) => {
  const slot = e.target.closest('[data-time]');
  if (!slot || slot.disabled) return;
  state.time = slot.dataset.time;
  renderSlots();
  renderSummary();
  $('#error').textContent = '';
});

/* ---------- 4. Coordonnées et envoi ---------- */

function renderSummary() {
  const ready = Boolean(state.date && state.time);
  $('#summary').innerHTML = ready
    ? `Table pour <b>${state.people} personne${state.people > 1 ? 's' : ''}</b>, le <b>${esc(longDate(state.date))}</b> à <b>${frTime(state.time)}</b>.`
    : state.date ? 'Choisissez une heure.' : 'Choisissez un jour et une heure.';
  $('#submitBtn').disabled = !ready;
}

/** Vérifie les champs avant l'envoi ; renvoie le premier message d'erreur, ou ''. */
function checkContact() {
  const email = form.email.value.trim();
  const phone = form.phone.value.trim();
  // Facultatif et vide : accepté ; rempli : doit être valide
  const checks = [
    [form.name, form.name.value.trim(), 'Indiquez votre nom.'],
    [form.email, (!email && !state.info.requireEmail) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Indiquez une adresse email valide.'],
    [form.phone, (!phone && !state.info.requirePhone) || (/^\+?[\d\s.()-]+$/.test(phone) && phone.replace(/\D/g, '').length >= 8), 'Indiquez un numéro de téléphone valide.'],
  ];
  let message = '';
  for (const [input, ok, text] of checks) {
    input.classList.toggle('invalid', !ok);
    if (!ok && !message) {
      message = text;
      input.focus();
    }
  }
  return message;
}
for (const input of [form.name, form.email, form.phone]) input.addEventListener('input', () => input.classList.remove('invalid'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#error');
  error.textContent = '';
  if (!state.date || !state.time) return (error.textContent = 'Choisissez un jour et une heure.');
  const invalid = checkContact();
  if (invalid) return (error.textContent = invalid);
  const btn = $('#submitBtn');
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  try {
    const data = await getJson('/api/public/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        people: state.people,
        date: state.date,
        time: state.time,
        name: form.name.value,
        email: form.email.value,
        phone: form.phone.value,
        notes: form.notes.value,
        website: form.website.value,
      }),
    });
    $('#doneText').innerHTML = data.date
      ? `Merci ${esc(data.name)} ! Votre table pour <b>${data.people} personne${data.people > 1 ? 's' : ''}</b> est réservée le <b>${esc(longDate(data.date))}</b> à <b>${frTime(data.time)}</b>.`
      : 'Merci ! Votre réservation est enregistrée.';
    form.hidden = true;
    $('#done').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    error.textContent = err.message;
    // Créneau pris entre-temps : on rafraîchit les horaires
    if (err.reason === 'full' || err.reason === 'slot') loadSlots();
  } finally {
    btn.textContent = 'Confirmer la réservation';
    renderSummary();
  }
});

$('#again').addEventListener('click', () => {
  form.reset();
  Object.assign(state, { date: null, time: null, services: [] });
  $('#slots').innerHTML = '<p class="bk-hint">Choisissez d\'abord un jour.</p>';
  renderCalendar();
  renderSummary();
  $('#done').hidden = true;
  form.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ---------- Démarrage ---------- */

try {
  state.info = await getJson('/api/public/info');
  applyInfo();
} catch (err) {
  form.hidden = false;
  form.innerHTML = `<p class="bk-error" style="padding:20px 0">${esc(err.message)}</p>`;
}

/** Nom, téléphone, message du restaurant ; champs obligatoires ; réservation fermée. */
function applyInfo() {
  const { restaurantName, restaurantPhone, message, enabled, closedMessage } = state.info;
  if (restaurantName) {
    $('#restaurantName').textContent = restaurantName;
    $('#restaurantName').hidden = false;
    document.title = `Réserver une table — ${restaurantName}`;
  }
  if (restaurantPhone) {
    $('#restaurantPhone').innerHTML = `Une question ? ${phoneLink(restaurantPhone)}`;
    $('#restaurantPhone').hidden = false;
    $('#doneHint').innerHTML = `Un empêchement ? Prévenez-nous au ${phoneLink(restaurantPhone)} pour libérer la table.`;
  }
  if (message) {
    $('#message').textContent = message;
    $('#message').hidden = false;
  }
  if (!enabled) {
    $('#closedText').innerHTML =
      esc(closedMessage || 'La réservation en ligne est fermée pour le moment.') +
      (restaurantPhone ? `<br />Vous pouvez nous appeler au ${phoneLink(restaurantPhone)}.` : '');
    $('#closed').hidden = false;
    return;
  }
  $('#emailOptional').hidden = state.info.requireEmail;
  $('#phoneOptional').hidden = state.info.requirePhone;
  form.hidden = false;
  state.month = state.info.today.slice(0, 7);
  renderPeople();
  renderCalendar();
  renderSummary();
}
