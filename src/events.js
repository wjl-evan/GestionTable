// Synchronisation en direct entre appareils (Server-Sent Events) :
// chaque appareil garde une connexion ouverte ; après chaque modification, le serveur
// prévient tout le monde et les autres appareils rechargent ce qui a changé.

const clients = new Set();

/** GET /api/events : flux d'événements pour un appareil. */
export function eventsHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n'); // reconnexion automatique après 3 s si la liaison coupe
  clients.add(res);
  // Signe de vie régulier : garde la connexion ouverte et détecte les appareils partis
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(message);
}

/** Après chaque modification réussie de l'API, prévient les appareils connectés. */
export function notifyChanges(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    // Modifier le plan (tables, fusions…) peut aussi toucher aux réservations : on recharge tout
    const scope = req.path.startsWith('/reservations') ? 'reservations' : 'all';
    broadcast({ scope, origin: req.get('X-Client-Id') || null });
  });
  next();
}
