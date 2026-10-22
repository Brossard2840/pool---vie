const test = require('node:test');
const assert = require('node:assert');
const { parseLine, parseList } = require('../lib/contracts');

test('lit les lignes de contrats dans plusieurs formats', () => {
  const cases = [
    ['Connor McDavid  $12,500,000  2026-27', { name: 'Connor McDavid', aav: 12500000, end: 2027 }],
    ['Nick Suzuki, 7.875M, 2030', { name: 'Nick Suzuki', aav: 7875000, end: 2030 }],
    ['Cole Caufield\t7 850 000\t2031', { name: 'Cole Caufield', aav: 7850000, end: 2031 }],
    ['Lane Hutson D MTL 8,850,000 $ 2033-34', { name: 'Lane Hutson', team: 'MTL', aav: 8850000, end: 2034 }],
    ['Sebastian Aho (CAR) 9,750,000 2032', { name: 'Sebastian Aho', team: 'CAR', aav: 9750000, end: 2032 }],
    ['Ivan Demidov; 975000; 2027/28', { name: 'Ivan Demidov', aav: 975000, end: 2028 }],
    ['Juraj Slafkovsky 7,6 M$ 2033', { name: 'Juraj Slafkovsky', aav: 7600000, end: 2033 }],
    ['Sam Montembeault 3150000 2027', { name: 'Sam Montembeault', aav: 3150000, end: 2027 }],
    ['Patrik Laine 2026', { name: 'Patrik Laine', aav: null, end: 2026 }]
  ];
  for (const [line, want] of cases) {
    const r = parseLine(line);
    for (const k of Object.keys(want)) assert.deepEqual(r[k], want[k], `${line} → ${k}`);
  }
});

test('ignore l\'en-tête et les lignes vides', () => {
  assert.equal(parseList('Nom\tAAV\tFin\n\nNick Suzuki 7875000 2030\n').length, 1);
});
