# Gestion des tables

Application Node.js / Express pour gérer les réservations d'un restaurant et les placer sur un plan de salle.

## Démarrage

**Au restaurant (Windows)** : double-cliquer sur `demarrer.bat`. Il installe ce qu'il faut au premier lancement,
démarre le serveur et le **relance automatiquement** s'il s'arrête. La fenêtre affiche les adresses à ouvrir :
<http://localhost:3000> sur l'ordinateur, `http://<IP>:3000` sur les tablettes du même Wi-Fi.

Pour qu'il démarre tout seul à l'allumage du PC : `Win + R` → `shell:startup` → y placer un raccourci vers
`demarrer.bat`. Conseillé : donner à ce PC une adresse IP fixe dans la box (sinon l'adresse des tablettes peut changer).

**En développement** :

```bash
npm install
npm start        # ou: npm run dev (rechargement auto)
npm test         # tests automatiques des règles de placement
```

Au premier lancement, `data/db.json` est créé avec un plan et des réservations de démonstration pour la date du jour.

## Mise en service

- **Code d'accès** : au premier lancement, ouvrir <http://localhost:3000> **sur l'ordinateur serveur** pour créer
  le code de l'équipe (4 à 8 chiffres). Il est ensuite demandé sur chaque appareil (session de 30 jours). Bouton
  cadenas en haut : verrouiller l'appareil. « Modifier le plan » → « Code d'accès » : changer le code (les autres
  appareils devront le ressaisir). 5 erreurs → 1 minute d'attente. Le code est stocké haché, jamais en clair.
- **Synchronisation** : toutes les tablettes et ordinateurs voient les changements des autres en direct. Une mise à
  jour n'interrompt jamais une saisie en cours (formulaire, note, déplacement). Si la liaison avec le serveur est
  coupée, un bandeau rouge l'indique ; tout se recharge automatiquement au retour.
- **Sauvegardes** : une copie par jour dans `data/backups/` (gardée 30 jours), mise à jour au plus toutes les
  5 minutes après un changement. Si `db.json` est abîmé, il est mis de côté et le serveur repart de la dernière
  sauvegarde. Pour restaurer à la main : arrêter le serveur, copier `data/backups/db-AAAA-MM-JJ.json` vers
  `data/db.json`, relancer. Conseillé : copier aussi régulièrement `data/backups/` sur une clé USB ou un cloud.
- **Conservation des données clients** (réglable dans « Modifier le plan » → *Données des clients*) :
  - après **60 jours** (14 à 365), les services passés quittent `db.json` pour `data/archives/reservations-AAAA.json`
    (copie dans `data/backups/archives/`). `db.json` reste donc petit et rapide. Les services archivés restent
    consultables en choisissant leur date, mais ne sont plus modifiables ;
  - après **12 mois** (1 à 36), nom, téléphone, demande du client et note interne sont effacés définitivement
    (« Client anonymisé ») ; date, heure, couverts et tables sont gardés pour les statistiques ;
  - passage automatique au démarrage puis une fois par jour, et tout de suite après un changement de réglage.

## Fonctionnalités

- **Réservations** par date et par service (midi < 16h, soir) : création, modification, suppression.
  La liste est triée par heure puis par nom et **groupée par créneau** : un en-tête par heure (nombre de
  réservations, de couverts et de réservations à placer) reste visible en haut pendant le défilement. Sur chaque carte, le nom, le nombre de personnes et la table
  ressortent en premier ; en dessous, plus discrets : le statut (petit point : ○ attendu, ● vert
  arrivé, ● gris parti) et le téléphone (cliquable). Puis la demande du client, la note interne et des
  boutons toujours visibles : Arrivé / Libérer / Rétablir, Note, Modifier, Retirer (↶ pour annuler une
  arrivée). Les clients déjà installés sont atténués, les partis encore plus ; un client arrivé sans table
  reste bien visible avec « À placer » en rouge.
- **Recherche** : par nom (sans tenir compte des accents), par nombre de personnes (« 4 », « 4 pers ») ou par
  numéro de téléphone ; si rien n'est trouvé, la liste propose le résultat de l'autre service.
- **Note interne** : visible uniquement par l'équipe (en jaune), modifiable depuis la carte (« Note ») ou
  dans le formulaire, distincte de la demande du client.
- **Suivi du service** : chaque réservation est *Attendue*, *Arrivée* (heure notée) ou *Partie*.
  « Libérer » marque les clients comme partis : leurs tables redeviennent disponibles pour le reste du
  service (placement manuel et auto). « Rétablir » annule ; si les tables ont été redonnées entre-temps,
  la réservation repasse « à placer ». Sur le plan, une table réservée est en pointillé, une table dont
  les clients sont arrivés est pleine.
- **Glisser-déposer au doigt** : appui d'environ ¼ s sur une carte (ou une table occupée), puis glisser
  vers une table ; une étiquette suit le doigt et l'aperçu de fusion s'affiche. Depuis une table, déposer
  sur la liste retire la réservation du plan. Un glissé immédiat fait toujours défiler la liste ou le plan.
- **Tablette** : toucher une réservation affiche « Touchez une table libre pour la placer » (ou « …pour la
  déplacer ») ; toucher une table l'y place (mêmes propositions de fusion). Retoucher la carte ou « Annuler »
  quitte ce mode. Sur le plan : glisser au doigt pour se déplacer (même en partant d'une table), pincer à
  deux doigts pour zoomer. Sur écran tactile, boutons et champs sont agrandis (≈ 40–44 px) ; entre 700 et
  1100 px de large (tablette en portrait), la liste reste à côté du plan. Pour l'ouvrir sur une tablette du
  même réseau Wi-Fi : `http://<adresse IP du PC>:3000`.
- **Placement par glisser-déposer** d'une réservation sur une table du plan.
- **Table trop petite → choix des tables** : au dépôt, une barre demande quelles tables utiliser. Elle est
  pré-remplie avec la meilleure fusion libre s'il y en a une (ex. 2 + 4 = 6, en minimisant les places
  perdues) et indique « ✓ c'est suffisant » ou « il manque N places ». On clique sur les tables du plan
  pour en ajouter ou en retirer, « T52 seule » garde uniquement la table visée, puis « Placer » (ou
  « Placer quand même » si on se serre). Une table assez grande est placée directement.
- **Bouton « Auto »** : place toutes les réservations restantes du service, les plus grandes d'abord. Il
  donne en priorité les tables **peu polyvalentes** (isolées, sans fusion) et garde libres celles qui
  permettent de grandes tables (ex. T1 + T2 = 10 n'est pas cassée pour un groupe de 4). Si une réservation
  resterait sans table, il recommence en anticipant : chaque choix est jugé sur ce qu'il laisse pour la suite.
- **Historique** (en bas de la fiche d'une réservation) : création, chaque modification (nom, personnes, date, heure,
  téléphone, notes : avant → après), arrivée / départ, annulation, rétablissement. Les changements de tables ne sont
  pas notés. À l'anonymisation, les anciens noms / téléphones / notes de l'historique sont effacés aussi.
- **Annuler une réservation** (fiche ou formulaire) : elle n'est pas supprimée ; elle libère ses tables, ne compte plus
  nulle part et n'apparaît que dans la catégorie « Annulées », d'où on peut la rétablir.
- **Services** (« Modifier le plan » → *Services*) : Matin, Midi, Soir… avec leurs horaires de réservation (début →
  dernière réservation acceptée ; en dehors, on demande confirmation) et leurs jours
  d'ouverture habituels ; on peut en ajouter (ex. Brunch le dimanche) ou en supprimer. Une réservation va au service
  commencé le plus récemment à son heure. Pour un jour précis, le bouton à côté des services (sur téléphone : « Plus »)
  ouvre un service exceptionnellement ou en ferme un. Réserver dans un service fermé est refusé, avec « Ouvrir ce
  service et enregistrer ». Le calendrier montre un point par service ouvert.
- **Placement dès la création** : chaque nouvelle réservation (ou réservation changée de service) reçoit
  automatiquement une table libre ; s'il n'y en a pas, elle reste « à placer ».
- **Réservation fixée** (bouton « Fixer » sur la carte, cadenas violet sur la carte et le plan) : elle ne peut
  plus être glissée, retirée, ni touchée par « Auto » ou « Tout retirer ». « Fixée » la libère.
- **Tout retirer** (à côté d'« Auto ») : retire du plan les réservations attendues du service pour recommencer
  à zéro ; les réservations fixées et les clients déjà installés restent en place.
- Le choix fait dans la barre ne vaut que pour cette réservation, sans créer de fusion permanente ; si on se
  serre, elle est marquée « serré » (ex. 7/6).
- Glisser une table occupée vers une autre pour déplacer la réservation ; la déposer sur la liste pour la retirer.
- **Salle entièrement personnalisable** (bouton « Modifier le plan ») :
  - dimensions de la salle (jusqu'à 4000 × 4000) ;
  - tables : ajout, déplacement, redimensionnement (poignée), nom, places, forme, fusionnable ou non ;
  - éléments : bar, entrée, fenêtre, mur, cuisine, toilettes, zone libre (terrasse, salon…) — à placer,
    redimensionner, renommer ;
  - « Repartir d'un plan vierge » pour dessiner sa salle de zéro ;
  - **tout se fait à la souris** grâce à la barre d'outils : « Sélection multiple » (chaque clic ajoute ou
    retire un élément), « Tout sélectionner », « Copier », « Coller » (copie décalée, nouveaux numéros de
    table), « Dupliquer », « Supprimer » ; glisser sur le fond trace un rectangle de sélection (tables
    touchées + éléments entièrement inclus) ; glisser un élément sélectionné déplace tout le groupe ;
    le bouton « Déplacer la vue » (flèches, à côté du zoom) fait défiler le plan au lieu de sélectionner ;
  - raccourcis clavier facultatifs : Ctrl+clic, Ctrl+A, Ctrl+C / Ctrl+V, Ctrl+D, Suppr, Échap.
  Deux tables fusionnables sont voisines lorsqu'elles se font face avec un écart de 24 px maximum.
- **Fusions manuelles** (2 tables ou plus) : sélectionner les tables (« Sélection multiple » ou rectangle) → « Créer une
  fusion », avec le **nombre maximum de personnes** de la grande table obtenue (ex. trois tables de 2 et une
  de 4 → 12). Les tables peuvent être éloignées. Pour deux tables : « Lier à une autre table » dans le panneau
  d'une table. Une fusion s'utilise **en entier** : pour autoriser une partie de ses tables (ex. T72 + T73
  dans T71 + T72 + T73), créez aussi cette fusion-là. Régler la capacité de deux voisines
  automatiques crée une fusion à 2. Les anciens « liens » sont convertis automatiquement en fusions.
- **Zoom** à la molette (centré sur le curseur) ou avec les boutons en bas à droite ; glisser le fond du plan pour se déplacer.

## Structure

```
├── server.js                 # Point d'entrée Express (affiche les adresses pour les tablettes)
├── demarrer.bat              # Lancement au restaurant (Windows), avec relance automatique
├── shared/rules.js           # Règles partagées client/serveur (voisinage, fusion, services)
├── tests/                    # Tests automatiques (npm test)
├── src/
│   ├── store.js              # Persistance JSON (data/db.json) + sauvegardes (data/backups)
│   ├── auth.js               # Code d'accès de l'équipe, sessions
│   ├── events.js             # Synchronisation en direct entre appareils
│   ├── retention.js          # Archivage et anonymisation des anciennes réservations
│   ├── seed.js               # Données de démonstration
│   └── routes/
│       ├── plan.js           # GET /api/plan
│       ├── tables.js         # CRUD /api/tables
│       ├── reservations.js   # CRUD /api/reservations + assign / unassign
│       └── settings.js       # Durées de conservation des données clients
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js            # Client HTTP
│       └── app.js            # Interface (liste, plan, glisser-déposer, édition)
└── data/                     # Base JSON, archives, sauvegardes (ignorées par git)
```

Toute l'API (sauf `/api/auth/*`) exige une session ouverte avec le code d'accès. `GET /api/events` diffuse les
changements aux appareils connectés.

## API

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/api/plan` | Salle, zones et tables |
| PUT | `/api/plan/room` | `{ w, h }` — dimensions de la salle |
| DELETE | `/api/plan` | Plan vierge (supprime tables et éléments) |
| POST / PUT / DELETE | `/api/plan/zones[/:id]` | Éléments : bar, entrée, mur, fenêtre… |
| POST | `/api/plan/groups` | `{ tableIds, capacity }` — crée une fusion (ou met à jour sa capacité) |
| PUT / DELETE | `/api/plan/groups/:id` | Modifie la capacité / supprime la fusion |
| POST / PUT / DELETE | `/api/tables[/:id]` | Gestion des tables |
| GET | `/api/reservations?date=YYYY-MM-DD` | Réservations du jour (y compris archivées, marquées `archived`) |
| POST / PUT / DELETE | `/api/reservations[/:id]` | Gestion des réservations |
| POST | `/api/reservations/:id/assign` | `{ tableId }` — place la réservation (fusion auto si besoin) |
| POST | `/api/reservations/:id/assign-manual` | `{ tableIds }` — place sur des tables choisies (pour ce service, même si trop petites) |
| POST | `/api/reservations/:id/unassign` | Retire la réservation du plan |
| POST | `/api/reservations/:id/cancel` · `/uncancel` | Annule (réservation gardée) / rétablit |
| POST | `/api/reservations/:id/pin` | `{ pinned }` — fixe la réservation à ses tables (ou la libère) |
| POST | `/api/reservations/unassign-all` | `{ date, service }` — retire du plan les réservations attendues non fixées |
| POST | `/api/reservations/:id/status` | `{ status: 'expected' \| 'arrived' \| 'left' }` — arrivée / départ |
| GET / PUT | `/api/settings` | `{ archiveAfterDays, anonymizeAfterMonths }` — conservation des données, appliquée aussitôt |
| GET / PUT | `/api/services` | Services `{ services: [{ id, label, start, end, days }] }` et exceptions par date |
| PUT | `/api/services/day/:date` | `{ id, open: true | false | null }` — ouvrir / fermer un service ce jour-là |
