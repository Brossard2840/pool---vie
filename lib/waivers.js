// Ballottage (art. 5.5 et 5.6) : un joueur libéré passe d'abord au ballottage. À la fin de la période,
// il va à l'équipe prioritaire qui l'a réclamé ; sinon, il devient agent libre.
// Priorité : avant le 1er novembre, le pire classement de la saison précédente ; ensuite, le pire
// pointage de la saison en cours. Égalité : le plus faible ratio de points par match.

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

function createWaivers(app, admin, deps) {
  const { pool, h, inTransaction, movePlayers, getConfig, setConfig, seasonId, rules, standings, claimPicks } = deps;
  const notify = deps.notify || (() => {});

  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS waivers(
        id SERIAL PRIMARY KEY,
        player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        from_team_id INT REFERENCES teams(id) ON DELETE SET NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ends_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        winner_team_id INT REFERENCES teams(id) ON DELETE SET NULL,
        note TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS waivers_open_player ON waivers(player_id) WHERE status='open';
      CREATE TABLE IF NOT EXISTS waiver_claims(
        waiver_id INT NOT NULL REFERENCES waivers(id) ON DELETE CASCADE,
        team_id INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        release_player_id INT REFERENCES players(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (waiver_id, team_id)
      );
      ALTER TABLE teams ADD COLUMN IF NOT EXISTS prev_rank INT;
    `);
  }

  const hours = async () => Math.max(1, Number(await getConfig('waiver_hours', 24)) || 24);
  const costsPick = async () => (await getConfig('waiver_costs_pick', '1')) !== '0';

  // Retire le joueur de son équipe et l'inscrit au ballottage.
  async function putOnWaivers(client, playerId, by, note) {
    const { rows } = await client.query(`SELECT team_id FROM picks WHERE player_id=$1`, [playerId]);
    const fromTeam = rows[0]?.team_id || null;
    await movePlayers(client, [{ playerId, toTeamId: null }], 'Libération', note || 'Au ballottage (art. 5.5)', by);
    await client.query(`
      INSERT INTO waivers(player_id, from_team_id, ends_at) VALUES($1, $2, NOW() + make_interval(hours => $3))
      ON CONFLICT (player_id) WHERE status='open' DO NOTHING`, [playerId, fromTeam, await hours()]);
    const { rows: info } = await client.query(`SELECT p.name, p.pos, p.nhl_team, t.name AS team FROM players p LEFT JOIN teams t ON t.id=$2 WHERE p.id=$1`, [playerId, fromTeam]);
    if (info[0]) notify({ kind: 'waiver', title: `⏳ Au ballottage : ${info[0].name}`,
      body: `${info[0].pos} · ${info[0].nhl_team || ''} — libéré par ${info[0].team || 'le commissaire'}. Réclamable pendant ${await hours()} h.`,
      link: '#/echanges', dedupe: `waiver:${playerId}:${new Date().toISOString().slice(0, 13)}` });
  }

  // Ordre de priorité de toutes les équipes, la première étant prioritaire.
  async function priorityOrder() {
    const table = await standings(); // [{ id, name, points, ppg, rank }]
    const season = await seasonId();
    const nov1 = new Date(`${season.slice(0, 4)}-11-01T00:00:00-04:00`);
    const { rows } = await pool.query(`SELECT id, prev_rank FROM teams`);
    const prev = new Map(rows.map(r => [r.id, r.prev_rank]));
    const usePrev = Date.now() < nov1.getTime() && rows.some(r => r.prev_rank);
    const sorted = table.slice().sort((a, b) => {
      if (usePrev) {
        // Rang le plus élevé = pire équipe. Une équipe sans rang (nouvelle) passe en premier.
        const ra = prev.get(a.id) ?? 999, rb = prev.get(b.id) ?? 999;
        if (ra !== rb) return rb - ra;
      } else if (a.points !== b.points) return a.points - b.points;
      return a.ppg - b.ppg;
    });
    return { basis: usePrev ? 'saison précédente' : 'saison en cours', teams: sorted.map((t, i) => ({ id: t.id, name: t.name, priority: i + 1, points: t.points, ppg: t.ppg, prev_rank: prev.get(t.id) ?? null })) };
  }

  // Vérifie que l'équipe peut accueillir le joueur (maximum par position, plafond).
  async function fits(client, teamId, playerId, releaseId) {
    const { rows: roster } = await client.query(`SELECT p.* FROM players p JOIN picks pk ON pk.player_id=p.id WHERE pk.team_id=$1`, [teamId]);
    const { rows: pl } = await client.query(`SELECT * FROM players WHERE id=$1`, [playerId]);
    const after = roster.filter(p => p.id !== releaseId).concat(pl).map(p => ({ ...p, aav: Number(p.aav || 0) }));
    const s = rules.teamSummary(after, { cap: Number(await getConfig('cap', 104000000)), floor: 0 });
    return s.issues.filter(i => /maximum|Plafond/.test(i));
  }

  // Fin de période : attribution au réclamant prioritaire qui respecte les règles.
  async function processDue() {
    const { rows: due } = await pool.query(`SELECT id FROM waivers WHERE status='open' AND ends_at <= NOW() ORDER BY ends_at`);
    if (!due.length) return 0;
    const order = (await priorityOrder()).teams.map(t => t.id);
    for (const { id } of due) {
      try {
        await inTransaction(async c => {
          const { rows: w } = await c.query(`SELECT w.*, p.name FROM waivers w JOIN players p ON p.id=w.player_id WHERE w.id=$1 AND w.status='open' FOR UPDATE OF w`, [id]);
          if (!w[0]) return;
          const { rows: claims } = await c.query(`SELECT * FROM waiver_claims WHERE waiver_id=$1`, [id]);
          claims.sort((a, b) => order.indexOf(a.team_id) - order.indexOf(b.team_id));
          for (const cl of claims) {
            if (cl.release_player_id) {
              const { rows } = await c.query(`SELECT team_id FROM picks WHERE player_id=$1`, [cl.release_player_id]);
              if (rows[0]?.team_id !== cl.team_id) continue;
            }
            if ((await fits(c, cl.team_id, w[0].player_id, cl.release_player_id)).length) continue;
            let pick = null;
            if (await costsPick()) {
              pick = (await claimPicks(cl.team_id)).forced;
              if (!pick) continue;
            }
            const { rows: tn } = await c.query(`SELECT name FROM teams WHERE id=$1`, [cl.team_id]);
            if (cl.release_player_id) await putOnWaivers(c, cl.release_player_id, tn[0].name, `Pour faire place à ${w[0].name}`);
            await movePlayers(c, [{ playerId: w[0].player_id, toTeamId: cl.team_id }], 'Ballottage',
              `Réclamé au ballottage${pick ? ' contre ' + pick.label : ''} (art. 5.6)`, tn[0].name);
            if (pick) {
              await c.query(`UPDATE draft_picks SET used=TRUE, note=$2 WHERE id=$1`, [pick.id, `Abandonné pour ${w[0].name} (ballottage)`]);
              await c.query(`INSERT INTO moves(draft_pick_id, player_name, from_team, to_team, kind, note, by_team)
                VALUES($1,$2,$3,NULL,'Abandon',$4,$3)`, [pick.id, pick.label, tn[0].name, `Pour réclamer ${w[0].name} au ballottage`]);
            }
            await c.query(`UPDATE waivers SET status='claimed', winner_team_id=$2 WHERE id=$1`, [id, cl.team_id]);
            notify({ kind: 'waiver', title: `🏒 ${w[0].name} réclamé au ballottage`, body: `${tn[0].name} obtient ${w[0].name}${pick ? ' contre ' + pick.label.replace('Choix ', 'le choix ') : ''} (art. 5.6)`,
              link: '#/historique', dedupe: `waiver:${id}:done` });
            return;
          }
          await c.query(`UPDATE waivers SET status='cleared', note=$2 WHERE id=$1`,
            [id, claims.length ? 'Aucune réclamation valide' : 'Aucune réclamation']);
          await c.query(`INSERT INTO moves(player_id, player_name, kind, note) VALUES($1,$2,'Ballottage',$3)`,
            [w[0].player_id, w[0].name, 'Non réclamé : devient agent libre']);
          notify({ kind: 'waiver', title: `🆓 ${w[0].name} devient agent libre`, body: 'Personne ne l\'a réclamé au ballottage. Réclamable contre un choix de 1re ronde (art. 5.4).',
            link: '#/joueurs', dedupe: `waiver:${id}:done` });
        });
      } catch (e) { console.error(`Ballottage ${id} :`, e.message); }
    }
    return due.length;
  }

  async function onWaivers(playerId) {
    const { rows } = await pool.query(`SELECT id, ends_at FROM waivers WHERE player_id=$1 AND status='open'`, [playerId]);
    return rows[0] || null;
  }

  // ---------- API ----------

  app.get('/api/waivers', h(async (req, res) => {
    await processDue();
    const { rows } = await pool.query(`
      SELECT w.*, p.name, p.pos, p.aav, p.nhl_team, p.gp, p.goals, p.assists, p.wins, p.ot_losses, p.shutouts,
        f.name AS from_team, wt.name AS winner_team,
        (SELECT COUNT(*)::int FROM waiver_claims c WHERE c.waiver_id=w.id) AS claims,
        EXISTS (SELECT 1 FROM waiver_claims c WHERE c.waiver_id=w.id AND c.team_id=$1) AS mine
      FROM waivers w JOIN players p ON p.id=w.player_id
      LEFT JOIN teams f ON f.id=w.from_team_id LEFT JOIN teams wt ON wt.id=w.winner_team_id
      WHERE w.status='open' OR w.started_at > NOW() - INTERVAL '30 days'
      ORDER BY (w.status='open') DESC, w.ends_at DESC LIMIT 100`, [req.me.teamId]);
    res.json({
      waivers: rows.map(r => ({ ...r, aav: r.aav === null ? null : Number(r.aav), pts: rules.poolPoints(r) })),
      priority: await priorityOrder(), hours: await hours(), costsPick: await costsPick()
    });
  }));

  // Un pooler libère un de ses joueurs (art. 5.5).
  app.post('/api/release', h(async (req, res) => {
    const playerId = Number(req.body.playerId);
    if (!req.me.isAdmin && await deps.deadlinePassed()) throw err('Après la date limite, l\'équipe reste la même jusqu\'aux listes de protection (art. 5.5)');
    await inTransaction(async c => {
      const { rows } = await c.query(`SELECT pk.team_id, p.pos, p.name FROM picks pk JOIN players p ON p.id=pk.player_id WHERE pk.player_id=$1`, [playerId]);
      if (!rows[0]) throw err('Ce joueur n\'appartient à aucune équipe');
      if (rows[0].team_id !== req.me.teamId && !req.me.isAdmin) throw err('Ce joueur n\'est pas dans ton équipe', 403);
      const { rows: n } = await c.query(`SELECT COUNT(*)::int n FROM picks pk JOIN players p ON p.id=pk.player_id WHERE pk.team_id=$1 AND p.pos=$2`,
        [rows[0].team_id, rows[0].pos]);
      if (n[0].n - 1 < rules.POS_MIN[rows[0].pos] && !req.me.isAdmin)
        throw err(`Impossible : il faut au moins ${rules.POS_MIN[rows[0].pos]} ${rules.POS_LABEL[rows[0].pos].toLowerCase()} en tout temps (art. 1.1)`);
      await putOnWaivers(c, playerId, req.me.name);
    });
    res.json({ ok: true });
  }));

  app.post('/api/waivers/:id/claim', h(async (req, res) => {
    const id = Number(req.params.id), releaseId = req.body.releasePlayerId ? Number(req.body.releasePlayerId) : null;
    if (!req.me.isAdmin && await deps.deadlinePassed()) throw err('La date limite des transactions est passée (art. 5.1)');
    const { rows } = await pool.query(`SELECT * FROM waivers WHERE id=$1 AND status='open' AND ends_at > NOW()`, [id]);
    if (!rows[0]) throw err('Ce ballottage est terminé');
    if (rows[0].from_team_id === req.me.teamId) throw err('Tu ne peux pas réclamer un joueur que tu viens de libérer');
    if (await costsPick() && !(await claimPicks(req.me.teamId)).forced) throw err('Aucun choix de 1re ronde disponible pour réclamer (art. 5.4)');
    if (releaseId) {
      const { rows: r } = await pool.query(`SELECT team_id FROM picks WHERE player_id=$1`, [releaseId]);
      if (r[0]?.team_id !== req.me.teamId) throw err('Le joueur à libérer ne fait pas partie de ton équipe');
    }
    const problems = await fits(pool, req.me.teamId, rows[0].player_id, releaseId);
    if (problems.length) throw err(`Réclamation impossible : ${problems.join(' · ')}. Choisis un joueur à libérer.`);
    await pool.query(`
      INSERT INTO waiver_claims(waiver_id, team_id, release_player_id) VALUES($1,$2,$3)
      ON CONFLICT (waiver_id, team_id) DO UPDATE SET release_player_id=EXCLUDED.release_player_id`, [id, req.me.teamId, releaseId]);
    res.json({ ok: true });
  }));

  app.post('/api/waivers/:id/unclaim', h(async (req, res) => {
    await pool.query(`DELETE FROM waiver_claims WHERE waiver_id=$1 AND team_id=$2`, [req.params.id, req.me.teamId]);
    res.json({ ok: true });
  }));

  // Commissaire : mettre fin tout de suite (traitement immédiat) ou annuler (le joueur devient agent libre).
  admin.post('/waivers/:id/end', h(async (req, res) => {
    await pool.query(`UPDATE waivers SET ends_at=NOW() WHERE id=$1 AND status='open'`, [req.params.id]);
    await processDue();
    res.json({ ok: true });
  }));
  admin.post('/waivers/:id/cancel', h(async (req, res) => {
    await pool.query(`UPDATE waivers SET status='cleared', note='Annulé par le commissaire' WHERE id=$1 AND status='open'`, [req.params.id]);
    res.json({ ok: true });
  }));

  admin.post('/waiver-settings', h(async (req, res) => {
    const { hours: hrs, costsPick: cost, prevRanks } = req.body;
    if (hrs !== undefined) await setConfig('waiver_hours', Math.max(1, Math.min(168, Number(hrs) || 24)));
    if (cost !== undefined) await setConfig('waiver_costs_pick', cost ? '1' : '0');
    if (prevRanks) for (const [teamId, rank] of Object.entries(prevRanks)) {
      await pool.query(`UPDATE teams SET prev_rank=$2 WHERE id=$1`, [teamId, rank ? Number(rank) : null]);
    }
    res.json({ ok: true });
  }));

  return { initTables, putOnWaivers, processDue, onWaivers, priorityOrder };
}

module.exports = { createWaivers };
