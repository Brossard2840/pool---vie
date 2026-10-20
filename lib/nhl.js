// Statistiques officielles de la LNH (api.nhle.com, API publique utilisée par NHL.com).
// Deux rapports couvrent toute la ligue : patineurs et gardiens.
const { posGroup } = require('./rules');

const BASE = process.env.NHL_API_BASE || 'https://api.nhle.com/stats/rest/en';
const PAGE = 100;

async function fetchReport(kind, seasonId, gameTypeId) {
  const rows = [];
  const sort = kind === 'goalie' ? 'wins' : 'points';
  for (let start = 0; ; start += PAGE) {
    const url = `${BASE}/${kind}/summary?isAggregate=false&isGame=false` +
      `&sort=${encodeURIComponent(JSON.stringify([{ property: sort, direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }]))}` +
      `&start=${start}&limit=${PAGE}` +
      `&cayenneExp=${encodeURIComponent(`seasonId=${seasonId} and gameTypeId=${gameTypeId}`)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'pool-a-vie' } });
    if (!res.ok) throw new Error(`API LNH ${kind} : HTTP ${res.status}`);
    const json = await res.json();
    const data = json.data || [];
    rows.push(...data);
    const total = Number(json.total ?? 0);
    if (data.length < PAGE || (total && rows.length >= total)) break;
  }
  return rows;
}

// Un joueur échangé en cours de saison peut apparaître sur plusieurs lignes : on additionne.
function combine(rows, isGoalie) {
  const map = new Map();
  for (const r of rows) {
    const id = r.playerId;
    if (!id) continue;
    const name = (isGoalie ? r.goalieFullName : r.skaterFullName) || `${r.firstName || ''} ${r.lastName || ''}`.trim();
    const teams = String(r.teamAbbrevs || '').split(',').map(s => s.trim()).filter(Boolean);
    const cur = map.get(id) || {
      nhl_id: id, name,
      pos: isGoalie ? 'G' : (posGroup(r.positionCode) || 'F'),
      nhl_team: null, gp: 0, goals: 0, assists: 0, wins: 0, ot_losses: 0, shutouts: 0
    };
    if (teams.length) cur.nhl_team = teams[teams.length - 1];
    cur.gp += r.gamesPlayed || 0;
    cur.goals += r.goals || 0;
    cur.assists += r.assists || 0;
    if (isGoalie) {
      cur.wins += r.wins || 0;
      cur.ot_losses += r.otLosses || 0; // défaites en prolongation ET en fusillade
      cur.shutouts += r.shutouts || 0;
    }
    map.set(id, cur);
  }
  return [...map.values()];
}

async function fetchSeason(seasonId, gameTypeId = 2) {
  const [skaters, goalies] = await Promise.all([
    fetchReport('skater', seasonId, gameTypeId),
    fetchReport('goalie', seasonId, gameTypeId)
  ]);
  return [...combine(skaters, false), ...combine(goalies, true)];
}

module.exports = { fetchSeason, combine };
