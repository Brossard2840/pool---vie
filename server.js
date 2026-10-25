require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const rules = require('./lib/rules');
const nhl = require('./lib/nhl');
const auth = require('./lib/auth');
const { createLive, addDays } = require('./lib/live');
const { registerTrades } = require('./lib/trades');
const { createWaivers } = require('./lib/waivers');
const { createProtection, categories } = require('./lib/protection');
const { createPlayoffs } = require('./lib/playoffs');
const { createDraft } = require('./lib/draft');
const { createNotify } = require('./lib/notify');
const { createReminders } = require('./lib/reminders');
const { createProjections } = require('./lib/projections');
const { createFun } = require('./lib/fun');
const { createBlock } = require('./lib/block');
const { createInjuries } = require('./lib/injuries');
const { createPasskeys } = require('./lib/passkeys');
const { createContracts } = require('./lib/contracts');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
// Marque nos réponses : le service worker ne garde en cache que les vraies pages de l'app,
// jamais l'écran d'attente de Render pendant que le serveur se réveille.
app.use((req, res, next) => { res.set('X-Pool-App', '1'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
if (IS_PROD && !process.env.DATABASE_URL) {
  console.error('ERREUR : la variable DATABASE_URL est absente. Ajoutez-la dans Render → Environment ' +
    '(adresse « Session pooler » de Supabase), puis redéployez.');
  process.exit(1);
}
// DATABASE_PASSWORD (optionnel) remplace le mot de passe de l'adresse : on peut alors coller
// l'adresse de Supabase telle quelle, avec [YOUR-PASSWORD], et mettre le mot de passe à part.
function databaseUrl() {
  const raw = (process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/pool').trim();
  const pw = process.env.DATABASE_PASSWORD;
  if (!pw) return raw;
  const u = new URL(raw.replace(/\[YOUR-PASSWORD\]/i, 'x'));
  u.password = encodeURIComponent(pw.trim());
  return u.toString();
}
const DATABASE_URL = databaseUrl();

// Résumé de connexion sans révéler le mot de passe (aide au dépannage).
function describeDb(url) {
  try {
    const u = new URL(url);
    const pw = decodeURIComponent(u.password || '');
    return `hôte ${u.hostname}, port ${u.port || 5432}, utilisateur ${decodeURIComponent(u.username)}, ` +
      `mot de passe ${pw.length} caractère(s)${process.env.DATABASE_PASSWORD ? ' (variable DATABASE_PASSWORD)' : ' (dans DATABASE_URL)'}` +
      `${/\s/.test(pw) ? ', CONTIENT UNE ESPACE' : ''}${/[\[\]]/.test(pw) ? ', CONTIENT DES CROCHETS' : ''}`;
  } catch { return 'adresse illisible'; }
}
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 20);
let SECRET = process.env.SESSION_SECRET || null;

const h = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---------- Base de données ----------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams(
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      code_hash TEXT,
      code_version INT NOT NULL DEFAULT 1,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS players(
      id SERIAL PRIMARY KEY,
      nhl_id INT UNIQUE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      nhl_team TEXT,
      pos TEXT NOT NULL CHECK (pos IN ('F','D','G')),
      aav BIGINT,
      age INT,
      contract_end INT,
      rookie BOOLEAN NOT NULL DEFAULT FALSE,
      stats_season TEXT,
      gp INT NOT NULL DEFAULT 0,
      goals INT NOT NULL DEFAULT 0,
      assists INT NOT NULL DEFAULT 0,
      wins INT NOT NULL DEFAULT 0,
      ot_losses INT NOT NULL DEFAULT 0,
      shutouts INT NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS players_name_key ON players(name_key);
    CREATE TABLE IF NOT EXISTS picks(
      player_id INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS config(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS watchlist(
      team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      position INT NOT NULL,
      PRIMARY KEY (team_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS moves(
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      player_id INT REFERENCES players(id) ON DELETE SET NULL,
      player_name TEXT,
      from_team TEXT,
      to_team TEXT,
      kind TEXT,
      note TEXT,
      by_team TEXT
    );
  `);
  await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS avatar JSONB`);
  await pool.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS owner_name TEXT`);
  await live.initTables();
  await trades.initTables();
  await waivers.initTables();
  await protection.initTables();
  await draft.initTables();
  await notifier.initTables();
  await projections.initTables();
  await fun.initTables();
  await block.initTables();
  await injuries.initTables();
  await passkeys.initTables();
  await setDefault('cap', '104000000');   // plafond LNH 2026-27
  await setDefault('floor', '76900000');  // plancher LNH 2026-27

  if (!SECRET) {
    // Clé de signature des sessions, générée une fois et conservée dans la base.
    await setDefault('session_secret', crypto.randomBytes(32).toString('hex'));
    SECRET = await getConfig('session_secret');
  }

  // Le commissaire : son code vient de la variable d'environnement COMMISSAIRE_CODE.
  // Le compte commissaire est neutre : il n'a pas d'équipe. Chaque pooler (le commissaire aussi) gère
  // son équipe avec le code de son équipe. Plusieurs personnes peuvent être connectées en même temps.
  const adminCode = (process.env.COMMISSAIRE_CODE || '').trim();
  if (adminCode) {
    const stored = await getConfig('commissaire_hash');
    if (!stored || !auth.checkCode(adminCode, stored)) {
      await setConfig('commissaire_hash', auth.hashCode(adminCode));
      await setConfig('commissaire_version', Number(await getConfig('commissaire_version', 0)) + 1);
    }
    await pool.query(`UPDATE teams SET is_admin=FALSE WHERE is_admin`);
    console.log(`Commissaire prêt (compte neutre, code de ${adminCode.length} caractère(s)).`);
  } else {
    console.warn('ATTENTION : la variable COMMISSAIRE_CODE est vide ou absente — personne ne peut se connecter. ' +
      'Ajoutez-la dans Render → Environment, puis redéployez.');
  }
}

async function getConfig(key, fallback = null) {
  const { rows } = await pool.query(`SELECT value FROM config WHERE key=$1`, [key]);
  return rows[0] ? rows[0].value : fallback;
}
async function setConfig(key, value) {
  await pool.query(`INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, String(value)]);
}
async function setDefault(key, value) {
  await pool.query(`INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING`, [key, value]);
}
async function seasonId() {
  return (await getConfig('season_id')) || process.env.SEASON_ID || rules.currentSeasonId();
}
async function leagueConfig() {
  return {
    cap: Number(await getConfig('cap', 104000000)),
    floor: Number(await getConfig('floor', 0)),
    seasonId: await seasonId(),
    lastUpdate: await getConfig('last_stats_update'),
    lastResult: JSON.parse((await getConfig('last_stats_result')) || 'null'),
    refreshMinutes: REFRESH_MINUTES,
    lastLive: await getConfig('last_live_sync'),
    hornVersion: await getConfig('horn_version'),
    liveReady: (await getConfig('log_season')) === (await seasonId())
  };
}

// ---------- Statistiques LNH ----------

// En direct : sommaires de match (voir lib/live.js). Une fois la saison rattrapée, ce sont eux
// qui donnent les totaux ; le rapport de saison ne sert plus qu'au catalogue des joueurs.
let notifier = null; // créé plus bas, une fois les routes protégées par la connexion
const notify = n => {
  // Les transactions, réclamations et résultats de ballottage s'affichent aussi sur le mur de la gang (avec réactions).
  if (fun && n.dedupe && (n.kind === 'trade' || n.kind === 'freeagent' || (n.kind === 'waiver' && n.dedupe.endsWith(':done') && n.title.includes('réclamé'))))
    fun.autoPost(`${n.title}\n${n.body || ''}`, n.link, 'wall:' + n.dedupe).catch(() => {});
  if (fun && n.kind === 'freeagent' && !n.dedupe) fun.autoPost(`${n.title}\n${n.body || ''}`, n.link, 'wall:fa:' + n.title).catch(() => {});
  return notifier ? notifier.notify(n) : null;
};
let fun = null;
const live = createLive(pool, { getConfig, setConfig, seasonId: () => seasonId(),
  onUpdated: async () => { await linkUnlinked(); await checkLeader(); }, onGame: (...a) => gameHighlights(...a) });

// Exploits des joueurs du pool pendant les matchs d'hier et d'aujourd'hui (pas lors du rattrapage de la saison).
async function gameHighlights(gameId, game, rows) {
  if (!game.game_date || String(game.game_date) < addDays(live.todayET(), -1)) return;
  const ids = rows.map(r => r.nhl_id);
  const { rows: owned } = await pool.query(`
    SELECT p.nhl_id, p.name, t.name AS team, t.id AS team_id FROM players p JOIN picks pk ON pk.player_id=p.id JOIN teams t ON t.id=pk.team_id
    WHERE p.nhl_id = ANY($1::int[])`, [ids]);
  const final = ['FINAL', 'OFF'].includes(game.state);
  for (const o of owned) {
    const r = rows.find(x => x.nhl_id === o.nhl_id);
    const pts = r.goals + r.assists;
    if (r.goals >= 3) notify({ kind: 'highlight', title: `🎩 TOUR DU CHAPEAU pour ${o.name} !`, body: `${r.goals} buts ce soir — gros soir pour ${o.team}.`, link: '#/direct', dedupe: `hl:${gameId}:${o.nhl_id}:hat` });
    else if (pts >= 4) notify({ kind: 'highlight', title: `🔥 ${o.name} : ${pts} points ce soir !`, body: `${r.goals} B, ${r.assists} A pour ${o.team}.`, link: '#/direct', dedupe: `hl:${gameId}:${o.nhl_id}:4pts` });
    if (final && r.shutouts) notify({ kind: 'highlight', title: `🧱 Blanchissage de ${o.name} !`, body: `3 points pour ${o.team}.`, link: '#/direct', dedupe: `hl:${gameId}:${o.nhl_id}:so` });
  }
}

// Changement de meneur au classement.
async function checkLeader() {
  const { teams } = await buildLeague();
  if (!teams.length || !teams[0].points) return;
  const prev = await getConfig('leader_id');
  if (String(teams[0].id) === prev) return;
  await setConfig('leader_id', teams[0].id);
  if (prev) notify({ kind: 'standings', title: `👑 ${teams[0].name} prend la 1re place !`, body: `${teams[0].points} pts, devant ${teams[1]?.name || ''} (${teams[1]?.points ?? 0} pts).`,
    link: '#/classement', dedupe: `leader:${teams[0].id}:${new Date().toISOString().slice(0, 13)}` });
}

// Relie les joueurs du pool sans identifiant LNH à une fiche du catalogue (même nom, position, équipe).
async function linkUnlinked() {
  const { rows: unlinked } = await pool.query(`SELECT id, name_key, pos, nhl_team FROM players WHERE nhl_id IS NULL`);
  let n = 0;
  for (const p of unlinked) {
    let { rows: cands } = await pool.query(
      `SELECT id, nhl_id, pos, nhl_team FROM players WHERE name_key=$1 AND nhl_id IS NOT NULL AND id<>$2`, [p.name_key, p.id]);
    // Second recours : même nom de famille et même prénom une fois les diminutifs ramenés (Dan = Daniel).
    if (!cands.length) {
      const last = p.name_key.split(' ').slice(1).join(' ');
      if (last) {
        const { rows } = await pool.query(`SELECT id, nhl_id, name_key, pos, nhl_team FROM players
          WHERE name_key LIKE $1 AND nhl_id IS NOT NULL AND id<>$2`, ['% ' + last, p.id]);
        cands = rows.filter(r => rules.canonicalKey(r.name_key) === rules.canonicalKey(p.name_key));
        // Un diminutif ne suffit pas pour deviner : position identique exigée.
        if (p.pos) cands = cands.filter(r => r.pos === p.pos);
      }
    }
    const c = findCandidates(cands, p);
    if (c.length !== 1) continue;
    // La fiche LNH existe déjà au catalogue : on y transfère le salaire, le contrat et l'équipe du pool.
    try { await mergePlayers(p.id, c[0].id); n++; } catch (e) { console.warn(`Lien ${p.id} :`, e.message); }
  }
  return n;
}

// Relie les joueurs saisis à la main (sans identifiant LNH) à leur fiche LNH.
// On compare le nom, puis la position, puis l'équipe LNH pour les homonymes (ex. deux Sebastian Aho).
function findCandidates(list, { pos, nhl_team }) {
  let c = list;
  if (pos && c.length > 1) { const f = c.filter(x => x.pos === pos); if (f.length) c = f; }
  if (nhl_team && c.length > 1) { const f = c.filter(x => (x.nhl_team || '').toUpperCase() === nhl_team.toUpperCase()); if (f.length) c = f; }
  return c;
}

let refreshing = null;
async function refreshStats() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const season = await seasonId();
    const rows = await nhl.fetchSeason(season, 2);
    const keepStats = await live.isReady();
    if (!rows.length) {
      // Début de saison ou API indisponible : on ne remet rien à zéro.
      const result = { at: new Date().toISOString(), season, nhlPlayers: 0, linked: 0, unlinked: [] };
      await setConfig('last_stats_update', result.at);
      await setConfig('last_stats_result', JSON.stringify(result));
      await applyKnownSalaries().catch(e => console.warn('Salaires de référence :', e.message));
    return result;
    }

    const byKey = new Map(), byCanon = new Map();
    for (const r of rows) {
      r.name_key = rules.normalizeName(r.name);
      if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
      byKey.get(r.name_key).push(r);
      const ck = rules.canonicalKey(r.name_key);
      if (!byCanon.has(ck)) byCanon.set(ck, []);
      byCanon.get(ck).push(r);
    }
    const { rows: known } = await pool.query(`SELECT nhl_id FROM players WHERE nhl_id IS NOT NULL`);
    const usedIds = new Set(known.map(r => r.nhl_id));

    let linked = 0;
    const { rows: unlinkedPlayers } = await pool.query(
      `SELECT id, name, name_key, pos, nhl_team FROM players WHERE nhl_id IS NULL`);
    for (const p of unlinkedPlayers) {
      let pool1 = (byKey.get(p.name_key) || []).filter(r => !usedIds.has(r.nhl_id));
      // Diminutif (Dan / Daniel) : seulement à la même position.
      if (!pool1.length) pool1 = (byCanon.get(rules.canonicalKey(p.name_key)) || []).filter(r => !usedIds.has(r.nhl_id) && (!p.pos || r.pos === p.pos));
      const cands = findCandidates(pool1, p);
      if (cands.length === 1) {
        await pool.query(`UPDATE players SET nhl_id=$1 WHERE id=$2`, [cands[0].nhl_id, p.id]);
        usedIds.add(cands[0].nhl_id);
        linked++;
      }
    }

    // Mise à jour groupée de toute la ligue (les nouveaux joueurs LNH sont ajoutés au catalogue).
    await pool.query(`
      INSERT INTO players(nhl_id, name, name_key, nhl_team, pos, stats_season, gp, goals, assists, wins, ot_losses, shutouts, last_updated)
      SELECT r.nhl_id, r.name, r.name_key, r.nhl_team, r.pos, $2, r.gp, r.goals, r.assists, r.wins, r.ot_losses, r.shutouts, NOW()
      FROM json_to_recordset($1::json) AS r(nhl_id INT, name TEXT, name_key TEXT, nhl_team TEXT, pos TEXT,
        gp INT, goals INT, assists INT, wins INT, ot_losses INT, shutouts INT)
      ON CONFLICT (nhl_id) DO UPDATE SET
        nhl_team = CASE WHEN $3 THEN COALESCE(players.nhl_team, EXCLUDED.nhl_team) ELSE COALESCE(EXCLUDED.nhl_team, players.nhl_team) END,
        stats_season = CASE WHEN $3 THEN players.stats_season ELSE EXCLUDED.stats_season END,
        gp = CASE WHEN $3 THEN players.gp ELSE EXCLUDED.gp END,
        goals = CASE WHEN $3 THEN players.goals ELSE EXCLUDED.goals END,
        assists = CASE WHEN $3 THEN players.assists ELSE EXCLUDED.assists END,
        wins = CASE WHEN $3 THEN players.wins ELSE EXCLUDED.wins END,
        ot_losses = CASE WHEN $3 THEN players.ot_losses ELSE EXCLUDED.ot_losses END,
        shutouts = CASE WHEN $3 THEN players.shutouts ELSE EXCLUDED.shutouts END,
        last_updated = NOW()
    `, [JSON.stringify(rows), season, keepStats]);

    // Joueurs sans aucun match cette saison : stats à zéro (évite de traîner les stats de l'an passé).
    if (!keepStats) await pool.query(`
      UPDATE players SET gp=0, goals=0, assists=0, wins=0, ot_losses=0, shutouts=0, stats_season=$1
      WHERE stats_season IS DISTINCT FROM $1`, [season]);
    await linkUnlinked();

    const { rows: stillUnlinked } = await pool.query(`
      SELECT p.name, t.name AS team FROM players p JOIN picks pk ON pk.player_id=p.id
      JOIN teams t ON t.id=pk.team_id WHERE p.nhl_id IS NULL ORDER BY t.name, p.name`);
    const result = {
      at: new Date().toISOString(), season, nhlPlayers: rows.length, linked,
      unlinked: stillUnlinked.map(r => `${r.name} (${r.team})`)
    };
    await setConfig('last_stats_update', result.at);
    await setConfig('last_stats_result', JSON.stringify(result));
    console.log(`Stats mises à jour (${season}) : ${rows.length} joueurs LNH, ${linked} nouveau(x) lien(s), ` +
      `${result.unlinked.length} joueur(s) de pool sans fiche LNH${result.unlinked.length ? ' : ' + result.unlinked.join(', ') : ''}`);
    // Nouveaux joueurs LNH au catalogue : salaire de référence s'ils n'en ont pas.
    await applyKnownSalaries().catch(e => console.warn('Salaires de référence :', e.message));
    return result;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshIfStale() {
  if (refreshing) return;
  const last = await getConfig('last_stats_update');
  if (!last || Date.now() - new Date(last).getTime() > REFRESH_MINUTES * 60 * 1000) {
    refreshStats().catch(e => console.error('Mise à jour des stats échouée :', e.message));
  }
}

// ---------- Sessions ----------

app.use(h(async (req, res, next) => {
  req.me = null;
  const s = auth.getSession(req, SECRET);
  if (s?.admin) {
    if (String(s.av) === String(await getConfig('commissaire_version'))) req.me = { teamId: null, name: 'Commissaire', isAdmin: true };
  } else if (s) {
    const { rows } = await pool.query(`SELECT id, name, code_version FROM teams WHERE id=$1`, [s.teamId]);
    const t = rows[0];
    if (t && t.code_version === s.v) req.me = { teamId: t.id, name: t.name, isAdmin: false };
  }
  next();
}));

const requireLogin = (req, res, next) => req.me ? next() : res.status(401).json({ error: 'Connexion requise' });
// Gestes réservés à un pooler (le compte commissaire est neutre, sans équipe).
const TEAM_ONLY = [/^\/api\/watchlist\//, /^\/api\/block(\/needs|\/\d+\/interest)?$/, /^\/api\/wall\/\d+\/react$/, /^\/api\/awards\/vote$/,
  /^\/api\/projections/, /^\/api\/trades$/, /^\/api\/claims$/, /^\/api\/waivers\/\d+\/(un)?claim$/];
app.use((req, res, next) => {
  if (req.me && !req.me.teamId && req.method !== 'GET' && TEAM_ONLY.some(re => re.test(req.path)))
    return res.status(403).json({ error: 'Le compte commissaire est neutre : connecte-toi avec le code de ton équipe pour ça.' });
  next();
});
const requireAdmin = (req, res, next) => req.me?.isAdmin ? next() : res.status(403).json({ error: 'Réservé au commissaire' });

// Point d'entrée pour un service de « ping » externe : garde le serveur éveillé et les stats à jour.
app.get('/healthz', h(async (req, res) => {
  await refreshIfStale();
  live.tick().catch(e => console.error('Direct :', e.message));
  waivers.processDue().catch(e => console.error('Ballottage :', e.message));
  reminders.tick().catch(e => console.error('Rappels :', e.message));
  res.json({ ok: true, lastUpdate: await getConfig('last_stats_update'), lastLive: await getConfig('last_live_sync') });
}));

// Logo de l'équipe (chandail, casque, masque de gardien, filet…) et ses couleurs, choisis par le pooler (ou le commissaire).
const AVATAR_TYPES = ['chandail', 'casque', 'masque', 'patins', 'baton', 'gants', 'rondelle', 'filet', 'lumiere', 'coupe', 'ecusson', 'lys', 'surfaceuse', 'biere'];
app.post('/api/team/avatar', h(async (req, res) => {
  if (!req.me) return res.status(401).json({ error: 'Connexion requise' });
  const teamId = req.me.isAdmin && req.body.teamId ? Number(req.body.teamId) : req.me.teamId;
  if (!teamId) return res.status(400).json({ error: 'Choisis une équipe' });
  const a = req.body.avatar || {};
  const color = v => /^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : null;
  if (!AVATAR_TYPES.includes(a.type) || !color(a.c1) || !color(a.c2) || !color(a.c3)) return res.status(400).json({ error: 'Logo invalide' });
  const avatar = { type: a.type, c1: color(a.c1), c2: color(a.c2), c3: color(a.c3), letter: String(a.letter || '').trim().slice(0, 2).toUpperCase() };
  await pool.query(`UPDATE teams SET avatar=$2 WHERE id=$1`, [teamId, avatar]);
  res.json({ ok: true, avatar });
}));

// Profil de l'équipe (réglages) : nom de l'équipe et prénom du pooler. Le commissaire peut modifier n'importe quelle équipe.
app.post('/api/team/profile', h(async (req, res) => {
  if (!req.me) return res.status(401).json({ error: 'Connexion requise' });
  const teamId = req.me.isAdmin && req.body.teamId ? Number(req.body.teamId) : req.me.teamId;
  if (!teamId) return res.status(400).json({ error: 'Choisis une équipe' });
  const { rows: cur } = await pool.query(`SELECT name FROM teams WHERE id=$1`, [teamId]);
  if (!cur[0]) return res.status(404).json({ error: 'Équipe introuvable' });
  if (req.body.name !== undefined) {
    const name = String(req.body.name).replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 30) return res.status(400).json({ error: 'Nom d\'équipe : 2 à 30 caractères' });
    const { rows: dup } = await pool.query(`SELECT 1 FROM teams WHERE LOWER(name)=LOWER($1) AND id<>$2`, [name, teamId]);
    if (dup.length) return res.status(400).json({ error: 'Ce nom est déjà pris' });
    if (name !== cur[0].name) {
      await pool.query(`UPDATE teams SET name=$2 WHERE id=$1`, [teamId, name]);
      notify({ kind: 'wall', title: `🏷️ ${cur[0].name} s'appelle maintenant ${name}`, link: '#/classement', dedupe: `rename:${teamId}:${name}` });
    }
  }
  if (req.body.owner !== undefined) {
    const owner = String(req.body.owner).replace(/\s+/g, ' ').trim().slice(0, 20) || null;
    await pool.query(`UPDATE teams SET owner_name=$2 WHERE id=$1`, [teamId, owner]);
  }
  res.json({ ok: true });
}));

const loginAttempts = new Map();
app.get('/api/login/teams', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name FROM teams WHERE code_hash IS NOT NULL ORDER BY LOWER(name)`);
  const admin = (await getConfig('commissaire_hash')) ? [{ id: 'admin', name: '🔑 Commissaire' }] : [];
  res.json([...rows, ...admin]);
}));

app.post('/api/login', h(async (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, since: Date.now() };
  if (Date.now() - a.since > 15 * 60 * 1000) { a.n = 0; a.since = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  const { teamId, code } = req.body || {};
  if (teamId === 'admin') {
    if (!auth.checkCode(code, await getConfig('commissaire_hash'))) {
      a.n++; loginAttempts.set(ip, a);
      console.warn(`Connexion commissaire refusée : code reçu de ${String(code || '').trim().length} caractère(s), ` +
        `attendu ${(process.env.COMMISSAIRE_CODE || '').trim().length} (essai ${a.n}/10).`);
      return res.status(401).json({ error: 'Code invalide' });
    }
    loginAttempts.delete(ip);
    auth.setSession(res, { admin: true, av: await getConfig('commissaire_version') }, SECRET, IS_PROD);
    return res.json({ ok: true });
  }
  const { rows } = await pool.query(`SELECT id, code_hash, code_version FROM teams WHERE id=$1`, [teamId]);
  const t = rows[0];
  if (!t || !auth.checkCode(code, t.code_hash)) {
    a.n++; loginAttempts.set(ip, a);
    console.warn(`Connexion refusée pour l'équipe ${JSON.stringify(teamId)} (essai ${a.n}/10).`);
    return res.status(401).json({ error: 'Code invalide' });
  }
  loginAttempts.delete(ip);
  auth.setSession(res, { teamId: t.id, v: t.code_version }, SECRET, IS_PROD);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

// Face ID : connexion par clé d'accès (voir lib/passkeys.js).
const passkeys = createPasskeys(app, { pool, h, auth, getConfig, secret: () => SECRET, secure: IS_PROD });

app.use('/api', requireLogin);
app.use('/api', (req, res, next) => { refreshIfStale().catch(() => {}); next(); });

// ---------- Lecture ----------

const PLAYER_COLS = `p.id, p.nhl_id, p.name, p.nhl_team, p.pos, p.aav, p.age, p.contract_end, p.rookie,
  p.gp, p.goals, p.assists, p.wins, p.ot_losses, p.shutouts, p.birth_date, p.auto_override`;

// Forme d'un joueur à partir de ses derniers matchs (ordre chronologique).
function trendOf(pts, pos) {
  const last5 = pts.slice(-5), sum5 = last5.reduce((a, b) => a + b, 0);
  const hot = last5.length >= 3 && sum5 >= (pos === 'G' ? 8 : 5);
  const cold = last5.length === 5 && (pos === 'G' ? sum5 <= 2 : sum5 === 0);
  return { games: pts, last5: sum5, form: hot ? 'hot' : cold ? 'cold' : null };
}

// Âge exact si on connaît la date de naissance (NHL.com), sinon l'âge saisi.
function ageOf(p, at = new Date()) {
  if (!p.birth_date) return p.age ?? null;
  const b = new Date(p.birth_date);
  let a = at.getFullYear() - b.getFullYear();
  if (at.getMonth() < b.getMonth() || (at.getMonth() === b.getMonth() && at.getDate() < b.getDate())) a--;
  return a;
}

function clean(p) {
  return { ...p, aav: p.aav === null ? null : Number(p.aav), age: ageOf(p), pts: rules.poolPoints(p), injury: injuries.of(p) };
}

async function buildLeague() {
  const config = await leagueConfig();
  const { rows: teams } = await pool.query(`SELECT id, name, is_admin, avatar, owner_name, code_hash IS NOT NULL AS has_code FROM teams ORDER BY LOWER(name)`);
  const { rows: owned } = await pool.query(`SELECT ${PLAYER_COLS}, pk.team_id FROM picks pk JOIN players p ON p.id = pk.player_id`);
  // Retenues salariales de la saison (art. 5.3) : le joueur coûte moins à son équipe actuelle,
  // et l'équipe qui retient garde ce montant dans sa masse.
  const { rows: ret } = await pool.query(`SELECT player_id, team_id, amount FROM retentions WHERE season=$1`, [config.seasonId]);
  const retOnPlayer = new Map(), retByTeam = new Map();
  for (const r of ret) {
    retOnPlayer.set(r.player_id, (retOnPlayer.get(r.player_id) || 0) + Number(r.amount));
    retByTeam.set(r.team_id, (retByTeam.get(r.team_id) || 0) + Number(r.amount));
  }
  const byTeam = new Map(teams.map(t => [t.id, []]));
  for (const p of owned) {
    const c = clean(p), cut = retOnPlayer.get(p.id) || 0;
    if (cut && c.aav !== null) { c.aav_full = c.aav; c.aav = Math.max(0, c.aav - cut); c.retained = cut; }
    byTeam.get(p.team_id)?.push(c);
  }
  // Recrues et protections automatiques possibles (art. 4.3), d'après l'historique LNH de chaque joueur.
  // « GP » (peu de matchs) ne veut rien dire en cours de saison : on ne l'affiche que pendant la période de protection.
  const ids = owned.map(p => p.nhl_id).filter(Boolean);
  const { rows: hist } = await pool.query(`SELECT nhl_id, season_start, gp FROM player_seasons WHERE nhl_id = ANY($1::int[])`, [ids]);
  const seasonsOf = new Map();
  for (const r of hist) { if (!seasonsOf.has(r.nhl_id)) seasonsOf.set(r.nhl_id, new Map()); seasonsOf.get(r.nhl_id).set(r.season_start, r.gp); }
  const startYear = Number(String(config.seasonId).slice(0, 4));
  const protOpen = (await getConfig('prot_status')) === 'open';
  for (const list of byTeam.values()) for (const p of list) {
    p.age = ageOf(p);
    const known = seasonsOf.get(p.nhl_id);
    p.cats = known || p.auto_override ? categories(p, startYear, known || new Map(), p.birth_date).filter(c => protOpen || c !== 'GP') : [];
  }
  // Forme récente : points de pool des 10 derniers matchs (🔥 5 pts ou plus en 5 matchs, 🧊 aucun point en 5 matchs).
  const { rows: recent } = await pool.query(`
    SELECT player_nhl_id, goals, assists, wins, ot_losses, shutouts, pos FROM (
      SELECT l.*, ROW_NUMBER() OVER (PARTITION BY player_nhl_id ORDER BY game_date DESC) rn
      FROM game_log l WHERE season=$1 AND game_type=2 AND player_nhl_id = ANY($2::int[])) x
    WHERE rn <= 10 ORDER BY player_nhl_id, rn DESC`, [config.seasonId, ids]);
  const games = new Map();
  for (const r of recent) { if (!games.has(r.player_nhl_id)) games.set(r.player_nhl_id, []); games.get(r.player_nhl_id).push(rules.poolPoints(r)); }
  for (const list of byTeam.values()) for (const p of list) p.trend = trendOf(games.get(p.nhl_id) || [], p.pos);
  const summaries = teams.map(t => {
    const list = byTeam.get(t.id), ages = list.map(p => p.age).filter(a => a);
    return { id: t.id, name: t.name, hasCode: t.has_code, avatar: t.avatar, ownerName: t.owner_name || null,
      avgAge: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length * 10) / 10 : null,
      rookies: list.filter(p => p.cats.includes('R')).length,
      ...rules.teamSummary(list, { ...config, retained: retByTeam.get(t.id) || 0 }) };
  });
  // Rang d'âge : 1 = équipe la plus jeune.
  summaries.filter(t => t.avgAge).sort((a, b) => a.avgAge - b.avgAge).forEach((t, i) => { t.ageRank = i + 1; });
  const ranked = rules.rankTeams(summaries);
  return { config, teams: ranked };
}

app.get('/api/state', h(async (req, res) => {
  const league = await buildLeague();
  res.json({ me: req.me, pendingTrades: await trades.pendingCount(req.me), pendingProtection: await protection.pendingFor(req.me.teamId),
    draft: await draft.status(), unreadNotifications: await notifier.unread(req.me), block: await block.ids(), annonce: await currentAnnonce(), ...league });
}));

app.get('/api/players', h(async (req, res) => {
  const { q = '', pos = '', status = 'all', sort = 'pts' } = req.query;
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const params = [];
  const where = [];
  if (q.trim()) { params.push(`%${rules.normalizeName(q)}%`); where.push(`p.name_key LIKE $${params.length}`); }
  if (['F', 'D', 'G'].includes(pos)) { params.push(pos); where.push(`p.pos = $${params.length}`); }
  if (status === 'available') where.push(`pk.team_id IS NULL`);
  if (status === 'owned') where.push(`pk.team_id IS NOT NULL`);
  if (status === 'unlinked') where.push(`p.nhl_id IS NULL`);
  const ptsExpr = `(p.goals + p.assists + CASE WHEN p.pos='G' THEN 2*p.wins + p.ot_losses + p.shutouts ELSE 0 END)`;
  const order = { pts: `${ptsExpr} DESC, p.gp ASC`, aav: `p.aav DESC NULLS LAST`, name: `p.name ASC`, age: `p.age ASC NULLS LAST` }[sort] || `${ptsExpr} DESC`;
  const { rows } = await pool.query(`
    SELECT ${PLAYER_COLS}, t.name AS team, t.id AS team_id
    FROM players p LEFT JOIN picks pk ON pk.player_id = p.id LEFT JOIN teams t ON t.id = pk.team_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}, p.name LIMIT ${limit}`, params);
  res.json(rows.map(clean));
}));

app.get('/api/players/:id', h(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ${PLAYER_COLS}, t.name AS team, t.id AS team_id
    FROM players p LEFT JOIN picks pk ON pk.player_id = p.id LEFT JOIN teams t ON t.id = pk.team_id
    WHERE p.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Joueur introuvable' });
  const { rows: w } = await pool.query(`
    SELECT w.id, w.ends_at, EXISTS (SELECT 1 FROM waiver_claims c WHERE c.waiver_id=w.id AND c.team_id=$2) AS mine
    FROM waivers w WHERE w.player_id=$1 AND w.status='open'`, [req.params.id, req.me.teamId]);
  const { rows: last } = await pool.query(`
    SELECT game_date, team, goals, assists, wins, ot_losses, shutouts, pos FROM game_log
    WHERE player_nhl_id=$1 AND game_type IN (2,3) ORDER BY game_date DESC LIMIT 10`, [rows[0].nhl_id || -1]);
  const lastGames = last.reverse().map(g => ({ date: g.game_date, pts: rules.poolPoints(g), goals: g.goals, assists: g.assists, wins: g.wins }));
  const p = rows[0], pp = rules.poolPoints(p);
  // Rang du joueur à sa position et au total (points de pool, joueurs qui ont joué cette saison).
  const PTS = `(goals + assists + CASE WHEN pos='G' THEN 2*wins + ot_losses + shutouts ELSE 0 END)`;
  const { rows: rk } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE pos=$1 AND ${PTS} > $2)::int + 1 AS pos_rank, COUNT(*) FILTER (WHERE pos=$1)::int AS pos_total,
           COUNT(*) FILTER (WHERE ${PTS} > $2)::int + 1 AS all_rank, COUNT(*)::int AS all_total
    FROM players WHERE gp > 0 AND nhl_id IS NOT NULL`, [p.pos, pp]);
  // Matchs récents détaillés (adversaire, domicile/visiteur) à partir de nos matchs compilés.
  const { rows: recent } = await pool.query(`
    SELECT l.game_date, l.team, l.goals, l.assists, l.wins, l.ot_losses, l.shutouts, l.pos, g.away, g.home, g.away_score, g.home_score, g.state
    FROM game_log l LEFT JOIN games g ON g.id=l.game_id
    WHERE l.player_nhl_id=$1 AND l.game_type IN (2,3) ORDER BY l.game_date DESC LIMIT 10`, [p.nhl_id || -1]);
  res.json({ ...clean(p), waiver: w[0] || null, lastGames, trend: trendOf(lastGames.map(g => g.pts), p.pos),
    rank: p.gp > 0 ? rk[0] : null,
    recent: recent.map(g => {
      const home = g.home === g.team, opp = home ? g.away : g.home, us = home ? g.home_score : g.away_score, them = home ? g.away_score : g.home_score;
      return { date: g.game_date, opp, home, goals: g.goals, assists: g.assists, wins: g.wins, ot_losses: g.ot_losses, shutouts: g.shutouts,
        pts: rules.poolPoints(g), result: us === null || us === undefined ? null : `${us > them ? 'V' : 'D'} ${us}-${them}` };
    }),
    card: p.nhl_id ? await playerCard(p.nhl_id) : null });
}));

// Fiche LNH d'un joueur (photo, numéro, stats de la saison, 5 derniers matchs, carrière), gardée 3 h en mémoire.
const cardCache = new Map();
async function playerCard(nhlId) {
  const hit = cardCache.get(nhlId);
  if (hit && Date.now() - hit.at < 3 * 3600 * 1000) return hit.card;
  const WEB = process.env.NHL_WEB_BASE || 'https://api-web.nhle.com/v1';
  try {
    const r = await fetch(`${WEB}/player/${nhlId}/landing`, { headers: { 'User-Agent': 'pool-a-vie' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const t = v => (v && typeof v === 'object' ? v.default || v.fr : v) || null;
    const sub = d.featuredStats?.regularSeason?.subSeason || null;
    const card = {
      photo: d.headshot || null, hero: d.heroImage || null, number: d.sweaterNumber ?? null, position: d.position || null,
      team: d.currentTeamAbbrev || null, teamName: t(d.fullTeamName) || t(d.teamCommonName), teamLogo: d.teamLogo || null,
      shoots: d.shootsCatches || null, height: d.heightInCentimeters || null, weight: d.weightInKilograms || null,
      birthCity: t(d.birthCity), birthCountry: d.birthCountry || null, draft: d.draftDetails || null,
      season: d.featuredStats?.season || null, stats: sub,
      last5: (d.last5Games || []).map(g => ({ date: g.gameDate, opp: g.opponentAbbrev, home: g.homeRoadFlag === 'H', goals: g.goals, assists: g.assists,
        points: g.points, plusMinus: g.plusMinus, shots: g.shots, pim: g.pim, toi: g.toi, decision: g.decision, ga: g.goalsAgainst, svPct: g.savePctg, sa: g.shotsAgainst })),
      career: (d.seasonTotals || []).filter(s => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2).map(s => ({ season: s.season, team: t(s.teamName),
        gp: s.gamesPlayed, goals: s.goals, assists: s.assists, points: s.points, plusMinus: s.plusMinus, wins: s.wins, gaa: s.goalsAgainstAvg, svPct: s.savePctg, shutouts: s.shutouts }))
    };
    cardCache.set(nhlId, { at: Date.now(), card });
    return card;
  } catch (e) {
    console.warn(`Fiche LNH ${nhlId} :`, e.message);
    return hit ? hit.card : null;
  }
}


// Points de la journée (en direct) + classement cumulatif.
app.get('/api/live', h(async (req, res) => {
  const today = live.todayET();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
  if (date >= addDays(today, -1)) {
    // Les données fraîches sont attendues au plus quelques secondes ; sinon on sert ce qu'on a.
    await Promise.race([live.sync().catch(e => console.warn('Direct :', e.message)), new Promise(r => setTimeout(r, 8000))]);
  }
  const { rows: games } = await pool.query(`SELECT * FROM games WHERE game_date=$1 AND game_type IN (2,3) ORDER BY start_utc, id`, [date]);
  const playing = new Set(games.flatMap(g => [g.away, g.home]));
  const byId = new Map(games.map(g => [Number(g.id), g]));
  const { rows: logs } = await pool.query(`
    SELECT l.*, p.id AS player_id, pk.team_id FROM game_log l
    JOIN players p ON p.nhl_id = l.player_nhl_id JOIN picks pk ON pk.player_id = p.id
    WHERE l.game_date = $1 AND l.game_type IN (2,3)`, [date]);

  const league = await buildLeague();
  const leader = league.teams.length ? league.teams[0].points : 0;
  const teams = league.teams.map(t => {
    const all = ['F', 'D', 'G'].flatMap(pos => t.positions[pos].players);
    const mine = logs.filter(l => l.team_id === t.id).map(l => {
      const g = byId.get(Number(l.game_id)) || {};
      return { name: l.name, pos: l.pos, team: l.team, goals: l.goals, assists: l.assists, wins: l.wins,
        ot_losses: l.ot_losses, shutouts: l.shutouts, pts: rules.poolPoints(l), state: g.state || null };
    }).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
    const livePts = mine.reduce((s, p) => s + p.pts, 0);
    return {
      id: t.id, name: t.name, rank: t.rank,
      scheduled: all.filter(p => playing.has(p.nhl_team)).length,
      liveGp: mine.length, livePts, liveAvg: mine.length ? livePts / mine.length : 0,
      cumGp: t.gp, cumPts: t.points, cumAvg: t.ppg, diff: leader - t.points,
      players: mine
    };
  });
  res.json({ date, today, games, teams, lastLive: await getConfig('last_live_sync'), ready: await live.isReady() });
}));

// Son de la sirène des transactions : fichier téléversé par le commissaire (sinon, klaxon synthétique).
app.get('/api/horn', h(async (req, res) => {
  const data = await getConfig('horn_audio');
  if (!data) return res.status(404).json({ error: 'Aucun son' });
  const [, type, b64] = data.match(/^data:([^;]+);base64,(.*)$/) || [];
  res.set('Content-Type', type || 'audio/mpeg').set('Cache-Control', 'private, max-age=31536000').send(Buffer.from(b64 || '', 'base64'));
}));

app.get('/api/moves', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM moves ORDER BY at DESC, id DESC LIMIT 300`);
  res.json(rows);
}));

