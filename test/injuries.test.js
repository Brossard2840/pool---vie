const test = require('node:test');
const assert = require('node:assert');
const { parseFeed, duration } = require('../lib/injuries');

// Exemple au format du flux public d'ESPN (équipes → blessures → athlète, statut, détails, commentaire).
const sample = {
  injuries: [
    { displayName: 'Montreal Canadiens', injuries: [
      { status: 'Injured Reserve', date: '2026-10-18T15:00Z', shortComment: 'Dach (knee) is out indefinitely after undergoing surgery.',
        athlete: { displayName: 'Kirby Dach', position: { abbreviation: 'C' }, team: { abbreviation: 'MON' } },
        details: { type: 'Knee', returnDate: '2027-01-15' } },
      { status: 'Day-To-Day', shortComment: 'Guhle (lower body) is day-to-day.',
        athlete: { displayName: 'Kaiden Guhle', position: { abbreviation: 'D' }, team: { abbreviation: 'MTL' } }, details: { type: 'Lower Body' } }
    ] },
    { displayName: 'Tampa Bay Lightning', injuries: [
      { status: 'Out', shortComment: 'Hedman (upper body) will be out four to six weeks.',
        athlete: { displayName: 'Victor Hedman', position: { abbreviation: 'D' }, team: { abbreviation: 'TB' } }, details: { type: 'Upper Body' } },
      { status: 'Active', shortComment: 'Point returned to the lineup.', athlete: { displayName: 'Brayden Point', position: { abbreviation: 'C' } } }
    ] }
  ]
};

test('lit le rapport des blessés et traduit la durée', () => {
  const r = parseFeed(sample);
  assert.equal(r.length, 3);  // le joueur « Active » est ignoré
  const dach = r.find(x => x.name === 'Kirby Dach');
  assert.equal(dach.team, 'MTL'); assert.equal(dach.pos, 'F'); assert.equal(dach.injury, 'genou');
  assert.equal(dach.label, 'absence indéterminée'); assert.equal(dach.returnDate, '2027-01-15');
  const guhle = r.find(x => x.name === 'Kaiden Guhle');
  assert.equal(guhle.label, 'au jour le jour'); assert.ok(guhle.dtd); assert.equal(guhle.injury, 'bas du corps');
  const hedman = r.find(x => x.name === 'Victor Hedman');
  assert.equal(hedman.team, 'TBL'); assert.equal(hedman.label, 'absent 4 à 6 semaines');
});

test('durées en français', () => {
  assert.equal(duration({ status: 'Out', comment: 'He will miss the rest of the season.' }), 'absent pour la saison');
  assert.equal(duration({ status: 'Out', comment: 'Expected to miss at least a month.' }), 'absent 1 mois');
  assert.equal(duration({ status: 'Out', comment: 'Out for a few weeks.' }), 'absent quelques semaines');
  assert.equal(duration({ status: 'Out', comment: 'Sidelined 2 weeks' }), 'absent 2 semaines');
  assert.equal(duration({ status: 'Out', comment: '', returnDate: '2026-11-15' }), 'retour prévu 15 novembre');
  assert.equal(duration({ status: 'Injured Reserve', comment: 'Placed on IR.' }), 'sur la liste des blessés');
});
