// Listes de protection avant le repêchage (art. 4.2 et 4.3).
// Chaque pooler protège 10 joueurs, plus jusqu'à 3 joueurs qui se protègent automatiquement :
//   R  (4.3.1) recrue pendant la saison qui se termine ;
//   GP (4.3.2) attaquant ou défenseur avec 39 matchs ou moins, gardien avec 20 ou moins ;
//   R2 (4.3.3) recrue la saison d'avant (une année de protection supplémentaire).
// Limites (4.3.4) : 3 au total, au plus 1 R2, au plus 2 GP, et au plus 2 en GP et R2 combinés.

const WEB = process.env.NHL_WEB_BASE || 'https://api-web.nhle.com/v1';
const PROTECTED = 10;
const MAX_AUTO = 3;
const CAT_LABEL = { R: 'Recrue (4.3.1)', GP: 'Peu de matchs (4.3.2)', R2: 'Recrue 2e année (4.3.3)' };

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Recrue LNH pour la saison qui commence l'année y (art. 4.3.1, critères de la LNH).
// seasons : Map(année de début → matchs LNH en saison régulière).
function isRookie(y, birthDate, seasons) {
  if (birthDate && new Date(birthDate) <= new Date(`${y - 26}-09-15T00:00:00Z`)) return false;
  for (const [yr, gp] of seasons) if (yr < y && gp > 25) return false;
  if ((seasons.get(y - 1) || 0) > 6 && (seasons.get(y - 2) || 0) > 6) return false;
  return true;
}

// Catégories d'admissibilité d'un joueur pour la protection qui suit la saison commençant l'année y.
function categories(p, y, seasons, birthDate) {
  if (p.auto_override === 'none') return [];
  if (p.auto_override) return p.auto_override.split(',');
  const cats = [];
  const gpNow = seasons.has(y) ? seasons.get(y) : (p.gp || 0);
  if (gpNow >= 1 && isRookie(y, birthDate, seasons)) cats.push('R');
  if (gpNow <= (p.pos === 'G' ? 20 : 39)) cats.push('GP');
  if ((seasons.get(y - 1) || 0) >= 1 && isRookie(y - 1, birthDate, seasons) && !cats.includes('R')) cats.push('R2');
  return cats;
}

// Trouve une catégorie pour chaque protégé automatique en respectant l'art. 4.3.4 (null si impossible).
function assignCategories(list) {
  if (list.length > MAX_AUTO) return null;
  const ok = a => {
    const n = c => a.filter(x => x === c).length;
    return n('R2') <= 1 && n('GP') <= 2 && n('GP') + n('R2') <= 2;
  };
  const walk = (i, acc) => {
    if (i === list.length) return ok(acc) ? acc : null;
    for (const c of list[i].cats) { const r = walk(i + 1, [...acc, c]); if (r) return r; }
    return null;
  };
  return walk(0, []);
}

