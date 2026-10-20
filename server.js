require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SEASON_ID = process.env.SEASON_ID || '20252026';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams(
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      nhl_team TEXT,
      pos TEXT CHECK (pos IN ('F','D','G')),
      aav BIGINT DEFAULT 0,
      age INT,
      contract_end INT,
      goals INT DEFAULT 0,
      assists INT DEFAULT 0,
      last_updated TIMESTAMP,
      UNIQUE(name, nhl_team)
    );
    CREATE TABLE IF NOT EXISTS picks(
      player_id INT REFERENCES players(id) ON DELETE CASCADE UNIQUE,
      team_id INT REFERENCES teams(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS config(
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS my_draft_list(
      position INT PRIMARY KEY,
      player_id INT REFERENCES players(id) ON DELETE CASCADE
    );
  `);
  const cap = await pool.query(`SELECT value FROM config WHERE key='cap'`);
  if (cap.rowCount === 0) {
    await pool.query(`INSERT INTO config(key,value) VALUES('cap','104000000')`);
  }
}

// ---------- Statistiques LNH (API publique, un seul appel = toute la ligue) ----------
function normalize(str) {
  return (str || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '').trim();
}

async function fetchAllSkaterStats() {
  const url = `https://api.nhle.com/stats/rest/en/skater/summary?isAggregate=false&limit=-1&sort=points&cayenneExp=seasonId=${SEASON_ID}%20and%20gameTypeId=2`;
  const res = await fetch(url);
  const json = await res.json();
  const map = {};
  (json.data || []).forEach(row => {
    const name = row.skaterFullName || `${row.firstName || ''} ${row.lastName || ''}`;
    map[normalize(name)] = { goals: row.goals || 0, assists: row.assists || 0 };
  });
  return map;
}

async function fetchAllGoalieStats() {
  const url = `https://api.nhle.com/stats/rest/en/goalie/summary?isAggregate=false&limit=-1&sort=wins&cayenneExp=seasonId=${SEASON_ID}%20and%20gameTypeId=2`;
  const res = await fetch(url);
  const json = await res.json();
  const map = {};
  (json.data || []).forEach(row => {
    const name = row.goalieFullName || `${row.firstName || ''} ${row.lastName || ''}`;
    map[normalize(name)] = { goals: row.goals || 0, assists: row.assists || 0 };
  });
  return map;
}

async function refreshStats() {
  const skaterMap = await fetchAllSkaterStats();
  const goalieMap = await fetchAllGoalieStats();
  const { rows: players } = await pool.query(`SELECT id, name, pos FROM players`);
  let matched = 0, missed = 0;
  const missedNames = [];
  for (const p of players) {
    const key = normalize(p.name);
    const stats = (p.pos === 'G') ? goalieMap[key] : skaterMap[key];
    if (stats) {
      await pool.query(
        `UPDATE players SET goals=$1, assists=$2, last_updated=NOW() WHERE id=$3`,
        [stats.goals, stats.assists, p.id]
      );
      matched++;
    } else {
      missed++;
      missedNames.push(p.name);
    }
  }
  await pool.query(
    `INSERT INTO config(key,value) VALUES('last_stats_update', NOW()::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  );
  console.log(`Stats mises à jour : ${matched} trouvé(s), ${missed} manquant(s)${missedNames.length ? ' (' + missedNames.join(', ') + ')' : ''}`);
  return { matched, missed, missedNames };
}

// Filet de sécurité : si la dernière mise à jour date de plus de 24h,
// on la relance dès qu'une requête arrive (utile si le serveur dormait
// au moment prévu par le cron ci-dessous).
let refreshing = false;
app.use(async (req, res, next) => {
  try {
    if (!refreshing) {
      const { rows } = await pool.query(`SELECT value FROM config WHERE key='last_stats_update'`);
      const last = rows[0] ? new Date(rows[0].value) : null;
      if (!last || (Date.now() - last.getTime()) > 24 * 60 * 60 * 1000) {
        refreshing = true;
        refreshStats().catch(e => console.error(e)).finally(() => { refreshing = false; });
      }
    }
  } catch (e) { console.error('Vérification de rafraîchissement échouée', e); }
  next();
});

// Déclencheur programmé (fonctionne quand le serveur est éveillé à cette heure)
cron.schedule('0 6 * * *', () => {
  console.log('Cron quotidien : mise à jour des statistiques...');
  refreshStats().catch(e => console.error(e));
});

// ---------- API ----------

app.get('/api/state', async (req, res) => {
  const teams = (await pool.query(`SELECT name FROM teams ORDER BY name`)).rows.map(r => r.name);
  const players = (await pool.query(`
    SELECT p.id, p.name, p.nhl_team, p.pos, p.aav, p.age, p.contract_end, p.goals, p.assists, t.name AS team
    FROM players p
    LEFT JOIN picks pk ON pk.player_id = p.id
    LEFT JOIN teams t ON t.id = pk.team_id
    ORDER BY p.aav DESC
  `)).rows;
  const cap = (await pool.query(`SELECT value FROM config WHERE key='cap'`)).rows[0]?.value || 104000000;
  const lastUpdate = (await pool.query(`SELECT value FROM config WHERE key='last_stats_update'`)).rows[0]?.value || null;
  res.json({ teams, players, cap: Number(cap), lastUpdate });
});

app.post('/api/teams', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    await pool.query(`INSERT INTO teams(name) VALUES($1)`, [name]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'Équipe déjà existante' }); }
});

app.delete('/api/teams/:name', async (req, res) => {
  await pool.query(`DELETE FROM teams WHERE name=$1`, [req.params.name]);
  res.json({ ok: true });
});

app.post('/api/cap', async (req, res) => {
  const { cap } = req.body;
  await pool.query(
    `INSERT INTO config(key,value) VALUES('cap',$1) ON CONFLICT (key) DO UPDATE SET value=$1`,
    [String(cap)]
  );
  res.json({ ok: true });
});

app.post('/api/players', async (req, res) => {
  const { name, nhl_team, pos, aav } = req.body;
  if (!name || !nhl_team || !pos || !aav) return res.status(400).json({ error: 'Champs manquants' });
  try {
    await pool.query(
      `INSERT INTO players(name,nhl_team,pos,aav) VALUES($1,$2,$3,$4)`,
      [name, nhl_team, pos, aav]
    );
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'Joueur déjà existant' }); }
});

app.post('/api/players/import', async (req, res) => {
  const { lines } = req.body;
  let added = 0, updated = 0, skipped = 0;
  for (const line of (lines || [])) {
    const parts = line.split(';').map(s => s.trim());
    if (parts.length < 4) { skipped++; continue; }
    let [name, team, pos, aavRaw, ageRaw, contractEndRaw] = parts;
    pos = pos.toUpperCase();
    if (!['F', 'D', 'G'].includes(pos)) {
      if (pos.startsWith('A')) pos = 'F';
      else if (pos.startsWith('D')) pos = 'D';
      else if (pos.startsWith('G')) pos = 'G';
      else { skipped++; continue; }
    }
    const aav = parseInt(String(aavRaw).replace(/[^0-9]/g, ''), 10);
    const age = ageRaw ? parseInt(ageRaw, 10) : null;
    const contractEnd = contractEndRaw ? parseInt(contractEndRaw, 10) : null;
    if (!name || !team || !aav) { skipped++; continue; }
    const existing = await pool.query(`SELECT id FROM players WHERE name=$1 AND nhl_team=$2`, [name, team]);
    if (existing.rowCount) {
      await pool.query(
        `UPDATE players SET pos=$1, aav=$2, age=COALESCE($3,age), contract_end=COALESCE($4,contract_end) WHERE id=$5`,
        [pos, aav, age, contractEnd, existing.rows[0].id]
      );
      updated++;
    } else {
      await pool.query(
        `INSERT INTO players(name,nhl_team,pos,aav,age,contract_end) VALUES($1,$2,$3,$4,$5,$6)`,
        [name, team, pos, aav, age, contractEnd]
      );
      added++;
    }
  }
  res.json({ added, updated, skipped });
});

app.post('/api/pick', async (req, res) => {
  const { playerId, team } = req.body;
  const t = await pool.query(`SELECT id FROM teams WHERE name=$1`, [team]);
  if (!t.rowCount) return res.status(400).json({ error: 'Équipe inconnue' });
  await pool.query(
    `INSERT INTO picks(player_id, team_id) VALUES($1,$2)
     ON CONFLICT (player_id) DO UPDATE SET team_id=$2`,
    [playerId, t.rows[0].id]
  );
  res.json({ ok: true });
});

app.post('/api/release', async (req, res) => {
  const { playerId } = req.body;
  await pool.query(`DELETE FROM picks WHERE player_id=$1`, [playerId]);
  res.json({ ok: true });
});

app.post('/api/reset', async (req, res) => {
  await pool.query(`DELETE FROM picks`);
  res.json({ ok: true });
});

app.get('/api/standings', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.name AS team, p.pos, (p.goals + p.assists) AS pts
    FROM picks pk
    JOIN players p ON p.id = pk.player_id
    JOIN teams t ON t.id = pk.team_id
  `);
  const teams = {};
  rows.forEach(r => {
    if (!teams[r.team]) teams[r.team] = { F: [], D: [], G: [] };
    if (teams[r.team][r.pos]) teams[r.team][r.pos].push(r.pts);
  });
  const top = (arr, n) => arr.slice().sort((a, b) => b - a).slice(0, n).reduce((s, v) => s + v, 0);
  const standings = Object.keys(teams).map(team => {
    const t = teams[team];
    return { team, points: top(t.F, 9) + top(t.D, 4) + top(t.G, 2) };
  }).sort((a, b) => b.points - a.points);
  res.json(standings);
});

app.get('/api/mylist', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.nhl_team, p.pos, p.aav, p.age, t.name AS team
    FROM my_draft_list ml
    JOIN players p ON p.id = ml.player_id
    LEFT JOIN picks pk ON pk.player_id = p.id
    LEFT JOIN teams t ON t.id = pk.team_id
    ORDER BY ml.position ASC
  `);
  res.json(rows);
});

app.post('/api/mylist/add', async (req, res) => {
  const { playerId } = req.body;
  const { rows } = await pool.query(`SELECT COALESCE(MAX(position),-1)+1 AS next FROM my_draft_list`);
  await pool.query(
    `INSERT INTO my_draft_list(position, player_id) VALUES($1,$2)
     ON CONFLICT (position) DO NOTHING`,
    [rows[0].next, playerId]
  );
  res.json({ ok: true });
});

app.post('/api/mylist/remove', async (req, res) => {
  const { playerId } = req.body;
  await pool.query(`DELETE FROM my_draft_list WHERE player_id=$1`, [playerId]);
  // Renumérote les positions pour éviter les trous
  const { rows } = await pool.query(`SELECT player_id FROM my_draft_list ORDER BY position ASC`);
  await pool.query(`DELETE FROM my_draft_list`);
  for (let i = 0; i < rows.length; i++) {
    await pool.query(`INSERT INTO my_draft_list(position, player_id) VALUES($1,$2)`, [i, rows[i].player_id]);
  }
  res.json({ ok: true });
});

app.post('/api/mylist/reorder', async (req, res) => {
  const { orderedPlayerIds } = req.body; // array d'ids dans le nouvel ordre
  await pool.query(`DELETE FROM my_draft_list`);
  for (let i = 0; i < orderedPlayerIds.length; i++) {
    await pool.query(`INSERT INTO my_draft_list(position, player_id) VALUES($1,$2)`, [i, orderedPlayerIds[i]]);
  }
  res.json({ ok: true });
});

app.post('/api/roster/import', async (req, res) => {
  const { lines } = req.body; // "ÉquipePool;Nom;Position;AAV;Age;FinContrat"
  let teamsAdded = 0, playersCreated = 0, playersUpdated = 0, picked = 0, skipped = 0;
  for (const line of (lines || [])) {
    const parts = line.split(';').map(s => s.trim());
    if (parts.length < 4) { skipped++; continue; }
    let [poolTeam, name, pos, aavRaw, ageRaw, contractEndRaw] = parts;
    pos = (pos || 'F').toUpperCase();
    if (!['F', 'D', 'G'].includes(pos)) {
      if (pos.startsWith('A')) pos = 'F';
      else if (pos.startsWith('D')) pos = 'D';
      else if (pos.startsWith('G')) pos = 'G';
      else pos = 'F';
    }
    if (!poolTeam || !name) { skipped++; continue; }
    const aav = parseInt(String(aavRaw || '0').replace(/[^0-9]/g, ''), 10) || 0;
    const age = ageRaw ? parseInt(ageRaw, 10) : null;
    const contractEnd = contractEndRaw ? parseInt(contractEndRaw, 10) : null;

    const teamCheck = await pool.query(`SELECT id FROM teams WHERE name=$1`, [poolTeam]);
    let teamId;
    if (teamCheck.rowCount) {
      teamId = teamCheck.rows[0].id;
    } else {
      const ins = await pool.query(`INSERT INTO teams(name) VALUES($1) RETURNING id`, [poolTeam]);
      teamId = ins.rows[0].id;
      teamsAdded++;
    }

    const existing = await pool.query(`SELECT id FROM players WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
    let playerId;
    if (existing.rowCount) {
      playerId = existing.rows[0].id;
      await pool.query(
        `UPDATE players SET pos=$1, aav=$2, age=COALESCE($3,age), contract_end=COALESCE($4,contract_end) WHERE id=$5`,
        [pos, aav, age, contractEnd, playerId]
      );
      playersUpdated++;
    } else {
      const ins = await pool.query(
        `INSERT INTO players(name,nhl_team,pos,aav,age,contract_end) VALUES($1,'',$2,$3,$4,$5) RETURNING id`,
        [name, pos, aav, age, contractEnd]
      );
      playerId = ins.rows[0].id;
      playersCreated++;
    }

    await pool.query(
      `INSERT INTO picks(player_id, team_id) VALUES($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET team_id=$2`,
      [playerId, teamId]
    );
    picked++;
  }
  res.json({ teamsAdded, playersCreated, playersUpdated, picked, skipped });
});

app.post('/api/stats/refresh', async (req, res) => {
  try {
    const result = await refreshStats();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`Pool à vie en écoute sur le port ${PORT}`));
}).catch(e => {
  console.error('Erreur d\'initialisation de la base de données :', e);
  process.exit(1);
});
