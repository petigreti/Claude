/* Weigh It Up: renders the decision matrix and keeps the ranking in sync. */
(function () {
  'use strict';

  const DM = window.DecisionMatrix;
  const STORAGE_KEY = 'weigh-it-up:v1';
  const TOAST_MS = 6000;
  const WEIGHT_WORDS = { 1: 'minor', 2: 'low', 3: 'moderate', 4: 'high', 5: 'critical' };
  const ICONS = {
    plus: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('decision-title'),
    exampleNote: $('example-note'),
    table: $('matrix'),
    matrixPanel: $('matrix').closest('.matrix-panel'),
    verdict: $('verdict'),
    verdictNote: $('verdict-note'),
    rankList: $('rank-list'),
    formula: $('formula'),
    storageNote: $('storage-note'),
    toast: $('toast'),
    toastText: $('toast-text'),
    toastUndo: $('toast-undo'),
    announcer: $('announcer'),
  };

  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const fmt = (n) => numberFormat.format(n);
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  const storageOk = storageAvailable();
  let state = loadState() || DM.exampleMatrix();
  let refs = null; // DOM references for the current table render
  const rankParts = new WeakMap();
  let undoSnapshot = null;
  let toastTimer = 0;
  let lastLeaderKey = null; // null until the first render, so the page doesn't announce on load

  // ---------- Storage ----------

  function storageAvailable() {
    try {
      const probe = STORAGE_KEY + ':probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  }

  function loadState() {
    if (!storageOk) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? DM.normalizeMatrix(JSON.parse(raw)) : null;
    } catch (err) {
      return null;
    }
  }

  function saveState() {
    if (!storageOk) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // Quota or blocked storage: keep working in memory.
    }
  }

  // ---------- Small DOM helpers ----------

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked') node.checked = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(child);
    }
    return node;
  }

  function icon(name) {
    const span = h('span', { className: 'icon' });
    span.innerHTML = ICONS[name];
    return span.firstChild;
  }

  const optionName = (o) => o.name.trim() || 'Untitled option';
  const criterionName = (c) => c.name.trim() || 'Untitled criterion';
  const plural = (n, one, many) => (n === 1 ? one : many);

  /** Grow a one-line textarea to fit its wrapped text. */
  function fitText(field) {
    field.style.height = 'auto';
    field.style.height = field.scrollHeight + field.offsetHeight - field.clientHeight + 'px';
  }

  function fitAllText() {
    fitText(els.title);
    for (const field of els.table.querySelectorAll('textarea')) fitText(field);
  }

  /** Names are single-line values; turn pasted line breaks into spaces. */
  function singleLine(field) {
    if (/[\r\n]/.test(field.value)) field.value = field.value.replace(/[\r\n]+/g, ' ');
  }

  function announce(message) {
    els.announcer.textContent = '';
    window.setTimeout(() => {
      els.announcer.textContent = message;
    }, 50);
  }

  // ---------- Matrix table ----------

  function renderMatrix() {
    refs = { options: {}, criteria: {}, cells: {}, maxLabel: null };
    const { options, criteria } = state;

    const headRow = h(
      'tr',
      null,
      h(
        'th',
        { className: 'crit corner', scope: 'col' },
        h('span', { className: 'axis axis-x' }, 'Options ', h('span', { 'aria-hidden': 'true' }, '→')),
        h('span', { className: 'axis axis-y' }, h('span', { 'aria-hidden': 'true' }, '↓ '), 'Criteria')
      ),
      ...options.map(renderOptionHeader),
      h(
        'th',
        { className: 'ghost', scope: 'col' },
        h('button', { type: 'button', className: 'add-btn', id: 'add-option', 'data-action': 'add-option' }, icon('plus'), 'Add option')
      )
    );

    const tbody = h('tbody', null, ...criteria.map(renderCriterionRow));
    tbody.append(
      h(
        'tr',
        { className: 'add-row' },
        h(
          'th',
          { className: 'crit', scope: 'row' },
          h('button', { type: 'button', className: 'add-btn', id: 'add-criterion', 'data-action': 'add-criterion' }, icon('plus'), 'Add criterion')
        ),
        h('td', { className: 'ghost', colspan: String(options.length + 1) })
      )
    );

    refs.maxLabel = h('span', { className: 'total-sub' });
    const footRow = h(
      'tr',
      null,
      h('th', { className: 'crit', scope: 'row' }, h('span', { className: 'total-label' }, 'Weighted total'), refs.maxLabel),
      ...options.map(renderTotalCell),
      h('td', { className: 'ghost' })
    );

    els.table.replaceChildren(
      h('caption', { className: 'sr-only' }, 'Decision matrix. Criteria are rows and options are columns. Each score is multiplied by its criterion weight.'),
      h('thead', null, headRow),
      tbody,
      h('tfoot', null, footRow)
    );
    refreshLabels();
    fitAllText();
  }

  function renderOptionHeader(o) {
    const input = h('textarea', {
      id: 'opt-name-' + o.id,
      className: 'name-input opt-name',
      rows: '1',
      value: o.name,
      maxlength: '60',
      autocomplete: 'off',
      placeholder: 'Option name',
      'data-option': o.id,
    });
    const remove = h('button', { type: 'button', className: 'icon-btn', 'data-action': 'remove-option', 'data-option': o.id }, icon('close'));
    const tag = h('span', { className: 'lead-tag' }, 'Leading');
    const th = h('th', { className: 'opt', scope: 'col' }, input, h('div', { className: 'opt-foot' }, tag, remove));
    refs.options[o.id] = { th, input, remove, tag, cells: [th], total: null };
    return th;
  }

  function renderCriterionRow(c) {
    const nameInput = h('textarea', {
      id: 'crit-name-' + c.id,
      className: 'name-input crit-name',
      rows: '1',
      value: c.name,
      maxlength: '80',
      autocomplete: 'off',
      placeholder: 'Criterion name',
      'data-criterion': c.id,
    });
    const remove = h('button', { type: 'button', className: 'icon-btn', 'data-action': 'remove-criterion', 'data-criterion': c.id }, icon('close'));

    const steps = h('span', { className: 'weight-steps' });
    for (let w = DM.WEIGHT_MIN; w <= DM.WEIGHT_MAX; w += 1) {
      const id = `w-${c.id}-${w}`;
      steps.append(
        h('input', { type: 'radio', id, name: 'w-' + c.id, value: String(w), checked: c.weight === w, className: 'weight-radio', 'data-criterion': c.id }),
        h('label', { for: id, title: `${w} – ${WEIGHT_WORDS[w]}` }, h('span', { className: 'sr-only' }, `${w}, ${WEIGHT_WORDS[w]}`))
      );
    }
    const value = h('span', { className: 'weight-value', 'aria-hidden': 'true' });
    const group = h('div', { className: 'weight', role: 'radiogroup' }, h('span', { className: 'weight-label', 'aria-hidden': 'true' }, 'Weight'), steps, value);

    const tr = h('tr', null, h('th', { className: 'crit', scope: 'row' }, h('div', { className: 'crit-head' }, nameInput, remove), group));
    refs.criteria[c.id] = { input: nameInput, remove, group, labels: Array.from(steps.querySelectorAll('label')), value };
    refs.cells[c.id] = {};

    for (const o of state.options) {
      const score = DM.getScore(state, c.id, o.id);
      const input = h('input', {
        id: `score-${c.id}-${o.id}`,
        className: 'score-input',
        type: 'number',
        min: String(DM.SCORE_MIN),
        max: String(DM.SCORE_MAX),
        step: 'any',
        inputmode: 'decimal',
        placeholder: '–',
        value: score === null ? '' : String(score),
        'data-criterion': c.id,
        'data-option': o.id,
      });
      const contrib = h('span', { className: 'contrib', 'aria-hidden': 'true' });
      const td = h('td', { className: 'score-cell' }, input, contrib);
      refs.cells[c.id][o.id] = { input, contrib };
      refs.options[o.id].cells.push(td);
      tr.append(td);
    }
    tr.append(h('td', { className: 'ghost' }));
    return tr;
  }

  function renderTotalCell(o) {
    const num = h('span', { className: 'total-num' });
    const chip = h('span', { className: 'rank-chip' });
    const pct = h('span', { className: 'total-pct' });
    const td = h('td', { className: 'total-cell' }, num, h('span', { className: 'total-meta' }, chip, pct));
    refs.options[o.id].total = { num, chip, pct };
    refs.options[o.id].cells.push(td);
    return td;
  }

  /** Accessible names mention option and criterion names, so they follow renames. */
  function refreshLabels() {
    for (const o of state.options) {
      const r = refs.options[o.id];
      r.input.setAttribute('aria-label', `Option name, ${optionName(o)}`);
      r.remove.setAttribute('aria-label', `Remove option ${optionName(o)}`);
    }
    for (const c of state.criteria) {
      const r = refs.criteria[c.id];
      r.input.setAttribute('aria-label', `Criterion name, ${criterionName(c)}`);
      r.remove.setAttribute('aria-label', `Remove criterion ${criterionName(c)}`);
      r.group.setAttribute('aria-label', `Weight for ${criterionName(c)}`);
      for (const o of state.options) {
        refs.cells[c.id][o.id].input.setAttribute('aria-label', `${optionName(o)}, score for ${criterionName(c)}, 0 to 10`);
      }
    }
  }

  // ---------- Results ----------

  function updateResults() {
    const res = DM.computeResults(state);
    const showLead = res.scoredCells > 0 && state.options.length > 1;

    for (const c of state.criteria) {
      const r = refs.criteria[c.id];
      r.labels.forEach((label, i) => label.classList.toggle('on', i < c.weight));
      r.value.textContent = '×' + c.weight;
      for (const o of state.options) {
        const score = DM.getScore(state, c.id, o.id);
        refs.cells[c.id][o.id].contrib.textContent = score === null ? '' : `×${c.weight} = ${fmt(score * c.weight)}`;
      }
    }

    for (const o of state.options) {
      const row = res.byId[o.id];
      const r = refs.options[o.id];
      const lead = showLead && row.rank === 1;
      r.total.num.textContent = fmt(row.total);
      r.total.pct.textContent = res.maxTotal ? `${Math.round(row.percent)}%` : '';
      r.total.chip.textContent = res.scoredCells ? rankLabel(row) : '–';
      r.tag.textContent = row.tied ? 'Tied first' : 'Leading';
      for (const cell of r.cells) cell.classList.toggle('is-lead', lead);
    }
    refs.maxLabel.textContent = `out of ${fmt(res.maxTotal)}`;

    renderRanking(res, showLead);
    announceLeader(res, showLead);
  }

  function rankLabel(row) {
    return (row.tied ? '=' : '#') + row.rank;
  }

  function renderRanking(res, showLead) {
    const list = els.rankList;
    const top = () => list.getBoundingClientRect().top;
    const before = new Map();
    const listTopBefore = top();
    for (const li of list.children) before.set(li.dataset.option, li.getBoundingClientRect().top - listTopBefore);

    renderVerdict(res);

    const existing = new Map(Array.from(list.children, (li) => [li.dataset.option, li]));
    const items = res.ranked.map((row) => {
      const li = existing.get(row.id) || createRankItem(row.id);
      const p = rankParts.get(li);
      li.classList.toggle('is-lead', showLead && row.rank === 1);
      p.pos.textContent = res.scoredCells ? (row.tied ? '=' : '') + row.rank : '–';
      p.name.textContent = optionName(row);
      p.total.textContent = fmt(row.total);
      p.max.textContent = '/' + fmt(res.maxTotal);
      p.bar.style.width = `${Math.max(0, Math.min(100, row.percent))}%`;
      const meta = [];
      if (res.maxTotal) meta.push(`${Math.round(row.percent)}% of max`);
      if (res.scoredCells && row.unscored) meta.push(`${row.unscored} ${plural(row.unscored, 'score', 'scores')} blank`);
      p.meta.textContent = meta.join(' · ');
      return li;
    });
    list.replaceChildren(...items);

    els.formula.textContent = state.criteria.length
      ? `Total = Σ score × weight. Max ${fmt(res.maxTotal)} = 10 × total weight ${res.totalWeight}.`
      : 'Total = Σ score × weight.';

    if (reduceMotion && reduceMotion.matches) return;
    const listTopAfter = top();
    for (const li of items) {
      const prev = before.get(li.dataset.option);
      if (prev === undefined || typeof li.animate !== 'function') continue;
      const dy = prev - (li.getBoundingClientRect().top - listTopAfter);
      if (Math.abs(dy) > 1) {
        li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: 340,
          easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
        });
      }
    }
  }

  function createRankItem(id) {
    const parts = {
      pos: h('span', { className: 'rank-pos' }),
      name: h('span', { className: 'rank-name' }),
      total: h('span'),
      max: h('span', { className: 'rank-max' }),
      bar: h('span'),
      meta: h('div', { className: 'rank-meta' }),
    };
    const li = h(
      'li',
      { className: 'rank-item', 'data-option': id },
      parts.pos,
      h(
        'div',
        { className: 'rank-body' },
        h('div', { className: 'rank-line' }, parts.name, h('span', { className: 'rank-score' }, parts.total, parts.max)),
        h('div', { className: 'rank-bar', 'aria-hidden': 'true' }, parts.bar),
        parts.meta
      )
    );
    rankParts.set(li, parts);
    return li;
  }

  function renderVerdict(res) {
    const ranked = res.ranked;
    const strong = (row) => h('strong', null, optionName(row));
    let parts;
    if (!state.options.length) {
      parts = ['Add an option to start comparing.'];
    } else if (!state.criteria.length) {
      parts = ['Add a criterion to score the options against.'];
    } else if (!res.scoredCells) {
      parts = ['Enter scores to see which option comes out ahead.'];
    } else if (ranked.length === 1) {
      parts = [strong(ranked[0]), ' is the only option. Add another to compare.'];
    } else {
      const leaders = ranked.filter((row) => row.rank === 1);
      if (leaders.length > 1) {
        parts = ['Tied for first: '];
        leaders.forEach((row, i) => {
          if (i > 0) parts.push(i === leaders.length - 1 ? ' and ' : ', ');
          parts.push(strong(row));
        });
        parts.push(`, with ${fmt(leaders[0].total)} points each.`);
      } else {
        const gap = Math.round((ranked[0].total - ranked[1].total) * 10) / 10;
        parts = [strong(ranked[0]), ` leads ${optionName(ranked[1])} by ${fmt(gap)} ${plural(gap, 'point', 'points')}.`];
      }
    }
    els.verdict.replaceChildren(...parts);

    const blank = res.unscoredCells;
    const note = res.scoredCells && blank ? `${blank} ${plural(blank, 'score is', 'scores are')} still blank and count as 0.` : '';
    els.verdictNote.textContent = note;
    els.verdictNote.hidden = !note;
  }

  function announceLeader(res, showLead) {
    const leaders = showLead ? res.ranked.filter((row) => row.rank === 1) : [];
    const key = leaders.map((row) => row.id).join('|');
    const previous = lastLeaderKey;
    lastLeaderKey = key;
    if (previous === null || key === previous || !leaders.length) return;
    announce(leaders.length > 1 ? `Tie for first: ${leaders.map(optionName).join(', ')}.` : `${optionName(leaders[0])} now leads.`);
  }

  // ---------- Header, toast ----------

  function syncHeader() {
    if (els.title.value !== state.title) {
      els.title.value = state.title;
      fitText(els.title);
    }
    els.exampleNote.hidden = !state.example;
  }

  function markEdited() {
    if (state.example) {
      state.example = false;
      els.exampleNote.hidden = true;
    }
  }

  /** Re-render everything after a change to the matrix structure. */
  function commit(edited) {
    if (edited) markEdited();
    saveState();
    syncHeader();
    renderMatrix();
    updateResults();
  }

  /** Apply a destructive change and offer to undo it. */
  function withUndo(message, change, edited) {
    undoSnapshot = JSON.stringify(state);
    change();
    commit(edited);
    showToast(message);
  }

  function showToast(message) {
    els.toastText.textContent = message;
    els.toast.hidden = false;
    announce(message + ' Undo is available.');
    startToastTimer();
  }

  function startToastTimer() {
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    els.toast.hidden = true;
    undoSnapshot = null;
  }

  function focusField(id, select) {
    const field = $(id);
    if (!field) return;
    field.focus();
    if (select && typeof field.select === 'function') field.select();
  }

  // ---------- Events ----------

  els.table.addEventListener('input', (event) => {
    const t = event.target;
    if (t.classList.contains('score-input')) {
      DM.setScore(state, t.dataset.criterion, t.dataset.option, t.value);
    } else if (t.classList.contains('opt-name')) {
      singleLine(t);
      DM.renameOption(state, t.dataset.option, t.value);
      refreshLabels();
      fitText(t);
    } else if (t.classList.contains('crit-name')) {
      singleLine(t);
      DM.renameCriterion(state, t.dataset.criterion, t.value);
      refreshLabels();
      fitText(t);
    } else {
      return;
    }
    markEdited();
    saveState();
    updateResults();
  });

  els.table.addEventListener('change', (event) => {
    const t = event.target;
    if (t.classList.contains('score-input')) {
      // Show the stored (clamped, rounded) value once the user leaves the cell.
      const score = DM.getScore(state, t.dataset.criterion, t.dataset.option);
      t.value = score === null ? '' : String(score);
    } else if (t.classList.contains('weight-radio')) {
      DM.setWeight(state, t.dataset.criterion, t.value);
      markEdited();
      saveState();
      updateResults();
    }
  });

  // Enter moves down a column, like a spreadsheet. Shift+Enter moves up.
  // In a name field it jumps to the first score for that option or criterion.
  els.table.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const t = event.target;
    const criteria = state.criteria;
    let next = null;
    if (t.classList.contains('score-input')) {
      const i = criteria.findIndex((c) => c.id === t.dataset.criterion);
      const target = criteria[i + (event.shiftKey ? -1 : 1)];
      if (target) next = `score-${target.id}-${t.dataset.option}`;
    } else if (t.classList.contains('opt-name')) {
      if (criteria.length) next = `score-${criteria[0].id}-${t.dataset.option}`;
    } else if (t.classList.contains('crit-name')) {
      if (state.options.length) next = `score-${t.dataset.criterion}-${state.options[0].id}`;
    } else {
      return;
    }
    event.preventDefault();
    if (next) focusField(next, true);
  });

  els.matrixPanel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    switch (button.dataset.action) {
      case 'add-option': {
        const option = DM.addOption(state);
        commit(true);
        focusField('opt-name-' + option.id, true);
        break;
      }
      case 'add-criterion': {
        const criterion = DM.addCriterion(state);
        commit(true);
        focusField('crit-name-' + criterion.id, true);
        break;
      }
      case 'remove-option': {
        const option = state.options.find((o) => o.id === button.dataset.option);
        if (!option) return;
        withUndo(`Removed ${optionName(option)}.`, () => DM.removeOption(state, option.id), true);
        focusField('add-option');
        break;
      }
      case 'remove-criterion': {
        const criterion = state.criteria.find((c) => c.id === button.dataset.criterion);
        if (!criterion) return;
        withUndo(`Removed ${criterionName(criterion)}.`, () => DM.removeCriterion(state, criterion.id), true);
        focusField('add-criterion');
        break;
      }
    }
  });

  els.title.addEventListener('input', () => {
    singleLine(els.title);
    fitText(els.title);
    state.title = els.title.value;
    markEdited();
    saveState();
  });

  els.title.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    els.title.blur();
  });

  // Wrapped text changes height when the fonts arrive or the columns resize.
  let fitFrame = 0;
  window.addEventListener('resize', () => {
    window.cancelAnimationFrame(fitFrame);
    fitFrame = window.requestAnimationFrame(fitAllText);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAllText);

  function startBlank() {
    withUndo('Started a blank matrix.', () => {
      state = DM.blankMatrix();
    }, false);
    focusField('decision-title');
  }

  $('start-blank').addEventListener('click', startBlank);
  $('example-start-blank').addEventListener('click', startBlank);
  $('load-example').addEventListener('click', () => {
    withUndo('Loaded the example.', () => {
      state = DM.exampleMatrix();
    }, false);
  });

  els.toastUndo.addEventListener('click', () => {
    if (!undoSnapshot) return;
    state = DM.normalizeMatrix(JSON.parse(undoSnapshot));
    hideToast();
    commit(false);
    announce('Undone.');
  });

  // Keep the toast up while the pointer or keyboard focus is on it.
  els.toast.addEventListener('mouseenter', () => window.clearTimeout(toastTimer));
  els.toast.addEventListener('focusin', () => window.clearTimeout(toastTimer));
  els.toast.addEventListener('mouseleave', startToastTimer);
  els.toast.addEventListener('focusout', startToastTimer);

  // ---------- Start ----------

  els.storageNote.textContent = storageOk
    ? 'Your matrix saves automatically in this browser.'
    : 'This browser is blocking storage, so your matrix lasts only until you close the page.';
  syncHeader();
  renderMatrix();
  updateResults();
})();
