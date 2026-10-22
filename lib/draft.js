// Repêchage annuel (art. 4.4 à 4.6).
// Loterie entre les 5 équipes qui ont terminé dernières (pourcentages réglables), puis ordre fixe
// pour les choix suivants ; chaque ronde suit le même ordre. Le repêchage d'un pooler se termine
// quand il a 23 joueurs (art. 4.5) : ses choix restants sont alors passés.
// Minuteur : chaque pooler a 2 minutes. Temps écoulé : le minuteur s'arrête à 0:00 et le commissaire décide
// (passer au suivant, ou avertissement et 1 minute de plus). En attendant, le pooler peut encore choisir.
// Un choix passé peut être fait en retard, quand le pooler veut.

const ROSTER_FULL = 23;
const DEFAULT_WEIGHTS = [25, 25, 20, 15, 10];
const DEFAULT_CLOCK = Number(process.env.DRAFT_CLOCK_SECONDS) || 120;  // 2 minutes (variable seulement pour les tests)
const EXTRA_TIME = 60;  // temps accordé avec un avertissement

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

// Tirage pondéré sans remise : chaque position tirée parmi les équipes restantes.
function drawLottery(teams, weights, rand = Math.random) {
  const pool = teams.map((id, i) => ({ id, w: Number(weights[i]) || 0, pct: Number(weights[i]) || 0 }));
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, t) => s + t.w, 0);
    let x = rand() * (total || pool.length), k = 0;
    if (total) { for (; k < pool.length - 1; k++) { x -= pool[k].w; if (x < 0) break; } }
    else k = Math.floor(x);
    out.push(pool.splice(k, 1)[0]);
  }
  return out.map((t, i) => ({ position: i + 1, team_id: t.id, pct: t.pct }));
}

