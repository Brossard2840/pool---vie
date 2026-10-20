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

## Développement local

```bash
npm install
DATABASE_URL=postgres://postgres@127.0.0.1:5432/pool COMMISSAIRE_CODE=test npm start
npm test   # tests des règles (pointage, masse salariale, égalités)
```
