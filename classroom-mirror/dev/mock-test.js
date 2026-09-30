// Offline test harness: runs Code.gs against in-memory fakes of Classroom,
// Drive, DriveApp, ScriptApp, etc. Not needed for using the script.
// Run with: node classroom-mirror/dev/mock-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

let clock = Date.parse('2026-09-30T10:00:00Z');
const tick = (ms) => { clock += ms; };

function makeWorld() {
  const files = {};
  let nextId = 1;
  const props = {};
  let triggers = [];
  const w = { files, props, get triggers() { return triggers; }, calls: 0, failNextCopy: false };

  function addFile(f) {
    const id = f.id || 'f' + nextId++;
    files[id] = Object.assign({ id, trashed: false, parents: [], appProperties: {}, createdTime: new Date(clock).toISOString(),
      modifiedTime: new Date(clock).toISOString(), capabilities: { canCopy: true, canDownload: true }, content: '' }, f, { id });
    return files[id];
  }
  w.addFile = addFile;
  addFile({ id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder' });

  function notFound() { throw new Error('GoogleJsonResponseException: API call to drive.files.get failed with error: File not found: x'); }
  function api() { w.calls++; tick(150); }
  function unesc(s) { return s.replace(/\\(.)/g, '$1'); }
  function match(f, q) {
    let m;
    if (/trashed=false/.test(q) && f.trashed) return false;
    if ((m = q.match(/'([^']+)' in parents/)) && f.parents.indexOf(m[1]) < 0) return false;
    if ((m = q.match(/mimeType='([^']+)'/)) && f.mimeType !== m[1]) return false;
    if ((m = q.match(/name='((?:\\.|[^'\\])*)'/)) && f.name !== unesc(m[1])) return false;
    if ((m = q.match(/appProperties has \{ key='([^']+)' and value='((?:\\.|[^'\\])*)' \}/)) &&
        (f.appProperties || {})[m[1]] !== unesc(m[2])) return false;
    return true;
  }
  const pub = (f) => JSON.parse(JSON.stringify(Object.assign({}, f, { content: undefined })));

  const Drive = { Files: {
    get(id) { api(); const f = files[id]; if (!f || f.hidden) notFound(); return pub(f); },
    list(o) { api(); return { files: Object.values(files).filter((f) => !f.hidden && f.id !== 'root' && match(f, o.q)).map(pub) }; },
    create(res, blob) {
      api();
      const f = addFile({ name: res.name, mimeType: res.mimeType, parents: res.parents.slice(), appProperties: Object.assign({}, res.appProperties),
        content: blob ? blob.content : '', mine: true });
      return pub(f);
    },
    copy(res, srcId) {
      api();
      if (w.failNextCopy) { w.failNextCopy = false; throw new Error('Insufficient permissions for this file'); }
      const s = files[srcId]; if (!s || s.hidden) notFound();
      const f = addFile({ name: res.name, mimeType: s.mimeType, parents: res.parents.slice(), appProperties: Object.assign({}, res.appProperties),
        content: s.content, md5Checksum: s.md5Checksum, mine: true });
      return pub(f);
    },
    update(res, id, blob) { api(); const f = files[id]; if (!f) notFound(); if (blob) f.content = blob.content; return pub(f); },
  } };

  function blob(content, mime, name) {
    return { content, mime, name, setName(n) { this.name = n; return this; }, getDataAsString() { return this.content; } };
  }
  const DriveApp = {
    getFileById(id) {
      api();
      const f = files[id];
      if (!f || f.hidden) throw new Error('No item with the given ID could be found. Possibly because you have not edited this item.');
      return {
        isTrashed: () => f.trashed || f.parents.some((p) => files[p] && files[p].trashed),
        getBlob: () => blob(f.content, f.mimeType, f.name),
        getAs: (mime) => { if (f.tooBig) throw new Error('Conversion too large'); return blob('PDF(' + f.content + ')', mime, f.name); },
      };
    },
  };

  const Utilities = {
    newBlob: blob,
    sleep: (ms) => tick(ms),
    formatDate: (d, tz, fmt) => {
      const iso = d.toISOString();
      return fmt === 'yyyy-MM-dd' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
    },
    computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(s).digest()).map((b) => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { MD5: 'MD5' },
    Charset: { UTF_8: 'UTF-8' },
  };

  const PropertiesService = { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { if (String(v).length > 9000) throw new Error('property too large'); props[k] = String(v); },
    deleteProperty: (k) => { delete props[k]; },
  }) };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
    newTrigger: (h) => ({ timeBased: () => {
      const spec = { h };
      const b = { everyHours: (n) => { spec.every = n; return b; }, after: (ms) => { spec.after = ms; return b; },
        create: () => { const t = { getHandlerFunction: () => h, spec }; triggers.push(t); return t; } };
      return b;
    } }),
  };

  // --- Classroom fake ---
  const courses = [];
  w.courses = courses;
  function page(arr, o, field) {
    api();
    const start = o.pageToken ? Number(o.pageToken) : 0;
    const out = { [field]: arr.slice(start, start + o.pageSize) };
    if (start + o.pageSize < arr.length) out.nextPageToken = String(start + o.pageSize);
    return out;
  }
  const course = (id) => { const c = courses.find((x) => x.id === id); if (!c) throw new Error('Requested entity was not found.'); return c; };
  const Classroom = { Courses: {
    list: (o) => page(courses.filter((c) => c.state === 'ACTIVE'), { pageSize: o.pageSize, pageToken: o.pageToken }, 'courses'),
    get: (id) => { api(); return course(id); },
    CourseWorkMaterials: { list: (id, o) => page(course(id).materials, o, 'courseWorkMaterial') },
    CourseWork: { list: (id, o) => page(course(id).work, o, 'courseWork') },
    Announcements: { list: (id, o) => page(course(id).ann, o, 'announcements') },
    Topics: { list: (id, o) => page(course(id).topics, o, 'topic') },
  } };

  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
  }
  const logs = [];
  const sandbox = { Drive, DriveApp, Utilities, PropertiesService, LockService, ScriptApp, Classroom,
    Session: { getScriptTimeZone: () => 'UTC' }, Date: FakeDate, Math, JSON, String, Object, Array, Error, isNaN, RegExp,
    console: { log: (s) => logs.push(s), warn: (s) => logs.push('WARN ' + s), error: (s) => logs.push('ERR ' + s) } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\nthis.CONFIG = CONFIG;', sandbox);
  w.g = sandbox;
  w.logs = logs;
  return w;
}

// ---------- helpers ----------
const mine = (w) => Object.values(w.files).filter((f) => f.mine && !f.trashed);
const byName = (w, name) => Object.values(w.files).find((f) => f.name === name && !f.trashed);
const childNames = (w, folderId) => mine(w).filter((f) => f.parents[0] === folderId).map((f) => f.name).sort();
const copies = (w) => mine(w).filter((f) => f.appProperties.mirrorSrc);
function drain(w, maxRuns = 50) {
  // Run the hourly entry point, then keep firing continuations until the pass is done.
  w.g.mirrorClassroom();
  let n = 1;
  while (w.props.CRAWL && n < maxRuns) { tick(60000); w.g.continueMirror(); n++; }
  assert(!w.props.CRAWL, 'pass did not finish');
  return n;
}
const drive = (id, title) => ({ driveFile: { driveFile: { id, title, alternateLink: 'https://drive.google.com/file/d/' + id } } });

function seed(w) {
  const doc = w.addFile({ id: 'DOC', name: 'Lecture 1', mimeType: 'application/vnd.google-apps.document', content: 'doc v1' });
  w.addFile({ id: 'PDF', name: 'Syllabus: Fall/2026.pdf', mimeType: 'application/pdf', content: 'pdf', md5Checksum: 'aaa' });
  w.addFile({ id: 'NOACCESS', name: 'secret', mimeType: 'application/pdf', hidden: true });
  w.addFile({ id: 'LOCKED', name: 'Locked.docx', mimeType: 'application/msword', md5Checksum: 'x', capabilities: { canCopy: false, canDownload: false } });
  w.addFile({ id: 'FORM', name: 'Quiz', mimeType: 'application/vnd.google-apps.form' });
  w.courses.push({
    id: 'C1', name: 'Bio 101', section: 'A', state: 'ACTIVE',
    topics: [{ topicId: 'T1', name: 'Week 1' }],
    materials: [{ id: 'm1', title: 'Week 1 slides', topicId: 'T1', creationTime: '2026-09-01T10:00:00Z',
      materials: [drive('DOC', 'Lecture 1'), drive('PDF', 'Syllabus'), { youtubeVideo: { id: 'yt', title: 'Intro video', alternateLink: 'https://youtu.be/yt' } }] }],
    work: [{ id: 'w1', title: 'Essay [1]', creationTime: '2026-09-02T10:00:00Z',
      materials: [drive('PDF', 'Syllabus'), drive('NOACCESS', 'secret'), drive('LOCKED', 'Locked'), { form: { formUrl: 'https://forms/q', title: 'Quiz' } }] }],
    ann: [{ id: 'a1', text: 'Hello   class! '.repeat(10), creationTime: '2026-09-03T10:00:00Z',
      materials: [drive('DOC', 'Lecture 1'), { link: { url: 'https://example.com/a b', title: 'Example' } }] }],
  });
  w.courses.push({ id: 'C2', name: 'Bio 101', section: 'B', state: 'ACTIVE', topics: [], materials: [], work: [],
    ann: Array.from({ length: 45 }, (_, i) => ({ id: 'b' + i, text: 'Post ' + i, creationTime: '2026-09-04T10:00:00Z',
      materials: [drive(w.addFile({ name: 'Handout ' + i + '.pdf', mimeType: 'application/pdf', md5Checksum: 'h' + i }).id, 'H')] })) });
  w.courses.push({ id: 'C3', name: 'Old', state: 'ARCHIVED', topics: [], materials: [], work: [], ann: [] });
  return doc;
}

// ---------- scenarios ----------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('first pass mirrors everything into the right folders', () => {
  const w = makeWorld(); seed(w);
  drain(w);
  const root = byName(w, 'Classroom Mirror');
  assert(root && root.parents[0] === 'root');
  assert.deepStrictEqual(childNames(w, root.id), ['Bio 101', 'Bio 101 - B', '_meta']);
  const c1 = byName(w, 'Bio 101');
  assert.deepStrictEqual(childNames(w, c1.id), ['Announcements', 'Syllabus Fall 2026.pdf', 'Week 1', 'links.md']);
  assert.deepStrictEqual(childNames(w, byName(w, 'Week 1').id), ['Lecture 1.pdf', 'Syllabus Fall 2026.pdf']);
  assert.deepStrictEqual(childNames(w, byName(w, 'Announcements').id), ['Lecture 1.pdf']);
  assert.strictEqual(byName(w, 'Lecture 1.pdf').content, 'PDF(doc v1)');
  const links = byName(w, 'links.md').content;
  for (const s of ['YouTube: [Intro video]', 'Form: [Quiz]', 'Link: [Example](<https://example.com/a%20b>)', 'Locked.docx', 'Essay \\[1\\]', 'Hello class! Hello'])
    assert(links.includes(s), 'links.md missing ' + s + '\n' + links);
  assert(!links.includes('secret'));
  assert.strictEqual(copies(w).length, 4 + 45);
  const log = byName(w, 'mirror-log.csv').content;
  assert(/SKIPPED.*No access/.test(log) && /SKIPPED.*disabled download/.test(log));
  assert.strictEqual(w.triggers.length, 0, 'continuation triggers left behind');
});

