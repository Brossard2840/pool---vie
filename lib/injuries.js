// Blessures : rapport des blessés de la LNH (flux public d'ESPN, mis à jour plusieurs fois par jour).
// Chaque joueur blessé reçoit un statut, la durée d'absence prévue (en français) et le commentaire d'origine.
// Le propriétaire d'un joueur du pool est avisé quand il se blesse ou que son statut change.
const rules = require('./rules');

const FEED = process.env.INJURY_FEED || 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries';
const REFRESH_MS = 2 * 3600 * 1000;

// Abréviations d'ESPN qui diffèrent de celles de la LNH.
const TEAM_FIX = { TB: 'TBL', NJ: 'NJD', SJ: 'SJS', LA: 'LAK', WAS: 'WSH', UTAH: 'UTA', MON: 'MTL', CLB: 'CBJ', NAS: 'NSH', VEG: 'VGK' };
const BODY = {
  'upper body': 'haut du corps', 'lower body': 'bas du corps', knee: 'genou', ankle: 'cheville', shoulder: 'épaule', head: 'tête',
  concussion: 'commotion cérébrale', hand: 'main', wrist: 'poignet', foot: 'pied', groin: 'aine', hip: 'hanche', back: 'dos',
  leg: 'jambe', hamstring: 'ischio-jambiers', illness: 'maladie', undisclosed: 'non dévoilée', finger: 'doigt', thumb: 'pouce',
  elbow: 'coude', neck: 'cou', face: 'visage', jaw: 'mâchoire', abdomen: 'abdomen', ribs: 'côtes', achilles: 'tendon d\'Achille',
  collarbone: 'clavicule', eye: 'œil', personal: 'raisons personnelles', 'not injury related': 'raisons personnelles'
};
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const UNIT = { day: 'jour', week: 'semaine', month: 'mois' };

function posGroup(abbr) {
  const a = String(abbr || '').toUpperCase();
  return a === 'G' ? 'G' : a === 'D' ? 'D' : a ? 'F' : null;
}

const plural = (n, u) => `${n} ${u}${n > 1 && u !== 'mois' ? 's' : ''}`;

// Durée prévue, à partir du statut, du commentaire et de la date de retour.
function duration({ status, comment, returnDate }) {
  const c = String(comment || '').toLowerCase();
  const st = String(status || '').toLowerCase();
  if (/rest of (the )?(regular )?season|out for the season|season-ending|remainder of the season/.test(c)) return 'absent pour la saison';
  if (/indefinitely|no timetable|without a timetable/.test(c)) return 'absence indéterminée';
  let m = c.match(/(?:at least |about |roughly |approximately |another |additional )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)(?:\s*(?:-|to)\s*(\d+|two|three|four|five|six|seven|eight|ten|twelve))?\s+(day|week|month)s?/);
  if (m) {
    const a = NUM[m[1]] ?? Number(m[1]), b = m[2] ? (NUM[m[2]] ?? Number(m[2])) : null, u = UNIT[m[3]];
    return `absent ${b ? `${a} à ${plural(b, u)}` : plural(a, u)}`;
  }
  if (/(a )?few weeks|several weeks|multiple weeks/.test(c)) return 'absent quelques semaines';
  if (/(a )?few days|several days/.test(c)) return 'absent quelques jours';
  if (/long[- ]term injured reserve|ltir/.test(c) || /long[- ]term/.test(st)) return 'liste des blessés à long terme';
  if (/day[- ]to[- ]day/.test(st) || /day[- ]to[- ]day/.test(c)) return 'au jour le jour';
  if (/questionable|game[- ]time decision/.test(st + ' ' + c)) return 'incertain pour le prochain match';
  if (returnDate) return 'retour prévu ' + new Date(returnDate + 'T12:00:00Z').toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  if (/injured reserve|\bir\b/.test(st + ' ' + c)) return 'sur la liste des blessés';
  if (/out/.test(st)) return 'absent, durée inconnue';
  return 'blessé';
}

function statusFr(st) {
  const s = String(st || '').toLowerCase();
  if (/long[- ]term/.test(s)) return 'Liste des blessés à long terme';
  if (/injured reserve|^ir$/.test(s)) return 'Liste des blessés';
  if (/day[- ]to[- ]day/.test(s)) return 'Au jour le jour';
  if (/questionable/.test(s)) return 'Incertain';
  if (/suspen/.test(s)) return 'Suspendu';
  if (/out/.test(s)) return 'Absent';
  return st || 'Blessé';
}

function bodyPart(type, comment) {
  const t = String(type || '').toLowerCase().trim();
  if (BODY[t]) return BODY[t];
  const m = String(comment || '').toLowerCase().match(/\(([a-z -]+)\)/);
  if (m && BODY[m[1].trim()]) return BODY[m[1].trim()];
  return t ? type : null;
}

