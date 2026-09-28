const { test } = require('node:test');
const assert = require('node:assert/strict');
const DM = require('../js/matrix.js');

function build(weights, scoreRows, optionNames) {
  const m = { title: '', options: [], criteria: [], scores: {}, example: false };
  const options = optionNames.map((name) => DM.addOption(m, name));
  weights.forEach((weight, r) => {
    const criterion = DM.addCriterion(m, 'C' + r, weight);
    scoreRows[r].forEach((score, i) => DM.setScore(m, criterion.id, options[i].id, score));
  });
  return { m, options };
}

test('parseScore clamps to 0-10, keeps one decimal, and treats blanks as unscored', () => {
  assert.equal(DM.parseScore('7'), 7);
  assert.equal(DM.parseScore(' 7.25 '), 7.3);
  assert.equal(DM.parseScore('6,5'), 6.5);
  assert.equal(DM.parseScore('12'), 10);
  assert.equal(DM.parseScore('-3'), 0);
  assert.equal(DM.parseScore(4), 4);
  assert.equal(DM.parseScore(''), null);
  assert.equal(DM.parseScore('abc'), null);
  assert.equal(DM.parseScore(null), null);
  assert.equal(DM.parseScore(undefined), null);
});

test('clampWeight keeps weights whole and between 1 and 5', () => {
  assert.equal(DM.clampWeight(0), 1);
  assert.equal(DM.clampWeight(9), 5);
  assert.equal(DM.clampWeight('4'), 4);
  assert.equal(DM.clampWeight(2.6), 3);
  assert.equal(DM.clampWeight(undefined), DM.DEFAULT_WEIGHT);
  assert.equal(DM.clampWeight(''), DM.DEFAULT_WEIGHT);
  assert.equal(DM.clampWeight('heavy'), DM.DEFAULT_WEIGHT);
});

test('weighted totals are the sum of score x weight', () => {
  const { m, options } = build(
    [5, 1],
    [
      [8, 2],
      [0, 10],
    ],
    ['A', 'B']
  );
  const res = DM.computeResults(m);
  assert.equal(res.totalWeight, 6);
  assert.equal(res.maxTotal, 60);
  assert.equal(res.byId[options[0].id].total, 40);
  assert.equal(res.byId[options[1].id].total, 20);
  assert.deepEqual(
    res.ranked.map((r) => [r.name, r.rank]),
    [
      ['A', 1],
      ['B', 2],
    ]
  );
  assert.equal(Math.round(res.byId[options[0].id].percent), 67);
});

test('changing a weight can flip the ranking', () => {
  const { m } = build(
    [5, 1],
    [
      [8, 2],
      [0, 10],
    ],
    ['A', 'B']
  );
  DM.setWeight(m, m.criteria[1].id, 5);
  DM.setWeight(m, m.criteria[0].id, 1);
  const res = DM.computeResults(m);
  assert.equal(res.ranked[0].name, 'B');
  assert.equal(res.ranked[0].total, 52);
  assert.equal(res.ranked[1].total, 8);
});

test('equal totals share a rank and later ranks skip ahead', () => {
  const { m } = build([2], [[5, 5, 3, 5]], ['A', 'B', 'C', 'D']);
  const res = DM.computeResults(m);
  assert.deepEqual(
    res.ranked.map((r) => [r.name, r.rank, r.tied]),
    [
      ['A', 1, true],
      ['B', 1, true],
      ['D', 1, true],
      ['C', 4, false],
    ]
  );
});

test('decimal scores do not leave floating point noise in totals', () => {
  const { m, options } = build([3, 3], [[7.1], [0.2]], ['A']);
  assert.equal(DM.computeResults(m).byId[options[0].id].total, 21.9);
});

