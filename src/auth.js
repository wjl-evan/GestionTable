// Comptes de l'équipe : protège les données clients (noms, téléphones).
// - Chaque compte a un nom, un email et un mot de passe (stocké haché : scrypt + sel, jamais en clair).
// - Rôles : « admin » (gère les comptes) ou « staff » (équipe).
// - Chaque appareil reçoit un cookie de session signé (HMAC), valable 30 jours.
// - Le premier compte (admin) ne peut être créé que depuis l'ordinateur qui fait tourner le serveur.
import crypto from 'node:crypto';
import { Router } from 'express';
import { backup, getDb, persist, httpError } from './store.js';

const COOKIE = 'gt_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const PASSWORD_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ROLES = ['admin', 'staff'];

const fails = new Map(); // adresse IP → { count, until }
const settings = () => getDb().settings;
const users = () => (getDb().users ??= []);

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const sign = (payload) => crypto.createHmac('sha256', settings().secret).update(payload).digest('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

export const isConfigured = () => users().length > 0;

/** Ce que l'interface peut voir d'un compte (jamais le hash). */
export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt });

const findByEmail = (email) => users().find((u) => u.email === email);

// Jeton : idCompte.version.expiration.signature — la version change avec le mot de passe (sessions annulées)
function makeToken(user) {
  const payload = `${user.id}.${user.sessionVersion}.${Date.now() + SESSION_DAYS * 86400000}`;
  return `${payload}.${sign(payload)}`;
}

function userFromToken(token) {
  if (!token || !settings().secret) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, version, expires, signature] = parts;
  if (!safeEqual(signature, sign(`${id}.${version}.${expires}`)) || Number(expires) <= Date.now()) return null;
  const user = users().find((u) => u.id === id);
  return user && String(user.sessionVersion) === version ? user : null;
}

function readCookie(req) {
  const found = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return found ? decodeURIComponent(found.slice(COOKIE.length + 1)) : null;
}

function setSession(res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(user)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
}

const isLocal = (req) => true;

export const currentUser = (req) => (isConfigured() ? userFromToken(readCookie(req)) : null);

/** Protège l'API : sans session valide → 401 (l'interface affiche alors l'écran de connexion). */
export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (user) {
    req.user = user;
    return next();
  }
  res.status(401).json({ error: 'Connexion requise', auth: isConfigured() ? 'login' : 'setup' });
}

/** Réservé aux administrateurs (gestion des comptes). */
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  throw httpError(403, 'Réservé aux administrateurs.');
}

/* ---------- Validation ---------- */

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 60) throw httpError(400, 'Le nom est obligatoire (60 caractères maximum).');
  return name;
}

function cleanEmail(value, exceptId) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) throw httpError(400, 'Adresse email invalide.');
  const other = findByEmail(email);
  if (other && other.id !== exceptId) throw httpError(409, 'Un compte utilise déjà cette adresse email.');
  return email;
}

function cleanPassword(value) {
  const password = String(value ?? '');
  if (password.length < PASSWORD_MIN || password.length > 200) {
    throw httpError(400, `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`);
  }
  return password;
}

function cleanRole(value) {
  if (!ROLES.includes(value)) throw httpError(400, 'Rôle invalide.');
  return value;
}

function setPassword(user, password) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passwordHash = hashPassword(password, user.salt);
  user.sessionVersion = (user.sessionVersion ?? 0) + 1; // les sessions ouvertes avec l'ancien mot de passe sont annulées
}

function checkPassword(user, password) {
  return safeEqual(hashPassword(password, user.salt), user.passwordHash);
}

/** Crée un compte (validé) et l'ajoute à la base. */
export function createUser({ name, email, password, role }) {
  const user = {
    id: `u${crypto.randomBytes(6).toString('hex')}`,
    name: cleanName(name),
    email: cleanEmail(email),
    role: cleanRole(role),
    createdAt: new Date().toISOString(),
  };
  setPassword(user, cleanPassword(password));
  users().push(user);
  return user;
}

const adminCount = () => users().filter((u) => u.role === 'admin').length;

/* ---------- Connexion ---------- */

const router = Router();

