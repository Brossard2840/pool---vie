// Stats en direct : sommaires de match de la LNH (api-web.nhle.com, la source de NHL.com).
// Chaque match est enregistré joueur par joueur (table game_log). Les totaux de la saison
// sont la somme de ces matchs, donc les points marqués pendant un match en cours comptent
// tout de suite au classement.
const { posGroup, normalizeName } = require('./rules');

const WEB = process.env.NHL_WEB_BASE || 'https://api-web.nhle.com/v1';
const LIVE_STATES = new Set(['LIVE', 'CRIT']);
const FINAL_STATES = new Set(['FINAL', 'OFF']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`${WEB}${path}`, { headers: { 'User-Agent': 'pool-a-vie' } });
  if (!res.ok) throw new Error(`API LNH ${path} : HTTP ${res.status}`);
  return res.json();
}

// Date du jour à l'heure de l'Est (les « journées » de la LNH).
function todayET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function gameRow(g, date) {
  return {
    id: g.id, season: String(g.season || ''), game_type: g.gameType, game_date: g.gameDate || date,
    state: g.gameState, away: g.awayTeam?.abbrev, home: g.homeTeam?.abbrev,
    away_score: g.awayTeam?.score ?? null, home_score: g.homeTeam?.score ?? null,
    start_utc: g.startTimeUTC || null,
    period: g.periodDescriptor?.number ?? g.period ?? null,
    period_type: g.periodDescriptor?.periodType || null,
    clock: g.clock?.timeRemaining || null,
    in_intermission: !!g.clock?.inIntermission
  };
}

// Sommaire d'un match → une ligne par joueur qui a joué.
function parseBoxscore(b) {
  const rows = [];
  for (const side of ['awayTeam', 'homeTeam']) {
    const team = b[side]?.abbrev || null;
    const s = b.playerByGameStats?.[side] || {};
    for (const group of ['forwards', 'defense']) {
      for (const p of s[group] || []) {
        rows.push({
          nhl_id: p.playerId, name: p.name?.default || '', pos: group === 'defense' ? 'D' : (posGroup(p.position) || 'F'),
          team, gp: 1, goals: p.goals || 0, assists: p.assists || 0, wins: 0, ot_losses: 0, shutouts: 0
        });
      }
    }
    const played = (s.goalies || []).filter(g => g.toi && g.toi !== '00:00');
    for (const g of played) {
      const win = g.decision === 'W';
      rows.push({
        nhl_id: g.playerId, name: g.name?.default || '', pos: 'G', team, gp: 1,
        // Le sommaire ne donne pas les buts et passes des gardiens : null = garder ce qu'on a déjà (voir patchPlayer).
        goals: g.goals ?? null, assists: g.assists ?? null,
        wins: win ? 1 : 0,
        ot_losses: g.decision === 'O' ? 1 : 0, // défaite en prolongation ou en fusillade
        // Blanchissage : victoire, aucun but accordé, seul gardien utilisé par son équipe.
        shutouts: win && g.goalsAgainst === 0 && played.length === 1 ? 1 : 0
      });
    }
  }
  return rows;
}

