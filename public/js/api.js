/** Identifiant de cet onglet : permet d'ignorer ses propres modifications dans la synchronisation. */
export const CLIENT_ID = crypto.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let onAuthRequired = () => {};
/** Appelé quand le serveur demande une connexion (session expirée, mot de passe changé…). */
export const setAuthHandler = (fn) => (onAuthRequired = fn);

export class AuthError extends Error {}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Client-Id': CLIENT_ID, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Connexion au serveur impossible : vérifiez le Wi-Fi. La modification n’a pas été enregistrée.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && data?.auth) {
    onAuthRequired(data.auth);
    throw new AuthError(data.error);
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Erreur ${res.status}`);
    err.reason = data?.reason; // ex. « no_table » : aucune table libre pour cette réservation
    throw err;
  }
  return data;
}

export const auth = {
  status: () => request('GET', '/api/auth/status'),
  setup: (data) => request('POST', '/api/auth/setup', data),
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (current, password) => request('POST', '/api/auth/password', { current, password }),
};

export const users = {
  list: () => request('GET', '/api/users'),
  create: (data) => request('POST', '/api/users', data),
  update: (id, data) => request('PUT', `/api/users/${id}`, data),
  remove: (id) => request('DELETE', `/api/users/${id}`),
};

export const api = {
  plan: () => request('GET', '/api/plan'),
  updateRoom: (size) => request('PUT', '/api/plan/room', size),
  clearPlan: () => request('DELETE', '/api/plan'),
  createZone: (data) => request('POST', '/api/plan/zones', data),
  updateZone: (id, data) => request('PUT', `/api/plan/zones/${id}`, data),
  deleteZone: (id) => request('DELETE', `/api/plan/zones/${id}`),
  saveGroup: (tableIds, capacity) => request('POST', '/api/plan/groups', { tableIds, capacity }),
  updateGroup: (id, capacity) => request('PUT', `/api/plan/groups/${id}`, { capacity }),
  deleteGroup: (id) => request('DELETE', `/api/plan/groups/${id}`),

  reservations: (date) => request('GET', `/api/reservations?date=${encodeURIComponent(date)}`),
  summary: (from, to) => request('GET', `/api/reservations/summary?from=${from}&to=${to}`),
  createReservation: (data) => request('POST', '/api/reservations', data),
  updateReservation: (id, data) => request('PUT', `/api/reservations/${id}`, data),
  deleteReservation: (id) => request('DELETE', `/api/reservations/${id}`),
  cancelReservation: (id) => request('POST', `/api/reservations/${id}/cancel`),
  uncancelReservation: (id) => request('POST', `/api/reservations/${id}/uncancel`),
  assignManual: (id, tableIds) => request('POST', `/api/reservations/${id}/assign-manual`, { tableIds }),
  assign: (id, tableId) => request('POST', `/api/reservations/${id}/assign`, { tableId }),
  setStatus: (id, status) => request('POST', `/api/reservations/${id}/status`, { status }),
  settings: () => request('GET', '/api/settings'),
  updateServices: (services) => request('PUT', '/api/services', { services }),
  setServiceDay: (date, id, open) => request('PUT', `/api/services/day/${date}`, { id, open }),
  updateSettings: (data) => request('PUT', '/api/settings', data),
  bookingSettings: () => request('GET', '/api/settings/booking'),
  updateBookingSettings: (data) => request('PUT', '/api/settings/booking', data),
  autoAssign: (date, service) => request('POST', '/api/reservations/auto-assign', { date, service }),
  unassign: (id) => request('POST', `/api/reservations/${id}/unassign`),
  setPinned: (id, pinned) => request('POST', `/api/reservations/${id}/pin`, { pinned }),
  unassignAll: (date, service) => request('POST', '/api/reservations/unassign-all', { date, service }),

  createTable: (data) => request('POST', '/api/tables', data),
  updateTable: (id, data) => request('PUT', `/api/tables/${id}`, data),
  deleteTable: (id) => request('DELETE', `/api/tables/${id}`),
};