// ---------- Ma liste (une par pooler) ----------

app.get('/api/watchlist', h(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT ${PLAYER_COLS}, t.name AS team FROM watchlist w JOIN players p ON p.id = w.player_id
    LEFT JOIN picks pk ON pk.player_id = p.id LEFT JOIN teams t ON t.id = pk.team_id
    WHERE w.team_id = $1 ORDER BY w.position`, [req.me.teamId]);
  res.json(rows.map(clean));
}));

app.post('/api/watchlist/add', h(async (req, res) => {
  await pool.query(`
    INSERT INTO watchlist(team_id, player_id, position)
    SELECT $1, $2, COALESCE(MAX(position), -1) + 1 FROM watchlist WHERE team_id = $1
    ON CONFLICT DO NOTHING`, [req.me.teamId, req.body.playerId]);
  res.json({ ok: true });
}));

app.post('/api/watchlist/remove', h(async (req, res) => {
  await pool.query(`DELETE FROM watchlist WHERE team_id=$1 AND player_id=$2`, [req.me.teamId, req.body.playerId]);
  res.json({ ok: true });
}));

app.post('/api/watchlist/reorder', h(async (req, res) => {
  const ids = (req.body.orderedPlayerIds || []).map(Number);
  await pool.query(`
    UPDATE watchlist w SET position = o.ord FROM unnest($2::int[]) WITH ORDINALITY AS o(pid, ord)
    WHERE w.team_id = $1 AND w.player_id = o.pid`, [req.me.teamId, ids]);
  res.json({ ok: true });
}));

// ---------- Commissaire ----------

const admin = express.Router();
admin.use(requireAdmin);

// Échanges et choix de repêchage (lib/trades.js). Déclaré ici : les fonctions utilitaires plus bas sont « hissées ».
// Notifications (lib/notify.js).
notifier = createNotify(app, { pool, h, getConfig, setConfig });
const reminders = createReminders({ pool, getConfig, setConfig, notify, buildLeague, rules,
  postWall: (...a) => fun ? fun.autoPost(...a) : null });
const trades = registerTrades(app, admin, { pool, h, inTransaction, movePlayers, getConfig, setConfig, seasonId, rules, notify,
  putOnWaivers: (...a) => waivers.putOnWaivers(...a) });
// Ballottage (lib/waivers.js).
const waivers = createWaivers(app, admin, { pool, h, inTransaction, movePlayers, getConfig, setConfig, seasonId, rules, notify,
  standings: async () => (await buildLeague()).teams, claimPicks: id => trades.claimPicks(id), deadlinePassed: () => trades.deadlinePassed() });
// Listes de protection (lib/protection.js).
const protection = createProtection(app, admin, { pool, h, inTransaction, getConfig, setConfig, seasonId, notify,
  generatePicks: y => trades.generatePicks(y) });
// Pool des séries (lib/playoffs.js).
const playoffs = createPlayoffs(app, { pool, h, seasonId, buildLeague });
// Repêchage (lib/draft.js).
const draft = createDraft(app, admin, { pool, h, inTransaction, movePlayers, getConfig, setConfig, rules, buildLeague, notify });
// Projections d'alignement (lib/projections.js).
const projections = createProjections(app, { pool, h, inTransaction, seasonId, rules });
// Mur de la gang, trophées de la semaine, temple de la renommée (lib/fun.js).
fun = createFun(app, admin, { pool, h, getConfig, seasonId, buildLeague, playoffs, notify });
// Marché des transactions (lib/block.js).
// Rapport des blessés (lib/injuries.js).
const injuries = createInjuries({ pool, getConfig, setConfig, notify });
const block = createBlock(app, { pool, h, notify, injuryOf: p => injuries.of(p) });
// Contrats : import en lot et échéances du 1er juillet (lib/contracts.js).
const contracts = createContracts(admin, { pool, h, inTransaction, getConfig, setConfig, notify, ageOf });

// Salaires de référence (liste Fantrax des joueurs disponibles, data/salaires-reference.json) : donnent un salaire
// aux joueurs qui n'en ont pas, y compris ceux qui apparaîtront plus tard dans les stats de la LNH.
// Un salaire déjà enregistré (alignements, import de contrats, commissaire) n'est jamais remplacé.
async function seedKnownSalaries() {
  const file = path.join(__dirname, 'data', 'salaires-reference.json');
  if (!fs.existsSync(file)) return;
  const stamp = String(fs.statSync(file).size);
  await pool.query(`CREATE TABLE IF NOT EXISTS known_salaries(name_key TEXT NOT NULL, team TEXT NOT NULL, pos TEXT, aav BIGINT NOT NULL, PRIMARY KEY (name_key, team))`);
  if ((await getConfig('known_salaries_stamp')) !== stamp) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')).players.map(([name, team, pos, aav]) => ({ k: rules.normalizeName(name), t: team, p: pos, a: aav }));
    await pool.query(`DELETE FROM known_salaries`);
    await pool.query(`INSERT INTO known_salaries(name_key, team, pos, aav) SELECT k, t, p, a FROM json_to_recordset($1::json) AS r(k TEXT, t TEXT, p TEXT, a BIGINT) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
    await setConfig('known_salaries_stamp', stamp);
  }
  await applyKnownSalaries();
}
async function applyKnownSalaries() {
  // Même nom : l'entrée de la même équipe LNH d'abord, sinon l'entrée unique de ce nom.
  const { rowCount } = await pool.query(`
    UPDATE players p SET aav = ks.aav FROM (
      SELECT DISTINCT ON (p2.id) p2.id, k.aav FROM players p2 JOIN known_salaries k ON k.name_key = p2.name_key
      WHERE p2.aav IS NULL AND (k.team = p2.nhl_team OR (SELECT COUNT(*) FROM known_salaries k2 WHERE k2.name_key = p2.name_key) = 1)
      ORDER BY p2.id, (k.team = p2.nhl_team) DESC) ks
    WHERE p.id = ks.id`);
  if (rowCount) console.log(`Salaires de référence : ${rowCount} joueur(s) sans salaire complété(s)`);
  return rowCount;
}

