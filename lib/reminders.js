// Notifications planifiées : rappels de dates limites, alertes d'alignement, résumé du matin,
// fin prochaine d'un ballottage et changements d'équipe LNH des joueurs du pool.
// Chaque notification a une clé unique (« dedupe ») : elle ne part qu'une fois même si la tâche repasse.

const SUMMARY_HOUR = 9;   // résumé du matin et rappels, heure de l'Est
const TZ = 'America/Toronto';

function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
function addDays(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const ord = n => n === 1 ? '1re' : `${n}e`;
const frDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function createReminders({ pool, getConfig, setConfig, notify, buildLeague, rules }) {
  // Rappels la veille et le matin d'une date limite (transactions, art. 5.1 ; protection, art. 4.2).
  async function deadlines(now) {
    const trade = await getConfig('trade_deadline');
    if (trade && now.hour >= SUMMARY_HOUR) {
      if (now.date === addDays(trade, -1)) notify({ kind: 'reminder', title: '⏰ Date limite des transactions demain', body: `${frDate(trade)} à 21 h. Après, plus aucun mouvement jusqu'aux listes de protection (art. 5.1).`, link: '#/echanges', dedupe: `rem:trade:${trade}:-1` });
      if (now.date === trade) notify({ kind: 'reminder', title: '⏰ Dernier jour pour les transactions !', body: 'Jusqu\'à 21 h ce soir (art. 5.1).', link: '#/echanges', dedupe: `rem:trade:${trade}:0` });
    }
    const status = await getConfig('prot_status'), prot = await getConfig('prot_deadline'), season = await getConfig('prot_season');
    if (status === 'open' && prot && now.hour >= SUMMARY_HOUR && [addDays(prot, -1), prot].includes(now.date)) {
      const { rows } = await pool.query(`SELECT t.id FROM teams t WHERE NOT EXISTS (SELECT 1 FROM protection_submissions s WHERE s.team_id=t.id AND s.season=$1)`, [season]);
      for (const t of rows) notify({ kind: 'reminder', audience: `team:${t.id}`, title: now.date === prot ? '🛡️ Dernier jour pour ta liste de protection !' : '🛡️ Ta liste de protection est due demain',
        body: `Date limite : ${frDate(prot)} à 21 h. Tu ne l'as pas encore remise.`, link: '#/protection', dedupe: `rem:prot:${prot}:${now.date}:${t.id}` });
    }
  }

  // Ballottage qui se termine dans moins de 2 heures.
  async function waiversEnding() {
    const { rows } = await pool.query(`
      SELECT w.id, p.name, w.ends_at FROM waivers w JOIN players p ON p.id=w.player_id
      WHERE w.status='open' AND w.ends_at > NOW() AND w.ends_at <= NOW() + INTERVAL '2 hours'`);
    for (const w of rows) notify({ kind: 'reminder', title: `⏳ Dernière chance : ${w.name}`, body: 'Son ballottage se termine dans moins de 2 heures.', link: '#/echanges', dedupe: `waiver:${w.id}:soon` });
  }

  // Alignement non conforme : plafond, plancher, minimum ou maximum par position (art. 1 et 3). Une fois par jour.
  async function rosterAlerts(now, league) {
    // Pas pendant l'entre-saison (listes de protection, repêchage) : les alignements sont incomplets.
    const { rows: d } = await pool.query(`SELECT 1 FROM drafts WHERE status IN ('setup','live') LIMIT 1`);
    if (d.length || ['open', 'revealed', 'applied'].includes(await getConfig('prot_status'))) return;
    for (const t of league.teams) {
      if (!t.issues.length || !t.size) continue;
      notify({ kind: 'alert', audience: `team:${t.id}`, title: '⚠️ Ton alignement n\'est pas conforme', body: t.issues.join(' · '),
        link: '#/mon-equipe', dedupe: `alert:${t.id}:${now.date}:${t.issues.join('|')}` });
    }
  }

  // Joueurs du pool qui changent d'équipe dans la LNH (échange, ballottage de la LNH…).
  async function nhlMoves() {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.nhl_team, t.name AS team FROM picks pk JOIN players p ON p.id=pk.player_id JOIN teams t ON t.id=pk.team_id
      WHERE p.nhl_team IS NOT NULL AND p.nhl_team <> ''`);
    const prev = JSON.parse((await getConfig('roster_nhl_teams')) || 'null');
    const now = Object.fromEntries(rows.map(r => [r.id, r.nhl_team]));
    if (prev) for (const r of rows) {
      if (prev[r.id] && prev[r.id] !== r.nhl_team)
        notify({ kind: 'nhl', title: `🔁 ${r.name} passe de ${prev[r.id]} à ${r.nhl_team}`, body: `Joueur de ${r.team}.`, link: '#/joueurs', dedupe: `nhl:${r.id}:${prev[r.id]}:${r.nhl_team}` });
    }
    await setConfig('roster_nhl_teams', JSON.stringify(now));
  }

  // Résumé du matin, pour chaque pooler : ses points d'hier, son rang, ses meilleurs joueurs.
  async function morningSummary(now, league) {
    if (now.hour < SUMMARY_HOUR) return;
    const yesterday = addDays(now.date, -1);
    const { rows: logs } = await pool.query(`
      SELECT pk.team_id, l.name, l.pos, l.goals, l.assists, l.wins, l.ot_losses, l.shutouts
      FROM game_log l JOIN players p ON p.nhl_id=l.player_nhl_id JOIN picks pk ON pk.player_id=p.id
      WHERE l.game_date=$1 AND l.game_type IN (2,3)`, [yesterday]);
    if (!logs.length) return;  // pas de match hier
    const snap = JSON.parse((await getConfig('rank_snapshot')) || 'null');
    const ranks = Object.fromEntries(league.teams.map(t => [t.id, t.rank]));
    for (const t of league.teams) {
      const mine = logs.filter(l => l.team_id === t.id).map(l => ({ ...l, pts: rules.poolPoints(l) })).sort((a, b) => b.pts - a.pts);
      const pts = mine.reduce((s, l) => s + l.pts, 0);
      const before = snap && snap.date !== now.date ? snap.ranks[t.id] : null;
      const move = before && before !== t.rank ? (before > t.rank ? ` (↑ de ${ord(before)})` : ` (↓ de ${ord(before)})`) : '';
      const stars = mine.filter(l => l.pts > 0).slice(0, 3).map(l => `${l.name} ${l.pts}`).join(', ');
      notify({ kind: 'summary', audience: `team:${t.id}`, title: `☀️ Hier : ${pts >= 0 ? '+' : ''}${pts} pts · ${ord(t.rank)} place${move}`,
        body: stars ? `Meilleurs : ${stars}. Total : ${t.points} pts.` : `Aucun point hier. Total : ${t.points} pts.`,
        link: `#/direct/${yesterday}`, dedupe: `summary:${now.date}:${t.id}` });
    }
    if (!snap || snap.date !== now.date) await setConfig('rank_snapshot', JSON.stringify({ date: now.date, ranks }));
  }

  let running = false, last = 0;
  async function tick() {
    if (running || Date.now() - last < 9 * 60 * 1000) return;
    running = true; last = Date.now();
    try {
      const now = etParts();
      const league = await buildLeague();
      await deadlines(now);
      await waiversEnding();
      await rosterAlerts(now, league);
      await nhlMoves();
      await morningSummary(now, league);
    } catch (e) { console.warn('Rappels :', e.message); }
    finally { running = false; }
  }

  return { tick };
}

module.exports = { createReminders, etParts };