test('blank cells count as 0 and are reported as unscored', () => {
  const { m, options } = build(
    [3, 4],
    [
      [6, null],
      [null, null],
    ],
    ['A', 'B']
  );
  const res = DM.computeResults(m);
  assert.equal(res.byId[options[0].id].total, 18);
  assert.equal(res.byId[options[0].id].unscored, 1);
  assert.equal(res.byId[options[1].id].unscored, 2);
  assert.equal(res.scoredCells, 1);
  assert.equal(res.unscoredCells, 3);
});

test('clearing a score removes it', () => {
  const { m, options } = build([3], [[6]], ['A']);
  const cid = m.criteria[0].id;
  assert.equal(DM.getScore(m, cid, options[0].id), 6);
  assert.equal(DM.setScore(m, cid, options[0].id, ''), null);
  assert.equal(DM.getScore(m, cid, options[0].id), null);
});

test('a matrix with no criteria has a max of 0 and no percentages', () => {
  const m = DM.blankMatrix();
  m.criteria = [];
  const res = DM.computeResults(m);
  assert.equal(res.maxTotal, 0);
  assert.ok(res.ranked.every((r) => r.total === 0 && r.percent === 0));
});

test('removing an option or criterion drops its scores', () => {
  const { m, options } = build(
    [3, 3],
    [
      [1, 2],
      [3, 4],
    ],
    ['A', 'B']
  );
  const [first, second] = m.criteria;
  DM.removeOption(m, options[0].id);
  assert.deepEqual(Object.keys(m.scores[first.id]), [options[1].id]);
  DM.removeCriterion(m, second.id);
  assert.equal(m.scores[second.id], undefined);
  assert.equal(m.criteria.length, 1);
  assert.equal(DM.removeOption(m, 'missing'), false);
});

test('new options and criteria get the next unused default name', () => {
  const m = DM.blankMatrix();
  assert.deepEqual(
    m.options.map((o) => o.name),
    ['Option A', 'Option B']
  );
  DM.removeOption(m, m.options[0].id);
  assert.equal(DM.addOption(m).name, 'Option A');
  assert.equal(DM.addOption(m).name, 'Option C');
  assert.equal(DM.addCriterion(m).name, 'Criterion 3');
  assert.equal(DM.addCriterion(m).weight, DM.DEFAULT_WEIGHT);
});

test('the example data ranks Old Town studio first out of 170', () => {
  const m = DM.exampleMatrix();
  const res = DM.computeResults(m);
  assert.equal(res.maxTotal, 170);
  assert.deepEqual(
    res.ranked.map((r) => [r.name, r.total, r.rank]),
    [
      ['Old Town studio', 121, 1],
      ['Harbor loft', 114, 2],
      ['Parkside flat', 112, 3],
      ['Maple Ave 2-bed', 107, 4],
    ]
  );
});

test('normalizeMatrix round-trips saved data', () => {
  const m = DM.exampleMatrix();
  const restored = DM.normalizeMatrix(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(restored, m);
});

test('normalizeMatrix repairs bad input and rejects unusable shapes', () => {
  assert.equal(DM.normalizeMatrix(null), null);
  assert.equal(DM.normalizeMatrix({ options: 'nope', criteria: [] }), null);

  const m = DM.normalizeMatrix({
    title: 42,
    options: [{ id: 'oa', name: 'A' }, { id: 'oa', name: 'Duplicate id' }, null, { id: '__proto__', name: 'Bad id' }],
    criteria: [{ id: 'cx', name: 'Price', weight: 11 }, { name: 'No id' }],
    scores: { cx: { oa: '15', ghost: 4 }, nope: { oa: 3 } },
  });
  assert.equal(m.title, '');
  assert.equal(m.options.length, 3);
  assert.equal(new Set(m.options.map((o) => o.id)).size, 3);
  assert.notEqual(m.options[2].id, '__proto__');
  assert.equal(m.criteria[0].weight, 5);
  assert.equal(m.criteria[1].weight, DM.DEFAULT_WEIGHT);
  assert.deepEqual(m.scores, { cx: { oa: 10 } });
  assert.equal(m.example, false);
});