// Dates de naissance de tous les joueurs de la LNH (une fois par semaine) : l'âge de chacun est toujours exact.
async function refreshBirthDates(force = false) {
  const last = await getConfig('bios_at');
  if (!force && last && Date.now() - Date.parse(last) < 7 * 864e5) return null;
  await setConfig('bios_at', new Date().toISOString());
  const rows = await nhl.fetchBirthDates(await seasonId());
  if (!rows.length) return 0;
  const { rowCount } = await pool.query(`
    UPDATE players p SET birth_date = r.birth_date::date
    FROM json_to_recordset($1::json) AS r(nhl_id INT, birth_date TEXT)
    WHERE p.nhl_id = r.nhl_id AND p.birth_date IS DISTINCT FROM r.birth_date::date`, [JSON.stringify(rows)]);
  console.log(`Dates de naissance : ${rows.length} joueurs LNH, ${rowCount} mise(s) à jour`);
  return rowCount;
}
admin.post('/injuries/refresh', h(async (req, res) => res.json({ count: await injuries.refresh(true) })));

admin.post('/config', h(async (req, res) => {
  const { cap, floor, seasonId: sid } = req.body;
  if (cap !== undefined) await setConfig('cap', Math.round(Number(cap)));
  if (floor !== undefined) await setConfig('floor', Math.round(Number(floor)));
  if (sid !== undefined) {
    if (sid && !/^\d{8}$/.test(sid)) return res.status(400).json({ error: 'Saison au format AAAAAAAA (ex. 20262027)' });
    await pool.query(sid ? `INSERT INTO config(key,value) VALUES('season_id',$1) ON CONFLICT (key) DO UPDATE SET value=$1`
      : `DELETE FROM config WHERE key='season_id'`, sid ? [sid] : []);
  }
  res.json({ ok: true });
}));

