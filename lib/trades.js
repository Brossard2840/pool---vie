// Échanges entre poolers (joueurs et choix de repêchage) et suivi des choix.
// Déroulement : proposée → acceptée par l'autre pooler → approuvée par le commissaire → complétée.
// (Sans approbation requise, l'acceptation complète l'échange directement.)

const STATUS = {
  proposed: 'proposée', accepted: 'en attente du commissaire', completed: 'complétée',
  refused: 'refusée', cancelled: 'annulée', rejected: 'rejetée par le commissaire', expired: 'expirée'
};
const ROUNDS = 12;

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

function pickLabel(p) {
  const r = p.round === 1 ? '1re' : `${p.round}e`;
  return `Choix ${p.year} · ${r} ronde · ${p.original_team}`;
}

function nextDraftYear(seasonId) {
  // Saison 2026-27 → prochain repêchage : 2027 (art. 4.6).
  return Number(String(seasonId).slice(4, 8));
}

function registerTrades(app, admin, { pool, h, inTransaction, movePlayers, getConfig, setConfig, seasonId }) {
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS draft_picks(
        id SERIAL PRIMARY KEY,
        year INT NOT NULL,
        round INT NOT NULL,
        original_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        owner_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (year, round, original_team_id)
      );
      CREATE TABLE IF NOT EXISTS trades(
        id SERIAL PRIMARY KEY,
        from_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        to_team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'proposed',
        message TEXT,
        reply TEXT,
        counter_of INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trade_items(
        trade_id INT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
        from_team_id INT NOT NULL,
        player_id INT REFERENCES players(id) ON DELETE CASCADE,
        draft_pick_id INT REFERENCES draft_picks(id) ON DELETE CASCADE
      );
      ALTER TABLE moves ADD COLUMN IF NOT EXISTS draft_pick_id INT REFERENCES draft_picks(id) ON DELETE SET NULL;
    `);
    // Chaque équipe possède ses choix du prochain repêchage, rondes 1 à 12.
    await generatePicks(nextDraftYear(await seasonId()));
  }

  async function generatePicks(year, rounds = ROUNDS) {
    const { rowCount } = await pool.query(`
      INSERT INTO draft_picks(year, round, original_team_id, owner_team_id)
      SELECT $1, r, t.id, t.id FROM teams t CROSS JOIN generate_series(1, $2) AS r
      ON CONFLICT DO NOTHING`, [year, rounds]);
    return rowCount;
  }

  async function picksWithNames(where = '', params = []) {
    const { rows } = await pool.query(`
      SELECT dp.id, dp.year, dp.round, dp.used, dp.original_team_id, dp.owner_team_id,
        o.name AS original_team, w.name AS owner_team
      FROM draft_picks dp JOIN teams o ON o.id = dp.original_team_id JOIN teams w ON w.id = dp.owner_team_id
      ${where} ORDER BY dp.year, dp.round, LOWER(o.name)`, params);
    return rows.map(p => ({ ...p, label: pickLabel(p) }));
  }

  // Date limite (art. 5.1) : 21 h, heure de l'Est, le jour inscrit par le commissaire.
  async function deadlinePassed() {
    const d = await getConfig('trade_deadline');
    if (!d) return false;
    const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
    return now > `${d}T21:00`;
  }

  async function loadTrades(where, params) {
    const { rows: trades } = await pool.query(`
      SELECT tr.*, f.name AS from_team, t.name AS to_team FROM trades tr
      JOIN teams f ON f.id = tr.from_team_id JOIN teams t ON t.id = tr.to_team_id
      ${where} ORDER BY tr.updated_at DESC LIMIT 200`, params);
    if (!trades.length) return [];
    const ids = trades.map(t => t.id);
    const { rows: items } = await pool.query(`
      SELECT ti.*, p.name AS player_name, p.pos, p.aav, p.nhl_team,
        dp.year, dp.round, o.name AS original_team
      FROM trade_items ti
      LEFT JOIN players p ON p.id = ti.player_id
      LEFT JOIN draft_picks dp ON dp.id = ti.draft_pick_id LEFT JOIN teams o ON o.id = dp.original_team_id
      WHERE ti.trade_id = ANY($1::int[])`, [ids]);
    return trades.map(t => ({
      ...t, status_label: STATUS[t.status] || t.status,
      items: items.filter(i => i.trade_id === t.id).map(i => ({
        from_team_id: i.from_team_id,
        kind: i.player_id ? 'player' : 'pick',
        id: i.player_id || i.draft_pick_id,
        label: i.player_id ? i.player_name : pickLabel(i),
        pos: i.pos || null, aav: i.aav === null || i.aav === undefined ? null : Number(i.aav), nhl_team: i.nhl_team || null
      }))
    }));
  }

  // Vérifie que chaque élément appartient encore à l'équipe qui l'envoie.
  async function checkOwnership(client, items) {
    for (const i of items) {
      if (i.player_id) {
        const { rows } = await client.query(`SELECT team_id FROM picks WHERE player_id=$1`, [i.player_id]);
        if (rows[0]?.team_id !== i.from_team_id) return false;
      } else {
        const { rows } = await client.query(`SELECT owner_team_id, used FROM draft_picks WHERE id=$1`, [i.draft_pick_id]);
        if (!rows[0] || rows[0].used || rows[0].owner_team_id !== i.from_team_id) return false;
      }
    }
    return true;
  }

  async function execute(tradeId, by) {
    return inTransaction(async c => {
      const { rows } = await c.query(`SELECT * FROM trades WHERE id=$1 FOR UPDATE`, [tradeId]);
      const t = rows[0];
      const { rows: items } = await c.query(`SELECT * FROM trade_items WHERE trade_id=$1`, [tradeId]);
      if (!(await checkOwnership(c, items))) {
        await c.query(`UPDATE trades SET status='expired', updated_at=NOW() WHERE id=$1`, [tradeId]);
        return { expired: true };
      }
      const other = id => (id === t.from_team_id ? t.to_team_id : t.from_team_id);
      const note = `Échange #${tradeId}`;
      await movePlayers(c, items.filter(i => i.player_id).map(i => ({ playerId: i.player_id, toTeamId: other(i.from_team_id) })),
        'Échange', note, by);
      for (const i of items.filter(i => i.draft_pick_id)) {
        const to = other(i.from_team_id);
        const { rows: pk } = await c.query(`
          UPDATE draft_picks dp SET owner_team_id=$2 FROM teams o, teams f, teams t2
          WHERE dp.id=$1 AND o.id=dp.original_team_id AND f.id=$3 AND t2.id=$2
          RETURNING dp.year, dp.round, o.name AS original_team, f.name AS from_name, t2.name AS to_name`,
          [i.draft_pick_id, to, i.from_team_id]);
        await c.query(`INSERT INTO moves(draft_pick_id, player_name, from_team, to_team, kind, note, by_team)
          VALUES($1,$2,$3,$4,'Échange',$5,$6)`, [i.draft_pick_id, pickLabel(pk[0]), pk[0].from_name, pk[0].to_name, note, by]);
      }
      await c.query(`UPDATE trades SET status='completed', updated_at=NOW() WHERE id=$1`, [tradeId]);
      // Les autres offres en attente qui contenaient ces éléments ne sont plus valides.
      await c.query(`
        UPDATE trades SET status='expired', updated_at=NOW()
        WHERE id<>$1 AND status IN ('proposed','accepted') AND id IN (
          SELECT trade_id FROM trade_items WHERE player_id IN (SELECT player_id FROM trade_items WHERE trade_id=$1 AND player_id IS NOT NULL)
             OR draft_pick_id IN (SELECT draft_pick_id FROM trade_items WHERE trade_id=$1 AND draft_pick_id IS NOT NULL))`, [tradeId]);
      return { completed: true };
    });
  }

  async function approvalRequired() {
    return (await getConfig('trade_approval', '1')) !== '0';
  }

  // ---------- Choix de repêchage ----------

  app.get('/api/picks', h(async (req, res) => {
    await generatePicks(nextDraftYear(await seasonId())); // équipes ajoutées depuis
    const picks = await picksWithNames();
    const { rows: history } = await pool.query(`
      SELECT * FROM moves WHERE draft_pick_id IS NOT NULL ORDER BY at DESC, id DESC LIMIT 300`);
    res.json({ picks, history });
  }));

  admin.post('/picks/generate', h(async (req, res) => {
    const year = Number(req.body.year);
    if (!(year >= 2020 && year <= 2100)) throw err('Année invalide');
    res.json({ created: await generatePicks(year, Math.min(Number(req.body.rounds) || ROUNDS, 30)) });
  }));

  // Correction manuelle du propriétaire d'un choix (ex. choix cédé pour un agent libre, art. 5.4).
  admin.post('/picks/:id', h(async (req, res) => {
    const { ownerTeamId, used, note } = req.body;
    await inTransaction(async c => {
      const [p] = await picksWithNames('WHERE dp.id=$1', [req.params.id]);
      if (!p) throw err('Choix introuvable', 404);
      if (ownerTeamId && Number(ownerTeamId) !== p.owner_team_id) {
        const { rows } = await c.query(`UPDATE draft_picks SET owner_team_id=$2 WHERE id=$1 RETURNING owner_team_id`, [p.id, ownerTeamId]);
        const { rows: t } = await c.query(`SELECT name FROM teams WHERE id=$1`, [rows[0].owner_team_id]);
        await c.query(`INSERT INTO moves(draft_pick_id, player_name, from_team, to_team, kind, note, by_team)
          VALUES($1,$2,$3,$4,'Correction',$5,$6)`, [p.id, p.label, p.owner_team, t[0].name, note || null, req.me.name]);
      }
      if (used !== undefined) await c.query(`UPDATE draft_picks SET used=$2 WHERE id=$1`, [p.id, !!used]);
    });
    res.json({ ok: true });
  }));

  // ---------- Échanges ----------

  app.get('/api/trades', h(async (req, res) => {
    const trades = req.me.isAdmin
      ? await loadTrades('', [])
      : await loadTrades('WHERE tr.from_team_id=$1 OR tr.to_team_id=$1 OR tr.status=\'completed\'', [req.me.teamId]);
    res.json({
      trades, approvalRequired: await approvalRequired(),
      deadline: await getConfig('trade_deadline'), deadlinePassed: await deadlinePassed()
    });
  }));

  app.post('/api/trades', h(async (req, res) => {
    const { toTeamId, give = {}, get = {}, message, counterOf } = req.body;
    const from = req.me.teamId, to = Number(toTeamId);
    if (!to || to === from) throw err('Choisis une autre équipe');
    if (!req.me.isAdmin && await deadlinePassed()) throw err('La date limite des transactions est passée (art. 5.1)');
    const items = [
      ...(give.players || []).map(id => ({ from_team_id: from, player_id: Number(id) })),
      ...(give.picks || []).map(id => ({ from_team_id: from, draft_pick_id: Number(id) })),
      ...(get.players || []).map(id => ({ from_team_id: to, player_id: Number(id) })),
      ...(get.picks || []).map(id => ({ from_team_id: to, draft_pick_id: Number(id) }))
    ];
    if (!items.some(i => i.from_team_id === from) && !items.some(i => i.from_team_id === to)) throw err('Ajoute au moins un élément');
    const id = await inTransaction(async c => {
      if (!(await checkOwnership(c, items))) throw err('Un des éléments n\'appartient pas (ou plus) à cette équipe');
      if (counterOf) {
        const { rowCount } = await c.query(`
          UPDATE trades SET status='refused', reply=COALESCE(reply,'Contre-offre'), updated_at=NOW()
          WHERE id=$1 AND to_team_id=$2 AND status='proposed'`, [counterOf, from]);
        if (!rowCount) throw err('L\'offre d\'origine n\'est plus en attente');
      }
      const { rows } = await c.query(`INSERT INTO trades(from_team_id, to_team_id, message, counter_of) VALUES($1,$2,$3,$4) RETURNING id`,
        [from, to, (message || '').slice(0, 500) || null, counterOf || null]);
      for (const i of items) {
        await c.query(`INSERT INTO trade_items(trade_id, from_team_id, player_id, draft_pick_id) VALUES($1,$2,$3,$4)`,
          [rows[0].id, i.from_team_id, i.player_id || null, i.draft_pick_id || null]);
      }
      return rows[0].id;
    });
    res.json({ id });
  }));

  async function getTrade(id) {
    const { rows } = await pool.query(`SELECT * FROM trades WHERE id=$1`, [id]);
    if (!rows[0]) throw err('Échange introuvable', 404);
    return rows[0];
  }

  app.post('/api/trades/:id/:action', h(async (req, res) => {
    const t = await getTrade(req.params.id);
    const me = req.me.teamId, action = req.params.action, reply = (req.body.reply || '').slice(0, 500) || null;
    const set = (status) => pool.query(`UPDATE trades SET status=$2, reply=COALESCE($3, reply), updated_at=NOW() WHERE id=$1`, [t.id, status, reply]);

    if (action === 'cancel') {
      if (t.from_team_id !== me || !['proposed', 'accepted'].includes(t.status)) throw err('Impossible d\'annuler cette offre');
      await set('cancelled');
    } else if (action === 'refuse') {
      if (t.to_team_id !== me || t.status !== 'proposed') throw err('Impossible de refuser cette offre');
      await set('refused');
    } else if (action === 'accept') {
      if (t.to_team_id !== me || t.status !== 'proposed') throw err('Impossible d\'accepter cette offre');
      if (!req.me.isAdmin && await deadlinePassed()) throw err('La date limite des transactions est passée (art. 5.1)');
      if (await approvalRequired()) await set('accepted');
      else {
        await set('accepted');
        const r = await execute(t.id, req.me.name);
        if (r.expired) throw err('Un des éléments a changé d\'équipe : l\'offre a expiré');
      }
    } else if (action === 'approve' || action === 'reject') {
      if (!req.me.isAdmin) throw err('Réservé au commissaire', 403);
      if (action === 'approve' && t.status !== 'accepted') throw err('L\'autre pooler doit d\'abord accepter l\'offre');
      if (!['proposed', 'accepted'].includes(t.status)) throw err('Cet échange n\'est plus en attente');
      if (action === 'reject') await set('rejected');
      else {
        if (reply) await pool.query(`UPDATE trades SET reply=$2 WHERE id=$1`, [t.id, reply]);
        const r = await execute(t.id, req.me.name);
        if (r.expired) throw err('Un des éléments a changé d\'équipe : l\'offre a expiré');
      }
    } else throw err('Action inconnue', 404);
    res.json({ ok: true });
  }));

  admin.post('/trade-settings', h(async (req, res) => {
    const { approval, deadline } = req.body;
    if (approval !== undefined) await setConfig('trade_approval', approval ? '1' : '0');
    if (deadline !== undefined) {
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw err('Date au format AAAA-MM-JJ');
      await setConfig('trade_deadline', deadline || '');
    }
    res.json({ ok: true });
  }));

  // Nombre d'actions en attente pour la pastille de l'onglet Échanges.
  async function pendingCount(me) {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int n FROM trades
      WHERE (to_team_id=$1 AND status='proposed') OR ($2 AND status='accepted')`, [me.teamId, !!me.isAdmin]);
    return rows[0].n;
  }

  return { initTables, generatePicks, pendingCount };
}

module.exports = { registerTrades, pickLabel, nextDraftYear };
