// Contrats : import en lot (liste collée depuis PuckPedia ou un tableur) et échéances de chaque 1er juillet.
// Une ligne par joueur : nom, salaire (AAV) et fin du contrat, dans n'importe quel ordre, par exemple
//   Connor McDavid  $12,500,000  2026-27     ·   Nick Suzuki, 7.875M, 2030     ·   Cole Caufield	7 850 000	2031
// « Fin 2028 » = dernière saison 2027-28 (même convention que partout dans l'application).
const rules = require('./rules');

const NHL_TEAMS = new Set(['ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD',
  'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG']);
const POS = /^(C|LW|RW|L|R|F|D|G|LD|RD|W)$/i;

function err(message, status = 400) { return Object.assign(new Error(message), { status }); }

// Salaire : « $12,500,000 », « 12 500 000 $ », « 7.5M », « 7,5 M$ », « 950000 ».
function parseMoney(s) {
  const t = String(s).replace(/ /g, ' ');
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:M\$?|millions?)(?![a-z])/i);
  if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 1e6);
  m = t.match(/\$?\s*(?<!\d)(\d{1,3}(?:[ ,.]\d{3}){1,2})(?!\d)\s*\$?/);
  if (m) return Number(m[1].replace(/[ ,.]/g, ''));
  m = t.match(/\$\s*(\d{6,8})|(\d{6,8})\s*\$/);
  if (m) return Number(m[1] || m[2]);
  m = t.match(/(?<![\d-])(\d{6,8})(?![\d-])/);
  return m ? Number(m[1]) : null;
}

// Fin du contrat : « 2027-28 » ou « 2027/28 » → 2028 ; une année seule (2020 à 2049) → cette année-là.
function parseEnd(s) {
  const t = String(s);
  let m = t.match(/\b(20[2-4]\d)\s*[-–\/]\s*(\d{2}|20[2-4]\d)\b/);
  if (m) return m[2].length === 2 ? Number(m[1].slice(0, 2) + m[2]) : Number(m[2]);
  const years = [...t.matchAll(/(?<![\d,.])(20[2-4]\d)(?![\d]|[,.]\d)/g)].map(x => Number(x[1]));
  return years.length ? years[years.length - 1] : null;
}

function parseLine(line) {
  const raw = line.trim();
  if (!raw || /^(nom|name|player|joueur)\b/i.test(raw)) return null;
  const parts = raw.split(/\t|;|\s{2,}|,(?=\s*[^\d\s])|,\s*(?=\d+(?:[.,]\d+)?\s*M)/).map(x => x.trim()).filter(Boolean);
  // Nom : le texte avant le premier chiffre ou symbole de monnaie, sans position ni équipe.
  const first = raw.search(/[\d$]/);
  let name = (first > 0 ? raw.slice(0, first) : parts[0] || raw).replace(/[,;|]+\s*$/, '').trim();
  let team = null;
  const words = name.split(/\s+|,/).filter(Boolean);
  while (words.length > 1) {
    const w = words[words.length - 1].replace(/[()[\]]/g, '');
    if (NHL_TEAMS.has(w.toUpperCase()) && w === w.toUpperCase()) { team = w.toUpperCase(); words.pop(); }
    else if (POS.test(w) && w === w.toUpperCase()) words.pop();
    else break;
  }
  name = words.join(' ').replace(/[()[\]]/g, '').trim();
  const rest = first > 0 ? raw.slice(first) : raw;
  const aav = parseMoney(rest);
  // La fin se cherche hors du salaire (« 12,500,000 » ne doit pas donner 2050).
  const end = parseEnd(rest.replace(/\$?\s*(?<!\d)\d{1,3}(?:[ ,.]\d{3}){1,2}(?!\d)\s*\$?|(?<!\d)\d{6,8}(?!\d)|\d+(?:[.,]\d+)?\s*M\$?/gi, ' '));
  if (!team) { const t = rest.match(/\b([A-Z]{3})\b/); if (t && NHL_TEAMS.has(t[1])) team = t[1]; }
  return { raw, name, team, aav, end };
}

function parseList(text) {
  return String(text || '').split(/\r?\n/).map(parseLine).filter(r => r && r.name);
}