admin.get('/teams', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name, is_admin, code_hash IS NOT NULL AS has_code FROM teams ORDER BY LOWER(name)`);
  res.json(rows);
}));

admin.post('/teams', h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const code = auth.generateCode();
  try {
    const { rows } = await pool.query(`INSERT INTO teams(name, code_hash) VALUES($1,$2) RETURNING id`, [name, auth.hashCode(code)]);
    res.json({ id: rows[0].id, name, code });
  } catch { res.status(400).json({ error: 'Équipe déjà existante' }); }
}));

admin.post('/teams/:id/rename', h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  await pool.query(`UPDATE teams SET name=$1 WHERE id=$2`, [name, req.params.id]);
  res.json({ ok: true });
}));

// Génère un nouveau code (l'ancien cesse de fonctionner et ses sessions sont fermées).
admin.post('/teams/:id/code', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT is_admin FROM teams WHERE id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Équipe introuvable' });
  const code = auth.generateCode();
  await pool.query(`UPDATE teams SET code_hash=$1, code_version=code_version+1 WHERE id=$2`, [auth.hashCode(code), req.params.id]);
  res.json({ code });
}));

admin.delete('/teams/:id', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT is_admin FROM teams WHERE id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM teams WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

async function teamName(id) {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT name FROM teams WHERE id=$1`, [id]);
  return rows[0]?.name || null;
}

