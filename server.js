require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const rules = require('./lib/rules');
const nhl = require('./lib/nhl');
const auth = require('./lib/auth');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/pool';
const isLocalDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 20);
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
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
  await setDefault('cap', '104000000');   // plafond LNH 2026-27
  await setDefault('floor', '76900000');  // plancher LNH 2026-27

  if (!SECRET) {
    // Clé de signature des sessions, générée une fois et conservée dans la base.
    await setDefault('session_secret', crypto.randomBytes(32).toString('hex'));
    SECRET = await getConfig('session_secret');
  }

  // Le commissaire : son code vient de la variable d'environnement COMMISSAIRE_CODE.
  const adminCode = process.env.COMMISSAIRE_CODE;
  const adminTeam = process.env.COMMISSAIRE_EQUIPE || 'Andybros';
  if (adminCode) {
    const { rows } = await pool.query(
      `INSERT INTO teams(name) VALUES($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id, code_hash`,
      [adminTeam]);
    const t = rows[0];
    if (!t.code_hash || !auth.checkCode(adminCode, t.code_hash)) {
      await pool.query(`UPDATE teams SET code_hash=$1, code_version=code_version+1 WHERE id=$2`,
        [auth.hashCode(adminCode), t.id]);
    }
    await pool.query(`UPDATE teams SET is_admin=TRUE WHERE id=$1`, [t.id]);
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
    refreshMinutes: REFRESH_MINUTES
  };
}

// ---------- Statistiques LNH ----------

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
    if (!rows.length) {
      // Début de saison ou API indisponible : on ne remet rien à zéro.
      const result = { at: new Date().toISOString(), season, nhlPlayers: 0, linked: 0, unlinked: [] };
      await setConfig('last_stats_update', result.at);
      await setConfig('last_stats_result', JSON.stringify(result));
      return result;
    }

    const byKey = new Map();
    for (const r of rows) {
      r.name_key = rules.normalizeName(r.name);
      if (!byKey.has(r.name_key)) byKey.set(r.name_key, []);
      byKey.get(r.name_key).push(r);
    }
    const { rows: known } = await pool.query(`SELECT nhl_id FROM players WHERE nhl_id IS NOT NULL`);
    const usedIds = new Set(known.map(r => r.nhl_id));

    let linked = 0;
    const { rows: unlinkedPlayers } = await pool.query(
      `SELECT id, name, name_key, pos, nhl_team FROM players WHERE nhl_id IS NULL`);
    for (const p of unlinkedPlayers) {
      const cands = findCandidates((byKey.get(p.name_key) || []).filter(r => !usedIds.has(r.nhl_id)), p);
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
        nhl_team = COALESCE(EXCLUDED.nhl_team, players.nhl_team),
        stats_season = EXCLUDED.stats_season,
        gp = EXCLUDED.gp, goals = EXCLUDED.goals, assists = EXCLUDED.assists,
        wins = EXCLUDED.wins, ot_losses = EXCLUDED.ot_losses, shutouts = EXCLUDED.shutouts,
        last_updated = NOW()
    `, [JSON.stringify(rows), season]);

    // Joueurs sans aucun match cette saison : stats à zéro (évite de traîner les stats de l'an passé).
    await pool.query(`
      UPDATE players SET gp=0, goals=0, assists=0, wins=0, ot_losses=0, shutouts=0, stats_season=$1
      WHERE stats_season IS DISTINCT FROM $1`, [season]);

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
  if (s) {
    const { rows } = await pool.query(`SELECT id, name, is_admin, code_version FROM teams WHERE id=$1`, [s.teamId]);
    const t = rows[0];
    if (t && t.code_version === s.v) req.me = { teamId: t.id, name: t.name, isAdmin: t.is_admin };
  }
  next();
}));

const requireLogin = (req, res, next) => req.me ? next() : res.status(401).json({ error: 'Connexion requise' });
const requireAdmin = (req, res, next) => req.me?.isAdmin ? next() : res.status(403).json({ error: 'Réservé au commissaire' });

// Point d'entrée pour un service de « ping » externe : garde le serveur éveillé et les stats à jour.
app.get('/healthz', h(async (req, res) => {
  await refreshIfStale();
  res.json({ ok: true, lastUpdate: await getConfig('last_stats_update') });
}));

const loginAttempts = new Map();
app.get('/api/login/teams', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT id, name FROM teams WHERE code_hash IS NOT NULL ORDER BY LOWER(name)`);
  res.json(rows);
}));