function createContracts(admin, { pool, h, inTransaction, getConfig, setConfig, notify = () => {} }) {
  // Aperçu : chaque ligne reliée à un joueur, avec l'ancien et le nouveau contrat.
  admin.post('/contracts/preview', h(async (req, res) => {
    const lines = parseList(req.body.text);
    if (!lines.length) throw err('Aucune ligne reconnue. Une ligne par joueur : nom, salaire, fin du contrat.');
    if (lines.length > 1500) throw err('Maximum 1500 lignes à la fois');
    const keys = [...new Set(lines.map(l => rules.normalizeName(l.name)))];
    const { rows: cands } = await pool.query(`
      SELECT p.id, p.name, p.name_key, p.pos, p.nhl_team, p.nhl_id, p.aav, p.contract_end, t.name AS owner
      FROM players p LEFT JOIN picks pk ON pk.player_id=p.id LEFT JOIN teams t ON t.id=pk.team_id
      WHERE p.name_key = ANY($1::text[])`, [keys]);
    const rows = lines.map(l => {
      let c = cands.filter(p => p.name_key === rules.normalizeName(l.name));
      if (c.length > 1) { const linked = c.filter(p => p.nhl_id); if (linked.length) c = linked; }
      if (c.length > 1 && l.team) c = c.filter(p => p.nhl_team === l.team);
      if (c.length > 1) { const owned = c.filter(p => p.owner); if (owned.length === 1) c = owned; }
      const base = { line: l.raw, name: l.name, aav: l.aav, end: l.end };
      if (!c.length) return { ...base, status: 'introuvable' };
      if (c.length > 1) return { ...base, status: 'ambigu', choices: c.map(p => ({ id: p.id, name: p.name, team: p.nhl_team, owner: p.owner })) };
      const p = c[0], oldAav = p.aav === null ? null : Number(p.aav);
      const problems = [];
      if (l.aav !== null && (l.aav < 500000 || l.aav > 25000000)) problems.push('salaire inhabituel');
      if (l.aav === null && l.end === null) problems.push('ni salaire ni fin de contrat');
      const changed = (l.aav !== null && l.aav !== oldAav) || (l.end !== null && l.end !== p.contract_end);
      return { ...base, status: problems.length ? 'à vérifier' : changed ? 'changé' : 'identique', problems,
        player: { id: p.id, name: p.name, team: p.nhl_team, owner: p.owner, aav: oldAav, end: p.contract_end } };
    });
    res.json({ rows, counts: rows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {}) });
  }));

  // Application : seulement les lignes cochées (id, salaire, fin).
  admin.post('/contracts/apply', h(async (req, res) => {
    const list = (req.body.rows || []).map(r => ({ id: Number(r.id), aav: r.aav === null || r.aav === undefined ? null : Math.round(Number(r.aav)),
      end: r.end === null || r.end === undefined ? null : Math.round(Number(r.end)) })).filter(r => r.id);
    if (!list.length) throw err('Rien à appliquer');
    const n = await inTransaction(async c => {
      let k = 0;
      for (const r of list) {
        const { rowCount } = await c.query(`UPDATE players SET aav=COALESCE($2, aav), contract_end=COALESCE($3, contract_end) WHERE id=$1`, [r.id, r.aav, r.end]);
        k += rowCount;
      }
      return k;
    });
    await setConfig('contracts_import_at', new Date().toISOString());
    res.json({ updated: n });
  }));

  // Contrats à surveiller : joueurs des alignements dont le contrat est échu ou la fin inconnue.
  async function watchList(year) {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.pos, p.nhl_team, p.aav, p.contract_end, t.id AS team_id, t.name AS owner
      FROM picks pk JOIN players p ON p.id=pk.player_id JOIN teams t ON t.id=pk.team_id
      WHERE p.contract_end IS NULL OR p.contract_end <= $1 ORDER BY p.contract_end NULLS LAST, t.name, p.name`, [year]);
    return rows.map(r => ({ ...r, aav: r.aav === null ? null : Number(r.aav) }));
  }
  // Après le 1er juillet, les contrats qui finissaient cette année-là sont échus.
  const expiredYear = d => (d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1);
  admin.get('/contracts/watch', h(async (req, res) => {
    const year = expiredYear(new Date());
    res.json({ year, players: await watchList(year), importAt: await getConfig('contracts_import_at') });
  }));

  // 1er juillet : avis au commissaire et à chaque pooler (une fois par année).
  async function julyFirst(now = new Date()) {
    if (now.getMonth() < 6) return;
    const year = now.getFullYear();
    if (Number(await getConfig('contracts_checked')) === year) return;
    await setConfig('contracts_checked', year);
    const expired = (await watchList(year)).filter(p => p.contract_end !== null && p.contract_end <= year);
    if (!expired.length) return;
    const byTeam = new Map();
    for (const p of expired) { if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, []); byTeam.get(p.team_id).push(p); }
    for (const [teamId, list] of byTeam) notify({ kind: 'alert', audience: `team:${teamId}`, title: `📝 ${list.length} contrat${list.length > 1 ? 's' : ''} échu${list.length > 1 ? 's' : ''} dans ton équipe`,
      body: `${list.slice(0, 6).map(p => p.name).join(', ')}${list.length > 6 ? '…' : ''}. Le commissaire mettra les nouveaux contrats à jour.`, link: '#/mon-equipe', dedupe: `contracts:${year}:${teamId}` });
    notify({ kind: 'admin', audience: 'admin', title: `📝 1er juillet : ${expired.length} contrats échus à mettre à jour`,
      body: 'Commissaire → Contrats : colle les nouveaux contrats (PuckPedia) pour tout mettre à jour d\'un coup.', link: '#/commissaire', dedupe: `contracts:${year}:admin` });
  }

  return { julyFirst };
}

module.exports = { createContracts, parseList, parseLine, parseMoney, parseEnd };