// Déplace un ou plusieurs joueurs (ajout, libération, échange) et inscrit chaque mouvement à l'historique.
async function movePlayers(client, moves, kind, note, by) {
  const out = [];
  for (const m of moves) {
    const { rows } = await client.query(`
      SELECT p.id, p.name, t.name AS team FROM players p LEFT JOIN picks pk ON pk.player_id=p.id
      LEFT JOIN teams t ON t.id=pk.team_id WHERE p.id=$1`, [m.playerId]);
    const p = rows[0];
    if (!p) throw Object.assign(new Error(`Joueur ${m.playerId} introuvable`), { status: 400 });
    const to = m.toTeamId ? await teamName(m.toTeamId) : null;
    if (m.toTeamId && !to) throw Object.assign(new Error('Équipe inconnue'), { status: 400 });
    if (to === p.team) continue;
    if (m.toTeamId) {
      await client.query(`INSERT INTO picks(player_id, team_id) VALUES($1,$2) ON CONFLICT (player_id) DO UPDATE SET team_id=$2`,
        [p.id, m.toTeamId]);
    } else {
      await client.query(`DELETE FROM picks WHERE player_id=$1`, [p.id]);
    }
    await client.query(`INSERT INTO moves(player_id, player_name, from_team, to_team, kind, note, by_team) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, p.name, p.team, to, kind, note || null, by]);
    out.push({ player: p.name, from: p.team, to });
  }
  return out;
}

// Transfère salaire, contrat, équipe du pool, « Ma liste » et historique de src vers dst, puis supprime src.
async function mergePlayers(src, dst) {
  await inTransaction(async c => {
    const { rows } = await c.query(`SELECT * FROM players WHERE id = ANY($1::int[])`, [[src, dst]]);
    const s = rows.find(r => r.id === src), d = rows.find(r => r.id === dst);
    if (!s || !d) throw Object.assign(new Error('Joueur introuvable'), { status: 404 });
    const pk = await c.query(`SELECT player_id, team_id FROM picks WHERE player_id = ANY($1::int[])`, [[src, dst]]);
    const srcPick = pk.rows.find(r => r.player_id === src), dstPick = pk.rows.find(r => r.player_id === dst);
    if (srcPick && dstPick && srcPick.team_id !== dstPick.team_id)
      throw Object.assign(new Error('Les deux fiches appartiennent à des équipes différentes'), { status: 400 });
    await c.query(`UPDATE players SET aav=COALESCE($1,aav), age=COALESCE($2,age), contract_end=COALESCE($3,contract_end),
      rookie=$4 OR rookie, pos=$5 WHERE id=$6`, [s.aav, s.age, s.contract_end, s.rookie, s.pos, dst]);
    if (srcPick) {
      await c.query(`DELETE FROM picks WHERE player_id=$1`, [src]);
      await c.query(`INSERT INTO picks(player_id, team_id) VALUES($1,$2) ON CONFLICT (player_id) DO UPDATE SET team_id=$2`, [dst, srcPick.team_id]);
    }
    await c.query(`INSERT INTO watchlist(team_id, player_id, position) SELECT team_id, $2, position FROM watchlist WHERE player_id=$1 ON CONFLICT DO NOTHING`, [src, dst]);
    await c.query(`UPDATE moves SET player_id=$2 WHERE player_id=$1`, [src, dst]);
    await c.query(`DELETE FROM players WHERE id=$1`, [src]);
  });
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Ajout / libération d'un joueur. toTeamId = null pour libérer.
admin.post('/assign', h(async (req, res) => {
  const { playerId, toTeamId, note, direct } = req.body;
  const moved = await inTransaction(async c => {
    if (!toTeamId && !direct) { await waivers.putOnWaivers(c, playerId, req.me.name, note || 'Au ballottage (art. 5.5)'); return [{}]; }
    const r = await movePlayers(c, [{ playerId, toTeamId: toTeamId || null }], toTeamId ? 'Ajout' : 'Libération', note, req.me.name);
    await c.query(`UPDATE waivers SET status='cleared', note='Réglé par le commissaire' WHERE player_id=$1 AND status='open'`, [playerId]);
    return r;
  });
  res.json({ moved });
}));

// Échange : liste de mouvements { playerId, toTeamId } appliqués d'un coup.
admin.post('/trade', h(async (req, res) => {
  const { moves, note } = req.body;
  if (!Array.isArray(moves) || !moves.length) return res.status(400).json({ error: 'Aucun joueur sélectionné' });
  const moved = await inTransaction(c => movePlayers(c, moves, 'Échange', note, req.me.name));
  res.json({ moved });
}));

admin.post('/players', h(async (req, res) => {
  const { name, pos, nhl_team, aav, age, contract_end } = req.body;
  const g = rules.posGroup(pos);
  if (!name || !g) return res.status(400).json({ error: 'Nom et position requis' });
  const { rows } = await pool.query(`
    INSERT INTO players(name, name_key, pos, nhl_team, aav, age, contract_end) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [name.trim(), rules.normalizeName(name), g, nhl_team || null, num(aav), num(age), num(contract_end)]);
  res.json({ id: rows[0].id });
}));

