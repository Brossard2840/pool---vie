// Notifications planifiées : rappels de dates limites, alertes d'alignement, résumé du matin,
// fin prochaine d'un ballottage et changements d'équipe LNH des joueurs du pool.
// Chaque notification a une clé unique (« dedupe ») : elle ne part qu'une fois même si la tâche repasse.

const SUMMARY_HOUR = 9;   // rappels de dates limites, heure de l'Est
const RECAP_HOUR = 7;     // récap de la soirée d'hier
const TZ = 'America/Toronto';

function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
function addDays(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const ord = n => n === 1 ? '1re' : `${n}e`;
const pl = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

// Équipes LNH : nom et forme « de/des/du » pour les manchettes (« victoire écrasante des Islanders »).
const NHL = {
  ANA: ['Ducks', 'des'], BOS: ['Bruins', 'des'], BUF: ['Sabres', 'des'], CGY: ['Flames', 'des'], CAR: ['Hurricanes', 'des'],
  CHI: ['Blackhawks', 'des'], COL: ['Avalanche', "de l'"], CBJ: ['Blue Jackets', 'des'], DAL: ['Stars', 'des'], DET: ['Red Wings', 'des'],
  EDM: ['Oilers', 'des'], FLA: ['Panthers', 'des'], LAK: ['Kings', 'des'], MIN: ['Wild', 'du'], MTL: ['Canadiens', 'des'],
  NSH: ['Predators', 'des'], NJD: ['Devils', 'des'], NYI: ['Islanders', 'des'], NYR: ['Rangers', 'des'], OTT: ['Sénateurs', 'des'],
  PHI: ['Flyers', 'des'], PIT: ['Penguins', 'des'], SJS: ['Sharks', 'des'], SEA: ['Kraken', 'du'], STL: ['Blues', 'des'],
  TBL: ['Lightning', 'du'], TOR: ['Maple Leafs', 'des'], UTA: ['Mammoth', 'du'], VAN: ['Canucks', 'des'], VGK: ['Golden Knights', 'des'],
  WSH: ['Capitals', 'des'], WPG: ['Jets', 'des']
};
const club = a => NHL[a]?.[0] || a;
const deClub = a => NHL[a] ? (NHL[a][1] === "de l'" ? `de l'${NHL[a][0]}` : `${NHL[a][1]} ${NHL[a][0]}`) : `de ${a}`;
const frDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function createReminders({ pool, getConfig, setConfig, notify, buildLeague, rules, postWall = async () => {} }) {
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

  // Récap du matin (7 h) : la soirée d'hier en manchettes. Une seule notification par pooler :
  // sa propre soirée d'abord, puis les gros faits saillants du pool et de la LNH. Le récap va aussi sur le mur.
  async function morningRecap(now, league) {
    if (now.hour < RECAP_HOUR) return;
    if (JSON.parse((await getConfig('rank_snapshot')) || 'null')?.date === now.date) return;  // déjà fait ce matin
    const yesterday = addDays(now.date, -1);
    const { rows: games } = await pool.query(`
      SELECT id, state, away, home, away_score, home_score, final_synced FROM games
      WHERE game_date=$1 AND game_type IN (2,3)`, [yesterday]);
    if (!games.length) return;  // pas de match hier
    // On attend que tous les matchs d'hier soient terminés et compilés (au plus tard à 11 h).
    if (games.some(g => !g.final_synced) && now.hour < 11) return;
    const { rows: logs } = await pool.query(`
      SELECT pk.team_id, p.name, l.pos, l.team AS club, l.goals, l.assists, l.wins, l.ot_losses, l.shutouts
      FROM game_log l JOIN players p ON p.nhl_id=l.player_nhl_id JOIN picks pk ON pk.player_id=p.id
      WHERE l.game_date=$1 AND l.game_type IN (2,3)`, [yesterday]);

    const teamName = Object.fromEntries(league.teams.map(t => [t.id, t.name]));
    const snap = JSON.parse((await getConfig('rank_snapshot')) || 'null');
    const prev = snap && snap.date !== now.date ? snap : null;  // classement d'hier matin, avant les matchs
    const nightPts = t => prev?.points?.[t.id] !== undefined ? t.points - prev.points[t.id]
      : logs.filter(l => l.team_id === t.id).reduce((s, l) => s + rules.poolPoints(l), 0);
    const teams = league.teams.map(t => ({ ...t, night: nightPts(t), before: prev?.ranks?.[t.id] || null }));

    // Manchettes, de la plus spectaculaire à la plus ordinaire.
    const heads = [];
    const add = (score, text) => heads.push({ score, text });
    const leader = teams.find(t => t.rank === 1);
    if (leader && prev && leader.before && leader.before !== 1) add(100, `👑 ${leader.name} prend la 1re place du pool !`);
    for (const l of logs) {
      const who = `${l.name} (${teamName[l.team_id]})`;
      if (l.goals >= 3) add(90 + l.goals, `🎩 TOUR DU CHAPEAU : ${who}, ${l.goals} buts${l.assists ? ` et ${pl(l.assists, 'passe')}` : ''} !`);
      else if (l.goals + l.assists >= 4) add(80 + l.goals + l.assists, `🔥 ${who} : ${l.goals + l.assists} points (${l.goals} B, ${l.assists} A)`);
      if (l.shutouts) add(75, `🧱 Blanchissage de ${who}`);
    }
    const climbs = teams.filter(t => t.before && t.before - t.rank >= 2).sort((a, b) => (b.before - b.rank) - (a.before - a.rank));
    for (const t of climbs.slice(0, 2)) add(60 + t.before - t.rank, `🚀 ${t.name} grimpe de ${t.before - t.rank} rangs, maintenant ${ord(t.rank)}`);
    const falls = teams.filter(t => t.before && t.rank - t.before >= 3).sort((a, b) => (b.rank - b.before) - (a.rank - a.before));
    if (falls[0]) add(50, `📉 Glissade pour ${falls[0].name} : ${ord(falls[0].before)} → ${ord(falls[0].rank)}`);
    const best = [...teams].sort((a, b) => b.night - a.night)[0];
    if (best && best.night > 0) add(55, `💪 Pooler de la soirée : ${best.name}, +${best.night} pts`);
    const zero = teams.filter(t => t.size && t.night <= 0);
    if (zero.length === 1 && best?.night >= 5) add(20, `🥶 Soirée à oublier pour ${zero[0].name} : aucun point`);
    for (const g of games.filter(g => g.away_score !== null && Math.abs(g.away_score - g.home_score) >= 4)) {
      const [w, l, ws, ls] = g.away_score > g.home_score ? [g.away, g.home, g.away_score, g.home_score] : [g.home, g.away, g.home_score, g.away_score];
      add(40 + ws - ls, `💥 Victoire écrasante ${deClub(w)} : ${ws}-${ls} contre les ${club(l)}`);
    }
    let chLine = null;  // le résultat du CH est toujours dans le récap
    const ch = games.find(g => (g.away === 'MTL' || g.home === 'MTL') && g.away_score !== null);
    if (ch) {
      const mtl = ch.away === 'MTL' ? ch.away_score : ch.home_score, opp = ch.away === 'MTL' ? ch.home_score : ch.away_score;
      const vs = ch.away === 'MTL' ? ch.home : ch.away;
      chLine = (mtl > opp ? `🔵⚪🔴 Le CH gagne ${mtl}-${opp} contre les ${club(vs)} !` : `🔵⚪🔴 Le CH s'incline ${opp}-${mtl} contre les ${club(vs)}`);
    }
    heads.sort((a, b) => b.score - a.score);
    const top = [...heads.slice(0, chLine ? 6 : 7).map(h => h.text), ...(chLine ? [chLine] : [])];
    const nGames = games.length;

    // Sur le mur : le récap de toute la gang.
    if (top.length) await postWall(`🗞️ Le récap d'hier soir (${pl(nGames, 'match')})\n${top.join('\n')}`, '#/classement', `recap:${yesterday}`);

    // Notification de chaque pooler : sa soirée, puis les manchettes.
    for (const t of teams) {
      const mine = logs.filter(l => l.team_id === t.id).map(l => ({ ...l, pts: rules.poolPoints(l) })).filter(l => l.pts > 0).sort((a, b) => b.pts - a.pts);
      const move = t.before && t.before !== t.rank ? (t.before > t.rank ? ` (↑ ${t.before - t.rank})` : ` (↓ ${t.rank - t.before})`) : '';
      const stars = mine.slice(0, 3).map(l => `${l.name} ${l.pts}`).join(', ');
      const me = `Toi : ${t.night >= 0 ? '+' : ''}${t.night} pts, ${ord(t.rank)}${move}${stars ? ` · ${stars}` : ''}`;
      const headline = top[0] ? top[0] : `☀️ ${pl(nGames, 'match')} hier soir`;
      notify({ kind: 'summary', audience: `team:${t.id}`, title: `🗞️ ${headline.replace(/^\S+\s/, '')}`.slice(0, 120),
        body: [me, ...top.slice(1).filter(x => x !== chLine).slice(0, 4), ...(chLine && top[0] !== chLine ? [chLine] : [])].join('\n'), link: '#/mur', dedupe: `recap:${yesterday}:${t.id}` });
    }
    await setConfig('rank_snapshot', JSON.stringify({ date: now.date,
      ranks: Object.fromEntries(league.teams.map(t => [t.id, t.rank])), points: Object.fromEntries(league.teams.map(t => [t.id, t.points])) }));
  }

  // Classement de référence pour le récap de demain, même les jours sans match.
  async function snapshotIfNone(now, league) {
    if (now.hour < RECAP_HOUR) return;
    const snap = JSON.parse((await getConfig('rank_snapshot')) || 'null');
    if (snap?.date === now.date) return;
    const { rows } = await pool.query(`SELECT 1 FROM games WHERE game_date=$1 AND game_type IN (2,3) LIMIT 1`, [addDays(now.date, -1)]);
    if (rows.length) return;  // le récap s'en charge
    await setConfig('rank_snapshot', JSON.stringify({ date: now.date,
      ranks: Object.fromEntries(league.teams.map(t => [t.id, t.rank])), points: Object.fromEntries(league.teams.map(t => [t.id, t.points])) }));
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
      await morningRecap(now, league);
      await snapshotIfNone(now, league);
    } catch (e) { console.warn('Rappels :', e.message); }
    finally { running = false; }
  }

  return { tick };
}

module.exports = { createReminders, etParts };
