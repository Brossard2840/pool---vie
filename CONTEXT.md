# Pool à vie — contexte de transfert vers Claude Code

Ce document résume tout ce qui a été établi dans une longue conversation Claude.ai, pour
reprendre le développement de `pool-webapp` dans Claude Code sans perdre le contexte.
L'utilisateur est Andy Brossard, commissaire/GM d'une ligue de hockey fantasy dynastie
de 13 équipes ("Pool à vie"), anciennement gérée sur Fantrax, en train de migrer vers un
logiciel maison.

## 1. Structure de la ligue

13 équipes (poolers) : **Andybros** (l'équipe d'Andy), Cabrera, Godino_01, Jaylab36,
JeromeSteMarie, Joel, LeFarmerr, Milesstemarie, Nicolas_A, Olivierarchambault66,
Packydou, RaphDaoust, Simon Archambault.

## 2. Règles de la convention collective

Le document original est inclus : `data/Convention_collective_pool_à_vie.pdf` —
c'est la source faisant autorité ; le résumé ci-dessous peut omettre des détails
(notamment la logique complète de pointage des séries et les règles de protection de
l'article 4).

- **Items par équipe** : 23 après le repêchage.
- **Minimums en tout temps** : 9 attaquants, 4 défenseurs, 2 gardiens.
- **Maximums** : le double du minimum (18 attaquants, 8 défenseurs, 4 gardiens).
- **Pointage saison régulière** : 1 pt/but, 1 pt/passe (patineurs) ; gardiens : 1 pt/but,
  1 pt/passe, 2 pts/victoire, 1 pt/défaite en prolongation ou fusillade, 1 pt bonus par
  blanchissage.
- **Pointage séries** : similaire mais sans point de défaite en prolongation ; les points
  des séries sont multipliés par ronde (x1 ronde 1, x1.5 ronde 2, x2 finale de conférence,
  x3 finale de la Coupe Stanley) — logique complexe pas encore implémentée dans le code.
- **Calcul du classement** : seuls les 9 attaquants, 4 défenseurs et 2 gardiens avec le
  PLUS de points comptent pour chaque équipe (format "best-ball").
- **Masse salariale** : calculée à partir des 9 attaquants, 4 défenseurs et 2 gardiens
  les MIEUX PAYÉS (AAV), peu importe s'ils comptent pour les points. Plafond = celui de
  la LNH en vigueur (Andy utilise 104 000 000 $, à ajuster chaque saison).
- **Plancher salarial** : celui de la LNH, doit aussi être respecté.
- **Protection avant repêchage** : chaque pooler protège 10 joueurs + jusqu'à 3 joueurs
  qui se protègent automatiquement (recrues selon critères stricts d'âge/matchs joués —
  voir convention complète, article 4.3). Pas encore implémenté dans le code.
- **Rétention salariale lors des transactions** : max 50 % du salaire, max 3 transactions
  par saison avec rétention, max 15 % du plafond retenu au total, max 2 transactions
  impliquant rétention par contrat. Pas implémenté.
- **Date limite des transactions** : 2 jours après celle de la LNH, jusqu'à 21h.

## 3. ⚠️ Leçons critiques sur la fiabilité des données salariales

**Toujours utiliser la ligne "AAV" de PuckPedia spécifiquement** — jamais le "Cap Hit",
le "Base Salary" ni le "Total Salary", qui varient d'une année à l'autre et ne
représentent pas la bonne valeur pour le calcul du plafond.

**Piège découvert plusieurs fois** : un joueur qui a signé une PROLONGATION dont le
nouveau contrat ne débute qu'une saison plus tard affichera souvent l'AAV du NOUVEAU
contrat dans des sources comme Fantrax ou même la fiche générale PuckPedia — il faut
vérifier le tableau détaillé saison par saison de PuckPedia pour confirmer quelle valeur
s'applique à la saison en cours. Joueurs touchés (et corrigés dans ce projet) : Lane
Hutson, Jackson LaCombe, Jason Robertson, Dustin Wolf, Sergei Bobrovsky (a aussi changé
d'équipe : FLA → TOR), Filip Gustavsson, Jacob Markstrom, Jet Greaves, Jakub Dobes.

**État actuel (important)** : la conversation a eu lieu à cheval sur le changement de
saison. Les 7 premiers joueurs listés ci-dessus ont déjà été mis à jour vers leur
NOUVEAU contrat, maintenant applicable (saison 2026-27). `data/roster-162.json`
reflète cet état à jour.

**Sources de données utilisées** :
- PuckPedia (puckpedia.com) — AAV, dates d'échéance de contrat, équipe LNH, âge.
- Export CSV Fantrax (deux versions utilisées) :
  - Un export filtré "Status=FA" (agents libres seulement, ~8500 joueurs) — utilisé
    comme liste de joueurs disponibles au repêchage, colonnes : ID, Player, Team,
    Position, Rookie, RkOv, Status, Age, Opponent, Salary, FPts, FP/G, %D, ADP, Ros, +/-.
    Le champ Salary est en MILLIERS (multiplier par 1000 pour obtenir l'AAV réel).
  - Un export SANS le filtre FA — contient les joueurs déjà possédés par les poolers
    (Team, Age, Salary), mais aucun gardien (tous absents de cet export pour une raison
    inconnue — les 21 gardiens de la ligue ont dû être vérifiés individuellement sur
    PuckPedia).
- `data/roster-162.json` contient déjà le résultat final combiné et vérifié.

## 4. Logiciels construits jusqu'ici

### A. `data/pool-draft-reference.html` — prototype complet (autonome, Claude.ai)

Fichier HTML unique utilisant l'API `window.storage` des artefacts Claude.ai pour la
persistance. **Fonctionnalités à porter vers pool-webapp si pas déjà fait** :

- **Repêchage** : recherche/filtre, assignation d'un joueur à une équipe.
- **Mon équipe** : vue détaillée par position (actif vs réserve selon le plafond),
  **calculateur de salaire maximum par position** (tient compte de l'espace sous le
  plafond + réserve pour les postes vacants ailleurs + valeur du joueur qui serait
  poussé en réserve), champs éditables (équipe LNH, fin de contrat, statut recrue),
  recherche pour ajouter/retirer un joueur directement.
- **Ma liste** : liste personnelle de cibles de repêchage, séparée par position
  (attaquants/défenseurs/gardiens), avec âge affiché, réordonnable (↑↓), joueurs déjà
  pris affichés en grisé. **Déjà portée dans pool-webapp** (table `my_draft_list`).
- **Équipes** : vue de toutes les équipes de la ligue.
- **Simulations** : dupliquer l'alignement actuel d'Andybros et tester des scénarios
  (ajout/retrait de joueurs) sans toucher au vrai repêchage ; plusieurs simulations
  nommées possibles. **Pas encore portée dans pool-webapp.**
- **Classement** : calcul des points par équipe (format best-ball top 9/4/2).
- **Réglages** : gestion des équipes, plafond, import de joueurs en masse, import
  d'alignement complet (équipe+joueur+position+AAV+âge+contrat), mise à jour manuelle
  des statistiques, réinitialisation.

**Limitation qui a motivé la migration vers pool-webapp** : le stockage `window.storage`
ne semble pas survivre de façon fiable aux régénérations successives du fichier par
Claude — plusieurs pertes de données ont été observées (la liste de joueurs du
repêchage, puis "Ma liste" à deux reprises), malgré des mécanismes de "seed" one-shot
pour reconstruire automatiquement les données connues (équipes, joueurs, AAV, contrats,
âge) à partir de constantes codées en dur dans le fichier. Les données purement
dynamiques entrées par l'utilisateur (Ma liste, Simulations) n'ont aucun filet de
sécurité de ce genre — d'où la décision de migrer vers une vraie base de données.

### B. `pool-webapp/` — la cible permanente (Node.js + Express + PostgreSQL)

**Statut de déploiement : PAS ENCORE DÉPLOYÉ.** Andy était rendu à l'étape 1 (créer le
repo GitHub) au moment du transfert vers Claude Code. Voir `README.md` pour le guide
complet (GitHub → Supabase → Render, tout gratuit).

**Schéma de base de données (PostgreSQL)** :
- `teams(id, name)`
- `players(id, name, nhl_team, pos, aav, age, contract_end, goals, assists, last_updated)`
- `picks(player_id → team_id)` — un joueur = un pick, unique par joueur
- `config(key, value)` — stocke `cap` et `last_stats_update`
- `my_draft_list(position, player_id)` — la liste personnelle d'Andy (pas de notion
  multi-utilisateur pour l'instant, une seule liste globale)

**Endpoints API déjà construits** : `/api/state`, `/api/teams` (POST/DELETE),
`/api/cap`, `/api/players` (POST, et `/import` en masse), `/api/roster/import` (import
complet équipe+joueur+choix en une fois), `/api/pick`, `/api/release`, `/api/reset`,
`/api/standings`, `/api/stats/refresh`, `/api/mylist` (GET/add/remove/reorder).

**Mise à jour automatique des statistiques** : récupère TOUTES les statistiques de la
LNH en 2 appels groupés (`api.nhle.com/stats/rest/en/skater/summary` et
`/goalie/summary`, filtré par `seasonId` et `gameTypeId=2`), apparie par nom normalisé
(sans accents/majuscules). Tourne via `node-cron` tous les jours à 6h, PLUS un filet de
sécurité qui relance la mise à jour si elle date de plus de 24h, déclenché par n'importe
quelle requête entrante (utile si le service Render gratuit dormait à l'heure prévue).
**`SEASON_ID` dans les variables d'environnement Render doit être ajusté chaque saison**
(format AAAAAAAA, ex. 2026-27 = `20262027`).

**Pas encore porté depuis pool-draft-reference.html** : la vue "Mon équipe" détaillée
(actif/réserve, calculateur de salaire max, champs éditables), les Simulations, le
système de statut recrue, l'affichage des métriques Fantrax bonus (FPts, ADP, etc. —
déjà en partie dans les données si réimportées depuis `pool-draft-reference.html`).

## 5. Fichiers inclus dans ce transfert

- `server.js`, `package.json`, `public/index.html`, `README.md` — le code actuel de
  pool-webapp, prêt à déployer.
- `data/roster-162.json` — les 13 équipes et 162 joueurs avec AAV/équipe LNH/âge/fin de
  contrat déjà vérifiés et à jour (saison 2026-27 pour les contrats concernés).
- `data/webapp-import-roster.txt` — la même donnée déjà formatée pour l'import en masse
  (`ÉquipePool;Nom;Position;AAV;Âge;FinContrat`), à coller directement dans
  Réglages → "Importer un alignement complet" une fois le site déployé.
- `data/pool-draft-reference.html` — le prototype complet, à garder comme référence
  pour porter les fonctionnalités manquantes (Mon équipe détaillé, Simulations, etc.).

## 6. Prochaines étapes suggérées

1. Terminer le déploiement (GitHub → Supabase → Render) selon `README.md`.
2. Importer `data/webapp-import-roster.txt` une fois le site en ligne.
3. Porter la vue "Mon équipe" détaillée et les Simulations depuis
   `data/pool-draft-reference.html` vers `pool-webapp`.
4. Implémenter le système de protection pré-repêchage (article 4 de la convention) et
   la logique de pointage des séries éliminatoires pondérée par ronde (article 7.2).
5. Mettre à jour `SEASON_ID` chaque saison et revalider les AAV via PuckPedia au besoin.

## 7. Mise à jour — session Claude Code du 2026-10-20

Le repêchage 2026 a eu lieu ; la saison 2026-27 est en cours. Plafond 104 M$, plancher 76,9 M$
(NHLPA, 6 mai 2026).

Refait dans cette session :
- **Connexion** : un code d'accès par équipe (généré par le commissaire, haché en base), session
  dans un témoin signé valide 1 an. Le commissaire (Andybros) entre avec `COMMISSAIRE_CODE`.
  Les poolers consultent tout et gèrent leur propre « Ma liste » ; les mouvements de joueurs
  (ajout, libération, échange, fiches) sont réservés au commissaire et inscrits à l'historique.
- **Stats** : pointage complet des gardiens (V ×2, DP, BL), liaison par identifiant LNH,
  catalogue de tous les joueurs LNH, mise à jour aux 20 min + `/healthz` pour un service de réveil.
- **Règles** dans `lib/rules.js` (testées dans `test/`) : best-ball 9/4/2, masse 9/4/2 mieux payés,
  min/max par position, plancher, salaire max ajoutable par position, égalités (pt/match puis buts).
- **Interface mobile** installable (PWA) : Classement, Mon équipe, Équipes, Joueurs, Plus
  (Ma liste, Historique, Commissaire avec codes, import, échange avec aperçu de conformité).

Reste à faire : listes de protection (art. 4), ordre de repêchage et loterie (4.4), choix de
repêchage échangeables (4.6), retenues salariales (5.3), ballottage et priorité (5.5-5.6),
séries pondérées par ronde (7.2), Simulations.
