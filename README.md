# Gestion des tables

Application Node.js / Express pour gérer les réservations d'un restaurant et les placer sur un plan de salle.

## Démarrage

**Au restaurant (Windows)** : double-cliquer sur `demarrer.bat`. Il installe ce qu'il faut au premier lancement,
démarre le serveur et le **relance automatiquement** s'il s'arrête. La fenêtre affiche les adresses à ouvrir :
- **équipe** : <http://localhost:3000/gestion> sur l'ordinateur, `http://<IP>:3000/gestion` sur les tablettes du même Wi-Fi ;
- **clients** : <http://localhost:3000/> — la page publique de réservation (voir *Réservation en ligne*).

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

- **Comptes** : au premier lancement, ouvrir <http://localhost:3000/gestion> **sur l'ordinateur serveur** pour créer le
  compte administrateur (nom, email, mot de passe de 8 caractères minimum). Chaque personne se connecte ensuite
  avec son email et son mot de passe (session de 30 jours par appareil). L'administrateur crée, modifie ou supprime
  les comptes de l'équipe dans *Paramètres* → *Comptes de l'équipe* (rôle *Équipe* ou *Administrateur*) ;
  il reste toujours au moins un administrateur. Chacun peut changer son mot de passe dans *Mon compte* (ses autres
  appareils sont déconnectés). Bouton cadenas en haut : se déconnecter. 5 erreurs → 1 minute d'attente. Les mots
  de passe sont stockés hachés (scrypt), jamais en clair. L'historique d'une réservation indique qui a fait chaque
  changement. Une installation qui utilisait l'ancien code d'accès partagé redemande la création de l'administrateur.
- **Paramètres** (menu ☰ sur ordinateur et tablette, « Plus » sur téléphone) : une page à part, avec un onglet par
  sujet : *Services*, *Réservation en ligne*, *Données des clients*, *Mon compte* (mot de passe, déconnexion) et, pour les administrateurs,
  *Comptes de l'équipe*. « Retour » (ou Échap) ramène au plan. « Modifier le plan » ne sert plus qu'à dessiner la salle.
- **Réservation en ligne** (page publique, adresse de base `/`, sans compte), en 4 étapes affichées une à une avec une barre de progression (Retour / Continuer ; les étapes faites restent cliquables) : le client choisit le nombre de
  personnes, un jour (ni passé, ni trop lointain, ni fermé : barré dans le calendrier), puis un créneau parmi les
  services ouverts ce jour-là (ex. Midi 12:00 → 13:30 : 12:00, 12:15… 13:30). Il ne choisit pas de table : une table
  libre est attribuée automatiquement ; s'il n'y en a plus pour son groupe, le service est affiché « Complet ». La
  demande particulière est facultative. La réservation apparaît aussitôt chez l'équipe ; l'historique indique
  « Réservation en ligne ». Anti-abus : 5 réservations par heure et par adresse, piège à robots.
  **Réglages** (*Paramètres* → *Réservation en ligne*, enregistrés automatiquement à chaque changement) :
  - ouverte ou fermée (avec un message pour les clients quand elle est fermée) ;
  - nom et téléphone du restaurant, informations affichées en haut de la page ;
  - délai minimum avant le créneau (par défaut 1 h ; aucun à 2 jours ; les heures trop proches restent affichées, grisées) et jusqu'à combien de jours à l'avance (60) ;
  - créneaux toutes les 15, 30 ou 60 min ;
  - nombre maximum de personnes (12 ; au-delà, le client est invité à appeler) ;
  - couverts maximum par créneau (toutes réservations à la même heure, 0 = sans limite) pour étaler les arrivées ;
  - email et / ou téléphone obligatoires ou facultatifs (le nom est toujours demandé).
  Pour rendre la page accessible depuis internet, il faut exposer le serveur (box, nom de domaine, HTTPS) : à faire avec
  précaution, l'application de l'équipe est alors joignable aussi (protégée par les comptes).
- **Synchronisation** : toutes les tablettes et ordinateurs voient les changements des autres en direct. Une mise à
  jour n'interrompt jamais une saisie en cours (formulaire, note, déplacement). Si la liaison avec le serveur est
  coupée, un bandeau rouge l'indique ; tout se recharge automatiquement au retour.