function createProtection(app, admin, { pool, h, inTransaction, getConfig, setConfig, seasonId, generatePicks, notify = () => {} }) {
  async function initTables() {
    await pool.query(`
      ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_date DATE;
      ALTER TABLE players ADD COLUMN IF NOT EXISTS auto_override TEXT;
      CREATE TABLE IF NOT EXISTS player_seasons(
        nhl_id INT NOT NULL, season_start INT NOT NULL, gp INT NOT NULL DEFAULT 0,
        PRIMARY KEY (nhl_id, season_start)
      );
      CREATE TABLE IF NOT EXISTS protection_lists(
        season TEXT NOT NULL, team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('P','A')), category TEXT,
        PRIMARY KEY (season, team_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS protection_submissions(
        season TEXT NOT NULL, team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (season, team_id)
      );
    `);
  }

  // État de la période : season = saison qui se termine (ex. 20262027), status = closed | open | revealed | applied.
  async function period() {
    return {
      season: (await getConfig('prot_season')) || (await seasonId()),
      status: (await getConfig('prot_status')) || 'closed',
      deadline: (await getConfig('prot_deadline')) || null
    };
  }
  const startYear = season => Number(String(season).slice(0, 4));

  async function deadlinePassed(deadline) {
    if (!deadline) return false;
    const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
    return now > `${deadline}T21:00`;
  }

  // Alignement d'une équipe avec l'admissibilité de chaque joueur.
  async function rosterWithEligibility(teamId, season) {
    const y = startYear(season);
    const { rows: players } = await pool.query(`
      SELECT p.id, p.nhl_id, p.name, p.pos, p.nhl_team, p.aav, p.age, p.contract_end, p.gp, p.goals, p.assists,
        p.wins, p.ot_losses, p.shutouts, p.birth_date, p.auto_override
      FROM picks pk JOIN players p ON p.id = pk.player_id WHERE pk.team_id = $1`, [teamId]);
    const ids = players.map(p => p.nhl_id).filter(Boolean);
    const { rows: hist } = await pool.query(`SELECT nhl_id, season_start, gp FROM player_seasons WHERE nhl_id = ANY($1::int[])`, [ids]);
    const by = new Map();
    for (const r of hist) { if (!by.has(r.nhl_id)) by.set(r.nhl_id, new Map()); by.get(r.nhl_id).set(r.season_start, r.gp); }
    return players.map(p => {
      const seasons = by.get(p.nhl_id) || new Map();
      return { ...p, aav: p.aav === null ? null : Number(p.aav), cats: categories(p, y, seasons, p.birth_date), history: !!by.get(p.nhl_id) };
    });
  }

  // Historique LNH (matchs par saison, date de naissance) de tous les joueurs d'équipes, pour les recrues.
  let computing = null;
  async function computeHistory() {
    if (computing) return computing;
    computing = (async () => {
      const { rows } = await pool.query(`SELECT DISTINCT p.nhl_id FROM picks pk JOIN players p ON p.id=pk.player_id WHERE p.nhl_id IS NOT NULL`);
      let n = 0;
      for (const { nhl_id } of rows) {
        try {
          const res = await fetch(`${WEB}/player/${nhl_id}/landing`, { headers: { 'User-Agent': 'pool-a-vie' } });
          if (!res.ok) continue;
          const d = await res.json();
          const seasons = new Map();
          for (const s of d.seasonTotals || []) {
            if (s.leagueAbbrev !== 'NHL' || s.gameTypeId !== 2) continue;
            const y = Number(String(s.season).slice(0, 4));
            seasons.set(y, (seasons.get(y) || 0) + (s.gamesPlayed || 0));
          }
          for (const [y, gp] of seasons) await pool.query(`
            INSERT INTO player_seasons(nhl_id, season_start, gp) VALUES($1,$2,$3)
            ON CONFLICT (nhl_id, season_start) DO UPDATE SET gp=EXCLUDED.gp`, [nhl_id, y, gp]);
          if (d.birthDate) await pool.query(`UPDATE players SET birth_date=$2 WHERE nhl_id=$1`, [nhl_id, d.birthDate]);
          n++;
        } catch (e) { console.warn(`Historique ${nhl_id} :`, e.message); }
        await sleep(120);
      }
      await setConfig('prot_history_at', new Date().toISOString());
      console.log(`Historique LNH mis à jour pour ${n} joueur(s)`);
      return n;
    })().finally(() => { computing = null; });
    return computing;
  }

  async function myList(season, teamId) {
    const { rows } = await pool.query(`SELECT player_id, kind, category FROM protection_lists WHERE season=$1 AND team_id=$2`, [season, teamId]);
    const { rows: sub } = await pool.query(`SELECT submitted_at FROM protection_submissions WHERE season=$1 AND team_id=$2`, [season, teamId]);
    return { picks: rows, submittedAt: sub[0]?.submitted_at || null };
  }

  app.get('/api/protection', h(async (req, res) => {
    const P = await period();
    const teamId = Number(req.query.team) || req.me.teamId;
    const canSeeOthers = req.me.isAdmin || ['revealed', 'applied'].includes(P.status);
    if (teamId !== req.me.teamId && !canSeeOthers) throw err('Les listes des autres équipes sont dévoilées après la date limite', 403);
    const roster = P.status === 'applied' ? [] : await rosterWithEligibility(teamId, P.season);
    const mine = await myList(P.season, teamId);
    const { rows: subs } = await pool.query(`
      SELECT t.id, t.name, s.submitted_at FROM teams t
      LEFT JOIN protection_submissions s ON s.team_id=t.id AND s.season=$1 ORDER BY LOWER(t.name)`, [P.season]);
    let lists = null;
    if (canSeeOthers) {
      const { rows } = await pool.query(`
        SELECT pl.team_id, pl.kind, pl.category, p.id, p.name, p.pos, p.aav FROM protection_lists pl
        JOIN players p ON p.id=pl.player_id WHERE pl.season=$1 ORDER BY pl.kind DESC, p.pos, p.name`, [P.season]);
      lists = rows.map(r => ({ ...r, aav: r.aav === null ? null : Number(r.aav) }));
    }
    res.json({ ...P, deadlinePassed: await deadlinePassed(P.deadline), teamId, roster, ...mine,
      submissions: subs, lists, historyAt: await getConfig('prot_history_at'), rules: { protected: PROTECTED, auto: MAX_AUTO, labels: CAT_LABEL } });
  }));

  app.post('/api/protection', h(async (req, res) => {
    const P = await period();
    if (P.status !== 'open') throw err('La période de protection n\'est pas ouverte');
    if (!req.me.isAdmin && await deadlinePassed(P.deadline)) throw err('La date limite de remise des listes est passée');
    const teamId = req.me.isAdmin && req.body.teamId ? Number(req.body.teamId) : req.me.teamId;
    const prot = [...new Set((req.body.protected || []).map(Number))];
    const auto = [...new Set((req.body.auto || []).map(Number))].filter(id => !prot.includes(id));
    if (prot.length > PROTECTED) throw err(`Maximum ${PROTECTED} joueurs protégés (art. 4.2)`);
    const roster = await rosterWithEligibility(teamId, P.season);
    const byId = new Map(roster.map(p => [p.id, p]));
    for (const id of [...prot, ...auto]) if (!byId.has(id)) throw err('Un des joueurs n\'est pas dans l\'alignement');
    const autoPlayers = auto.map(id => byId.get(id));
    const bad = autoPlayers.find(p => !p.cats.length);
    if (bad) throw err(`${bad.name} n'est pas admissible à la protection automatique (art. 4.3)`);
    const cats = assignCategories(autoPlayers);
    if (!cats) throw err('Combinaison de protections automatiques non permise (art. 4.3.4) : au plus 3, dont au plus 1 recrue de 2e année et au plus 2 joueurs à peu de matchs (2 au total pour ces deux catégories)');
    await inTransaction(async c => {
      await c.query(`DELETE FROM protection_lists WHERE season=$1 AND team_id=$2`, [P.season, teamId]);
      for (const id of prot) await c.query(`INSERT INTO protection_lists(season, team_id, player_id, kind) VALUES($1,$2,$3,'P')`, [P.season, teamId, id]);
      for (let i = 0; i < autoPlayers.length; i++)
        await c.query(`INSERT INTO protection_lists(season, team_id, player_id, kind, category) VALUES($1,$2,$3,'A',$4)`, [P.season, teamId, autoPlayers[i].id, cats[i]]);
      if (req.body.submit) await c.query(`INSERT INTO protection_submissions(season, team_id) VALUES($1,$2)
        ON CONFLICT (season, team_id) DO UPDATE SET submitted_at=NOW()`, [P.season, teamId]);
    });
    res.json({ ok: true, categories: cats });
  }));

  // ---------- Commissaire ----------

  admin.post('/protection/open', h(async (req, res) => {
    const { deadline } = req.body;
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw err('Date au format AAAA-MM-JJ');
    await setConfig('prot_season', req.body.season || await seasonId());
    await setConfig('prot_status', 'open');
    await setConfig('prot_deadline', deadline || '');
    computeHistory().catch(e => console.error('Historique :', e.message));
    notify({ kind: 'protection', title: '🛡️ Les listes de protection sont ouvertes', body: deadline ? `Remets ta liste avant le ${deadline} à 21 h (art. 4.2).` : 'Remets ta liste : 10 joueurs + 3 automatiques (art. 4.2).',
      link: '#/protection', dedupe: `prot:open:${deadline || ''}:${new Date().toISOString().slice(0, 10)}` });
    res.json({ ok: true });
  }));

  admin.post('/protection/history', h(async (req, res) => {
    computeHistory().catch(e => console.error('Historique :', e.message));
    res.json({ started: true });
  }));

  admin.post('/protection/reveal', h(async (req, res) => {
    await setConfig('prot_status', 'revealed');
    notify({ kind: 'protection', title: '👀 Les listes de protection sont dévoilées', body: 'Va voir qui chaque équipe a gardé.', link: '#/protection', dedupe: `prot:reveal:${Date.now()}` });
    res.json({ ok: true });
  }));

  admin.post('/protection/close', h(async (req, res) => {
    await setConfig('prot_status', 'closed');
    res.json({ ok: true });
  }));

  // Applique les listes : les joueurs non protégés retournent dans le bassin du repêchage,
  // et les choix de l'année suivante deviennent disponibles (art. 4.6).
  admin.post('/protection/apply', h(async (req, res) => {
    const P = await period();
    if (P.status !== 'revealed') throw err('Dévoile d\'abord les listes');
    const released = await inTransaction(async c => {
      const { rows } = await c.query(`
        SELECT pk.player_id, p.name, t.name AS team FROM picks pk JOIN players p ON p.id=pk.player_id JOIN teams t ON t.id=pk.team_id
        WHERE NOT EXISTS (SELECT 1 FROM protection_lists pl WHERE pl.season=$1 AND pl.team_id=pk.team_id AND pl.player_id=pk.player_id)`, [P.season]);
      for (const r of rows) {
        await c.query(`DELETE FROM picks WHERE player_id=$1`, [r.player_id]);
        await c.query(`INSERT INTO moves(player_id, player_name, from_team, to_team, kind, note, by_team)
          VALUES($1,$2,$3,NULL,'Non protégé',$4,$5)`, [r.player_id, r.name, r.team, `Listes de protection ${P.season.slice(0, 4)}-${P.season.slice(6)}`, req.me.name]);
      }
      return rows.length;
    });
    const nextDraft = startYear(P.season) + 2;   // ex. après 2026-27 : les choix 2028 s'ajoutent à ceux de 2027
    const created = await generatePicks(nextDraft);
    await setConfig('prot_status', 'applied');
    res.json({ released, picksCreated: created, picksYear: nextDraft });
  }));

  // Exception manuelle à l'admissibilité d'un joueur ('' = automatique, 'none' = jamais, sinon 'R', 'GP', 'R2'...).
  admin.post('/protection/override', h(async (req, res) => {
    const v = String(req.body.value || '').trim();
    if (v && v !== 'none' && !v.split(',').every(c => CAT_LABEL[c])) throw err('Valeur invalide');
    await pool.query(`UPDATE players SET auto_override=$2 WHERE id=$1`, [req.body.playerId, v || null]);
    res.json({ ok: true });
  }));

  async function pendingFor(teamId) {
    const P = await period();
    if (P.status !== 'open') return 0;
    const { rows } = await pool.query(`SELECT 1 FROM protection_submissions WHERE season=$1 AND team_id=$2`, [P.season, teamId]);
    return rows.length ? 0 : 1;
  }

  return { initTables, computeHistory, pendingFor };
}

module.exports = { createProtection, isRookie, categories, assignCategories };