app.post('/api/login', h(async (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { n: 0, since: Date.now() };
  if (Date.now() - a.since > 15 * 60 * 1000) { a.n = 0; a.since = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Trop d\'essais. Réessayez dans 15 minutes.' });
  const { teamId, code } = req.body || {};
  const { rows } = await pool.query(`SELECT id, code_hash, code_version FROM teams WHERE id=$1`, [teamId]);
  const t = rows[0];
  if (!t || !auth.checkCode(code, t.code_hash)) {
    a.n++; loginAttempts.set(ip, a);
    return res.status(401).json({ error: 'Code invalide' });
  }
  loginAttempts.delete(ip);
  auth.setSession(res, { teamId: t.id, v: t.code_version }, SECRET, IS_PROD);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

app.use('/api', requireLogin);
app.use('/api', (req, res, next) => { refreshIfStale().catch(() => {}); next(); });

// ---------- Lecture ----------

const PLAYER_COLS = `p.id, p.nhl_id, p.name, p.nhl_team, p.pos, p.aav, p.age, p.contract_end, p.rookie,
  p.gp, p.goals, p.assists, p.wins, p.ot_losses, p.shutouts`;

function clean(p) {
  return { ...p, aav: p.aav === null ? null : Number(p.aav), pts: rules.poolPoints(p) };
}

async function buildLeague() {
  const config = await leagueConfig();
  const { rows: teams } = await pool.query(`SELECT id, name, is_admin, code_hash IS NOT NULL AS has_code FROM teams ORDER BY LOWER(name)`);
  const { rows: owned } = await pool.query(`SELECT ${PLAYER_COLS}, pk.team_id FROM picks pk JOIN players p ON p.id = pk.player_id`);
  const byTeam = new Map(teams.map(t => [t.id, []]));
  for (const p of owned) byTeam.get(p.team_id)?.push(clean(p));
  const summaries = teams.map(t => ({ id: t.id, name: t.name, hasCode: t.has_code, ...rules.teamSummary(byTeam.get(t.id), config) }));
  const ranked = rules.rankTeams(summaries);
  return { config, teams: ranked };
}

app.get('/api/state', h(async (req, res) => {
  const league = await buildLeague();
  res.json({ me: req.me, ...league });
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
  res.json(clean(rows[0]));
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
  if (rows[0].is_admin && process.env.COMMISSAIRE_CODE)
    return res.status(400).json({ error: 'Le code du commissaire se change dans la variable COMMISSAIRE_CODE de Render.' });
  const code = auth.generateCode();
  await pool.query(`UPDATE teams SET code_hash=$1, code_version=code_version+1 WHERE id=$2`, [auth.hashCode(code), req.params.id]);
  res.json({ code });
}));

admin.delete('/teams/:id', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT is_admin FROM teams WHERE id=$1`, [req.params.id]);
  if (rows[0]?.is_admin) return res.status(400).json({ error: 'Impossible de supprimer l\'équipe du commissaire' });
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
  const { playerId, toTeamId, note } = req.body;
  const kind = toTeamId ? 'Ajout' : 'Libération';
  const moved = await inTransaction(c => movePlayers(c, [{ playerId, toTeamId: toTeamId || null }], kind, note, req.me.name));
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
  await inTransaction(async c => {
    const { rows } = await c.query(`SELECT * FROM players WHERE id = ANY($1::int[])`, [[src, dst]]);
    const s = rows.find(r => r.id === src), d = rows.find(r => r.id === dst);
    if (!s || !d) throw Object.assign(new Error('Joueur introuvable'), { status: 404 });
    await c.query(`UPDATE players SET aav=COALESCE($1,aav), age=COALESCE($2,age), contract_end=COALESCE($3,contract_end),
      rookie=$4 OR rookie, pos=$5 WHERE id=$6`, [s.aav, s.age, s.contract_end, s.rookie, s.pos, dst]);
    const pk = await c.query(`SELECT team_id FROM picks WHERE player_id=$1`, [src]);
    if (pk.rows[0]) {
      await c.query(`DELETE FROM picks WHERE player_id=$1`, [src]);
      await c.query(`INSERT INTO picks(player_id, team_id) VALUES($1,$2) ON CONFLICT (player_id) DO UPDATE SET team_id=$2`, [dst, pk.rows[0].team_id]);
    }
    await c.query(`INSERT INTO watchlist(team_id, player_id, position) SELECT team_id, $2, position FROM watchlist WHERE player_id=$1 ON CONFLICT DO NOTHING`, [src, dst]);
    await c.query(`UPDATE moves SET player_id=$2 WHERE player_id=$1`, [src, dst]);
    await c.query(`DELETE FROM players WHERE id=$1`, [src]);
  });
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

admin.post('/stats/refresh', h(async (req, res) => {
  res.json(await refreshStats());
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
  app.listen(PORT, () => console.log(`Pool à vie en écoute sur le port ${PORT}`));
  // Mise à jour régulière des stats tant que le serveur est éveillé.
  if (process.env.NO_AUTO_REFRESH !== '1') {
    setInterval(() => refreshIfStale().catch(e => console.error(e)), 60 * 1000);
    refreshIfStale().catch(e => console.error(e));
  }
}).catch(e => {
  console.error('Erreur d\'initialisation de la base de données :', e);
  process.exit(1);
});
