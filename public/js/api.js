/** Identifiant de cet onglet : permet d'ignorer ses propres modifications dans la synchronisation. */
export const CLIENT_ID = crypto.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let onAuthRequired = () => {};
/** Appelé quand le serveur demande le code d'accès (session expirée, code changé…). */
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
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

export const auth = {
  status: () => request('GET', '/api/auth/status'),
  setup: (pin) => request('POST', '/api/auth/setup', { pin }),
  login: (pin) => request('POST', '/api/auth/login', { pin }),
  logout: () => request('POST', '/api/auth/logout'),
  change: (current, pin) => request('POST', '/api/auth/change', { current, pin }),
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
  createReservation: (data) => request('POST', '/api/reservations', data),
  updateReservation: (id, data) => request('PUT', `/api/reservations/${id}`, data),
  deleteReservation: (id) => request('DELETE', `/api/reservations/${id}`),
  assignManual: (id, tableIds) => request('POST', `/api/reservations/${id}/assign-manual`, { tableIds }),
  assign: (id, tableId) => request('POST', `/api/reservations/${id}/assign`, { tableId }),
  setStatus: (id, status) => request('POST', `/api/reservations/${id}/status`, { status }),
  settings: () => request('GET', '/api/settings'),
  updateSettings: (data) => request('PUT', '/api/settings', data),
  autoAssign: (date, service) => request('POST', '/api/reservations/auto-assign', { date, service }),
  unassign: (id) => request('POST', `/api/reservations/${id}/unassign`),

  createTable: (data) => request('POST', '/api/tables', data),
  updateTable: (id, data) => request('PUT', `/api/tables/${id}`, data),
  deleteTable: (id) => request('DELETE', `/api/tables/${id}`),
};
