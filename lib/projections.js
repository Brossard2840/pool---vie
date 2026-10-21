// Projections d'alignement pour les saisons à venir (privées : chaque pooler voit seulement les siennes).
// Pour la saison qui commence l'année S, un joueur est sous contrat si son contrat se termine après S
// (fin 2028 = dernière saison 2027-28). Sinon, son contrat est échu : 0 $ tant qu'on n'inscrit pas un
// salaire estimé. Le salaire utilisé est l'AAV (constant pendant toute la durée du contrat).

// Plafonds LNH connus ou annoncés, par année de début de saison.
const KNOWN_CAPS = { 2025: 95500000, 2026: 104000000, 2027: 113500000 };
const FLOOR_RATIO = 76900000 / 104000000;

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }
function defaultCap(year) {
  if (KNOWN_CAPS[year]) return { cap: KNOWN_CAPS[year], estimated: false };
  const last = Math.max(...Object.keys(KNOWN_CAPS).map(Number));
  return { cap: KNOWN_CAPS[last], estimated: true };
}

function createProjections(app, { pool, h, inTransaction, seasonId, rules }) {
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projections(
        id SERIAL PRIMARY KEY,
        team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        name TEXT NOT NULL, season_start INT NOT NULL, cap BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS projection_players(
        projection_id INT NOT NULL REFERENCES projections(id) ON DELETE CASCADE,
        player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        salary BIGINT, contract_end INT,
        PRIMARY KEY (projection_id, player_id)
      );
    `);
  }

  async function own(id, teamId) {
    const { rows } = await pool.query(`SELECT * FROM projections WHERE id=$1 AND team_id=$2`, [id, teamId]);
    if (!rows[0]) throw err('Projection introuvable', 404);
    return rows[0];
  }

  // Calcule l'alignement projeté : statut du contrat, salaire de la saison, âge cette saison-là, conformité.
  async function compute(pr) {
    const nowStart = Number(String(await seasonId()).slice(0, 4));
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.pos, p.nhl_team, p.aav, p.age, p.birth_date, p.contract_end AS real_end,
        pp.salary AS override, pp.contract_end AS end_override, t.name AS owner
      FROM projection_players pp JOIN players p ON p.id = pp.player_id
      LEFT JOIN picks pk ON pk.player_id = p.id LEFT JOIN teams t ON t.id = pk.team_id
      WHERE pp.projection_id = $1`, [pr.id]);
    const S = pr.season_start;
    const players = rows.map(p => {
      const end = p.end_override ?? p.real_end;
      const status = end === null || end === undefined ? 'inconnu' : end > S ? 'contrat' : 'échu';
      const base = p.aav === null ? 0 : Number(p.aav);
      const salary = p.override !== null && p.override !== undefined ? Number(p.override) : status === 'échu' ? 0 : base;
      const age = p.birth_date ? S - new Date(p.birth_date).getFullYear() - (new Date(p.birth_date).getMonth() > 8 ? 1 : 0)
        : p.age ? p.age + (S - nowStart) : null;
      return { id: p.id, name: p.name, pos: p.pos, nhl_team: p.nhl_team, owner: p.owner, aav: salary, aav_now: base,
        override: p.override === null ? null : Number(p.override), contract_end: end, end_override: p.end_override, status, age,
        gp: 0, goals: 0, assists: 0, wins: 0, ot_losses: 0, shutouts: 0 };
    });
    const sum = rules.teamSummary(players, { cap: Number(pr.cap), floor: Math.round(Number(pr.cap) * FLOOR_RATIO) });
    const ages = players.map(p => p.age).filter(Boolean);
    return {
      id: pr.id, name: pr.name, season_start: S, cap: Number(pr.cap), floor: Math.round(Number(pr.cap) * FLOOR_RATIO),
      capEstimated: defaultCap(S).estimated && Number(pr.cap) === defaultCap(S).cap,
      updated_at: pr.updated_at, capUsed: sum.capUsed, capSpace: sum.capSpace, issues: sum.issues, size: players.length,
      counts: { F: sum.positions.F.count, D: sum.positions.D.count, G: sum.positions.G.count },
      expired: players.filter(p => p.status === 'échu' && p.override === null).length,
      unknown: players.filter(p => p.status === 'inconnu').length,
      avgAge: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length * 10) / 10 : null,
      players: ['F', 'D', 'G'].flatMap(pos => sum.positions[pos].players.map(p => ({ ...p, counts_cap: p.counts_cap })))
        .sort((a, b) => 'FDG'.indexOf(a.pos) - 'FDG'.indexOf(b.pos) || b.aav - a.aav)
    };
  }

  app.get('/api/projections', h(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM projections WHERE team_id=$1 ORDER BY season_start, updated_at DESC`, [req.me.teamId]);
    const nowStart = Number(String(await seasonId()).slice(0, 4));
    res.json({ projections: await Promise.all(rows.map(compute)), seasons: [1, 2, 3, 4, 5].map(i => ({ start: nowStart + i, ...defaultCap(nowStart + i) })) });
  }));

  app.get('/api/projections/:id', h(async (req, res) => res.json(await compute(await own(req.params.id, req.me.teamId)))));

  // Nouvelle projection : copie de l'alignement actuel, d'une autre projection, ou vide.
  app.post('/api/projections', h(async (req, res) => {
    const nowStart = Number(String(await seasonId()).slice(0, 4));
    const S = Number(req.body.seasonStart) || nowStart + 1;
    if (S <= nowStart || S > nowStart + 10) throw err('Choisis une saison future');
    const name = String(req.body.name || '').trim().slice(0, 60) || `Projection ${S}-${String(S + 1).slice(2)}`;
    const id = await inTransaction(async c => {
      const { rows } = await c.query(`INSERT INTO projections(team_id, name, season_start, cap) VALUES($1,$2,$3,$4) RETURNING id`,
        [req.me.teamId, name, S, Number(req.body.cap) || defaultCap(S).cap]);
      const pid = rows[0].id;
      if (req.body.copyFrom === 'current') {
        await c.query(`INSERT INTO projection_players(projection_id, player_id) SELECT $1, player_id FROM picks WHERE team_id=$2`, [pid, req.me.teamId]);
      } else if (req.body.copyFrom) {
        await own(req.body.copyFrom, req.me.teamId);
        await c.query(`INSERT INTO projection_players(projection_id, player_id, salary, contract_end)
          SELECT $1, player_id, salary, contract_end FROM projection_players WHERE projection_id=$2`, [pid, req.body.copyFrom]);
      }
      return pid;
    });
    res.json({ id });
  }));

  app.post('/api/projections/:id', h(async (req, res) => {
    const pr = await own(req.params.id, req.me.teamId);
    const b = req.body;
    if (b.name !== undefined) await pool.query(`UPDATE projections SET name=$2 WHERE id=$1`, [pr.id, String(b.name).trim().slice(0, 60) || pr.name]);
    if (b.cap !== undefined) await pool.query(`UPDATE projections SET cap=$2 WHERE id=$1`, [pr.id, Math.max(0, Math.round(Number(b.cap) || 0))]);
    if (b.add) await pool.query(`INSERT INTO projection_players(projection_id, player_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [pr.id, b.add]);
    if (b.remove) await pool.query(`DELETE FROM projection_players WHERE projection_id=$1 AND player_id=$2`, [pr.id, b.remove]);
    if (b.player) {
      // Salaire estimé (ex. nouveau contrat) et fin de contrat supposée, pour cette projection seulement.
      const num = v => v === null || v === '' || v === undefined ? null : Math.round(Number(String(v).replace(/[^0-9.]/g, '')));
      await pool.query(`UPDATE projection_players SET salary=$3, contract_end=$4 WHERE projection_id=$1 AND player_id=$2`,
        [pr.id, b.player, num(b.salary), num(b.contractEnd)]);
    }
    await pool.query(`UPDATE projections SET updated_at=NOW() WHERE id=$1`, [pr.id]);
    res.json(await compute(await own(pr.id, req.me.teamId)));
  }));

  app.delete('/api/projections/:id', h(async (req, res) => {
    const pr = await own(req.params.id, req.me.teamId);
    await pool.query(`DELETE FROM projections WHERE id=$1`, [pr.id]);
    res.json({ ok: true });
  }));

  return { initTables };
}

module.exports = { createProjections, defaultCap };
