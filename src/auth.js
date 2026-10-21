// Code d'accès partagé par l'équipe : protège les données clients (noms, téléphones).
// - Le code est stocké haché (scrypt + sel), jamais en clair.
// - Chaque appareil reçoit un cookie de session signé (HMAC), valable 30 jours.
// - Le premier code ne peut être créé que depuis l'ordinateur qui fait tourner le serveur.
import crypto from 'node:crypto';
import { Router } from 'express';
import { backup, getDb, persist, httpError } from './store.js';

const COOKIE = 'gt_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const PIN_RE = /^\d{4,8}$/;

const fails = new Map(); // adresse IP → { count, until }
const settings = () => getDb().settings;

const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const sign = (payload) => crypto.createHmac('sha256', settings().secret).update(payload).digest('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const isConfigured = () => Boolean(settings().pinHash);

function makeToken() {
  const expires = String(Date.now() + SESSION_DAYS * 86400000);
  return `${expires}.${sign(expires)}`;
}

function validToken(token) {
  if (!token || !settings().secret) return false;
  const [expires, signature] = token.split('.');
  return Boolean(expires && signature) && safeEqual(signature, sign(expires)) && Number(expires) > Date.now();
}

function readCookie(req) {
  const found = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return found ? decodeURIComponent(found.slice(COOKIE.length + 1)) : null;
}

function setSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export const isAuthenticated = (req) => isConfigured() && validToken(readCookie(req));

/** Protège l'API : sans session valide → 401 (l'interface affiche alors l'écran du code). */
export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Code d’accès requis', auth: isConfigured() ? 'login' : 'setup' });
}

function setPin(pin) {
  const s = settings();
  s.pinSalt = crypto.randomBytes(16).toString('hex');
  s.pinHash = hashPin(pin, s.pinSalt);
  s.secret = crypto.randomBytes(32).toString('hex'); // nouveau secret : les anciennes sessions sont annulées
}

const router = Router();

router.get('/status', (req, res) => {
  res.json({ configured: isConfigured(), authenticated: isAuthenticated(req), canSetup: !isConfigured() && isLocal(req) });
});

/** Premier lancement : création du code, uniquement depuis l'ordinateur serveur. */
router.post('/setup', async (req, res) => {
  if (isConfigured()) throw httpError(409, 'Un code d’accès existe déjà.');
  if (!isLocal(req)) throw httpError(403, 'Le code d’accès doit d’abord être créé sur l’ordinateur qui fait tourner l’application.');
  const pin = String(req.body.pin ?? '');
  if (!PIN_RE.test(pin)) throw httpError(400, 'Le code doit contenir de 4 à 8 chiffres.');
  setPin(pin);
  await persist();
  await backup(); // le code doit figurer tout de suite dans la sauvegarde
  setSession(res);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  if (!isConfigured()) throw httpError(409, 'Aucun code d’accès n’a encore été créé.');
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip);
  if (f?.until > Date.now()) {
    throw httpError(429, `Trop d’essais. Réessayez dans ${Math.ceil((f.until - Date.now()) / 1000)} s.`);
  }
  const pin = String(req.body.pin ?? '');
  const s = settings();
  if (!safeEqual(hashPin(pin, s.pinSalt), s.pinHash)) {
    const count = (f?.count ?? 0) + 1;
    fails.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    throw httpError(401, count >= MAX_FAILS ? 'Code incorrect. Trop d’essais : patientez une minute.' : 'Code incorrect.');
  }
  fails.delete(ip);
  setSession(res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

/** Changer le code (déconnecte tous les autres appareils). */
router.post('/change', requireAuth, async (req, res) => {
  const s = settings();
  if (!safeEqual(hashPin(String(req.body.current ?? ''), s.pinSalt), s.pinHash)) throw httpError(401, 'Code actuel incorrect.');
  const pin = String(req.body.pin ?? '');
  if (!PIN_RE.test(pin)) throw httpError(400, 'Le nouveau code doit contenir de 4 à 8 chiffres.');
  setPin(pin);
  await persist();
  await backup(); // le code doit figurer tout de suite dans la sauvegarde
  setSession(res);
  res.json({ ok: true });
});

export default router;
