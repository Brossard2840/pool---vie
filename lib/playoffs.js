// Pool des séries éliminatoires (art. 7).
// Les 8 premières équipes de la saison participent. Ronde 1 (×1) : les 6 meilleures passent.
// Ronde 2 (×1,5), cumulée avec la ronde 1 : les 4 meilleures passent. Finale de conférence (×2) et
// finale de la Coupe Stanley (×3) : le plus haut cumulatif est champion. Pointage de l'art. 2.2.
const rules = require('./rules');

const MULT = { 1: 1, 2: 1.5, 3: 2, 4: 3 };
const ADVANCE = { 1: 6, 2: 4 };

// Rang dans une étape : points, puis points par match, puis buts (art. 7.3).
function rank(list, key) {
  return list.slice().sort((a, b) => b[key].total - a[key].total || b[key].ppg - a[key].ppg || b[key].goals - a[key].goals);
}

function createPlayoffs(app, { pool, h, seasonId, buildLeague }) {
  async function compute() {
    const season = await seasonId();
    const league = await buildLeague();
    const qualified = league.teams.slice(0, 8);
    const { rows: started } = await pool.query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(id::text, 8, 1) AS INT)), 0) AS r FROM games WHERE season=$1 AND game_type=3`, [season]);
    const maxRound = Math.min(4, started[0].r);

    // Points de séries par joueur et par ronde (le numéro de ronde est dans l'identifiant du match LNH).
    const { rows } = await pool.query(`
      SELECT player_nhl_id, CAST(SUBSTRING(game_id::text, 8, 1) AS INT) AS round,
        SUM(gp)::int gp, SUM(goals)::int goals, SUM(assists)::int assists, SUM(wins)::int wins, SUM(shutouts)::int shutouts
      FROM game_log WHERE season=$1 AND game_type=3 GROUP BY 1, 2`, [season]);
    const stats = new Map();
    for (const r of rows) {
      if (!stats.has(r.player_nhl_id)) stats.set(r.player_nhl_id, {});
      stats.get(r.player_nhl_id)[r.round] = r;
    }

    const teams = qualified.map(t => {
      const roster = ['F', 'D', 'G'].flatMap(pos => t.positions[pos].players);
      const players = roster.map(p => {
        const s = stats.get(p.nhl_id) || {};
        const rounds = [1, 2, 3, 4].map(r => s[r] ? rules.playoffPoints({ ...s[r], pos: p.pos }) : 0);
        const upTo = n => {
          let v = 0, gp = 0, goals = 0;
          for (let r = 1; r <= n; r++) { v += rounds[r - 1] * MULT[r]; gp += s[r]?.gp || 0; goals += s[r]?.goals || 0; }
          return { v, gp, goals };
        };
        return { id: p.id, name: p.name, pos: p.pos, nhl_team: p.nhl_team, rounds, upTo };
      });
      // Meilleurs 9 A, 4 D, 2 G sur le cumul pondéré de chaque étape (art. 2.3).
      const stage = n => rules.bestBall(players.map(p => { const u = p.upTo(n); return { pos: p.pos, gp: u.gp, goals: u.goals, v: u.v }; }), p => p.v);
      return {
        id: t.id, name: t.name, seed: t.rank,
        r1: stage(1), r2: stage(2), final: stage(4),
        players: players.map(p => ({ id: p.id, name: p.name, pos: p.pos, nhl_team: p.nhl_team, rounds: p.rounds,
          total: Math.round(p.upTo(4).v * 10) / 10 })).filter(p => p.total > 0).sort((a, b) => b.total - a.total)
      };
    });

    // Éliminations : une ronde est terminée quand la suivante a commencé dans la LNH.
    let alive = teams.slice();
    for (const t of teams) t.status = 'en vie';
    if (maxRound >= 2) {
      const order = rank(alive, 'r1');
      order.slice(ADVANCE[1]).forEach(t => { t.status = 'éliminé (ronde 1)'; t.out = 1; });
      alive = order.slice(0, ADVANCE[1]);
    }
    if (maxRound >= 3) {
      const order = rank(alive, 'r2');
      order.slice(ADVANCE[2]).forEach(t => { t.status = 'éliminé (ronde 2)'; t.out = 2; });
      alive = order.slice(0, ADVANCE[2]);
    }
    const key = maxRound <= 1 ? 'r1' : maxRound === 2 ? 'r2' : 'final';
    for (const t of teams) t.current = t.out === 1 ? t.r1 : t.out === 2 ? t.r2 : t[key];
    const standings = [...rank(teams.filter(t => !t.out), key), ...rank(teams.filter(t => t.out === 2), 'r2'), ...rank(teams.filter(t => t.out === 1), 'r1')]
      .map((t, i) => ({ ...t, place: i + 1 }));
    return { season, maxRound, multipliers: MULT, stage: key, teams: standings };
  }

  app.get('/api/playoffs', h(async (req, res) => res.json(await compute())));
  return { compute };
}

module.exports = { createPlayoffs, MULT };
