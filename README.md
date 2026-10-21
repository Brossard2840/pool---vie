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

Le forfait gratuit de Render inclut 750 heures par mois, assez pour un site allumé en permanence.
Les visites régulières empêchent aussi Supabase de mettre le projet en pause (pause après 7 jours sans activité).

## Étape 5 — Configurer la ligue

1. Ouvrez le site, choisissez **Andybros** et entrez votre `COMMISSAIRE_CODE`.
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

## Développement local

```bash
npm install
DATABASE_URL=postgres://postgres@127.0.0.1:5432/pool COMMISSAIRE_CODE=test npm start
npm test   # tests des règles (pointage, masse salariale, égalités)
```