function createDraft(app, admin, { pool, h, inTransaction, movePlayers, getConfig, setConfig, rules, buildLeague, notify = () => {} }) {
  // Avise l'équipe dont c'est le tour (une seule fois par choix).
  async function notifyOnClock(year) {
    const B = await board(year);
    const cur = B.picks.find(p => p.id === B.current);
    if (cur) notify({ kind: 'draft', audience: `team:${cur.owner_team_id}`, title: `⏰ C'est ton tour au repêchage !`,
      body: `Ronde ${cur.round}, choix #${cur.overall}. Fais ta sélection.`, link: '#/repechage', dedupe: `draft:${year}:clock:${cur.id}` });
  }
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drafts(
        year INT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'setup',
        team_order INT[] NOT NULL DEFAULT '{}',
        weights INT[] NOT NULL DEFAULT '{25,25,20,15,10}',
        lottery JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE draft_picks ADD COLUMN IF NOT EXISTS player_id INT REFERENCES players(id) ON DELETE SET NULL;
      ALTER TABLE draft_picks ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;
      ALTER TABLE draft_picks ADD COLUMN IF NOT EXISTS passed BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS clock_seconds INT NOT NULL DEFAULT ${DEFAULT_CLOCK};
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS clock_started_at TIMESTAMPTZ;
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS clock_paused_left INT;
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS overtime_pick INT;
      CREATE TABLE IF NOT EXISTS draft_warnings(
        id SERIAL PRIMARY KEY, year INT NOT NULL, team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        pick_id INT, at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  // Année du prochain repêchage : la plus petite année où des choix n'ont pas encore servi.
  async function currentYear() {
    const forced = Number(await getConfig('draft_year'));
    if (forced) return forced;
    const { rows } = await pool.query(`SELECT MIN(year) y FROM draft_picks WHERE NOT used`);
    return rows[0].y || null;
  }

  // Ordre par défaut : la pire équipe d'abord (rang de la saison précédente, sinon classement actuel).
  async function defaultOrder() {
    const league = await buildLeague();
    const { rows } = await pool.query(`SELECT id, prev_rank FROM teams`);
    const prev = new Map(rows.map(r => [r.id, r.prev_rank]));
    const anyPrev = rows.some(r => r.prev_rank);
    return league.teams.slice().sort((a, b) => anyPrev
      ? (prev.get(b.id) ?? 999) - (prev.get(a.id) ?? 999)
      : a.points - b.points || a.ppg - b.ppg).map(t => t.id);
  }

  // Minuteur du choix en cours (0 seconde = pas de minuteur).
  function clockOf(d, running) {
    const seconds = d.clock_seconds ?? DEFAULT_CLOCK;
    const base = { seconds, serverNow: new Date().toISOString() };
    if (!running || !seconds) return base;
    if (d.clock_paused_left !== null && d.clock_paused_left !== undefined) return { ...base, paused: true, left: d.clock_paused_left };
    if (!d.clock_started_at) return base;
    return { ...base, startedAt: d.clock_started_at, deadline: new Date(new Date(d.clock_started_at).getTime() + seconds * 1000).toISOString() };
  }
  const restartClock = (c, year) => c.query(`UPDATE drafts SET clock_started_at=NOW(), overtime_pick=NULL WHERE year=$1`, [year]).then(() =>
    c.query(`UPDATE drafts SET clock_paused_left=clock_seconds WHERE year=$1 AND clock_paused_left IS NOT NULL`, [year]));

  // Temps écoulé : le choix est passé et c'est au suivant (le pooler pourra le faire en retard).
  // Temps écoulé : on s'arrête à 0:00 et on demande au commissaire de régulariser (une fois par choix).
  let advancing = false;
  async function advance(year) {
    if (advancing) return;
    advancing = true;
    try {
      const B = await board(year);
      const cur = B.picks.find(p => p.id === B.current);
      if (!cur || B.overtime || !B.clock.deadline || Date.now() < Date.parse(B.clock.deadline)) return;
      const { rowCount } = await pool.query(`UPDATE drafts SET overtime_pick=$2 WHERE year=$1 AND overtime_pick IS DISTINCT FROM $2`, [year, cur.id]);
      if (!rowCount) return;
      const n = B.warnings[cur.owner_team_id] || 0;
      notify({ kind: 'admin', audience: 'admin', title: `⏱️ Temps écoulé : ${cur.owner_team} n'a pas choisi (#${cur.overall})`,
        body: `Passer au suivant ou donner un avertissement (+1 min) ?${n ? ` Déjà ${n} avertissement${n > 1 ? 's' : ''}.` : ''}`, link: '#/repechage', dedupe: `draft:${year}:overtime:${cur.id}:${n}` });
      notify({ kind: 'draft', audience: `team:${cur.owner_team_id}`, title: `⏱️ Ton temps est écoulé (choix #${cur.overall})`,
        body: 'Fais ton choix vite : le commissaire va décider de passer au suivant ou de te donner un avertissement.', link: '#/repechage', dedupe: `draft:${year}:late:${cur.id}:${n}` });
    } finally { advancing = false; }
  }
  // Vérifie le minuteur toutes les 2 secondes pendant un repêchage en cours.
  let liveYear = null, lastCheck = 0;
  setInterval(async () => {
    try {
      if (Date.now() - lastCheck > 30000) {
        lastCheck = Date.now();
        const { rows } = await pool.query(`SELECT year FROM drafts WHERE status='live' ORDER BY year LIMIT 1`);
        liveYear = rows[0]?.year || null;
      }
      if (liveYear) await advance(liveYear);
    } catch (e) { if (!/does not exist/.test(e.message)) console.warn('Minuteur du repêchage :', e.message); }
  }, 2000).unref?.();

  async function getDraft(year, create = false) {
    let { rows } = await pool.query(`SELECT * FROM drafts WHERE year=$1`, [year]);
    if (!rows[0] && create) {
      await pool.query(`INSERT INTO drafts(year, team_order, weights) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [year, await defaultOrder(), DEFAULT_WEIGHTS]);
      ({ rows } = await pool.query(`SELECT * FROM drafts WHERE year=$1`, [year]));
    }
    return rows[0] || null;
  }

  async function board(year) {
    const d = await getDraft(year, true);
    const { rows: teams } = await pool.query(`SELECT id, name FROM teams`);
    const name = new Map(teams.map(t => [t.id, t.name]));
    // Les équipes absentes de l'ordre (ajoutées depuis) se placent à la fin.
    const order = [...d.team_order.filter(id => name.has(id)), ...teams.map(t => t.id).filter(id => !d.team_order.includes(id))];
    const pos = new Map(order.map((id, i) => [id, i + 1]));
    const { rows: counts } = await pool.query(`SELECT team_id, COUNT(*)::int n FROM picks GROUP BY team_id`);
    const size = new Map(counts.map(r => [r.team_id, r.n]));
    const { rows: picks } = await pool.query(`
      SELECT dp.*, p.name AS player_name, p.pos AS player_pos, p.nhl_team AS player_team
      FROM draft_picks dp LEFT JOIN players p ON p.id = dp.player_id WHERE dp.year=$1`, [year]);
    const n = order.length;
    const list = picks.map(p => ({
      id: p.id, round: p.round, position: pos.get(p.original_team_id) || n, used: p.used, note: p.note,
      original_team_id: p.original_team_id, owner_team_id: p.owner_team_id,
      original_team: name.get(p.original_team_id), owner_team: name.get(p.owner_team_id),
      player: p.player_id ? { id: p.player_id, name: p.player_name, pos: p.player_pos, nhl_team: p.player_team } : null,
      picked_at: p.picked_at, passed: p.passed && !p.used
    })).sort((a, b) => a.round - b.round || a.position - b.position);
    list.forEach(p => { p.overall = (p.round - 1) * n + p.position; });
    // Choix au tour : le premier non utilisé dont l'équipe n'a pas encore 23 joueurs.
    let current = null;
    for (const p of list) {
      if (p.used || p.player || p.passed) continue;
      if ((size.get(p.owner_team_id) || 0) >= ROSTER_FULL) { p.skipped = true; continue; }
      if (!current) current = p;
    }
    const { rows: warns } = await pool.query(`SELECT team_id, COUNT(*)::int n FROM draft_warnings WHERE year=$1 GROUP BY team_id`, [year]);
    const lotteryTeams = order.slice(0, 5).map((id, i) => ({ id, name: name.get(id), pct: d.weights[i] ?? 0 }));
    return {
      year, status: d.status, weights: d.weights, lottery: d.lottery,
      order: order.map(id => ({ id, name: name.get(id), size: size.get(id) || 0 })),
      lotteryTeams: d.lottery ? null : lotteryTeams,
      rounds: Math.max(0, ...list.map(p => p.round)), picks: list,
      current: d.status === 'live' && current ? current.id : null, rosterFull: ROSTER_FULL,
      clock: clockOf(d, d.status === 'live' && current),
      // Temps écoulé, en attente de la décision du commissaire.
      overtime: !!(d.status === 'live' && current && d.overtime_pick === current.id),
      warnings: Object.fromEntries(warns.map(w => [w.team_id, w.n]))
    };
  }

  app.get('/api/draft', h(async (req, res) => {
    const year = Number(req.query.year) || await currentYear();
    if (!year) return res.json({ year: null });
    await advance(year).catch(() => {});
    const { rows } = await pool.query(`SELECT DISTINCT year FROM draft_picks ORDER BY year`);
    res.json({ ...(await board(year)), years: rows.map(r => r.year) });
  }));

  app.post('/api/draft/pick', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    const B = await board(year);
    if (B.status !== 'live') throw err('Le repêchage n\'est pas commencé');
    const onClock = B.picks.find(p => p.id === B.current);
    // Choix fait : celui demandé (commissaire), sinon celui au tour, sinon un choix passé de l'équipe (en retard).
    let cur = req.body.pickId && req.me.isAdmin ? B.picks.find(p => p.id === Number(req.body.pickId) && !p.used && !p.player) : null;
    if (!cur && onClock && (onClock.owner_team_id === req.me.teamId || req.me.isAdmin)) cur = onClock;
    if (!cur) cur = B.picks.find(p => p.passed && p.owner_team_id === req.me.teamId);
    if (!cur) throw err(onClock ? `C'est au tour de ${onClock.owner_team}` : 'Le repêchage est terminé', onClock ? 403 : 400);
    const late = cur.id !== B.current;
    const playerId = Number(req.body.playerId);
    const result = await inTransaction(async c => {
      const { rows: pl } = await c.query(`SELECT p.*, pk.team_id FROM players p LEFT JOIN picks pk ON pk.player_id=p.id WHERE p.id=$1`, [playerId]);
      if (!pl[0]) throw err('Joueur introuvable', 404);
      if (pl[0].team_id) throw err('Ce joueur appartient déjà à une équipe');
      // Maximum par position (art. 1.2) et plafond (art. 3) ; le commissaire peut passer outre.
      const { rows: roster } = await c.query(`SELECT p.* FROM players p JOIN picks pk ON pk.player_id=p.id WHERE pk.team_id=$1`, [cur.owner_team_id]);
      const s = rules.teamSummary(roster.concat(pl[0]).map(p => ({ ...p, aav: Number(p.aav || 0) })), { cap: Number(await getConfig('cap', 104000000)), floor: 0 });
      const blocking = s.issues.filter(i => /maximum|Plafond/.test(i));
      if (blocking.length && !(req.me.isAdmin && req.body.force)) throw err(`Sélection impossible : ${blocking.join(' · ')}`);
      const { rowCount } = await c.query(`UPDATE draft_picks SET used=TRUE, player_id=$2, picked_at=NOW(), passed=FALSE WHERE id=$1 AND NOT used`, [cur.id, playerId]);
      if (!rowCount) throw err('Ce choix vient d\'être utilisé, recharge la page');
      if (!late) await restartClock(c, year);
      await movePlayers(c, [{ playerId, toTeamId: cur.owner_team_id }], 'Repêchage',
        `${year} · ronde ${cur.round}, choix ${cur.overall}${cur.owner_team_id !== cur.original_team_id ? ' (de ' + cur.original_team + ')' : ''}`, req.me.name);
      return { player: pl[0].name, team: cur.owner_team, overall: cur.overall, late };
    });
    notify({ kind: 'draft', title: `🎯 Choix #${result.overall}${late ? ' (en retard)' : ''} : ${result.team}`, body: `${result.player} est repêché.`, link: '#/repechage', dedupe: `draft:${year}:pick:${cur.id}` });
    notifyOnClock(year).catch(() => {});
    res.json(result);
  }));

  // ---------- Commissaire ----------

  admin.post('/draft/settings', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    await getDraft(year, true);
    if (req.body.weights) {
      const w = req.body.weights.map(v => Math.max(0, Math.round(Number(v) || 0))).slice(0, 5);
      await pool.query(`UPDATE drafts SET weights=$2, updated_at=NOW() WHERE year=$1`, [year, w]);
    }
    if (req.body.order) {
      const o = req.body.order.map(Number);
      await pool.query(`UPDATE drafts SET team_order=$2, updated_at=NOW() WHERE year=$1`, [year, o]);
    }
    if (req.body.resetOrder) await pool.query(`UPDATE drafts SET team_order=$2, lottery=NULL, updated_at=NOW() WHERE year=$1`, [year, await defaultOrder()]);
    res.json({ ok: true });
  }));

  // Loterie (art. 4.4) : les 5 premiers de l'ordre actuel (les 5 pires) se disputent les choix 1 à 5.
  admin.post('/draft/lottery', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    const d = await getDraft(year, true);
    if (d.status !== 'setup') throw err('Le repêchage est déjà commencé');
    // Toujours à partir de l'ordre de base : refaire la loterie ne la fait pas dépendre de la précédente.
    const base = d.lottery?.base || d.team_order;
    const draws = drawLottery(base.slice(0, 5), d.weights);
    const order = [...draws.map(x => x.team_id), ...base.slice(5)];
    const lottery = { at: new Date().toISOString(), draws, base };
    await pool.query(`UPDATE drafts SET team_order=$2, lottery=$3, updated_at=NOW() WHERE year=$1`, [year, order, lottery]);
    const { rows: tn } = await pool.query(`SELECT name FROM teams WHERE id=$1`, [draws[0].team_id]);
    notify({ kind: 'draft', title: `🎲 Loterie ${year} : ${tn[0]?.name} obtient le 1er choix !`, body: 'Voir l\'ordre complet du repêchage.', link: '#/repechage', dedupe: `draft:${year}:lottery:${lottery.at}` });
    res.json({ lottery });
  }));

  admin.post('/draft/start', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    await getDraft(year, true);
    if (req.body.pause || req.body.resume) {
      const d = await getDraft(year);
      if (req.body.pause && d.clock_paused_left === null) {
        const left = d.clock_started_at ? Math.max(0, Math.ceil(d.clock_seconds - (Date.now() - new Date(d.clock_started_at).getTime()) / 1000)) : d.clock_seconds;
        await pool.query(`UPDATE drafts SET clock_paused_left=$2 WHERE year=$1`, [year, left]);
      }
      if (req.body.resume && d.clock_paused_left !== null)
        await pool.query(`UPDATE drafts SET clock_started_at=NOW() - make_interval(secs => clock_seconds - clock_paused_left), clock_paused_left=NULL WHERE year=$1`, [year]);
      liveYear = year;
      return res.json({ ok: true });
    }
    await pool.query(`UPDATE drafts SET status=$2, clock_seconds=$3, clock_started_at=NOW(), clock_paused_left=NULL, overtime_pick=NULL, updated_at=NOW() WHERE year=$1`,
      [year, req.body.stop ? 'setup' : 'live', DEFAULT_CLOCK]);
    liveYear = req.body.stop ? null : year; lastCheck = Date.now();
    if (!req.body.stop) {
      notify({ kind: 'draft', title: `🏁 Le repêchage ${year} est commencé !`, body: 'Suis le tableau des choix en direct.', link: '#/repechage', dedupe: `draft:${year}:start:${Date.now()}` });
      notifyOnClock(year).catch(() => {});
    }
    res.json({ ok: true });
  }));

  // Temps écoulé : le commissaire passe au suivant, ou donne un avertissement et 1 minute de plus.
  admin.post('/draft/overtime', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    const B = await board(year);
    const cur = B.picks.find(p => p.id === B.current);
    if (!cur) throw err('Aucun choix en cours');
    if (req.body.action === 'pass') {
      await pool.query(`UPDATE draft_picks SET passed=TRUE WHERE id=$1 AND NOT used AND player_id IS NULL`, [cur.id]);
      await restartClock(pool, year);
      notify({ kind: 'draft', audience: `team:${cur.owner_team_id}`, title: `⏭ Ton choix #${cur.overall} est passé`,
        body: 'Le commissaire est passé au suivant. Tu peux faire ton choix en retard, quand tu veux.', link: '#/repechage', dedupe: `draft:${year}:passed:${cur.id}` });
      notifyOnClock(year).catch(() => {});
    } else if (req.body.action === 'warn') {
      await pool.query(`INSERT INTO draft_warnings(year, team_id, pick_id) VALUES($1,$2,$3)`, [year, cur.owner_team_id, cur.id]);
      await pool.query(`UPDATE drafts SET clock_started_at=NOW() - make_interval(secs => GREATEST(clock_seconds - $2, 0)), clock_paused_left=NULL, overtime_pick=NULL WHERE year=$1`, [year, EXTRA_TIME]);
      const n = (B.warnings[cur.owner_team_id] || 0) + 1;
      notify({ kind: 'draft', audience: `team:${cur.owner_team_id}`, title: `⚠️ Avertissement du commissaire (${n})`,
        body: `Tu as 1 minute de plus pour faire ton choix #${cur.overall}.`, link: '#/repechage', dedupe: `draft:${year}:warn:${cur.id}:${n}` });
    } else throw err('Action inconnue');
    res.json({ ok: true });
  }));

  // Fin du repêchage : les choix restants (équipes complètes) sont marqués non utilisés.
  admin.post('/draft/finish', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    const { rowCount } = await pool.query(`UPDATE draft_picks SET used=TRUE, note=COALESCE(note,'Non utilisé (équipe complète)') WHERE year=$1 AND NOT used`, [year]);
    await pool.query(`UPDATE drafts SET status='done', updated_at=NOW() WHERE year=$1`, [year]);
    liveYear = null;
    res.json({ closed: rowCount });
  }));

  admin.post('/draft/undo', h(async (req, res) => {
    const year = Number(req.body.year) || await currentYear();
    const r = await inTransaction(async c => {
      const { rows } = await c.query(`SELECT dp.id, dp.player_id, p.name FROM draft_picks dp JOIN players p ON p.id=dp.player_id
        WHERE dp.year=$1 AND dp.player_id IS NOT NULL ORDER BY dp.picked_at DESC LIMIT 1`, [year]);
      if (!rows[0]) throw err('Aucune sélection à annuler');
      await movePlayers(c, [{ playerId: rows[0].player_id, toTeamId: null }], 'Correction', 'Sélection au repêchage annulée', req.me.name);
      await c.query(`UPDATE draft_picks SET used=FALSE, player_id=NULL, picked_at=NULL, passed=FALSE WHERE id=$1`, [rows[0].id]);
      await restartClock(c, year);
      return rows[0].name;
    });
    res.json({ undone: r });
  }));

  async function status() {
    const year = await currentYear();
    if (!year) return null;
    const d = await getDraft(year);
    return d ? { year, status: d.status } : { year, status: 'none' };
  }

  return { initTables, status };
}

module.exports = { createDraft, drawLottery };