function createLive(pool, { getConfig, setConfig, seasonId, onUpdated, onGame }) {
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS games(
        id BIGINT PRIMARY KEY,
        season TEXT, game_type INT, game_date DATE, state TEXT,
        away TEXT, home TEXT, away_score INT, home_score INT,
        start_utc TIMESTAMPTZ, period INT, period_type TEXT, clock TEXT, in_intermission BOOLEAN,
        final_synced BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS games_date ON games(game_date);
      ALTER TABLE games ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS game_log(
        game_id BIGINT NOT NULL,
        player_nhl_id INT NOT NULL,
        game_date DATE NOT NULL,
        season TEXT, game_type INT,
        team TEXT, pos TEXT, name TEXT,
        gp INT NOT NULL DEFAULT 1,
        goals INT NOT NULL DEFAULT 0, assists INT NOT NULL DEFAULT 0,
        wins INT NOT NULL DEFAULT 0, ot_losses INT NOT NULL DEFAULT 0, shutouts INT NOT NULL DEFAULT 0,
        PRIMARY KEY (game_id, player_nhl_id)
      );
      CREATE INDEX IF NOT EXISTS game_log_date ON game_log(game_date);
      CREATE INDEX IF NOT EXISTS game_log_season ON game_log(season, game_type);
    `);
  }

  async function saveGames(games) {
    if (!games.length) return;
    await pool.query(`
      INSERT INTO games(id, season, game_type, game_date, state, away, home, away_score, home_score,
        start_utc, period, period_type, clock, in_intermission, updated_at)
      SELECT g.id, g.season, g.game_type, g.game_date, g.state, g.away, g.home, g.away_score, g.home_score,
        g.start_utc, g.period, g.period_type, g.clock, g.in_intermission, NOW()
      FROM json_to_recordset($1::json) AS g(id BIGINT, season TEXT, game_type INT, game_date DATE, state TEXT,
        away TEXT, home TEXT, away_score INT, home_score INT, start_utc TIMESTAMPTZ, period INT,
        period_type TEXT, clock TEXT, in_intermission BOOLEAN)
      ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, away_score=EXCLUDED.away_score, home_score=EXCLUDED.home_score,
        period=EXCLUDED.period, period_type=EXCLUDED.period_type, clock=EXCLUDED.clock,
        in_intermission=EXCLUDED.in_intermission, start_utc=COALESCE(EXCLUDED.start_utc, games.start_utc),
        season=COALESCE(NULLIF(EXCLUDED.season,''), games.season), updated_at=NOW()`,
      [JSON.stringify(games)]);
  }

  // Télécharge le sommaire d'un match et remplace ses lignes dans game_log.
  async function syncGame(gameId) {
    const b = await getJson(`/gamecenter/${gameId}/boxscore`);
    const rows = parseBoxscore(b);
    const g = gameRow(b);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: old } = await client.query(`SELECT player_nhl_id, goals, assists FROM game_log WHERE game_id=$1`, [gameId]);
      const before = new Map(old.map(r => [r.player_nhl_id, r]));
      for (const r of rows) {
        if (r.goals === null) r.goals = before.get(r.nhl_id)?.goals ?? 0;
        if (r.assists === null) r.assists = before.get(r.nhl_id)?.assists ?? 0;
      }
      await client.query(`DELETE FROM game_log WHERE game_id=$1`, [gameId]);
      if (rows.length) {
        await client.query(`
          INSERT INTO game_log(game_id, player_nhl_id, game_date, season, game_type, team, pos, name,
            gp, goals, assists, wins, ot_losses, shutouts)
          SELECT $2, r.nhl_id, $3, $4, $5, r.team, r.pos, r.name, r.gp, r.goals, r.assists, r.wins, r.ot_losses, r.shutouts
          FROM json_to_recordset($1::json) AS r(nhl_id INT, team TEXT, pos TEXT, name TEXT, gp INT,
            goals INT, assists INT, wins INT, ot_losses INT, shutouts INT)`,
          [JSON.stringify(rows), gameId, g.game_date, g.season, g.game_type]);
      }
      await client.query(`UPDATE games SET state=$2, away_score=$3, home_score=$4, final_synced=$5, updated_at=NOW(), checked_at=NOW() WHERE id=$1`,
        [gameId, g.state, g.away_score, g.home_score, g.state === 'OFF']);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    if (onGame) onGame(gameId, g, rows).catch(e => console.warn('Exploits :', e.message));
    return rows.length;
  }

  // Corrige les lignes d'un joueur à partir de son journal de matchs officiel (/player/ID/game-log).
  // Deux cas que le sommaire de match ne règle pas : les passes et buts des gardiens (absents du sommaire)
  // et les corrections de la LNH faites après le match (passe ajoutée ou retirée le lendemain).
  async function patchPlayer(nhlId, season, pos) {
    const log = await getJson(`/player/${nhlId}/game-log/${season}/2`);
    const changes = [];
    for (const g of log.gameLog || []) {
      const goals = g.goals ?? null, assists = g.assists ?? null;
      if (goals === null && assists === null) continue;
      const shutouts = pos === 'G' && g.shutouts !== undefined ? (g.shutouts ? 1 : 0) : null;
      const { rows } = await pool.query(`
        UPDATE game_log SET goals=COALESCE($3, goals), assists=COALESCE($4, assists), shutouts=COALESCE($5, shutouts)
        WHERE game_id=$1 AND player_nhl_id=$2 AND (goals IS DISTINCT FROM COALESCE($3, goals) OR assists IS DISTINCT FROM COALESCE($4, assists)
          OR shutouts IS DISTINCT FROM COALESCE($5, shutouts))
        RETURNING game_id, game_date`, [g.gameId, nhlId, goals, assists, shutouts]);
      for (const r of rows) changes.push({ gameId: Number(r.game_id), date: String(r.game_date).slice(0, 10), goals, assists });
    }
    return changes;
  }

  // Totaux de la saison = somme des matchs. Ajoute aussi au catalogue les joueurs jamais vus.
  async function recomputeSeason(season) {
    await pool.query(`
      INSERT INTO players(nhl_id, name, name_key, pos, nhl_team)
      SELECT DISTINCT ON (l.player_nhl_id) l.player_nhl_id, l.name, $2, l.pos, l.team
      FROM game_log l WHERE l.season=$1 AND NOT EXISTS (SELECT 1 FROM players p WHERE p.nhl_id=l.player_nhl_id)
      ORDER BY l.player_nhl_id, l.game_date DESC
      ON CONFLICT (nhl_id) DO NOTHING`, [season, '']); // name_key calculé ci-dessous
    const { rows: noKey } = await pool.query(`SELECT id, name FROM players WHERE name_key=''`);
    for (const p of noKey) await pool.query(`UPDATE players SET name_key=$1 WHERE id=$2`, [normalizeName(p.name), p.id]);

    await pool.query(`
      UPDATE players p SET gp=s.gp, goals=s.goals, assists=s.assists, wins=s.wins, ot_losses=s.ot_losses,
        shutouts=s.shutouts, stats_season=$1, nhl_team=COALESCE(s.team, p.nhl_team), last_updated=NOW()
      FROM (
        SELECT player_nhl_id, SUM(gp)::int gp, SUM(goals)::int goals, SUM(assists)::int assists, SUM(wins)::int wins,
          SUM(ot_losses)::int ot_losses, SUM(shutouts)::int shutouts,
          (ARRAY_AGG(team ORDER BY game_date DESC))[1] AS team
        FROM game_log WHERE season=$1 AND game_type=2 GROUP BY player_nhl_id
      ) s WHERE p.nhl_id = s.player_nhl_id`, [season]);
    await pool.query(`
      UPDATE players p SET gp=0, goals=0, assists=0, wins=0, ot_losses=0, shutouts=0, stats_season=$1
      WHERE p.nhl_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM game_log l WHERE l.player_nhl_id=p.nhl_id AND l.season=$1 AND l.game_type=2)`, [season]);
  }

  // Rattrapage : tous les matchs de la saison jusqu'à hier, une seule fois (puis seulement les manquants).
  let backfilling = null;
  async function backfill() {
    if (backfilling) return backfilling;
    backfilling = (async () => {
      const season = await seasonId();
      let start = `${season.slice(0, 4)}-10-01`;
      try {
        const seasons = await getJson('/standings-season');
        const s = (seasons.seasons || []).find(x => String(x.id) === season);
        if (s?.standingsStart) start = s.standingsStart;
      } catch (e) { console.warn('Début de saison inconnu, on part du 1er octobre :', e.message); }

      const today = todayET();
      const ids = [];
      for (let d = start; d <= today; d = addDays(d, 7)) {
        const sch = await getJson(`/schedule/${d}`);
        const games = [];
        for (const day of sch.gameWeek || []) {
          for (const g of day.games || []) {
            if (g.gameType !== 2 && g.gameType !== 3) continue;
            games.push(gameRow({ ...g, season: g.season || season }, day.date));
            if (day.date < today) ids.push(g.id);
          }
        }
        await saveGames(games);
      }
      const { rows: done } = await pool.query(`SELECT id FROM games WHERE final_synced`);
      const doneIds = new Set(done.map(r => Number(r.id)));
      const todo = [...new Set(ids)].filter(id => !doneIds.has(Number(id)));
      console.log(`Rattrapage des matchs ${season} : ${todo.length} sommaire(s) à télécharger`);
      let n = 0;
      for (const id of todo) {
        try { await syncGame(id); n++; } catch (e) { console.warn(`Match ${id} :`, e.message); }
        await sleep(150);
      }
      await recomputeSeason(season);
      await setConfig('log_season', season);
      console.log(`Rattrapage terminé : ${n} match(s) enregistrés`);
      onUpdated && await onUpdated();
    })().finally(() => { backfilling = null; });
    return backfilling;
  }

  // Synchronisation en direct : matchs d'hier non terminés + matchs d'aujourd'hui.
  let syncing = null;
  let lastSync = 0;
  async function sync({ force = false } = {}) {
    if (syncing) return syncing;
    if (!force && Date.now() - lastSync < 45 * 1000) return null;
    syncing = (async () => {
      lastSync = Date.now();
      const season = await seasonId();
      const today = todayET();
      const touched = [];
      for (const date of [addDays(today, -1), today]) {
        const score = await getJson(`/score/${date}`);
        const games = (score.games || []).filter(g => g.gameType === 2 || g.gameType === 3).map(g => gameRow(g, date));
        await saveGames(games);
        for (const g of games) {
          const { rows } = await pool.query(`SELECT final_synced FROM games WHERE id=$1`, [g.id]);
          if (rows[0]?.final_synced) continue;
          if (LIVE_STATES.has(g.state) || FINAL_STATES.has(g.state)) touched.push(g.id);
        }
      }
      // Corrections de la LNH après coup : on relit les matchs terminés des 3 derniers jours, aux 6 heures.
      const { rows: recheck } = await pool.query(`
        SELECT id FROM games WHERE final_synced AND game_date BETWEEN $1::date - 3 AND $1::date
          AND (checked_at IS NULL OR checked_at < NOW() - INTERVAL '6 hours') LIMIT 20`, [today]);
      for (const r of recheck) if (!touched.includes(Number(r.id))) touched.push(Number(r.id));
      for (const id of touched) {
        try { await syncGame(id); } catch (e) { console.warn(`Match ${id} :`, e.message); }
      }
      if (touched.length) {
        await recomputeSeason(season);
        onUpdated && await onUpdated();
      }
      await setConfig('last_live_sync', new Date().toISOString());
      return touched.length;
    })().finally(() => { syncing = null; });
    return syncing;
  }

  // Appelée chaque minute : synchronise seulement s'il y a (ou va y avoir) des matchs.
  async function tick() {
    const season = await seasonId();
    if ((await getConfig('log_season')) !== season) return backfill();
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int n FROM games
      WHERE game_date BETWEEN $1::date - 1 AND $1::date AND NOT final_synced
        AND (start_utc IS NULL OR start_utc <= NOW() + INTERVAL '10 minutes')`, [todayET()]);
    const last = Date.parse((await getConfig('last_live_sync')) || 0) || 0;
    if (rows[0].n > 0 || Date.now() - last > 15 * 60 * 1000) return sync();
  }

  async function isReady() {
    return (await getConfig('log_season')) === (await seasonId());
  }

  return { initTables, sync, tick, backfill, isReady, todayET, patchPlayer, recomputeSeason };
}

module.exports = { createLive, parseBoxscore, todayET, addDays };