// Lit le flux d'ESPN. Le format n'est pas documenté officiellement : on lit chaque champ prudemment.
function parseFeed(data) {
  const out = [];
  const teams = Array.isArray(data?.injuries) ? data.injuries : Array.isArray(data?.teams) ? data.teams : [];
  for (const t of teams) {
    const teamAbbr = t.team?.abbreviation || t.abbreviation || null;
    for (const i of t.injuries || []) {
      const a = i.athlete || {};
      const name = a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ');
      if (!name) continue;
      const status = i.status || i.type?.description || i.details?.fantasyStatus?.description || '';
      // Joueur de retour au jeu : on l'ignore.
      if (/^active$/i.test(status)) continue;
      const comment = i.shortComment || i.longComment || '';
      const analysis = i.shortComment && i.longComment && i.longComment !== i.shortComment ? i.longComment : '';
      const returnDate = (i.details?.returnDate || '').slice(0, 10) || null;
      const abbr = (a.team?.abbreviation || teamAbbr || '').toUpperCase();
      out.push({
        name, key: rules.normalizeName(name), pos: posGroup(a.position?.abbreviation), team: TEAM_FIX[abbr] || abbr || null,
        status, injury: bodyPart(i.details?.type, comment), returnDate, comment: comment.slice(0, 400), analysis: analysis.slice(0, 1500), date: i.date || null,
        dtd: /day[- ]to[- ]day|questionable/i.test(status)
      });
    }
  }
  for (const r of out) r.label = duration(r);
  return out;
}

function createInjuries({ pool, getConfig, setConfig, notify = () => {} }) {
  let byKey = new Map();

  async function initTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS injuries(
        name_key TEXT NOT NULL, pos TEXT, team TEXT, name TEXT, status TEXT, injury TEXT, label TEXT,
        return_date DATE, comment TEXT, dtd BOOLEAN NOT NULL DEFAULT FALSE, reported_at TIMESTAMPTZ,
        PRIMARY KEY (name_key, pos, team)
      );
      ALTER TABLE injuries ADD COLUMN IF NOT EXISTS analysis TEXT;
    `);
    await load();
  }

  async function load() {
    const { rows } = await pool.query(`SELECT * FROM injuries`);
    const m = new Map();
    for (const r of rows) { if (!m.has(r.name_key)) m.set(r.name_key, []); m.get(r.name_key).push(r); }
    byKey = m;
  }

  // Blessure d'un joueur : même nom, puis même position et même équipe s'il y a des homonymes.
  function of(p) {
    const list = byKey.get(rules.normalizeName(p.name || ''));
    if (!list) return null;
    let c = list.filter(r => !r.pos || !p.pos || r.pos === p.pos);
    if (c.length > 1 && p.nhl_team) c = c.filter(r => r.team === p.nhl_team);
    const r = c[0];
    return r ? { status: r.status, statusFr: statusFr(r.status), label: r.label, injury: r.injury, comment: r.comment, analysis: r.analysis,
      returnDate: r.return_date, reportedAt: r.reported_at, dtd: r.dtd } : null;
  }

  async function refresh(force = false) {
    const last = await getConfig('injuries_at');
    if (!force && last && Date.now() - Date.parse(last) < REFRESH_MS) return null;
    await setConfig('injuries_at', new Date().toISOString());  // un essai à la fois, même en cas d'échec
    const res = await fetch(FEED, { headers: { 'User-Agent': 'pool-a-vie' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('Rapport des blessés : HTTP ' + res.status);
    const list = parseFeed(await res.json());
    if (!list.length) { console.warn('Rapport des blessés vide : rien de changé'); return 0; }

    // Avis au propriétaire : nouveau blessé ou durée qui change.
    const { rows: owned } = await pool.query(`SELECT p.id, p.name, p.pos, p.nhl_team, pk.team_id FROM picks pk JOIN players p ON p.id=pk.player_id`);
    const before = new Map(owned.map(p => [p.id, of(p)]));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM injuries');
      for (const r of list) await client.query(`
        INSERT INTO injuries(name_key, pos, team, name, status, injury, label, return_date, comment, dtd, reported_at, analysis)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [r.key, r.pos || '', r.team || '', r.name, r.status, r.injury, r.label, r.returnDate, r.comment, r.dtd, r.date, r.analysis || null]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await load();
    if (await getConfig('injuries_seeded')) {
      for (const p of owned) {
        const was = before.get(p.id), now = of(p);
        if (!now) {
          if (was) notify({ kind: 'injury', audience: `team:${p.team_id}`, title: `✅ ${p.name} n'est plus sur la liste des blessés`,
            body: 'Il est de retour (ou n\'apparaît plus au rapport).', link: '#/mon-equipe', dedupe: `inj:${p.id}:off:${new Date().toISOString().slice(0, 10)}` });
          continue;
        }
        if (was && was.label === now.label) continue;
        notify({ kind: 'injury', audience: `team:${p.team_id}`, title: `${now.dtd ? '⚠️' : '❌'} ${p.name} : ${now.label}`,
          body: [now.injury ? `Blessure : ${now.injury}.` : '', now.comment].filter(Boolean).join(' ').slice(0, 200),
          link: '#/mon-equipe', dedupe: `inj:${p.id}:${now.label}` });
      }
    } else await setConfig('injuries_seeded', '1');  // premier chargement : pas d'avalanche d'avis
    console.log(`Rapport des blessés : ${list.length} joueur(s)`);
    return list.length;
  }

  return { initTables, refresh, of };
}

module.exports = { createInjuries, parseFeed, duration };
