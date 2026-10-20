// Règles de la convention collective du Pool à vie.
// Fonctions pures (aucun accès à la base de données) pour pouvoir les tester facilement.

// Art. 1.1 et 1.2 : minimums en tout temps, maximum = double du minimum.
const POS_MIN = { F: 9, D: 4, G: 2 };
const POS_MAX = { F: 18, D: 8, G: 4 };
// Art. 2.3 et 3.1 : nombre de joueurs qui comptent par position (points et masse salariale).
const COUNTED = { F: 9, D: 4, G: 2 };
const POS_LABEL = { F: 'Attaquants', D: 'Défenseurs', G: 'Gardiens' };

// Art. 2.1 : pointage en saison régulière.
function poolPoints(p) {
  const base = (p.goals || 0) + (p.assists || 0);
  if (p.pos !== 'G') return base;
  return base + 2 * (p.wins || 0) + (p.ot_losses || 0) + (p.shutouts || 0);
}

// Résumé d'une équipe : qui compte pour les points (top 9/4/2 en points),
// qui compte pour la masse salariale (top 9/4/2 en AAV), conformité.
function teamSummary(players, { cap, floor }) {
  const byPos = { F: [], D: [], G: [] };
  for (const p of players) if (byPos[p.pos]) byPos[p.pos].push({ ...p, pts: poolPoints(p) });

  let points = 0, capUsed = 0, gp = 0, goals = 0;
  const positions = {};
  for (const pos of ['F', 'D', 'G']) {
    const list = byPos[pos];
    const n = COUNTED[pos];
    const scorers = new Set(list.slice().sort((a, b) => b.pts - a.pts || b.goals - a.goals).slice(0, n).map(p => p.id));
    const earners = list.slice().sort((a, b) => (b.aav || 0) - (a.aav || 0)).slice(0, n);
    const earnerIds = new Set(earners.map(p => p.id));
    for (const p of list) {
      p.counts_points = scorers.has(p.id);
      p.counts_cap = earnerIds.has(p.id);
      if (p.counts_points) { points += p.pts; gp += p.gp || 0; goals += p.goals || 0; }
      if (p.counts_cap) capUsed += Number(p.aav || 0);
    }
    list.sort((a, b) => b.pts - a.pts || (b.aav || 0) - (a.aav || 0));
    positions[pos] = {
      players: list,
      count: list.length,
      min: POS_MIN[pos],
      max: POS_MAX[pos],
      // Plus petit salaire parmi ceux qui comptent (s'il y a déjà n joueurs) :
      // un nouveau joueur mieux payé le pousserait hors du calcul.
      lowestCounted: earners.length >= n ? Number(earners[n - 1].aav || 0) : null
    };
  }

  // Salaire maximal qu'on pourrait ajouter à chaque position sans dépasser le plafond.
  const capSpace = cap - capUsed;
  for (const pos of ['F', 'D', 'G']) {
    const lc = positions[pos].lowestCounted;
    positions[pos].maxNewSalary = lc === null ? capSpace : capSpace + lc;
  }

  const issues = [];
  for (const pos of ['F', 'D', 'G']) {
    const c = positions[pos].count;
    if (c < POS_MIN[pos]) issues.push(`${POS_LABEL[pos]} : ${c} (minimum ${POS_MIN[pos]})`);
    if (c > POS_MAX[pos]) issues.push(`${POS_LABEL[pos]} : ${c} (maximum ${POS_MAX[pos]})`);
  }
  if (capUsed > cap) issues.push(`Plafond dépassé de ${money(capUsed - cap)}`);
  if (floor && capUsed < floor) issues.push(`Sous le plancher de ${money(floor - capUsed)}`);

  return {
    points, capUsed, capSpace, gp, goals,
    ppg: gp ? points / gp : 0,
    size: players.length,
    positions, issues
  };
}

// Art. 6.2 : égalité départagée par le ratio de points par match, puis le nombre de buts.
function rankTeams(summaries) {
  return summaries.slice().sort((a, b) =>
    b.points - a.points || b.ppg - a.ppg || b.goals - a.goals
  ).map((t, i) => ({ ...t, rank: i + 1, playoffs: i < 8 }));
}

function money(n) {
  return Math.round(n).toLocaleString('fr-CA') + ' $';
}

// Saison LNH en cours selon la date : à partir de septembre, c'est la nouvelle saison.
function currentSeasonId(date = new Date()) {
  const y = date.getFullYear();
  return date.getMonth() >= 8 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

function normalizeName(str) {
  return (str || '').toString().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
}

// Position LNH (C, L, R, D, G) ou saisie libre (A, Att, Déf...) → F / D / G.
function posGroup(code) {
  const c = (code || '').toString().trim().toUpperCase();
  if (c === 'G' || c.startsWith('GAR')) return 'G';
  if (c === 'D' || c.startsWith('DEF') || c.startsWith('DÉF')) return 'D';
  if (['C', 'L', 'R', 'F', 'LW', 'RW', 'A'].includes(c) || c.startsWith('ATT')) return 'F';
  return null;
}

module.exports = {
  POS_MIN, POS_MAX, COUNTED, POS_LABEL,
  poolPoints, teamSummary, rankTeams, money, currentSeasonId, normalizeName, posGroup
};