test('second pass creates nothing and logs no repeat skips', () => {
  const w = makeWorld(); seed(w);
  drain(w);
  const before = mine(w).length;
  const log1 = byName(w, 'mirror-log.csv').content;
  const links1 = byName(w, 'links.md').content;
  drain(w);
  assert.strictEqual(mine(w).length, before);
  assert.strictEqual(byName(w, 'mirror-log.csv').content, log1);
  assert.strictEqual(byName(w, 'links.md').content, links1);
});

test('updated source gets a dated new version in each destination', () => {
  const w = makeWorld(); const doc = seed(w);
  drain(w);
  tick(86400000); doc.modifiedTime = new Date(clock).toISOString(); doc.content = 'doc v2';
  drain(w);
  const v2 = mine(w).filter((f) => f.name === 'Lecture 1 (updated 2026-10-01).pdf');
  assert.strictEqual(v2.length, 2);
  assert(v2.every((f) => f.content === 'PDF(doc v2)'));
  assert.strictEqual(mine(w).filter((f) => f.name === 'Lecture 1.pdf').length, 2, 'originals kept');
  drain(w);
  assert.strictEqual(mine(w).filter((f) => /Lecture 1/.test(f.name)).length, 4);
});

test('lost state.json does not cause duplicates', () => {
  const w = makeWorld(); seed(w);
  drain(w);
  const before = mine(w).length;
  w.g.resetState();
  drain(w);
  assert.strictEqual(mine(w).length, before);
  // Also with the state file deleted outright and Script Properties wiped.
  byName(w, 'state.json').trashed = true;
  for (const k of Object.keys(w.props)) delete w.props[k];
  drain(w);
  assert.strictEqual(mine(w).length, before, 'only a new state.json may appear');
});

