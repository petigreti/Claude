/*
 * Decision matrix model and scoring. No DOM access, so the same file runs in
 * the browser (as window.DecisionMatrix) and under Node for the tests.
 *
 * A matrix looks like:
 *   {
 *     title:    string,
 *     options:  [{ id, name }],            // columns
 *     criteria: [{ id, name, weight }],    // rows, weight 1-5
 *     scores:   { [criterionId]: { [optionId]: number } },  // 0-10, missing = unscored
 *     example:  boolean                    // true while the sample data is untouched
 *   }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DecisionMatrix = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCORE_MIN = 0;
  const SCORE_MAX = 10;
  const WEIGHT_MIN = 1;
  const WEIGHT_MAX = 5;
  const DEFAULT_WEIGHT = 3;
  const ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

  let idCounter = 0;

  function makeId(prefix) {
    idCounter += 1;
    return prefix + Math.random().toString(36).slice(2, 8) + idCounter.toString(36);
  }

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function findById(list, id) {
    return list.find((item) => item.id === id) || null;
  }

  /** Coerce anything to a whole-number weight between 1 and 5. */
  function clampWeight(value) {
    const usable = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    const n = usable ? Math.round(Number(value)) : NaN;
    if (!Number.isFinite(n)) return DEFAULT_WEIGHT;
    return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, n));
  }

  /**
   * Turn user input into a score between 0 and 10 with one decimal place,
   * or null when the cell is blank or not a number. Accepts "6,5" as 6.5.
   */
  function parseScore(value) {
    if (typeof value === 'string') {
      value = value.trim().replace(',', '.');
      if (value === '') return null;
    } else if (typeof value !== 'number') {
      return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return round1(Math.min(SCORE_MAX, Math.max(SCORE_MIN, n)));
  }

  function nextOptionName(m) {
    const taken = new Set(m.options.map((o) => o.name.trim().toLowerCase()));
    for (let i = 0; ; i += 1) {
      const name = 'Option ' + (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  function nextCriterionName(m) {
    const taken = new Set(m.criteria.map((c) => c.name.trim().toLowerCase()));
    for (let i = 1; ; i += 1) {
      const name = 'Criterion ' + i;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  function addOption(m, name) {
    const option = { id: makeId('o'), name: name === undefined ? nextOptionName(m) : String(name) };
    m.options.push(option);
    return option;
  }

  function removeOption(m, id) {
    const index = m.options.findIndex((o) => o.id === id);
    if (index === -1) return false;
    m.options.splice(index, 1);
    for (const criterionId of Object.keys(m.scores)) delete m.scores[criterionId][id];
    return true;
  }

  function renameOption(m, id, name) {
    const option = findById(m.options, id);
    if (option) option.name = String(name);
  }

  function addCriterion(m, name, weight) {
    const criterion = {
      id: makeId('c'),
      name: name === undefined ? nextCriterionName(m) : String(name),
      weight: weight === undefined ? DEFAULT_WEIGHT : clampWeight(weight),
    };
    m.criteria.push(criterion);
    return criterion;
  }

  function removeCriterion(m, id) {
    const index = m.criteria.findIndex((c) => c.id === id);
    if (index === -1) return false;
    m.criteria.splice(index, 1);
    delete m.scores[id];
    return true;
  }

  function renameCriterion(m, id, name) {
    const criterion = findById(m.criteria, id);
    if (criterion) criterion.name = String(name);
  }

  function setWeight(m, id, weight) {
    const criterion = findById(m.criteria, id);
    if (!criterion) return null;
    criterion.weight = clampWeight(weight);
    return criterion.weight;
  }

  function getScore(m, criterionId, optionId) {
    const row = own(m.scores, criterionId) ? m.scores[criterionId] : null;
    const value = row && own(row, optionId) ? row[optionId] : null;
    return typeof value === 'number' ? value : null;
  }

  /** Store a score (parsed and clamped). Blank input clears the cell. Returns the stored value. */
  function setScore(m, criterionId, optionId, value) {
    if (!findById(m.criteria, criterionId) || !findById(m.options, optionId)) return null;
    const score = parseScore(value);
    if (score === null) {
      if (own(m.scores, criterionId)) delete m.scores[criterionId][optionId];
    } else {
      if (!own(m.scores, criterionId)) m.scores[criterionId] = {};
      m.scores[criterionId][optionId] = score;
    }
    return score;
  }

  /**
   * Weighted total for every option: the sum of score x weight over all
   * criteria, with blank cells counting as 0. Ranking uses standard
   * competition order, so equal totals share a rank (1, 1, 3).
   */
  function computeResults(m) {
    const totalWeight = m.criteria.reduce((sum, c) => sum + c.weight, 0);
    const maxTotal = totalWeight * SCORE_MAX;
    let scoredCells = 0;
    let unscoredCells = 0;

    const rows = m.options.map((option, index) => {
      let total = 0;
      let unscored = 0;
      for (const criterion of m.criteria) {
        const score = getScore(m, criterion.id, option.id);
        if (score === null) unscored += 1;
        else total += score * criterion.weight;
      }
      scoredCells += m.criteria.length - unscored;
      unscoredCells += unscored;
      total = round1(total);
      return {
        id: option.id,
        name: option.name,
        index,
        total,
        percent: maxTotal > 0 ? (total / maxTotal) * 100 : 0,
        unscored,
        rank: 0,
        tied: false,
      };
    });

    const ranked = rows.slice().sort((a, b) => b.total - a.total || a.index - b.index);
    const perRank = new Map();
    ranked.forEach((row, i) => {
      const prev = ranked[i - 1];
      row.rank = prev && prev.total === row.total ? prev.rank : i + 1;
      perRank.set(row.rank, (perRank.get(row.rank) || 0) + 1);
    });
    for (const row of ranked) row.tied = perRank.get(row.rank) > 1;

    const byId = {};
    for (const row of rows) byId[row.id] = row;

    return { totalWeight, maxTotal, scoredCells, unscoredCells, ranked, byId };
  }

  function emptyMatrix() {
    return { title: '', options: [], criteria: [], scores: {}, example: false };
  }

  function blankMatrix() {
    const m = emptyMatrix();
    addOption(m);
    addOption(m);
    addCriterion(m);
    addCriterion(m);
    return m;
  }

  function exampleMatrix() {
    const m = emptyMatrix();
    m.title = 'Which apartment should we rent?';
    m.example = true;
    const options = ['Maple Ave 2-bed', 'Harbor loft', 'Parkside flat', 'Old Town studio'].map((name) =>
      addOption(m, name)
    );
    const rows = [
      ['Affordability', 5, [6, 3, 7, 9]],
      ['Short commute', 4, [5, 9, 6, 8]],
      ['Space', 3, [8, 7, 7, 3]],
      ['Natural light', 2, [6, 9, 7, 4]],
      ['Neighborhood', 3, [7, 8, 6, 9]],
    ];
    for (const [name, weight, scores] of rows) {
      const criterion = addCriterion(m, name, weight);
      scores.forEach((score, i) => setScore(m, criterion.id, options[i].id, score));
    }
    return m;
  }

  /**
   * Rebuild a matrix from untrusted JSON (e.g. localStorage). Returns null if
   * the shape is unusable; otherwise fixes ids, weights and scores as needed.
   */
  function normalizeMatrix(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.options) || !Array.isArray(raw.criteria)) {
      return null;
    }
    const seen = new Set();
    const keepId = (item, prefix) => {
      const id = typeof item.id === 'string' && ID_PATTERN.test(item.id) && !seen.has(item.id) ? item.id : makeId(prefix);
      seen.add(id);
      return id;
    };
    const text = (value) => (typeof value === 'string' ? value : '');
    const isObject = (value) => value !== null && typeof value === 'object';

    const m = emptyMatrix();
    m.title = text(raw.title);
    m.example = raw.example === true;
    m.options = raw.options.filter(isObject).map((o) => ({ id: keepId(o, 'o'), name: text(o.name) }));
    m.criteria = raw.criteria
      .filter(isObject)
      .map((c) => ({ id: keepId(c, 'c'), name: text(c.name), weight: clampWeight(c.weight) }));

    const rawScores = isObject(raw.scores) ? raw.scores : {};
    for (const criterion of m.criteria) {
      const row = own(rawScores, criterion.id) && isObject(rawScores[criterion.id]) ? rawScores[criterion.id] : null;
      if (!row) continue;
      for (const option of m.options) {
        if (own(row, option.id)) setScore(m, criterion.id, option.id, row[option.id]);
      }
    }
    return m;
  }

  return {
    SCORE_MIN,
    SCORE_MAX,
    WEIGHT_MIN,
    WEIGHT_MAX,
    DEFAULT_WEIGHT,
    clampWeight,
    parseScore,
    blankMatrix,
    exampleMatrix,
    normalizeMatrix,
    addOption,
    removeOption,
    renameOption,
    addCriterion,
    removeCriterion,
    renameCriterion,
    setWeight,
    getScore,
    setScore,
    computeResults,
  };
});