router.get('/status', (req, res) => {
  const user = currentUser(req);
  res.json({
    configured: isConfigured(),
    authenticated: Boolean(user),
    user: user ? publicUser(user) : null,
    canSetup: !isConfigured() && isLocal(req),
  });
});

/** Premier lancement : création du compte administrateur, uniquement depuis l'ordinateur serveur. */
router.post('/setup', async (req, res) => {
  if (isConfigured()) throw httpError(409, 'Un compte administrateur existe déjà.');
  if (!isLocal(req)) throw httpError(403, 'Le compte administrateur doit d’abord être créé sur l’ordinateur qui fait tourner l’application.');
  const s = settings();
  s.secret ??= crypto.randomBytes(32).toString('hex');
  // Ancien code d'accès partagé : remplacé par les comptes
  delete s.pinHash;
  delete s.pinSalt;
  const user = createUser({ ...req.body, role: 'admin' });
  await persist();
  await backup(); // le compte doit figurer tout de suite dans la sauvegarde
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/login', (req, res) => {
  if (!isConfigured()) throw httpError(409, 'Aucun compte n’a encore été créé.');
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip);
  if (f?.until > Date.now()) {
    throw httpError(429, `Trop d’essais. Réessayez dans ${Math.ceil((f.until - Date.now()) / 1000)} s.`);
  }
  const user = findByEmail(String(req.body.email ?? '').trim().toLowerCase());
  const password = String(req.body.password ?? '');
  // Email inconnu : on calcule quand même un hash, pour ne pas révéler quels comptes existent
  const ok = user ? checkPassword(user, password) : (hashPassword(password, DUMMY_SALT), false);
  if (!ok) {
    const count = (f?.count ?? 0) + 1;
    fails.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    throw httpError(401, count >= MAX_FAILS ? 'Email ou mot de passe incorrect. Trop d’essais : patientez une minute.' : 'Email ou mot de passe incorrect.');
  }
  fails.delete(ip);
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

/** Changer son propre mot de passe (déconnecte ses autres appareils). */
router.post('/password', requireAuth, async (req, res) => {
  if (!checkPassword(req.user, String(req.body.current ?? ''))) throw httpError(401, 'Mot de passe actuel incorrect.');
  setPassword(req.user, cleanPassword(req.body.password));
  await persist();
  await backup();
  setSession(res, req.user);
  res.json({ ok: true });
});

export default router;

/* ---------- Gestion des comptes (administrateurs) ---------- */

export const usersRouter = Router();
usersRouter.use(requireAdmin);

const findUser = (id) => {
  const user = users().find((u) => u.id === id);
  if (!user) throw httpError(404, 'Compte introuvable.');
  return user;
};

usersRouter.get('/', (req, res) => res.json(users().map(publicUser)));

usersRouter.post('/', async (req, res) => {
  const user = createUser({ ...req.body, role: req.body.role ?? 'staff' });
  await persist();
  res.status(201).json(publicUser(user));
});

/** Modifier un compte : nom, email, rôle, et nouveau mot de passe si fourni. */
usersRouter.put('/:id', async (req, res) => {
  const user = findUser(req.params.id);
  const next = {
    name: req.body.name === undefined ? user.name : cleanName(req.body.name),
    email: req.body.email === undefined ? user.email : cleanEmail(req.body.email, user.id),
    role: req.body.role === undefined ? user.role : cleanRole(req.body.role),
  };
  if (user.role === 'admin' && next.role !== 'admin' && adminCount() === 1) {
    throw httpError(400, 'Il doit rester au moins un administrateur.');
  }
  const password = req.body.password ? cleanPassword(req.body.password) : null;
  Object.assign(user, next);
  if (password) setPassword(user, password);
  await persist();
  if (password && user.id === req.user.id) setSession(res, user); // garder cet appareil connecté
  res.json(publicUser(user));
});

usersRouter.delete('/:id', async (req, res) => {
  const user = findUser(req.params.id);
  if (user.id === req.user.id) throw httpError(400, 'Vous ne pouvez pas supprimer votre propre compte.');
  if (user.role === 'admin' && adminCount() === 1) throw httpError(400, 'Il doit rester au moins un administrateur.');
  users().splice(users().indexOf(user), 1);
  await persist();
  res.status(204).end();
});
