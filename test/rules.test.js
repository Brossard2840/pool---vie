const test = require('node:test');
const assert = require('node:assert');
const rules = require('../lib/rules');
const nhl = require('../lib/nhl');

const sk = (id, pos, goals, assists, aav) => ({ id, pos, goals, assists, aav, gp: 10, wins: 0, ot_losses: 0, shutouts: 0 });

test('pointage des gardiens (art. 2.1)', () => {
  // 10 V dont 2 blanchissages, 3 défaites en prolongation/fusillade, 1 passe
  assert.strictEqual(rules.poolPoints({ pos: 'G', goals: 0, assists: 1, wins: 10, ot_losses: 3, shutouts: 2 }), 1 + 20 + 3 + 2);
  assert.strictEqual(rules.poolPoints({ pos: 'F', goals: 5, assists: 7, wins: 9 }), 12);
});

test('seuls les 9/4/2 meilleurs comptent pour les points, les 9/4/2 mieux payés pour la masse', () => {
  const players = [];
  for (let i = 0; i < 10; i++) players.push(sk(i, 'F', i, 0, (10 - i) * 1e6)); // le moins payé a le plus de points
  for (let i = 0; i < 4; i++) players.push(sk(20 + i, 'D', 1, 1, 1e6));
  players.push({ ...sk(30, 'G', 0, 0, 5e6), wins: 5 }, { ...sk(31, 'G', 0, 0, 4e6), wins: 1 });
  const s = rules.teamSummary(players, { cap: 104e6, floor: 76.9e6 });
  // Attaquants : points 1..9 (on exclut celui à 0 pt) = 45
  assert.strictEqual(s.points, 45 + 4 * 2 + 10 + 2);
  // Masse : 9 mieux payés des 10 attaquants = (10+...+2) M = 54 M, + 4 M (D) + 9 M (G)
  assert.strictEqual(s.capUsed, 54e6 + 4e6 + 9e6);
  assert.ok(s.issues.some(i => i.includes('plancher')));
  // Ajouter un attaquant pousse hors du calcul le moins bien payé (2 M) : espace + 2 M
  assert.strictEqual(s.positions.F.maxNewSalary, 104e6 - 67e6 + 2e6);
  assert.strictEqual(s.positions.F.players.find(p => p.id === 0).counts_points, false);
  assert.strictEqual(s.positions.F.players.find(p => p.id === 9).counts_cap, false);
});

test('minimums et maximums par position (art. 1)', () => {
  const s = rules.teamSummary([sk(1, 'F', 0, 0, 1e6)], { cap: 104e6, floor: 0 });
  assert.ok(s.issues.some(i => i.startsWith('Attaquants : 1')));
  assert.ok(s.issues.some(i => i.startsWith('Gardiens : 0')));
});

test('égalité départagée par points par match puis buts (art. 6.2)', () => {
  const r = rules.rankTeams([
    { name: 'A', points: 100, ppg: 1.0, goals: 50 },
    { name: 'B', points: 100, ppg: 1.2, goals: 10 },
    { name: 'C', points: 100, ppg: 1.0, goals: 60 }
  ]);
  assert.deepStrictEqual(r.map(t => t.name), ['B', 'C', 'A']);
});

test('saison courante selon la date', () => {
  assert.strictEqual(rules.currentSeasonId(new Date(2026, 9, 20)), '20262027');
  assert.strictEqual(rules.currentSeasonId(new Date(2027, 4, 1)), '20262027');
});

test('noms normalisés et positions', () => {
  assert.strictEqual(rules.normalizeName('Ryan Nugent-Hopkins'), rules.normalizeName('ryan nugenthopkins'));
  assert.strictEqual(rules.normalizeName('Tim Stützle'), 'tim stutzle');
  assert.deepStrictEqual(['C', 'L', 'R', 'D', 'G', 'A', 'x'].map(rules.posGroup), ['F', 'F', 'F', 'D', 'G', 'F', null]);
});

