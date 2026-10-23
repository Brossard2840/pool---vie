# Pool à vie — Guide de mise en ligne (gratuit)

L'application a 3 pièces, toutes gratuites :
1. **Le code** (ce dossier), déposé sur **GitHub**.
2. **La base de données** sur **Supabase** : équipes, joueurs, codes d'accès, historique.
3. **L'hébergement** sur **Render** : le site que tout le monde ouvre sur son téléphone.

Plus un petit service de « réveil » gratuit (**cron-job.org**) qui visite le site aux 10 minutes :
le serveur gratuit reste éveillé et les stats de la LNH se mettent à jour aux 20 minutes.

Comptez 30 minutes la première fois.

---

## Étape 1 — Mettre le code sur GitHub

1. Créez un compte sur [github.com](https://github.com).
2. **New repository** → nom `pool-a-vie` → **Private** → **Create repository**.
3. Cliquez **uploading an existing file** et glissez TOUT le contenu de ce dossier
   (`server.js`, `package.json`, les dossiers `lib`, `public`, `test`, `data`), puis **Commit changes**.

## Étape 2 — Base de données (Supabase)

1. Créez un compte sur [supabase.com](https://supabase.com) → **New project** (nom `pool-a-vie`,
   choisissez un mot de passe et notez-le ; région : *Canada (Central)* ou *East US*).
2. Une fois le projet prêt, cliquez le bouton **Connect** en haut de la page.
3. Choisissez **Session pooler** (important : Render ne peut pas utiliser la connexion « Direct »).
   Copiez l'adresse, qui ressemble à :
   `postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`
4. Remplacez `[YOUR-PASSWORD]` par votre mot de passe. C'est votre **`DATABASE_URL`**.

## Étape 3 — Hébergement (Render)

1. Créez un compte sur [render.com](https://render.com) avec votre compte GitHub.
2. **New** → **Web Service** → choisissez le dépôt `pool-a-vie`.
3. Réglages : Runtime **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. **Environment Variables** :
   | Nom | Valeur |
   |---|---|
   | `DATABASE_URL` | l'adresse copiée à l'étape 2 |
   | `COMMISSAIRE_CODE` | votre code secret de commissaire (ex. 8 lettres/chiffres) |
   | `TZ` | `America/Toronto` |
5. **Create Web Service**. Après 2 à 5 minutes, Render donne l'adresse du site,
   ex. `https://pool-a-vie.onrender.com`.

> La saison LNH est détectée automatiquement (à partir de septembre, c'est la nouvelle saison).
> Plus besoin de changer `SEASON_ID` chaque année ; on peut quand même la forcer dans *Commissaire → Réglages*.

## Étape 4 — Garder le site éveillé (cron-job.org)

Le serveur gratuit de Render s'endort après 15 minutes sans visite. Pour qu'il reste éveillé
et que les stats suivent les matchs :

1. Créez un compte sur [cron-job.org](https://cron-job.org).
2. **Create cronjob** → URL : `https://VOTRE-SITE.onrender.com/healthz` → **Every 10 minutes** → **Create**.

Le serveur se visite aussi lui-même aux 10 minutes (adresse fournie automatiquement par Render
dans `RENDER_EXTERNAL_URL`) : cron-job.org devient une simple sécurité. Après un redémarrage de
Render, la première visite le réveille et il reste ensuite éveillé.

Si l'application affiche « Réveil du serveur… » à l'ouverture, le serveur s'était endormi : vérifiez
dans cron-job.org que la tâche est toujours **Enabled** (le site la désactive après plusieurs échecs
de suite) et que l'historique montre des réponses 200.

Le forfait gratuit de Render inclut 750 heures par mois, assez pour un site allumé en permanence.
Les visites régulières empêchent aussi Supabase de mettre le projet en pause (pause après 7 jours sans activité).

## Étape 5 — Configurer la ligue

1. Ouvrez le site, choisissez **🔑 Commissaire** et entrez votre `COMMISSAIRE_CODE`.
   Le compte commissaire est **neutre** : il n'a pas d'équipe. Il approuve les échanges, gère les
   alignements, les codes, le repêchage, etc. Chaque pooler (le commissaire aussi) gère son équipe
   avec le code de son équipe. Plusieurs personnes peuvent utiliser le code commissaire en même temps
   (ex. un adjoint) ; leurs gestes sont notés « Commissaire ». Changer `COMMISSAIRE_CODE` dans Render
   déconnecte tous les appareils connectés en commissaire.
2. **Plus → Commissaire → Import des alignements** : collez la liste des joueurs
   (`ÉquipePool;Nom;Position;AAV;Âge;FinContrat`, une ligne par joueur), cochez
   « Remplacer tous les alignements », puis **Importer**. Les équipes sont créées automatiquement.
3. **Mettre à jour maintenant** (section Statistiques LNH) pour charger les stats immédiatement.
4. Pour chaque équipe, **Nouveau code** → **Envoyer au pooler** : le code part par texto ou Messenger
   avec le lien du site.

## Sur le téléphone

- **iPhone (Safari)** : ouvrir le lien → bouton Partager ⬆︎ → « Sur l'écran d'accueil ».
- **Android (Chrome)** : ouvrir le lien → menu ⋮ → « Installer l'application ».

L'icône « À VIE » s'ouvre alors en plein écran, comme une vraie application, et reste connectée.

---

## Statistiques

Source : les statistiques officielles de la LNH (`api.nhle.com`, l'API qu'utilise NHL.com).
Toute la ligue est lue en quelques appels, aux 20 minutes (`REFRESH_MINUTES` pour changer).
Les joueurs sont reliés par leur **identifiant LNH**, donc les homonymes (deux Sebastian Aho,
deux Elias Pettersson) ne se mélangent pas.

Un joueur du pool qui n'a pas encore joué cette saison (ex. espoir dans la LAH) apparaît
« sans fiche LNH » ; il est relié automatiquement à son premier match. Si son nom est écrit
différemment dans la LNH, ouvrez sa fiche et utilisez **Fusionner**.

## En direct

L'onglet **En direct** suit les matchs de la journée à partir des sommaires de match de la LNH
(`api-web.nhle.com`, la source de NHL.com) : rafraîchi chaque minute pendant les matchs.
Au premier démarrage d'une saison, le serveur télécharge tous les matchs déjà joués (quelques
minutes) ; ensuite, les totaux de la saison sont la somme de ces matchs, matchs en cours inclus.

## Échanges et choix de repêchage

Chaque équipe possède ses choix des rondes 1 à 12 du prochain repêchage (art. 4.6) ; le commissaire
ajoute ceux de l'année suivante après les listes de protection (Commissaire → Échanges et choix).
Un pooler monte une offre (joueurs et choix) dans l'onglet **Échanges** ; l'autre pooler accepte,
refuse ou fait une contre-offre, puis le commissaire approuve (réglable). L'écran montre la masse
salariale et les positions des deux équipes après l'échange. La page **Choix de repêchage** suit
qui possède chaque choix et l'historique de leurs échanges. Date limite (art. 5.1) réglable.

Agents libres (art. 5.4) : depuis la fiche d'un joueur libre, « Réclamer » abandonne un choix de
1re ronde dans un ordre imposé (son propre choix d'abord, puis ceux acquis du plus ancien au plus récent) et peut libérer
un joueur dans la même opération ; le maximum par position et le plafond sont vérifiés.

## Ballottage (art. 5.5 et 5.6)

Un joueur libéré (par son pooler, depuis sa fiche, ou par le commissaire) passe au ballottage
pendant une période réglable (24 h par défaut). Les autres équipes peuvent le réclamer, en nommant
au besoin un joueur à libérer. À la fin, il va à l'équipe prioritaire : avant le 1er novembre, la
pire au classement de la saison précédente (rangs saisis par le commissaire) ; ensuite, le pire
pointage actuel ; égalité : le plus faible ratio de points par match. Par défaut, une réclamation
réussie coûte un choix de 1re ronde, comme l'art. 5.4 (réglable). Sans réclamation, le joueur
devient agent libre.

## Listes de protection (art. 4.2 et 4.3)

Le commissaire ouvre la période (Plus → Liste de protection) avec une date limite. Chaque pooler
choisit 10 joueurs protégés (🛡️) et jusqu'à 3 protections automatiques (⚡) parmi ses joueurs
admissibles : R (recrue de la saison qui se termine), GP (39 matchs ou moins, 20 pour un gardien),
R2 (recrue la saison d'avant). Les combinaisons de l'art. 4.3.4 sont validées. Le statut de recrue
suit les critères de la LNH à partir de l'historique de chaque joueur sur NHL.com (le commissaire
peut forcer l'admissibilité d'un joueur). Le commissaire dévoile ensuite les listes, puis les applique :
les joueurs non protégés retournent dans le bassin du repêchage et les choix de l'année suivante sont créés.

## Pool des séries (art. 7)

Classement → Séries. Les 8 premières équipes participent. Les points des séries (art. 2.2 : pas de
point pour une défaite en prolongation) sont multipliés par ronde : ×1, ×1,5, ×2 (finale de
conférence), ×3 (finale de la Coupe). Après la 1re ronde, les 6 meilleures continuent ; après la
2e (cumulée), les 4 meilleures. Le plus haut cumulatif est champion. Les meilleurs 9 A, 4 D et 2 G
de chaque équipe comptent, sur le cumul pondéré. Une ronde est considérée terminée quand la
suivante commence dans la LNH.

## Retenues salariales (art. 5.3)

Dans une offre, chaque joueur envoyé peut avoir une retenue de 0 à 50 %. Le joueur coûte moins à sa
nouvelle équipe et le montant retenu reste dans la masse de l'équipe qui retient jusqu'à la fin de
la saison. Limites vérifiées : 3 échanges avec retenue par saison, 15 % du plafond au total, 2 échanges
avec retenue par contrat, et pas de retour du joueur dans l'équipe qui retient.

## Repêchage (art. 4.4 à 4.6)

Onglet **Repêchage** (il remplace « En direct » pendant la préparation et le déroulement ; aussi dans Plus).
1. Ordre de base : la pire équipe d'abord (rang de la saison précédente saisi dans Commissaire →
   Ballottage). Le commissaire peut réordonner les positions (ex. selon les séries).
2. Loterie : les 5 premières équipes de l'ordre se disputent les choix 1 à 5 selon des pourcentages
   réglables (25/25/20/15/10 par défaut). Tirage pondéré sans remise, dévoilé du 5e au 1er choix.
3. Repêchage en direct : même ordre à chaque ronde ; l'équipe au choix (ou le commissaire) choisit un
   joueur disponible. Une équipe à 23 joueurs a terminé (art. 4.5) : ses choix restants sont passés.
   Le commissaire peut annuler la dernière sélection, mettre en pause ou terminer.
4. Minuteur : 2 minutes par choix. Le commissaire appuie sur « Lancer le repêchage ». Un compte à rebours
   reste en haut de l'écran ; la case au choix est encadrée. Dans les 30 dernières secondes, il passe au
   rouge avec un tic-tac. Temps écoulé : le minuteur s'arrête à 0:00 (buzzer) et le commissaire reçoit une
   demande de régulariser : « Passer au suivant » (le choix devient « passé », en orange, et l'équipe peut
   le faire en retard quand elle veut) ou « Avertissement » (noté, 1 minute de plus). En attendant, le
   pooler peut encore choisir. Sons : fanfare à chaque sélection, carillon au changement de pooler
   (mélodie spéciale quand c'est ton tour), sirène au lancement. Le minuteur tourne sur le serveur : tout
   le monde voit le même temps. Pause et reprise par le commissaire.
5. 🧪 Simulation (bouton sous le tableau) : un repêchage pour pratiquer, sur ton téléphone seulement,
   rien n'est enregistré. Tu choisis pour ton équipe ; les autres choisissent toutes seules. Temps par
   choix au choix (30 s par défaut) ; à 0:00, la simulation passe au suivant.
Le tableau montre les rondes en lignes et les équipes en colonnes : le joueur repêché dans chaque case,
et « → équipe » quand le choix a été échangé.

## Notifications

- **Dans l'application** : cloche 🔔 avec compteur, fil des notifications, bannières qui apparaissent
  en haut de l'écran. Une transaction complétée déclenche l'alerte « 🚨 GROSSE TRANSACTION ! » (bannière
  rouge, sirène animée, klaxon de but, vibration) ; on la touche pour voir l'échange.
- **Sur le téléphone, application fermée** (Web Push) : Notifications → « Activer les notifications »,
  et choix des catégories. Sur iPhone (iOS 16.4+), l'application doit être ajoutée à l'écran d'accueil
  et ouverte depuis l'icône.
- Événements : transactions, offres reçues/acceptées/refusées, échange à approuver (commissaire),
  joueurs mis au ballottage et résultat, agents libres réclamés, loterie, début du repêchage, « c'est ton
  tour », chaque sélection, ouverture et dévoilement des listes de protection, tour du chapeau / 4 points /
  blanchissage d'un joueur du pool, changement de meneur au classement.
- Planifiées (heure de l'Est) : rappel la veille et le jour de la date limite des transactions,
  rappel aux équipes qui n'ont pas remis leur liste de protection, « dernière chance » 2 h avant la fin
  d'un ballottage, alerte quand ton alignement n'est plus conforme (plafond, plancher, positions ;
  une fois par jour, sauf pendant l'entre-saison), récap d'hier soir à 7 h et avis quand un joueur du pool change d'équipe dans la LNH.
- **🗞️ Récap d'hier soir** (7 h, dès que tous les matchs de la veille sont compilés, au plus tard à 11 h) :
  une notification par pooler avec sa soirée (points, rang, mouvement, meilleurs joueurs), puis les
  manchettes : nouveau meneur, tours du chapeau, soirées de 4 points et plus, blanchissages, poolers
  qui grimpent ou glissent au classement, pooler de la soirée, victoires écrasantes (4 buts d'écart)
  et toujours le résultat du CH. Le récap est aussi publié sur le mur de la gang.

- **⚙️ Réglages** (roue en haut de l'écran, ou Plus → Réglages) : mon équipe (logo, nom de l'équipe, prénom du
  pooler affiché à côté du nom ; le commissaire choisit l'équipe à modifier), apparence et page d'ouverture,
  notifications de ce téléphone, sons (sirène des transactions, sons du repêchage, son de la ligue pour le
  commissaire), compte (changer de compte, se déconnecter) et application (version, recharger).
- **Apparence** (Réglages → Apparence) : Auto (suit le mode clair ou sombre du téléphone), Clair ou Sombre.
  Nouveau look : cartes arrondies, gros titres, onglets en pilule, photo officielle de chaque joueur dans
  les listes (pastille de position), en-tête de l'équipe aux couleurs du pool.
- **Logo d'équipe** (bouton « 🎨 Logo » sur la page de son équipe) : chandail, bâton, patins, casque,
  rondelle ou bière, trois couleurs au choix et deux lettres. Le commissaire peut le changer pour n'importe
  quelle équipe. Il apparaît partout : classement, équipes, mur, marché, tableau du repêchage, choix de
  repêchage et onglet « Mon équipe ». Sans choix, chaque équipe a un chandail aux couleurs tirées de son nom.
- **Classement en cartes** : logo, rang, points de la saison et du jour (en direct), joueurs qui ont joué
  ou jouent aujourd'hui. **Joueurs** et **alignements** : photo, nom, position et équipe, propriétaire, puis
  les stats en colonnes (rang, âge, salaire, buts ou victoires, points, points par match).
- **Choix de repêchage** : en bas de chaque équipe, tableau des choix par saison (ronde, propriétaire
  d'origine). Page Choix de repêchage : par équipe, par ronde, choix échangés et historique.
- **📝 Contrats** (Commissaire → Contrats) : coller une liste copiée de PuckPedia ou d'un tableur, une ligne
  par joueur (nom, salaire AAV, fin du contrat, dans n'importe quel format : « $12,500,000 », « 7.5M »,
  « 2027-28 » ou « 2028 » ; l'équipe LNH en plus pour les homonymes). Aperçu avant d'appliquer : changé,
  identique, à vérifier (salaire inhabituel, non coché d'office), introuvable, ambigu. Liste des contrats à
  surveiller (échus ou fin inconnue) avec un bouton pour copier les noms. Chaque 1er juillet, les poolers et
  le commissaire sont avisés des contrats échus. La LNH ne publie pas les salaires : ils viennent de PuckPedia.
- **Salaires de référence** (`data/salaires-reference.json`, tirés de la liste Fantrax des 8 504 joueurs
  disponibles) : tout joueur sans salaire en reçoit un au démarrage et après chaque mise à jour des stats
  (nouveaux joueurs LNH compris). Un salaire déjà enregistré n'est jamais remplacé.
- **Âge** : calculé chaque jour à partir de la date de naissance officielle de tous les joueurs de la LNH
  (rapports « bios » de la LNH, relus chaque semaine).
- **🔊 Sons** (Réglages → Sons) : de vrais enregistrements libres de droits (orgue à tuyaux joué note par note,
  klaxon de but et foule, klaxon à air, sifflet de l'arbitre, corne de paquebot, traversier, train, locomotive à
  vapeur, passage à niveau, sirène à manivelle, feux d'artifice…), préparés en MP3 dans `public/sounds`
  (crédits dans `public/sounds/CREDITS.txt` et dans l'application ; script : `tools/studio-sons.py`).
  Chaque pooler choisit sa sirène, ou met son propre fichier (gardé sur son téléphone seulement).
- **Fiche du joueur** (toucher un joueur) : en-tête aux couleurs de son équipe avec sa photo, son numéro,
  son rang à sa position et ses points de pool ; boutons ronds (offre, marché, libérer, réclamer, ma liste) ;
  onglets Aperçu (rapport de blessure, dernières nouvelles et analyse, stats de la saison, 5 derniers
  matchs avec tirs et temps de glace, forme, contrat), Stats, Carrière et Gestion (commissaire).
  Données de la fiche LNH du joueur (api-web.nhle.com), gardées 3 h en mémoire.
- **❌ Blessures** : rapport des blessés de la LNH (flux public d'ESPN, relu aux 2 heures ; bouton
  « Mettre à jour les blessures » dans Commissaire). X rouge à côté du joueur (orange : au jour le jour),
  durée en français (absence indéterminée, absent 4 semaines, pour la saison, retour prévu…), partie du
  corps et, dans la fiche, le commentaire d'origine. Nombre de blessés sur la page de chaque équipe.
  Le propriétaire est avisé quand un de ses joueurs se blesse, que la durée change ou qu'il revient.

## Âge, recrues et projections

- **Âge moyen** de chaque équipe (date de naissance de NHL.com, sinon l'âge saisi), rang de la plus jeune,
  et tri « plus jeunes / plus vieilles » dans Équipes.
- **Recrues** : étiquettes « 🍼 Recrue ⚡ » (recrue LNH de la saison, protection automatique possible,
  art. 4.3.1) et « Recrue 2e an ⚡ » (art. 4.3.3), d'après l'historique LNH rafraîchi chaque semaine.
  « ≤ 39 PJ ⚡ » (art. 4.3.2) s'affiche seulement pendant la période de protection.
- **Projections** (Plus → 🔮) : copies de son alignement pour une saison future (1 à 5 ans), privées.
  Salaire = AAV si le joueur est encore sous contrat cette saison-là, sinon « contrat échu » (0 $)
  tant qu'on n'inscrit pas un salaire estimé. Plafond de l'année (113,5 M$ en 2027-28, puis estimé,
  modifiable), conformité, âge de chaque joueur cette saison-là. On peut ajouter n'importe quel joueur.
  Section « Recrues protégées automatiquement » : recrues (4.3.1) et recrues de 2e année (4.3.3) qui se
  protégeront avant cette saison, les 3 retenues selon l'art. 4.3.4, et un bouton pour ajouter celles
  de son équipe qui manquent dans la projection. Pour la saison suivante, les recrues d'aujourd'hui
  deviennent des recrues de 2e année ; les joueurs encore sans match LNH sont des recrues « possibles ».

## La vie de la gang

- **💬 Mur de la gang** (Plus) : messages, réactions 🍺🔥😂🤦🚨👑. Les transactions, agents libres
  réclamés, résultats de ballottage, trophées et champions y sont publiés automatiquement.
  Chaque nouveau message est envoyé aux téléphones (sauf à son auteur) ; l'auteur est avisé des réactions.
- **📣 Marché des transactions** (Échanges ou Plus) : chaque pooler y met les joueurs qu'il est prêt à échanger,
  avec une note (ce qu'il demande), et écrit ce qu'il cherche. La gang est avisée d'un nouveau joueur
  sur le marché. « 👀 Intéressé » avise le propriétaire sans dire qui (rumeur) ; « Faire une offre » ouvre
  une offre avec le joueur déjà ajouté. Un joueur échangé ou libéré quitte le marché tout seul.
  Les joueurs sur le marché portent l'étiquette 📣 partout dans l'application.
- Les catégories de notifications ajoutées après l'abonnement d'un téléphone sont activées d'office ;
  chacun peut les décocher dans 🔔 Notifications.
- **🏅 Trophées de la semaine** : pooler et joueur de la semaine (lundi au dimanche, tous les points de
  l'alignement), plus deux votes de la gang (coup de la semaine, pire transaction). Décernés chaque
  lundi, publiés sur le mur, gardés au palmarès.
- **🏆 Temple de la renommée — historique** (`data/historique.json`) : saisons et séries depuis 2020-21,
  compilées des publications du groupe Facebook (podiums, bourses, classements complets, résumés des
  séries) et palmarès par pooler (un même pooler sous ses surnoms : Archy = Simon Archambault, etc.).
  Modifier le fichier et augmenter « version » pour recharger l'historique.
- **🏆 Temple de la renommée** : podium de la saison et des séries (bouton « Clôturer la saison » du
  commissaire, avec les bourses), entrées manuelles pour les saisons passées, et records calculés
  (meilleur match d'un joueur, plus gros échange, pooler le plus actif, meilleure semaine).
- **🔥 / 🧊 Forme** : à côté du nom des joueurs (5 pts ou plus à ses 5 derniers matchs / aucun point),
  et graphique des 10 derniers matchs dans la fiche du joueur.

## Développement local

```bash
npm install
DATABASE_URL=postgres://postgres@127.0.0.1:5432/pool COMMISSAIRE_CODE=test npm start
npm test   # tests des règles (pointage, masse salariale, égalités)
```