admin.post('/players/:id', h(async (req, res) => {
  const fields = { aav: num, age: num, contract_end: num, nhl_team: v => v || null, rookie: v => !!v, pos: rules.posGroup };
  const sets = [], params = [];
  for (const [k, conv] of Object.entries(fields)) {
    if (req.body[k] === undefined) continue;
    const v = conv(req.body[k]);
    if (k === 'pos' && !v) return res.status(400).json({ error: 'Position invalide' });
    params.push(v); sets.push(`${k}=$${params.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(req.params.id);
  await pool.query(`UPDATE players SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
  res.json({ ok: true });
}));

// Fusionne un joueur saisi à la main avec sa fiche LNH (quand le lien automatique n'a pas fonctionné).
admin.post('/players/:id/merge', h(async (req, res) => {
  const src = Number(req.params.id), dst = Number(req.body.intoPlayerId);
  if (!dst || src === dst) return res.status(400).json({ error: 'Fiche LNH requise' });
  await mergePlayers(src, dst);
  res.json({ ok: true });
}));

function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Import d'alignements : « ÉquipePool;Nom;Position;AAV;Âge;FinContrat[;ÉquipeLNH] », une ligne par joueur.
admin.post('/roster/import', h(async (req, res) => {
  const lines = String(req.body.text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const replace = !!req.body.replace;
  const report = { teamsAdded: [], created: 0, updated: 0, assigned: 0, ambiguous: [], skipped: [] };
  await inTransaction(async c => {
    if (replace) await c.query(`DELETE FROM picks`);
    for (const line of lines) {
      const parts = line.split(/[;\t]/).map(s => s.trim());
      const [poolTeam, name, posRaw, aavRaw, ageRaw, endRaw, nhlTeam] = parts;
      const pos = rules.posGroup(posRaw);
      if (!poolTeam || !name || !pos) { report.skipped.push(line); continue; }

      let team = (await c.query(`SELECT id FROM teams WHERE LOWER(name)=LOWER($1)`, [poolTeam])).rows[0];
      if (!team) {
        team = (await c.query(`INSERT INTO teams(name) VALUES($1) RETURNING id`, [poolTeam])).rows[0];
        report.teamsAdded.push(poolTeam);
      }

      const key = rules.normalizeName(name);
      const { rows: same } = await c.query(`SELECT id, pos, nhl_team FROM players WHERE name_key=$1`, [key]);
      const cands = findCandidates(same, { pos, nhl_team: nhlTeam });
      let playerId;
      if (cands.length > 1) { report.ambiguous.push(`${name} (${poolTeam}) — ajoutez l'équipe LNH en 7e colonne`); continue; }
      const fields = [num(aavRaw), num(ageRaw), num(endRaw), nhlTeam || null];
      if (cands.length === 1) {
        playerId = cands[0].id;
        await c.query(`UPDATE players SET aav=COALESCE($1,aav), age=COALESCE($2,age), contract_end=COALESCE($3,contract_end),
          nhl_team=COALESCE(nhl_team,$4), pos=$5 WHERE id=$6`, [...fields, pos, playerId]);
        report.updated++;
      } else {
        playerId = (await c.query(`INSERT INTO players(name, name_key, pos, aav, age, contract_end, nhl_team)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [name, key, pos, ...fields])).rows[0].id;
        report.created++;
      }
      await c.query(`INSERT INTO picks(player_id, team_id) VALUES($1,$2) ON CONFLICT (player_id) DO UPDATE SET team_id=$2`, [playerId, team.id]);
      report.assigned++;
    }
    await c.query(`INSERT INTO moves(player_name, kind, note, by_team) VALUES(NULL,'Import',$1,$2)`,
      [`${report.assigned} joueur(s) importé(s)${replace ? ' (alignements remplacés)' : ''}`, req.me.name]);
  });
  res.json(report);
}));

admin.post('/horn', h(async (req, res) => {
  const data = String(req.body.data || '');
  if (!data) { await pool.query(`DELETE FROM config WHERE key IN ('horn_audio','horn_version')`); return res.json({ ok: true }); }
  if (!/^data:audio\/[a-z0-9.+-]+;base64,/.test(data)) return res.status(400).json({ error: 'Fichier audio requis (MP3, M4A, WAV)' });
  if (data.length > 1.5 * 1024 * 1024) return res.status(400).json({ error: 'Fichier trop gros (maximum 1 Mo)' });
  await setConfig('horn_audio', data);
  await setConfig('horn_version', Date.now());
  res.json({ ok: true });
}));

admin.post('/stats/refresh', h(async (req, res) => {
  const result = await refreshStats();
  refreshBirthDates(true).catch(e => console.warn('Dates de naissance :', e.message));
  if (await live.isReady()) await live.sync({ force: true });
  else live.backfill().catch(e => console.error('Rattrapage :', e.message));
  res.json(result);
}));

// Mot du commissaire : message libre envoyé à tous (notification sur chaque téléphone, même si la personne a coupé
// les autres catégories), affiché en bannière sur le classement jusqu'à l'échéance choisie, et publié sur le mur.
async function currentAnnonce() {
  const a = JSON.parse((await getConfig('annonce')) || 'null');
  return a && (!a.until || Date.parse(a.until) > Date.now()) ? a : null;
}
admin.post('/annonce', h(async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 1000);
  const title = String(req.body.title || '').trim().slice(0, 80) || 'Mot du commissaire';
  if (!body) return res.status(400).json({ error: 'Écris un message' });
  const days = Number(req.body.days);
  const until = days > 0 ? new Date(Date.now() + Math.min(days, 60) * 86400000).toISOString() : null;
  const n = await notify({ kind: 'annonce', title: `📢 ${title}`, body, link: '#/classement' });
  const a = { id: n ? n.id : Date.now(), title, body, at: new Date().toISOString(), until };
  await setConfig('annonce', JSON.stringify(a));
  if (fun) fun.autoPost(`📢 ${title}\n${body}`, '#/classement', `wall:annonce:${a.id}`).catch(() => {});
  res.json({ ok: true, annonce: a });
}));
admin.delete('/annonce', h(async (req, res) => {
  await setConfig('annonce', 'null');
  res.json({ ok: true });
}));

app.use('/api/admin', admin);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Erreur serveur' });
});

// ---------- Démarrage ----------

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  seedKnownSalaries().catch(e => console.warn('Salaires de référence :', e.message));
  app.listen(PORT, () => console.log(`Pool à vie en écoute sur le port ${PORT}`));
  // Mise à jour régulière des stats tant que le serveur est éveillé.
  if (process.env.NO_AUTO_REFRESH !== '1') {
    setInterval(() => {
      refreshIfStale().catch(e => console.error(e));
      live.tick().catch(e => console.error('Direct :', e.message));
      waivers.processDue().catch(e => console.error('Ballottage :', e.message));
      reminders.tick().catch(e => console.error('Rappels :', e.message));
      injuries.refresh().catch(e => console.warn('Blessures :', e.message));
      if (new Date().getMinutes() % 10 === 5) {
        contracts.julyFirst().catch(e => console.warn('Contrats :', e.message));
        refreshBirthDates().catch(e => console.warn('Dates de naissance :', e.message));
      }
      if (new Date().getMinutes() % 10 === 0) fun.closeWeek().catch(e => console.error('Trophées :', e.message));
      // Historique LNH (statut de recrue) : rafraîchi chaque semaine.
      getConfig('prot_history_at').then(at => {
        if (!at || Date.now() - Date.parse(at) > 7 * 864e5) protection.computeHistory().catch(e => console.error('Historique :', e.message));
      }).catch(() => {});
    }, 60 * 1000);
    refreshIfStale().catch(e => console.error(e));
  }
  // Render (gratuit) endort le serveur après 15 minutes sans visite. Le serveur se visite donc lui-même
  // par son adresse publique aux 10 minutes : il reste éveillé sans dépendre d'un service externe.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL;
  if (selfUrl && process.env.NO_KEEP_AWAKE !== '1') {
    const ping = () => fetch(`${selfUrl.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(30000) })
      .catch(e => console.warn('Réveil automatique :', e.message));
    setTimeout(ping, 60 * 1000);
    setInterval(ping, 10 * 60 * 1000);
    console.log(`Garde-éveil : ${selfUrl}/healthz aux 10 minutes`);
  }
}).catch(e => {
  const msg = String(e && e.message || e);
  const hints = [
    [/password authentication failed/i, 'Mot de passe refusé. Mettez le mot de passe Supabase dans une variable DATABASE_PASSWORD (Render → Environment) ; DATABASE_URL peut alors garder [YOUR-PASSWORD].'],
    [/tenant or user not found/i, 'Utilisateur inconnu : l\'adresse doit commencer par postgresql://postgres.<id-du-projet>: (adresse « Session pooler »).'],
    [/ENOTFOUND|getaddrinfo/i, 'Adresse du serveur introuvable : recopiez l\'adresse « Session pooler » depuis Supabase.'],
    [/ENETUNREACH|EHOSTUNREACH/i, 'Réseau inaccessible : utilisez l\'adresse « Session pooler » (pooler.supabase.com), pas « Direct connection ».'],
    [/Invalid URL|ERR_INVALID_URL/i, 'Adresse mal formée : un caractère spécial dans le mot de passe ? Générez un mot de passe sans symboles.']
  ];
  const hint = (hints.find(([re]) => re.test(msg)) || [null, ''])[1];
  console.error(`Connexion tentée : ${describeDb(DATABASE_URL)}`);
  console.error(`ERREUR base de données : ${msg}${e && e.code ? ' (code ' + e.code + ')' : ''}`);
  if (hint) console.error(`→ ${hint}`);
  process.exit(1);
});
