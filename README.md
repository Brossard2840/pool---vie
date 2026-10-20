# Pool à vie — Guide de mise en ligne (gratuit)

Cette application a 3 pièces :
1. **Le code** (déjà prêt, dans ce dossier) — le site que tout le monde va utiliser.
2. **Une base de données gratuite** (Supabase) — où sont stockés les joueurs, équipes et choix.
3. **Un hébergement gratuit** (Render) — le "serveur toujours allumé" qui fait tourner le code
   et met les statistiques à jour automatiquement chaque jour.

Comptez environ 20-30 minutes la première fois. Vous n'aurez plus jamais à refaire ça ensuite.

---

## Étape 1 — Mettre le code sur GitHub

1. Allez sur [github.com](https://github.com) et créez un compte gratuit si vous n'en avez pas.
2. Cliquez **New repository**. Nommez-le `pool-a-vie`. Laissez-le "Public" ou "Private" (les
   deux fonctionnent). Cliquez **Create repository**.
3. Sur la page du nouveau dépôt, cliquez **uploading an existing file**.
4. Glissez-déposez TOUS les fichiers de ce dossier (`server.js`, `package.json`, `README.md`,
   et le dossier `public` avec `index.html` dedans — gardez la structure de dossiers).
5. Cliquez **Commit changes**.

## Étape 2 — Créer la base de données (Supabase, gratuit)

1. Allez sur [supabase.com](https://supabase.com), créez un compte gratuit.
2. Cliquez **New project**. Donnez-lui un nom (ex. `pool-a-vie`) et un mot de passe
   (notez-le quelque part, vous en aurez besoin dans une minute).
3. Attendez ~2 minutes que le projet soit prêt.
4. Dans le menu de gauche : **Project Settings** (roue dentée) → **Database**.
5. Sous "Connection string", choisissez l'onglet **URI**. Copiez le lien — il ressemble à :
   `postgresql://postgres:[VOTRE-MOT-DE-PASSE]@db.xxxxx.supabase.co:5432/postgres`
6. Remplacez `[VOTRE-MOT-DE-PASSE]` par le mot de passe choisi à l'étape 2. Gardez ce lien
   de côté — c'est votre `DATABASE_URL`.

## Étape 3 — Héberger le site (Render, gratuit)

1. Allez sur [render.com](https://render.com), créez un compte gratuit (vous pouvez vous
   connecter directement avec votre compte GitHub, c'est plus simple).
2. Cliquez **New** → **Web Service**.
3. Connectez votre dépôt GitHub `pool-a-vie`.
4. Réglages :
   - **Name** : `pool-a-vie` (ou ce que vous voulez)
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
5. Descendez à **Environment Variables**, cliquez **Add Environment Variable** deux fois :
   - `DATABASE_URL` = le lien copié à l'étape 2
   - `SEASON_ID` = `20252026` (à changer chaque saison — voir plus bas)
6. Cliquez **Create Web Service**. Render installe et démarre le site (2-5 minutes).
7. Une fois prêt, Render vous donne une adresse comme `https://pool-a-vie.onrender.com` —
   **c'est le lien à partager avec tous vos poolers.**

## Étape 4 — Configurer votre ligue

1. Ouvrez le lien de votre site.
2. Onglet **Réglages** : ajoutez vos 11-14 équipes (une à la fois).
3. Ajustez le plafond salarial si besoin.
4. Onglet **Réglages → Import en masse** : collez votre liste de joueurs au format
   `Nom;Équipe;Position;AAV` (une ligne par joueur).
5. Onglet **Repêchage** : c'est parti — chaque choix est visible par tous en quelques
   secondes.

---

## Comment fonctionne la mise à jour automatique des stats

Le site va chercher les statistiques de toute la LNH une fois par jour (vers 6h du matin)
via l'API publique de la LNH, sans que personne n'ait besoin de rien faire. En plus, chaque
fois que quelqu'un visite le site, il vérifie si les stats datent de plus de 24h et les
rafraîchit au besoin — un filet de sécurité utile si le serveur gratuit s'était mis en
pause. Un bouton **"Rafraîchir maintenant"** est aussi disponible dans l'onglet Classement.

## À savoir sur le forfait gratuit de Render

Le service gratuit se met en pause après ~15 minutes sans visite, et prend 20-30 secondes
à se réveiller à la prochaine visite (c'est normal, pas un bris). Si ça devient gênant en
pleine saison, un forfait payant (~7 $US/mois) élimine complètement cette pause — à évaluer
selon vos besoins.

## Changer la saison l'an prochain

Dans Render, allez dans **Environment**, changez `SEASON_ID` pour la nouvelle saison
(format AAAAAAAA, ex. 2026-2027 → `20262027`), puis redéployez (Render le fait
automatiquement après un changement de variable d'environnement).

## Si les statistiques ne se mettent pas à jour (0 joueur trouvé)

L'API publique de la LNH peut changer légèrement ses noms de champs avec le temps.
Dans Render, onglet **Logs**, cherchez la ligne "Stats mises à jour". Si elle indique
beaucoup de joueurs "manquants", copiez-collez-moi ce message dans la conversation et
je corrige le code du serveur.