test('time limit: resumes at the exact attachment, one continuation at a time', () => {
  const w = makeWorld(); seed(w);
  w.g.CONFIG.MAX_RUN_MS = 3000; // forces many stops mid-page / mid-post
  let runs = 0;
  w.g.mirrorClassroom(); runs++;
  while (w.props.CRAWL) {
    assert(w.triggers.filter((t) => t.getHandlerFunction() === 'continueMirror').length <= 1);
    tick(60000); w.g.continueMirror(); runs++;
    assert(runs < 200);
  }
  assert(runs > 5, 'expected many runs, got ' + runs);
  assert.strictEqual(copies(w).length, 49);
  assert.strictEqual(new Set(copies(w).map((f) => f.appProperties.mirrorSrc + f.parents[0])).size, 49);
});

test('killed run (no clean exit) resumes without duplicates and skips a file that keeps killing it', () => {
  const w = makeWorld(); seed(w);
  // Simulate a hard kill: an export that never returns within the limit.
  w.addFile({ id: 'BIG', name: 'Huge deck', mimeType: 'application/vnd.google-apps.presentation', content: 'big' });
  w.courses[0].materials.unshift({ id: 'm0', title: 'Big', creationTime: '2026-09-01T09:00:00Z', materials: [drive('BIG', 'Huge deck')] });
  // Emulate Apps Script killing the process mid-export: throw something that also makes every
  // later ctx.log call throw, so no catch/finally cleanup in run_ gets to save anything.
  const realFormat = w.g.Utilities.formatDate;
  w.g.Utilities.formatDate = function () { if (w.dying) throw { killed: true }; return realFormat.apply(null, arguments); };
  w.g.processDriveFile_ = ((orig) => function (ctx, cc, info, df) {
    if (df.id === 'BIG' && !ctx.state.poison.BIG) { w.props.INFLIGHT_FILE_ID = 'BIG'; w.dying = true; throw { killed: true }; }
    return orig.apply(this, arguments);
  })(w.g.processDriveFile_);
  let kills = 0;
  const killRun = (fnName) => {
    try { w.g[fnName](); } catch (e) { if (!(e && e.killed)) throw e; kills++; w.dying = false; }
  };
  killRun('mirrorClassroom');
  let n = 0;
  while (w.props.CRAWL && n++ < 50) { tick(480000); killRun('continueMirror'); }
  assert.strictEqual(kills, 2, 'should give up on BIG after 2 kills');
  assert.strictEqual(copies(w).length, 49);
  assert(byName(w, 'links.md').content.includes('Huge deck'));
  assert(/Skipped: copying it repeatedly exceeded/.test(byName(w, 'mirror-log.csv').content));
});

