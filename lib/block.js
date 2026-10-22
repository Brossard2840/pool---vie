// Marché des transactions : chaque pooler y affiche les joueurs qu'il est prêt à échanger (avec une note),
// et ce qu'il cherche. Les autres peuvent signaler leur intérêt (anonyme pour le propriétaire) ou faire une offre.

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

function createBlock(app, { pool, h, notify = () => {} }) {
  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trade_block(
        player_id INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS trade_block_interest(
        player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (player_id, team_id)
      );
      CREATE TABLE IF NOT EXISTS team_needs(
        team_id INT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        note TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  // Un joueur échangé ou libéré quitte le marché de son ancien propriétaire.
  async function cleanup() {
    await pool.query(`DELETE FROM trade_block b WHERE NOT EXISTS (SELECT 1 FROM picks pk WHERE pk.player_id=b.player_id AND pk.team_id=b.team_id)`);
    await pool.query(`DELETE FROM trade_block_interest i WHERE NOT EXISTS (SELECT 1 FROM trade_block b WHERE b.player_id=i.player_id)`);
  }

  async function ids() {
    await cleanup();
    const { rows } = await pool.query(`SELECT player_id FROM trade_block`);
    return rows.map(r => r.player_id);
  }

  app.get('/api/block', h(async (req, res) => {
    await cleanup();
    const { rows } = await pool.query(`
      SELECT b.player_id AS id, b.team_id, t.name AS team, b.note, b.created_at, p.name, p.pos, p.nhl_team, p.aav, p.age, p.contract_end,
        p.gp, p.goals, p.assists, p.wins, p.ot_losses, p.shutouts,
        (SELECT COUNT(*)::int FROM trade_block_interest i WHERE i.player_id=b.player_id) AS interest,
        EXISTS (SELECT 1 FROM trade_block_interest i WHERE i.player_id=b.player_id AND i.team_id=$1) AS mine
      FROM trade_block b JOIN players p ON p.id=b.player_id JOIN teams t ON t.id=b.team_id
      ORDER BY b.created_at DESC`, [req.me.teamId]);
    const { rows: needs } = await pool.query(`
      SELECT n.team_id, t.name AS team, n.note, n.updated_at FROM team_needs n JOIN teams t ON t.id=n.team_id ORDER BY n.updated_at DESC`);
    res.json({
      // Le nombre d'intéressés n'est montré qu'au propriétaire du joueur.
      entries: rows.map(r => ({ ...r, aav: r.aav === null ? null : Number(r.aav), interest: r.team_id === req.me.teamId ? r.interest : null })),
      needs
    });
  }));

  app.post('/api/block', h(async (req, res) => {
    const playerId = Number(req.body.playerId);
    const note = String(req.body.note || '').trim().slice(0, 200) || null;
    const { rows } = await pool.query(`SELECT p.name, p.pos FROM picks pk JOIN players p ON p.id=pk.player_id WHERE pk.player_id=$1 AND pk.team_id=$2`, [playerId, req.me.teamId]);
    if (!rows[0]) throw err('Ce joueur n\'est pas dans ton alignement');
    const { rows: ins } = await pool.query(`
      INSERT INTO trade_block(player_id, team_id, note) VALUES($1,$2,$3)
      ON CONFLICT (player_id) DO UPDATE SET note=EXCLUDED.note, team_id=EXCLUDED.team_id
      RETURNING (xmax = 0) AS created`, [playerId, req.me.teamId, note]);
    if (ins[0].created) notify({ kind: 'block', title: `📣 ${req.me.name} met ${rows[0].name} sur le marché`,
      body: note || `${rows[0].pos} disponible par échange. Fais une offre !`, link: '#/marche',
      dedupe: `block:${playerId}:${req.me.teamId}:${new Date().toISOString().slice(0, 10)}`, exclude: req.me.teamId });
    res.json({ ok: true });
  }));

  app.delete('/api/block/:id', h(async (req, res) => {
    await pool.query(`DELETE FROM trade_block WHERE player_id=$1 AND (team_id=$2 OR $3)`, [req.params.id, req.me.teamId, !!req.me.isAdmin]);
    await cleanup();
    res.json({ ok: true });
  }));

  // « Intéressé » : le propriétaire est avisé sans savoir qui (ça reste une rumeur).
  app.post('/api/block/:id/interest', h(async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT b.team_id, p.name FROM trade_block b JOIN players p ON p.id=b.player_id WHERE b.player_id=$1`, [id]);
    if (!rows[0]) throw err('Ce joueur n\'est plus sur le marché', 404);
    if (rows[0].team_id === req.me.teamId) throw err('C\'est ton joueur');
    const del = await pool.query(`DELETE FROM trade_block_interest WHERE player_id=$1 AND team_id=$2`, [id, req.me.teamId]);
    if (!del.rowCount) {
      await pool.query(`INSERT INTO trade_block_interest(player_id, team_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [id, req.me.teamId]);
      const { rows: c } = await pool.query(`SELECT COUNT(*)::int n FROM trade_block_interest WHERE player_id=$1`, [id]);
      notify({ kind: 'block', audience: `team:${rows[0].team_id}`, title: `👀 Rumeur : un pooler s'intéresse à ${rows[0].name}`,
        body: c[0].n > 1 ? `${c[0].n} poolers intéressés. Attends les offres… ou va les chercher !` : 'Il ne t\'a pas encore fait d\'offre. À suivre…',
        link: '#/marche', dedupe: `interest:${id}:${req.me.teamId}:${new Date().toISOString().slice(0, 10)}` });
    }
    res.json({ ok: true });
  }));

  app.post('/api/block/needs', h(async (req, res) => {
    const note = String(req.body.note || '').trim().slice(0, 200);
    if (!note) await pool.query(`DELETE FROM team_needs WHERE team_id=$1`, [req.me.teamId]);
    else await pool.query(`INSERT INTO team_needs(team_id, note) VALUES($1,$2) ON CONFLICT (team_id) DO UPDATE SET note=EXCLUDED.note, updated_at=NOW()`, [req.me.teamId, note]);
    res.json({ ok: true });
  }));

  return { initTables, ids };
}

module.exports = { createBlock };