test('un joueur échangé sur deux lignes est additionné', () => {
  const rows = nhl.combine([
    { playerId: 1, skaterFullName: 'X', positionCode: 'C', teamAbbrevs: 'BOS', gamesPlayed: 5, goals: 2, assists: 1 },
    { playerId: 1, skaterFullName: 'X', positionCode: 'C', teamAbbrevs: 'TOR', gamesPlayed: 3, goals: 1, assists: 0 }
  ], false);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0].gp, rows[0].goals, rows[0].assists, rows[0].nhl_team], [8, 3, 1, 'TOR']);
});

test('sommaire de match : points des patineurs et des gardiens', () => {
  const { parseBoxscore } = require('../lib/live');
  const g = (id, decision, ga, toi = '60:00') => ({ playerId: id, name: { default: 'G' + id }, toi, decision, goalsAgainst: ga });
  const rows = parseBoxscore({
    awayTeam: { abbrev: 'MTL' }, homeTeam: { abbrev: 'TOR' },
    playerByGameStats: {
      awayTeam: { forwards: [{ playerId: 1, name: { default: 'A' }, position: 'C', goals: 2, assists: 1 }], defense: [],
                  goalies: [g(10, 'W', 0), g(11, undefined, 0, '00:00')] },
      homeTeam: { forwards: [], defense: [{ playerId: 2, name: { default: 'B' }, position: 'D', goals: 0, assists: 1 }],
                  goalies: [g(20, 'O', 3)] }
    }
  });
  const by = Object.fromEntries(rows.map(r => [r.nhl_id, r]));
  assert.strictEqual(rows.length, 4); // le gardien auxiliaire qui n'a pas joué est exclu
  assert.strictEqual(rules.poolPoints(by[1]), 3);
  assert.strictEqual(by[2].pos, 'D');
  assert.strictEqual(rules.poolPoints(by[10]), 3); // victoire + blanchissage
  assert.strictEqual(rules.poolPoints(by[20]), 1); // défaite en prolongation
});

test('protection : recrues et combinaisons permises (art. 4.3)', () => {
  const { isRookie, categories, assignCategories } = require('../lib/protection');
  const S = o => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
  // Recrue 2026-27 : 20 ans, 10 matchs en 2025-26 (< 25), jamais plus de 6 matchs deux ans de suite
  assert.ok(isRookie(2026, '2006-03-01', S({ 2025: 10, 2026: 60 })));
  assert.ok(!isRookie(2026, '2006-03-01', S({ 2025: 30 })));            // plus de 25 matchs une saison
  assert.ok(!isRookie(2026, '2006-03-01', S({ 2024: 7, 2025: 8 })));    // plus de 6 matchs deux saisons de suite
  assert.ok(!isRookie(2026, '2000-09-01', S({})));                      // 26 ans au 15 septembre
  // Catégories
  assert.deepStrictEqual(categories({ pos: 'F', gp: 70 }, 2026, S({ 2026: 70 }), '2006-01-01'), ['R']);
  assert.deepStrictEqual(categories({ pos: 'F', gp: 30 }, 2026, S({ 2026: 30, 2020: 80 }), '1995-01-01'), ['GP']);
  assert.deepStrictEqual(categories({ pos: 'G', gp: 25 }, 2026, S({ 2026: 25, 2020: 80 }), '1995-01-01'), []);
  assert.deepStrictEqual(categories({ pos: 'D', gp: 70 }, 2026, S({ 2025: 60, 2026: 70 }), '2005-01-01'), ['R2']);
  // 4.3.4 : les 4 combinaisons de la convention passent, les autres non
  const P = (...c) => ({ cats: c });
  assert.ok(assignCategories([P('R'), P('R'), P('R')]));
  assert.ok(assignCategories([P('R'), P('R'), P('R2')]));
  assert.ok(assignCategories([P('R'), P('GP'), P('GP')]));
  assert.ok(assignCategories([P('R'), P('GP'), P('R2')]));
  assert.strictEqual(assignCategories([P('GP'), P('GP'), P('GP')]), null);
  assert.strictEqual(assignCategories([P('R2'), P('GP'), P('GP')]), null);
  assert.strictEqual(assignCategories([P('R2'), P('R2')]), null);
  assert.deepStrictEqual(assignCategories([P('GP', 'R'), P('GP'), P('GP')]), ['R', 'GP', 'GP']); // un joueur admissible à deux catégories
  assert.strictEqual(assignCategories([P('R'), P('R'), P('R'), P('R')]), null);
});
