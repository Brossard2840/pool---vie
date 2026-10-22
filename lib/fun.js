// La vie de la gang : mur de discussion avec réactions, trophées de la semaine (calculés et votés)
// et temple de la renommée (champions inscrits à la clôture de chaque saison + records).
const rules = require('./rules');

const REACTIONS = ['🍺', '🔥', '😂', '🤦', '🚨', '👑'];
const TZ = 'America/Toronto';

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }
function todayET() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
// Lundi de la semaine d'une date (les semaines vont du lundi au dimanche).
function monday(d) { const x = new Date(d + 'T12:00:00Z'); return addDays(d, -((x.getUTCDay() + 6) % 7)); }
const PTS_SQL = `(l.goals + l.assists + CASE WHEN l.pos='G' THEN 2*l.wins + l.ot_losses + l.shutouts ELSE 0 END)`;

function createFun(app, admin, { pool, h, getConfig, seasonId, buildLeague, playoffs, notify = () => {} }) {
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wall_posts(
        id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        team_id INT REFERENCES teams(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'post', body TEXT NOT NULL, link TEXT, dedupe TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS wall_reactions(
        post_id INT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
        team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL, PRIMARY KEY (post_id, team_id, emoji)
      );
      CREATE TABLE IF NOT EXISTS awards(
        week TEXT NOT NULL, category TEXT NOT NULL, winner TEXT, detail TEXT,
        PRIMARY KEY (week, category)
      );
      CREATE TABLE IF NOT EXISTS award_votes(
        week TEXT NOT NULL, category TEXT NOT NULL, team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        choice TEXT NOT NULL, PRIMARY KEY (week, category, team_id)
      );
      CREATE TABLE IF NOT EXISTS hall(
        id SERIAL PRIMARY KEY, season TEXT NOT NULL, category TEXT NOT NULL,
        place INT, team_name TEXT, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  // ---------- Mur de la gang ----------

  // Message automatique (transaction, ballottage…) sur lequel la gang peut réagir.
  async function autoPost(body, link, dedupe) {
    await pool.query(`INSERT INTO wall_posts(kind, body, link, dedupe) VALUES('auto',$1,$2,$3) ON CONFLICT (dedupe) DO NOTHING`, [body, link, dedupe]);
  }

  app.get('/api/wall', h(async (req, res) => {
    const before = Number(req.query.before) || 2147483647;
    const { rows } = await pool.query(`
      SELECT w.*, t.name AS team FROM wall_posts w LEFT JOIN teams t ON t.id=w.team_id
      WHERE w.id < $1 ORDER BY w.id DESC LIMIT 40`, [before]);
    const { rows: rx } = await pool.query(`
      SELECT r.post_id, r.emoji, COUNT(*)::int n, BOOL_OR(r.team_id=$2) AS mine, STRING_AGG(t.name, ', ') AS who
      FROM wall_reactions r JOIN teams t ON t.id=r.team_id WHERE r.post_id = ANY($1::int[]) GROUP BY 1, 2`, [rows.map(r => r.id), req.me.teamId]);
    res.json({ reactions: REACTIONS, posts: rows.map(p => ({ ...p, reactions: rx.filter(r => r.post_id === p.id) })) });
  }));

  app.post('/api/wall', h(async (req, res) => {
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) throw err('Message vide');
    const { rows } = await pool.query(`INSERT INTO wall_posts(team_id, body) VALUES($1,$2) RETURNING id`, [req.me.teamId, body]);
    notify({ kind: 'wall', title: `💬 ${req.me.name}`, body: body.slice(0, 140), link: '#/mur', dedupe: `wall:${rows[0].id}`, exclude: req.me.teamId });
    res.json({ id: rows[0].id });
  }));

  app.post('/api/wall/:id/react', h(async (req, res) => {
    const emoji = req.body.emoji;
    if (!REACTIONS.includes(emoji)) throw err('Réaction inconnue');
    const del = await pool.query(`DELETE FROM wall_reactions WHERE post_id=$1 AND team_id=$2 AND emoji=$3`, [req.params.id, req.me.teamId, emoji]);
    if (!del.rowCount) {
      await pool.query(`INSERT INTO wall_reactions(post_id, team_id, emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, req.me.teamId, emoji]);
      // L'auteur du message est avisé des réactions (pas de ses propres réactions).
      const { rows } = await pool.query(`SELECT team_id, body FROM wall_posts WHERE id=$1`, [req.params.id]);
      if (rows[0]?.team_id && rows[0].team_id !== req.me.teamId)
        notify({ kind: 'wall', audience: `team:${rows[0].team_id}`, title: `${emoji} ${req.me.name} a réagi à ton message`, body: rows[0].body.slice(0, 120),
          link: '#/mur', dedupe: `react:${req.params.id}:${req.me.teamId}:${emoji}` });
    }
    res.json({ ok: true });
  }));

  app.delete('/api/wall/:id', h(async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM wall_posts WHERE id=$1 AND (team_id=$2 OR $3)`, [req.params.id, req.me.teamId, !!req.me.isAdmin]);
    if (!rowCount) throw err('Tu ne peux supprimer que tes messages', 403);
    res.json({ ok: true });
  }));

  // ---------- Trophées de la semaine ----------

  // Pooler et joueur de la semaine (points de tous les joueurs de l'alignement, lundi à dimanche).
  async function weekStats(week) {
    const end = addDays(week, 6);
    const { rows: teams } = await pool.query(`
      SELECT t.name, SUM(${PTS_SQL})::int pts FROM game_log l JOIN players p ON p.nhl_id=l.player_nhl_id
      JOIN picks pk ON pk.player_id=p.id JOIN teams t ON t.id=pk.team_id
      WHERE l.game_date BETWEEN $1 AND $2 AND l.game_type IN (2,3) GROUP BY t.name ORDER BY pts DESC LIMIT 3`, [week, end]);
    const { rows: players } = await pool.query(`
      SELECT l.name, t.name AS team, SUM(${PTS_SQL})::int pts, COUNT(*)::int gp FROM game_log l JOIN players p ON p.nhl_id=l.player_nhl_id
      JOIN picks pk ON pk.player_id=p.id JOIN teams t ON t.id=pk.team_id
      WHERE l.game_date BETWEEN $1 AND $2 AND l.game_type IN (2,3) GROUP BY l.name, t.name ORDER BY pts DESC, gp ASC LIMIT 3`, [week, end]);
    return { teams, players };
  }

  // Votes : choix = transactions de la semaine (échanges, réclamations).
  async function weekChoices(week) {
    const { rows } = await pool.query(`
      SELECT 'trade:' || tr.id AS id, f.name || ' ⇄ ' || t.name AS label FROM trades tr JOIN teams f ON f.id=tr.from_team_id JOIN teams t ON t.id=tr.to_team_id
      WHERE tr.status='completed' AND tr.updated_at >= ($1::date)::timestamptz AND tr.updated_at < ($1::date + 7)::timestamptz
      UNION ALL
      SELECT 'move:' || m.id, m.to_team || ' : ' || m.player_name || ' (' || LOWER(m.kind) || ')' FROM moves m
      WHERE m.kind IN ('Agent libre','Ballottage') AND m.to_team IS NOT NULL AND m.at >= ($1::date)::timestamptz AND m.at < ($1::date + 7)::timestamptz`, [week]);
    return rows;
  }
  const POLLS = { coup: '🍺 Le coup de la semaine', pire: '🤦 La pire transaction de la semaine' };

  async function pollResults(week, teamId) {
    const choices = await weekChoices(week);
    const { rows: votes } = await pool.query(`SELECT category, choice, COUNT(*)::int n, BOOL_OR(team_id=$2) mine FROM award_votes WHERE week=$1 GROUP BY 1, 2`, [week, teamId]);
    return Object.entries(POLLS).map(([cat, title]) => ({ category: cat, title,
      choices: choices.map(c => ({ ...c, votes: votes.find(v => v.category === cat && v.choice === c.id)?.n || 0,
        mine: !!votes.find(v => v.category === cat && v.choice === c.id && v.mine) })) }));
  }

  app.get('/api/awards', h(async (req, res) => {
    const week = monday(todayET());
    const live = await weekStats(week);
    const { rows: past } = await pool.query(`SELECT * FROM awards ORDER BY week DESC, category LIMIT 60`);
    res.json({ week, end: addDays(week, 6), live, polls: await pollResults(week, req.me.teamId), past });
  }));

  app.post('/api/awards/vote', h(async (req, res) => {
    const week = monday(todayET()), { category, choice } = req.body;
    if (!POLLS[category]) throw err('Vote inconnu');
    if (!(await weekChoices(week)).some(c => c.id === choice)) throw err('Choix invalide');
    await pool.query(`INSERT INTO award_votes(week, category, team_id, choice) VALUES($1,$2,$3,$4)
      ON CONFLICT (week, category, team_id) DO UPDATE SET choice=EXCLUDED.choice`, [week, category, req.me.teamId, choice]);
    res.json({ ok: true });
  }));

  // Chaque lundi : on fige les trophées de la semaine passée, on les publie sur le mur et on avise la gang.
  async function closeWeek() {
    const last = addDays(monday(todayET()), -7);
    const { rows: done } = await pool.query(`SELECT 1 FROM awards WHERE week=$1 LIMIT 1`, [last]);
    if (done.length) return;
    const { teams, players } = await weekStats(last);
    const polls = await pollResults(last, 0);
    const lines = [];
    const save = async (cat, winner, detail) => { await pool.query(`INSERT INTO awards(week, category, winner, detail) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [last, cat, winner, detail]); lines.push(`${cat === 'pooler' ? '🏅 Pooler' : cat === 'joueur' ? '⭐ Joueur' : POLLS[cat]} : ${winner} (${detail})`); };
    if (teams[0]) await save('pooler', teams[0].name, `${teams[0].pts} pts`);
    if (players[0]) await save('joueur', players[0].name, `${players[0].pts} pts en ${players[0].gp} matchs, ${players[0].team}`);
    for (const p of polls) {
      const top = p.choices.slice().sort((a, b) => b.votes - a.votes)[0];
      if (top && top.votes) await save(p.category, top.label, `${top.votes} vote${top.votes > 1 ? 's' : ''}`);
    }
    if (!lines.length) { await pool.query(`INSERT INTO awards(week, category, winner, detail) VALUES($1,'aucun',NULL,NULL) ON CONFLICT DO NOTHING`, [last]); return; }
    await autoPost(`🏅 Trophées de la semaine du ${last}\n${lines.join('\n')}`, '#/trophees', `awards:${last}`);
    notify({ kind: 'standings', title: `🏅 Trophées de la semaine : ${teams[0]?.name || '—'} pooler de la semaine`, body: lines.join(' · ').slice(0, 200), link: '#/trophees', dedupe: `awards:${last}` });
  }

  // ---------- Temple de la renommée ----------

  app.get('/api/hall', h(async (req, res) => {
    const { rows: entries } = await pool.query(`SELECT * FROM hall ORDER BY season DESC, category, place NULLS LAST, id`);
    const season = await seasonId();
    // Records calculés à partir des matchs enregistrés (joueurs qui étaient ou sont dans le pool).
    const { rows: bestGame } = await pool.query(`
      SELECT l.name, l.game_date, ${PTS_SQL} AS pts, l.goals, l.assists FROM game_log l JOIN players p ON p.nhl_id=l.player_nhl_id
      WHERE EXISTS (SELECT 1 FROM picks pk WHERE pk.player_id=p.id) OR EXISTS (SELECT 1 FROM moves m WHERE m.player_id=p.id)
      ORDER BY pts DESC, l.goals DESC, l.game_date LIMIT 3`);
    const { rows: bigTrade } = await pool.query(`
      SELECT tr.id, f.name || ' ⇄ ' || t.name AS label, COUNT(ti.*)::int items, tr.updated_at FROM trades tr
      JOIN teams f ON f.id=tr.from_team_id JOIN teams t ON t.id=tr.to_team_id JOIN trade_items ti ON ti.trade_id=tr.id
      WHERE tr.status='completed' GROUP BY tr.id, f.name, t.name ORDER BY items DESC, tr.updated_at LIMIT 3`);
    const { rows: busiest } = await pool.query(`
      SELECT name, COUNT(*)::int n FROM (
        SELECT f.name FROM trades tr JOIN teams f ON f.id=tr.from_team_id WHERE tr.status='completed'
        UNION ALL SELECT t.name FROM trades tr JOIN teams t ON t.id=tr.to_team_id WHERE tr.status='completed') x
      GROUP BY name ORDER BY n DESC LIMIT 3`);
    const { rows: bestWeek } = await pool.query(`SELECT week, winner, detail FROM awards WHERE category='pooler' ORDER BY CAST(SPLIT_PART(detail,' ',1) AS INT) DESC LIMIT 3`);
    res.json({ season, entries, records: { bestGame, bigTrade, busiest, bestWeek } });
  }));

  // Clôture : inscrit le podium de la saison et des séries (bourses de l'art. 6.1 et 7.4).
  admin.post('/hall/close', h(async (req, res) => {
    const season = req.body.season || await seasonId();
    const lbl = `${season.slice(0, 4)}-${season.slice(6)}`;
    await pool.query(`DELETE FROM hall WHERE season=$1 AND category IN ('saison','séries')`, [lbl]);
    const { teams } = await buildLeague();
    const prizeS = ['150 $', '70 $', '40 $'], prizeP = ['150 $', '40 $', '40 $'];
    for (let i = 0; i < Math.min(3, teams.length); i++)
      await pool.query(`INSERT INTO hall(season, category, place, team_name, detail) VALUES($1,'saison',$2,$3,$4)`, [lbl, i + 1, teams[i].name, `${teams[i].points} pts · bourse ${prizeS[i]}`]);
    const P = await playoffs.compute();
    if (P.maxRound >= 4) for (let i = 0; i < Math.min(3, P.teams.length); i++)
      await pool.query(`INSERT INTO hall(season, category, place, team_name, detail) VALUES($1,'séries',$2,$3,$4)`, [lbl, i + 1, P.teams[i].name, `${P.teams[i].current.total} pts · bourse ${prizeP[i]}`]);
    await autoPost(`🏆 Saison ${lbl} : ${teams[0]?.name} est champion de la saison !${P.maxRound >= 4 ? ` Champion des séries : ${P.teams[0].name}.` : ''}`, '#/temple', `hall:${lbl}`);
    notify({ kind: 'standings', title: `🏆 ${teams[0]?.name} champion de la saison ${lbl} !`, body: 'Inscrit au temple de la renommée.', link: '#/temple', dedupe: `hall:${lbl}:${Date.now()}` });
    res.json({ ok: true });
  }));

  admin.post('/hall', h(async (req, res) => {
    const { season, category, place, team_name, detail } = req.body;
    if (!season || !team_name) throw err('Saison et nom requis');
    await pool.query(`INSERT INTO hall(season, category, place, team_name, detail) VALUES($1,$2,$3,$4,$5)`,
      [String(season), category || 'saison', place ? Number(place) : null, String(team_name), detail || null]);
    res.json({ ok: true });
  }));
  admin.delete('/hall/:id', h(async (req, res) => { await pool.query(`DELETE FROM hall WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }));

  return { initTables, autoPost, closeWeek };
}

module.exports = { createFun, monday };