test('copy refused -> download+upload fallback; unreadable export -> link', () => {
  const w = makeWorld(); seed(w);
  w.failNextCopy = true;
  w.addFile({ id: 'TOOBIG', name: 'Giant sheet', mimeType: 'application/vnd.google-apps.spreadsheet', tooBig: true });
  w.courses[0].work[0].materials.push(drive('TOOBIG', 'Giant sheet'));
  drain(w);
  assert.strictEqual(copies(w).length, 49);
  assert(byName(w, 'links.md').content.includes('Giant sheet'));
  assert(/PDF export failed/.test(byName(w, 'mirror-log.csv').content));
});

test('existing non-script "Classroom Mirror" folder stops with a clear error and no loop', () => {
  const w = makeWorld(); seed(w);
  w.addFile({ name: 'Classroom Mirror', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
  assert.throws(() => w.g.mirrorClassroom(), /already exists in My Drive/);
  assert.strictEqual(w.triggers.length, 0);
});

test('setup / removeTriggers', () => {
  const w = makeWorld(); seed(w);
  w.g.setup(); w.g.setup();
  assert.deepStrictEqual(w.triggers.map((t) => t.getHandlerFunction()), ['mirrorClassroom']);
  w.g.removeTriggers();
  assert.strictEqual(w.triggers.length, 0);
});

test('testOneCourse only touches that course', () => {
  const w = makeWorld(); seed(w);
  w.g.CONFIG.TEST_COURSE_ID = 'C1';
  w.g.testOneCourse();
  while (w.props.CRAWL) { tick(60000); w.g.continueMirror(); }
  assert(!byName(w, 'Bio 101 - B'));
  assert.strictEqual(copies(w).length, 4);
});

test('name helpers', () => {
  const w = makeWorld();
  assert.strictEqual(w.g.fileName_('  ../a:b/c?.PDF ', ''), 'a b c.PDF');
  assert.strictEqual(w.g.fileName_('Report.pdf', '.pdf'), 'Report.pdf');
  assert.strictEqual(w.g.fileName_('', '.pdf'), 'Untitled.pdf');
  assert.strictEqual(w.g.withSuffix_('a.b.docx', ' (2)', true), 'a.b (2).docx');
  assert.strictEqual(w.g.withSuffix_('Chem 1.01', ' (2)', false), 'Chem 1.01 (2)');
  assert.strictEqual(w.g.fileName_('x'.repeat(300) + '.pdf', '').length, 124);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e)); }
}
process.exit(failed ? 1 : 0);