- **Sauvegardes** : une copie par jour dans `data/backups/` (gardée 30 jours), mise à jour au plus toutes les
  5 minutes après un changement. Si `db.json` est abîmé, il est mis de côté et le serveur repart de la dernière
  sauvegarde. Pour restaurer à la main : arrêter le serveur, copier `data/backups/db-AAAA-MM-JJ.json` vers
  `data/db.json`, relancer. Conseillé : copier aussi régulièrement `data/backups/` sur une clé USB ou un cloud.
- **Conservation des données clients** (réglable dans *Paramètres* → *Données des clients*) :
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
- **Liste et plan** (ordinateur, tablette) : la barre du haut et la barre d'outils de la liste (filtres, plan,
  recherche, Auto, ↺, Nouvelle) sont sur une ligne et ne bougent jamais. « Masquer le plan » : la liste prend toute la
  largeur et chaque réservation tient sur **une ligne** (statut, nom, notes — leur début si la place le permet, une
  icône sinon —, zone, tables, personnes, action). « Afficher le plan » : le plan s'ouvre à droite, la liste passe dans
  une colonne à gauche avec les cartes détaillées. La **ligne entre les deux se tire** pour élargir / rétrécir la liste
  (flèches du clavier aussi ; double-clic : taille par défaut) ; le plan garde au moins 320 px. Sur téléphone,
  « Compacte » passe la liste en lignes. Placer une réservation rouvre le plan le temps du placement, puis il se
  referme. Choix et largeur gardés sur l'appareil.
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
- **Services** (*Paramètres* → *Services*) : Matin, Midi, Soir… avec leurs horaires de réservation (début →
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
- **Cliquer sur une table libre** (sur téléphone : la toucher) : un menu propose
  - **Clients sans réservation** : choisir le nombre de personnes puis « Installer maintenant » — une réservation
    « Sans réservation » est créée à cette table, déjà arrivée (aujourd'hui, pour un service en cours ou à venir :
    avant le début du service, elle est notée à l'heure de début) ;
  - **Nouvelle réservation à cette table** : le formulaire habituel, la table déjà remplie ;
  - les réservations « à placer » du service, pour les y installer en un clic.
  Dans la liste, les clients sans réservation sont à part : section « Sans réservation » en fin de liste (hors des
  créneaux horaires) et filtre « Sans réservation ».
- **Déposer sur une table déjà occupée** (ou la toucher en mode placement) : une confirmation indique qui l'occupe et ce
  qu'il deviendra (« sera déplacé·e en T5 », ou « aucune autre table libre : à placer »). Si on accepte, la réservation
  prend la table et l'autre reçoit automatiquement une table libre (sinon elle passe « à placer »). Impossible si l'autre
  réservation est fixée ou si ses clients sont déjà installés.
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
- **Zones** (salle, étage, terrasse…) : dans « Modifier le plan », ajouter un élément *Zone* et l'étirer autour de
  ses tables. Chaque table appartient à la zone qui contient son centre. Une zone sélectionnée a :
  - **En dernier recours** (ex. l'étage) : « Auto », la création d'une réservation et la réservation en ligne
    remplissent d'abord les autres zones ; celle-ci ne sert que s'il n'y a plus de place ailleurs ;
  - **Accord du client en ligne** : si la table d'un client tombe dans cette zone, la page publique l'avertit avant
    qu'il réserve (avec la **description**, ex. « À l'étage : accès par un escalier ») et il doit cocher qu'il accepte ;
    sans cet accord, la réservation est refusée. La fiche indique « acceptée par le client » ;
  - une **couleur** (8 au choix, ou « Autre couleur… ») : étiquette de zone sur les cartes des réservations (la zone
    elle-même reste neutre sur le plan) ;
  - **Ne pas afficher la zone sur les cartes de la liste** (ex. la salle principale : seul « Étage » est alors signalé) ;
    la zone reste indiquée dans la fiche de la réservation ;
  - des **jours d'ouverture** (ex. V S D) et, au choix, certains **services** seulement. Fermée : hachurée sur le plan,
    tables grisées, jamais proposées automatiquement ; déposer une réservation dessus est refusé avec la raison, mais on
    peut toujours choisir ses tables à la main (« Sur le plan »).
  Sur chaque carte de réservation placée, le nom de sa zone est affiché à gauche de ses tables.
- **Zoom** à la molette (centré sur le curseur) ou avec les boutons en bas à droite ; glisser le fond du plan pour se déplacer.

## Structure

```
├── server.js                 # Point d'entrée Express (affiche les adresses pour les tablettes)
├── demarrer.bat              # Lancement au restaurant (Windows), avec relance automatique
├── shared/rules.js           # Règles partagées client/serveur (voisinage, fusion, services)
├── tests/                    # Tests automatiques (npm test)
├── src/
│   ├── store.js              # Persistance JSON (data/db.json) + sauvegardes (data/backups)
│   ├── booking.js            # Réglages de la réservation en ligne
│   ├── auth.js               # Comptes de l'équipe, connexion, sessions
│   ├── events.js             # Synchronisation en direct entre appareils
│   ├── retention.js          # Archivage et anonymisation des anciennes réservations
│   ├── seed.js               # Données de démonstration
│   └── routes/
│       ├── plan.js           # GET /api/plan
│       ├── tables.js         # CRUD /api/tables
│       ├── reservations.js   # CRUD /api/reservations + assign / unassign
│       ├── public.js         # Réservation en ligne (page publique, sans compte)
│       └── settings.js       # Durées de conservation des données clients
├── public/
│   ├── index.html            # Page publique de réservation (/)
│   ├── gestion.html          # Application de l'équipe (/gestion)
│   ├── css/style.css         # + css/booking.css (page publique)
│   └── js/
│       ├── booking.js        # Page publique de réservation
│       ├── api.js            # Client HTTP
│       └── app.js            # Interface (liste, plan, glisser-déposer, édition)
└── data/                     # Base JSON, archives, sauvegardes (ignorées par git)
```

Toute l'API (sauf `/api/auth/*` et `/api/public/*`) exige d'être connecté avec un compte ; `/api/users` est réservé aux administrateurs. `GET /api/events` diffuse les
changements aux appareils connectés.

## API

| Méthode | Route | Description |
| --- | --- | --- |
| GET | `/api/public/info` | Page publique : limites (personnes, jours à l'avance) et jours ouverts |
| GET | `/api/public/availability?date=&people=` | Page publique : créneaux par service ouvert, `full` si plus de table, `notice` si la table serait dans une zone à accepter |
| POST | `/api/public/reservations` | Page publique : `{ name, email, phone, people, date, time, notes, acceptArea }` (table attribuée automatiquement ; `acceptArea` = id de la zone acceptée) |
| GET | `/api/plan` | Salle, zones et tables |
| PUT | `/api/plan/room` | `{ w, h }` — dimensions de la salle |
| DELETE | `/api/plan` | Plan vierge (supprime tables et éléments) |
| POST / PUT / DELETE | `/api/plan/zones[/:id]` | Éléments : bar, entrée, mur, fenêtre… ; zone (`type: 'area'`) avec `description`, `color` (#rrggbb), `days` (0 = lundi, `null` = tous), `services` (vide = tous), `overflow` (dernier recours), `confirm` (accord du client en ligne) |
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
| GET / PUT | `/api/settings/booking` | Réglages de la réservation en ligne (délai, jours, créneaux, champs obligatoires…) |
| GET / PUT | `/api/settings` | `{ archiveAfterDays, anonymizeAfterMonths }` — conservation des données, appliquée aussitôt |
| GET / PUT | `/api/services` | Services `{ services: [{ id, label, start, end, days }] }` et exceptions par date |
| POST | `/api/auth/setup` · `/login` · `/logout` · `/password` | Création de l'admin, connexion, déconnexion, changer son mot de passe |
| GET / POST / PUT / DELETE | `/api/users[/:id]` | Comptes `{ name, email, password, role }` (administrateurs) |
| PUT | `/api/services/day/:date` | `{ id, open: true | false | null }` — ouvrir / fermer un service ce jour-là |
