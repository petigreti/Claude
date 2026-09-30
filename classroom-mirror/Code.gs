/**
 * Classroom Mirror
 * ----------------
 * Copies Google Classroom attachments (course materials, assignments and
 * announcements) into "Classroom Mirror/<Course>/<Topic>/" in your My Drive,
 * so Google Drive for desktop can keep a local copy on your Mac.
 *
 * Functions you run from the editor:
 *   listMyCourses()   print your ACTIVE student courses and their IDs
 *   testOneCourse()   mirror only CONFIG.TEST_COURSE_ID (first test)
 *   mirrorClassroom() mirror all active courses (the hourly trigger runs this)
 *   setup()           create the hourly trigger
 *   removeTriggers()  delete every trigger this script created
 *   showStatus()      show progress of the current / last pass
 *   resetState()      forget the bookkeeping; mirrored files are kept and are
 *                     NOT copied again (each copy is tagged with its source)
 *
 * How duplicates are prevented
 *   Every file the script creates carries hidden Drive "appProperties":
 *   mirrorSrc (source file ID) and mirrorRev (source revision). state.json in
 *   _meta/ is a fast cache of the same information. If state.json is lost or a
 *   run is killed before saving it, the tags on the copies are still there, so
 *   nothing gets copied twice.
 */

// ============================== CONFIG ==============================

const CONFIG = {
  // Put a course ID here (from listMyCourses) before running testOneCourse().
  TEST_COURSE_ID: '',

  ROOT_FOLDER_NAME: 'Classroom Mirror',
  META_FOLDER_NAME: '_meta',
  ANNOUNCEMENTS_FOLDER_NAME: 'Announcements',
  LINKS_FILE_NAME: 'links.md',
  STATE_FILE_NAME: 'state.json',
  LOG_FILE_NAME: 'mirror-log.csv',

  MAX_RUN_MS: 4.5 * 60 * 1000,      // stop well before Apps Script's 6-minute limit
  CONTINUE_DELAY_MS: 60 * 1000,      // continuation after a planned stop
  SAFETY_CONTINUE_MS: 8 * 60 * 1000, // continuation if a run gets killed anyway
  FLUSH_EVERY_ACTIONS: 10,           // save state after this many copies/links...
  FLUSH_EVERY_MS: 60 * 1000,         // ...or this much time, whichever comes first
  PAGE_SIZE: 20,                     // Classroom posts per API page
  LOG_MAX_ROWS: 5000,
  MAX_NAME_LENGTH: 120,
  MAX_HARD_KILLS: 2,                 // killed runs in a row at the same file before skipping it
  KILL_SKIP_DAYS: 7,                 // ...for this long (or until the file changes)
  MAX_FAILED_RUNS: 3,                // crashed runs in a row before a pass is abandoned
};

const HANDLER_HOURLY = 'mirrorClassroom';
// Each kind of pass has its own saved cursor and its own continuation trigger.
const MODE = {
  FULL: { label: 'Full pass', prop: 'CRAWL', inflightProp: 'INFLIGHT_FULL', continueHandler: 'continueMirror' },
  TEST: { label: 'Test pass', prop: 'TEST_CRAWL', inflightProp: 'INFLIGHT_TEST', continueHandler: 'continueTestCourse' },
};
const PROP = {
  STATE_ID: 'STATE_FILE_ID',
  LAST_DONE: 'LAST_COMPLETED_PASS',
};
const STREAMS = ['materials', 'courseWork', 'announcements'];
const STREAM_LABEL = { materials: 'Material', courseWork: 'Assignment', announcements: 'Announcement' };
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const GOOGLE_MIME_PREFIX = 'application/vnd.google-apps.';
const PDF_EXPORTABLE = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
];
const META_FIELDS =
  'id,name,mimeType,modifiedTime,md5Checksum,trashed,capabilities(canCopy,canDownload),shortcutDetails(targetId)';
const LOG_HEADER = 'time,action,course,subfolder,file,source_id,details';

// ========================== PUBLIC FUNCTIONS ==========================

function mirrorClassroom() {
  run_(MODE.FULL, false);
}

function continueMirror() {
  run_(MODE.FULL, false);
}

// Test pass for one course. It uses its own cursor and its own continuation
// trigger, never installs the hourly trigger, and never touches a full pass
// that's in progress. It shares state.json and the tags with the full mirror
// on purpose: files it copies are real, and the full pass recognises them
// instead of copying them again.
function testOneCourse() {
  const id = String(CONFIG.TEST_COURSE_ID || '').trim();
  if (!id) {
    throw new Error('Set CONFIG.TEST_COURSE_ID at the top of Code.gs first (run listMyCourses() to find it).');
  }
  run_(MODE.TEST, true);
}

function continueTestCourse() {
  run_(MODE.TEST, false);
}

function setup() {
  withLock_(function () {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === HANDLER_HOURLY) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger(HANDLER_HOURLY).timeBased().everyHours(1).create();
    const ctx = openContext_();
    ctx.log('SETUP', '', '', '', '', 'Hourly trigger created');
    flush_(ctx, null);
    console.log('Hourly trigger created. Mirror folder: https://drive.google.com/drive/folders/' + ctx.rootId);
  });
}

function removeTriggers() {
  const ours = [HANDLER_HOURLY, MODE.FULL.continueHandler, MODE.TEST.continueHandler];
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  console.log('Removed ' + n + ' trigger(s).');
}

function listMyCourses() {
  const courses = listActiveCourses_();
  if (!courses.length) console.log('No ACTIVE courses where you are a student.');
  courses.forEach(function (c) {
    console.log(c.id + '  —  ' + c.name + (c.section ? ' (' + c.section + ')' : ''));
  });
}

function showStatus() {
  const props = PropertiesService.getScriptProperties();
  console.log('Last completed full pass: ' + (props.getProperty(PROP.LAST_DONE) || 'never'));
  [MODE.FULL, MODE.TEST].forEach(function (mode) {
    const crawl = loadCrawl_(mode);
    if (!crawl) {
      console.log(mode.label + ': not in progress.');
      return;
    }
    const ci = crawl.courseIds.indexOf(crawl.pos.courseId);
    console.log(mode.label + ': in progress since ' + crawl.startedAt +
      ', course ' + (ci + 1) + ' of ' + crawl.courseIds.length +
      ', stream ' + (STREAMS[crawl.pos.stream] || '-'));
  });
  const triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  console.log('Triggers: ' + (triggers.length ? triggers.join(', ') : 'none'));
}

function resetState() {
  withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(MODE.FULL.prop);
    props.deleteProperty(MODE.TEST.prop);
    props.deleteProperty(MODE.FULL.inflightProp);
    props.deleteProperty(MODE.TEST.inflightProp);
    const ctx = openContext_();
    ctx.state = blankState_();
    ctx.dirty = true;
    ctx.log('RESET', '', '', '', '', 'State cleared; existing copies will be recognised by their tags');
    flush_(ctx, null);
    console.log('State cleared.');
  });
}

// ============================== RUNNER ==============================

// mode: MODE.FULL or MODE.TEST. fresh: start a new pass instead of resuming.
function run_(mode, fresh) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    console.log('Another mirror run is still active; exiting.');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  let ctx = null;
  let crawl = null;
  try {
    // At most one continuation trigger per mode: remove old ones (fired or
    // not), then arm a safety net that fires after this run's hard 6-minute
    // limit in case Apps Script kills it.
    deleteContinuations_(mode);
    scheduleContinuation_(mode, CONFIG.SAFETY_CONTINUE_MS);

    ctx = openContext_();
    ctx.inflightProp = mode.inflightProp;
    crawl = fresh ? null : loadCrawl_(mode);
    if (crawl && crawl.cleanExit === false) crawl = handleKilledRun_(ctx, crawl);
    if (!crawl) {
      if (mode === MODE.TEST && !fresh) {
        // A leftover test continuation with nothing to continue.
        deleteContinuations_(mode);
        flush_(ctx, null);
        return;
      }
      crawl = newCrawl_(mode);
    }
    crawl.cleanExit = false;
    saveCrawl_(crawl);

    const done = crawlCourses_(ctx, crawl);

    if (done) {
      flush_(ctx, null);
      props.deleteProperty(mode.prop);
      if (mode === MODE.FULL) props.setProperty(PROP.LAST_DONE, new Date().toISOString());
      deleteContinuations_(mode);
      console.log(mode.label + ' complete (' + ctx.actions + ' change(s) this run).');
    } else {
      crawl.cleanExit = true;
      crawl.kills = 0;
      crawl.killKey = '';
      crawl.errors = 0;
      flush_(ctx, crawl);
      deleteContinuations_(mode);
      scheduleContinuation_(mode, CONFIG.CONTINUE_DELAY_MS);
      console.log('Time budget used; continuing in about a minute (' + ctx.actions + ' change(s) this run).');
    }
  } catch (e) {
    console.error('Mirror run failed: ' + ((e && e.stack) || e));
    try {
      if (ctx) {
        ctx.log('ERROR', '', '', '', '', 'Run aborted: ' + shortErr_(e));
        flush_(ctx, null);
      }
      if (crawl) {
        crawl.cleanExit = true;
        crawl.errors = (crawl.errors || 0) + 1;
        if (crawl.errors >= CONFIG.MAX_FAILED_RUNS) {
          props.deleteProperty(mode.prop);
          deleteContinuations_(mode);
          console.error('Giving up on this pass; the next hourly run starts a fresh one.');
        } else {
          saveCrawl_(crawl); // the safety-net continuation retries it
        }
      } else {
        deleteContinuations_(mode); // failed before a pass existed: don't loop every few minutes
      }
    } catch (inner) {
      console.error('Cleanup after failure also failed: ' + inner);
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// The previous run ended without a clean exit, so Apps Script killed it at the
// 6-minute limit. Only kills at the SAME spot count toward giving up:
// - dying twice while copying the same file puts that file on a temporary
//   skip list (CONFIG.KILL_SKIP_DAYS; cleared sooner if the file changes);
// - dying twice at the same cursor outside a copy abandons this pass only.
// Ordinary errors are caught, never reach this function, and never skip a file.
function handleKilledRun_(ctx, crawl) {
  const props = PropertiesService.getScriptProperties();
  const parts = (props.getProperty(ctx.inflightProp) || '').split('|');
  const inflight = parts[0];
  const inflightRev = parts.slice(1).join('|');
  props.deleteProperty(ctx.inflightProp);
  const killKey = inflight ? 'file:' + inflight : 'pos:' + JSON.stringify(crawl.pos);
  crawl.kills = crawl.killKey === killKey ? (crawl.kills || 0) + 1 : 1;
  crawl.killKey = killKey;
  ctx.log('WARNING', '', '', '', inflight, 'Previous run hit the time limit ' +
    (inflight ? 'while copying this file' : 'between files') + ' (' + crawl.kills + 'x at the same spot)');
  if (crawl.kills < CONFIG.MAX_HARD_KILLS) return crawl;

  crawl.kills = 0;
  crawl.killKey = '';
  if (inflight) {
    ctx.state.poison[inflight] = {
      until: new Date(Date.now() + CONFIG.KILL_SKIP_DAYS * 86400000).toISOString(),
      rev: inflightRev,
    };
    ctx.dirty = true;
    return crawl;
  }
  ctx.log('ERROR', '', '', '', '', 'Abandoning this pass; the next hourly run starts over');
  return null;
}

function deleteContinuations_(mode) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === mode.continueHandler) ScriptApp.deleteTrigger(t);
  });
}

function scheduleContinuation_(mode, ms) {
  ScriptApp.newTrigger(mode.continueHandler).timeBased().after(ms).create();
}

// =============================== CRAWL ===============================
// A "pass" walks every course -> stream -> page -> post -> attachment.
// crawl.pos is the exact next attachment to process, saved with every flush.

function newCrawl_(mode) {
  const ids = mode === MODE.TEST
    ? [String(CONFIG.TEST_COURSE_ID).trim()]
    : listActiveCourses_().map(function (c) { return c.id; });
  return {
    prop: mode.prop,
    startedAt: new Date().toISOString(),
    courseIds: ids,
    pos: { courseId: ids[0] || '', stream: 0, pageToken: '', postId: '', att: 0 },
    kills: 0,
    killKey: '',
    errors: 0,
    cleanExit: true,
  };
}

function loadCrawl_(mode) {
  const raw = PropertiesService.getScriptProperties().getProperty(mode.prop);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveCrawl_(crawl) {
  PropertiesService.getScriptProperties().setProperty(crawl.prop, JSON.stringify(crawl));
}

// Returns true when the pass is finished, false when the time budget ran out.
function crawlCourses_(ctx, crawl) {
  const pos = crawl.pos;
  let ci = crawl.courseIds.indexOf(pos.courseId);
  if (ci < 0) return true;

  for (; ci < crawl.courseIds.length; ci++) {
    const courseId = crawl.courseIds[ci];
    if (pos.courseId !== courseId) {
      pos.courseId = courseId;
      pos.stream = 0;
      pos.pageToken = '';
      pos.postId = '';
      pos.att = 0;
    }
    let cc;
    try {
      cc = courseCtx_(ctx, courseId);
    } catch (e) {
      ctx.log('ERROR', courseId, '', '', '', 'Could not read course: ' + shortErr_(e));
      continue;
    }

    for (; pos.stream < STREAMS.length; pos.stream++, pos.pageToken = '', pos.postId = '', pos.att = 0) {
      const stream = STREAMS[pos.stream];
      let restarted = false;
      while (true) {
        if (outOfTime_(ctx)) return false;
        let page;
        try {
          page = listStream_(stream, courseId, pos.pageToken);
        } catch (e) {
          if (pos.pageToken && !restarted) {
            // A saved page token may have expired: restart this stream (copies are deduplicated).
            restarted = true;
            pos.pageToken = '';
            pos.postId = '';
            pos.att = 0;
            continue;
          }
          ctx.log('ERROR', cc.label, '', '', '', 'Could not list ' + stream + ': ' + shortErr_(e));
          break;
        }

        let start = 0;
        if (pos.postId) {
          const found = page.items.findIndex(function (p) { return p.id === pos.postId; });
          if (found >= 0) {
            start = found;
          } else {
            pos.postId = '';
            pos.att = 0;
          }
        }

        for (let i = start; i < page.items.length; i++) {
          const post = page.items[i];
          if (pos.postId !== post.id) {
            pos.postId = post.id;
            pos.att = 0;
          }
          const materials = post.materials || [];
          if (!materials.length) continue;
          const info = postInfo_(ctx, stream, post);
          while (pos.att < materials.length) {
            if (outOfTime_(ctx)) return false;
            try {
              processMaterial_(ctx, cc, info, materials[pos.att]);
            } catch (e) {
              ctx.log('ERROR', cc.label, '', '', '', info.label + ' "' + info.postTitle + '": ' + shortErr_(e));
            }
            pos.att++;
            maybeFlush_(ctx, crawl);
          }
        }

        if (!page.next) break;
        pos.pageToken = page.next;
        pos.postId = '';
        pos.att = 0;
      }
    }
  }
  pos.courseId = '';
  return true;
}

function outOfTime_(ctx) {
  return Date.now() - ctx.started > CONFIG.MAX_RUN_MS;
}

// ============================= CLASSROOM =============================

function listActiveCourses_() {
  const out = [];
  let token = '';
  do {
    const opts = { studentId: 'me', courseStates: ['ACTIVE'], pageSize: 100 };
    if (token) opts.pageToken = token;
    const r = retry_(function () { return Classroom.Courses.list(opts); });
    (r.courses || []).forEach(function (c) { out.push(c); });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

function listStream_(stream, courseId, pageToken) {
  const opts = { pageSize: CONFIG.PAGE_SIZE };
  if (pageToken) opts.pageToken = pageToken;
  let r;
  let items;
  if (stream === 'materials') {
    r = retry_(function () { return Classroom.Courses.CourseWorkMaterials.list(courseId, opts); });
    items = r.courseWorkMaterial;
  } else if (stream === 'courseWork') {
    r = retry_(function () { return Classroom.Courses.CourseWork.list(courseId, opts); });
    items = r.courseWork;
  } else {
    r = retry_(function () { return Classroom.Courses.Announcements.list(courseId, opts); });
    items = r.announcements;
  }
  return { items: items || [], next: r.nextPageToken || '' };
}

function courseCtx_(ctx, courseId) {
  if (!ctx.courses[courseId]) {
    const c = retry_(function () { return Classroom.Courses.get(courseId); });
    const name = c.name || 'Course ' + courseId;
    ctx.courses[courseId] = {
      id: courseId, name: name, section: c.section || '', topics: null,
      label: name + (c.section ? ' (' + c.section + ')' : ''), // for the log
    };
  }
  return ctx.courses[courseId];
}

function topicName_(ctx, cc, topicId) {
  if (!cc.topics) {
    cc.topics = {};
    try {
      let token = '';
      do {
        const opts = { pageSize: 100 };
        if (token) opts.pageToken = token;
        const r = retry_(function () { return Classroom.Courses.Topics.list(cc.id, opts); });
        (r.topic || []).forEach(function (t) { cc.topics[t.topicId] = t.name; });
        token = r.nextPageToken || '';
      } while (token);
    } catch (e) {
      ctx.log('WARNING', cc.label, '', '', '', 'Could not read topics, using course folder: ' + shortErr_(e));
    }
  }
  return cc.topics[topicId] || '';
}

function postInfo_(ctx, stream, post) {
  let title;
  if (stream === 'announcements') {
    const text = String(post.text || '').replace(/\s+/g, ' ').trim();
    title = text.length > 80 ? text.slice(0, 80).trim() + '…' : (text || '(announcement)');
  } else {
    title = post.title || '(untitled)';
  }
  return {
    stream: stream,
    label: STREAM_LABEL[stream],
    postKey: stream + ':' + post.id,
    postTitle: title,
    topicId: post.topicId || '',
    postDate: formatDate_(ctx, post.creationTime || post.updateTime),
  };
}

// ============================ ATTACHMENTS ============================

function processMaterial_(ctx, cc, info, m) {
  if (m.driveFile && m.driveFile.driveFile) return processDriveFile_(ctx, cc, info, m.driveFile.driveFile);
  if (m.youtubeVideo) {
    const v = m.youtubeVideo;
    return addLink_(ctx, cc, info, 'YouTube', v.title, v.alternateLink || 'https://www.youtube.com/watch?v=' + v.id);
  }
  if (m.link) return addLink_(ctx, cc, info, 'Link', m.link.title, m.link.url);
  if (m.form) return addLink_(ctx, cc, info, 'Form', m.form.title, m.form.formUrl);

  // Attachment types added to Classroom later: keep whatever link they carry.
  const kind = Object.keys(m)[0] || 'unknown';
  const v = m[kind] || {};
  const url = v.alternateLink || v.url || v.formUrl;
  if (url) return addLink_(ctx, cc, info, kind, v.title, url);
  skip_(ctx, cc, info, kind, '', 'Unsupported attachment type: ' + kind, null, '');
}

function processDriveFile_(ctx, cc, info, df) {
  let srcId = df.id;
  const title = df.title || srcId;
  const openUrl = df.alternateLink || 'https://drive.google.com/open?id=' + srcId;

  let meta;
  try {
    meta = getMetaOrNull_(srcId, META_FIELDS);
    if (meta && meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails && meta.shortcutDetails.targetId) {
      srcId = meta.shortcutDetails.targetId;
      meta = getMetaOrNull_(srcId, META_FIELDS);
    }
  } catch (e) {
    return skip_(ctx, cc, info, srcId, title, 'Could not read file info', null, shortErr_(e));
  }
  if (!meta) return skip_(ctx, cc, info, srcId, title, 'No access, or the file was deleted', null, '');
  if (meta.trashed) return skip_(ctx, cc, info, srcId, meta.name, 'File is in the owner\'s trash', null, '');
  const rev = meta.md5Checksum || meta.modifiedTime;
  const poison = ctx.state.poison[srcId];
  if (poison) {
    if (poison.until > new Date().toISOString() && poison.rev === rev) {
      return skip_(ctx, cc, info, srcId, meta.name, 'Temporarily skipped: copying it made the script time out twice; ' +
        'will retry after ' + poison.until.slice(0, 10) + ' or when the file changes', openUrl, '');
    }
    delete ctx.state.poison[srcId]; // expired, or the file changed: try again
    ctx.dirty = true;
  }

  const mime = meta.mimeType;
  const isGoogle = mime.indexOf(GOOGLE_MIME_PREFIX) === 0;
  if (isGoogle && PDF_EXPORTABLE.indexOf(mime) < 0) {
    // Forms, Sites, folders, My Maps...: no PDF version, so record the link.
    return addLink_(ctx, cc, info, mime === FOLDER_MIME ? 'Drive folder' : 'Google file', meta.name, openUrl);
  }
  const caps = meta.capabilities || {};
  const obtainable = isGoogle ? caps.canDownload !== false : (caps.canCopy !== false || caps.canDownload !== false);
  if (!obtainable) return skip_(ctx, cc, info, srcId, meta.name, 'Owner disabled download/copy for viewers', openUrl, '');

  const dest = destFolder_(ctx, cc, info);
  const key = srcId + '|' + dest.id; // one entry per source file per destination folder
  const prev = ctx.state.files[key] || adoptExistingCopy_(ctx, key, srcId, dest.id);
  if (prev && prev.rev === rev) return; // mirrored and unchanged

  const baseName = isGoogle ? fileName_(meta.name, '.pdf') : fileName_(meta.name, '');
  const wanted = prev
    ? withSuffix_(baseName, ' (updated ' + formatDate_(ctx, meta.modifiedTime) + ')', true)
    : baseName;
  const name = uniqueName_(dest.id, wanted, null, false);
  const tags = { mirrorSrc: srcId, mirrorRev: rev };

  if (isGoogle && ctx.conversionsBlocked) return; // daily conversion quota used up; next pass retries

  // Remember which file is being copied, in case Apps Script kills the run mid-copy.
  const props = PropertiesService.getScriptProperties();
  props.setProperty(ctx.inflightProp, srcId + '|' + rev);
  let created;
  try {
    created = isGoogle
      ? exportPdf_(srcId, name, dest.id, tags)
      : copyBinary_(srcId, name, mime, dest.id, tags, caps);
  } catch (e) {
    if (isGoogle && isDailyQuota_(e)) {
      ctx.conversionsBlocked = true;
      ctx.log('WARNING', cc.label, '', meta.name, srcId,
        'Daily Apps Script conversion quota reached; remaining PDF exports wait for a later pass');
      return;
    }
    // Not recorded as mirrored, so the next pass tries again.
    return skip_(ctx, cc, info, srcId, meta.name, isGoogle ? 'PDF export failed' : 'Copy failed', openUrl, shortErr_(e));
  } finally {
    props.deleteProperty(ctx.inflightProp);
  }

  ctx.state.files[key] = { rev: rev, name: created.name || name, copyId: created.id, at: new Date().toISOString() };
  delete ctx.state.skips[srcId + '|' + info.postKey];
  ctx.dirty = true;
  ctx.actions++;
  ctx.log(prev ? 'NEW_VERSION' : (isGoogle ? 'EXPORTED' : 'COPIED'),
    cc.label, dest.path, created.name || name, srcId, info.label + ': ' + info.postTitle);
}

function destFolder_(ctx, cc, info) {
  const courseFolderId = courseFolder_(ctx, cc);
  if (info.stream === 'announcements') {
    const name = CONFIG.ANNOUNCEMENTS_FOLDER_NAME;
    return { id: ensureFolder_(ctx, 'ann:' + cc.id, courseFolderId, name, null), path: name };
  }
  if (info.topicId) {
    const topic = topicName_(ctx, cc, info.topicId);
    if (topic) {
      let name = folderName_(topic);
      if (name.toLowerCase() === CONFIG.ANNOUNCEMENTS_FOLDER_NAME.toLowerCase()) name += ' (topic)';
      return { id: ensureFolder_(ctx, 'topic:' + cc.id + ':' + info.topicId, courseFolderId, name, null), path: name };
    }
  }
  return { id: courseFolderId, path: '' };
}

function courseFolder_(ctx, cc) {
  const alt = cc.section ? folderName_(cc.name + ' - ' + cc.section) : null;
  return ensureFolder_(ctx, 'course:' + cc.id, ctx.rootId, folderName_(cc.name), alt);
}

// Finds copies made earlier (e.g. before state.json was lost) via their tags.
function adoptExistingCopy_(ctx, key, srcId, folderId) {
  const found = listFiles_("'" + folderId + "' in parents and trashed=false and " + appPropQuery_('mirrorSrc', srcId),
    'id,name,createdTime,appProperties');
  if (!found.length) return null;
  found.sort(function (a, b) { return String(b.createdTime).localeCompare(String(a.createdTime)); });
  const latest = found[0];
  const entry = { rev: (latest.appProperties || {}).mirrorRev || '', name: latest.name, copyId: latest.id, at: latest.createdTime };
  ctx.state.files[key] = entry;
  ctx.dirty = true;
  return entry;
}

// The ONLY path that turns Google Docs/Sheets/Slides/Drawings into PDF:
// Apps Script's File.getAs() conversion (a read, so drive.readonly suffices),
// then an upload of the PDF via the Drive API (drive.file). getAs() counts
// toward Apps Script's daily conversion quota. Any failure throws to the caller,
// which logs it, links the file in links.md, and retries on the next pass.
function exportPdf_(srcId, name, folderId, tags) {
  const pdf = DriveApp.getFileById(srcId).getAs('application/pdf');
  return createFromBlob_(pdf, name, 'application/pdf', folderId, tags);
}

function copyBinary_(srcId, name, mime, folderId, tags, caps) {
  if (caps.canCopy !== false) {
    try {
      return retry_(function () {
        return Drive.Files.copy({ name: name, parents: [folderId], appProperties: tags }, srcId, { supportsAllDrives: true });
      });
    } catch (e) {
      if (caps.canDownload === false) throw e;
      // Fall back to download + upload below.
    }
  }
  return createFromBlob_(DriveApp.getFileById(srcId).getBlob(), name, mime, folderId, tags);
}

function createFromBlob_(blob, name, mime, folderId, tags) {
  blob.setName(name);
  return retry_(function () {
    return Drive.Files.create({ name: name, mimeType: mime, parents: [folderId], appProperties: tags }, blob);
  });
}

// Logs a skipped attachment once per (file, post, reason), not every hour.
function skip_(ctx, cc, info, srcId, name, reason, linkUrl, detail) {
  const k = srcId + '|' + info.postKey;
  if (ctx.state.skips[k] !== reason) {
    ctx.state.skips[k] = reason;
    ctx.dirty = true;
    ctx.log('SKIPPED', cc.label, '', name, srcId, reason + (detail ? ' — ' + detail : '') + ' [' + info.label + ': ' + info.postTitle + ']');
  }
  if (linkUrl) addLink_(ctx, cc, info, 'Drive file', name, linkUrl, reason);
}

// ============================== LINKS.MD ==============================

function addLink_(ctx, cc, info, kind, title, url, note) {
  if (!url) return;
  const lf = linksFor_(ctx, cc);
  const marker = 'cm:' + info.postKey + ':' + hash8_(url);
  if (lf.content.indexOf(marker) >= 0) return;
  if (lf.pending.some(function (line) { return line.indexOf(marker) >= 0; })) return;
  const safeUrl = String(url).replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\s/g, '%20');
  lf.pending.push('- ' + info.postDate + ' · ' + info.label + ' · **' + mdText_(info.postTitle) + '** — ' +
    kind + ': [' + mdText_(title || url) + '](<' + safeUrl + '>)' +
    (note ? ' _(' + mdText_(note) + ')_' : '') + ' <!-- ' + marker + ' -->');
  ctx.actions++;
  ctx.log('LINK', cc.label, '', CONFIG.LINKS_FILE_NAME, '', kind + ': ' + (title || url) + ' [' + info.label + ': ' + info.postTitle + ']');
}

function linksFor_(ctx, cc) {
  if (ctx.links[cc.id]) return ctx.links[cc.id];
  const folderId = courseFolder_(ctx, cc);
  const key = 'links:' + cc.id;
  let id = ctx.state.linkFiles[cc.id] || null;
  let content = null;
  if (id) {
    content = readText_(id);
    if (content === null) id = null;
  }
  if (!id) {
    const found = listFiles_("'" + folderId + "' in parents and trashed=false and " + appPropQuery_('mirrorKey', key), 'id');
    if (found.length) {
      id = found[0].id;
      content = readText_(id) || '';
      ctx.state.linkFiles[cc.id] = id;
      ctx.dirty = true;
    }
  }
  ctx.links[cc.id] = { id: id, folderId: folderId, key: key, title: cc.name, content: content || '', pending: [] };
  return ctx.links[cc.id];
}

function flushLinks_(ctx) {
  Object.keys(ctx.links).forEach(function (courseId) {
    const lf = ctx.links[courseId];
    if (!lf.pending.length) return;
    const added = lf.pending.join('\n') + '\n';
    let content;
    if (!lf.id) {
      content = '# Links — ' + lf.title + '\n\nNon-file attachments from Google Classroom, added by Classroom Mirror.\n\n' + added;
      const f = createTextFile_(lf.key, lf.folderId, CONFIG.LINKS_FILE_NAME, 'text/markdown', content);
      lf.id = f.id;
      ctx.state.linkFiles[courseId] = f.id;
      ctx.dirty = true;
    } else {
      content = lf.content + (lf.content && !/\n$/.test(lf.content) ? '\n' : '') + added;
      writeText_(lf.id, content, 'text/markdown');
    }
    lf.content = content;
    lf.pending = [];
  });
}

// ========================= CONTEXT, STATE, LOG =========================

function blankState_() {
  return { version: 1, folders: {}, files: {}, skips: {}, poison: {}, linkFiles: {} };
}

function parseState_(text) {
  const s = blankState_();
  if (!text) return s;
  try {
    const parsed = JSON.parse(text);
    Object.keys(s).forEach(function (k) { if (parsed[k]) s[k] = parsed[k]; });
  } catch (e) {
    console.warn('state.json was unreadable; rebuilding it from the tags on existing copies.');
  }
  return s;
}

function openContext_() {
  const props = PropertiesService.getScriptProperties();
  const ctx = {
    started: Date.now(),
    tz: Session.getScriptTimeZone(),
    state: blankState_(),
    stateId: null,
    rootId: null,
    metaId: null,
    logFile: null,
    verified: {},
    dirty: false,
    actions: 0,
    flushedActions: 0,
    lastFlush: Date.now(),
    logRows: [],
    links: {},
    courses: {},
    inflightProp: MODE.FULL.inflightProp,
    conversionsBlocked: false,
  };
  ctx.log = function (action, course, folder, file, srcId, detail) {
    const row = [Utilities.formatDate(new Date(), ctx.tz, 'yyyy-MM-dd HH:mm:ss'), action, course, folder, file, srcId, detail];
    ctx.logRows.push(row);
    console.log(row.filter(function (v) { return v; }).join(' | '));
  };

  const savedId = props.getProperty(PROP.STATE_ID);
  if (savedId) {
    let text = null;
    try {
      text = readText_(savedId);
    } catch (e) {
      console.warn('Could not read state file ' + savedId + ': ' + shortErr_(e));
    }
    if (text !== null) {
      ctx.stateId = savedId;
      ctx.state = parseState_(text);
    }
  }

  ctx.rootId = ensureFolder_(ctx, 'root', null, CONFIG.ROOT_FOLDER_NAME, null);
  ctx.metaId = ensureFolder_(ctx, 'meta', ctx.rootId, CONFIG.META_FOLDER_NAME, null);

  if (!ctx.stateId) {
    const f = findOrCreateTextFile_('state', ctx.metaId, CONFIG.STATE_FILE_NAME, 'application/json', '{}');
    const loaded = parseState_(f.content);
    loaded.folders.root = ctx.state.folders.root;
    loaded.folders.meta = ctx.state.folders.meta;
    ctx.state = loaded;
    ctx.stateId = f.id;
    ctx.dirty = true;
    props.setProperty(PROP.STATE_ID, f.id);
  }
  return ctx;
}

// Write order matters: links and log first, then state, then the cursor, so the
// cursor never points past work that hasn't been saved.
function flush_(ctx, crawl) {
  flushLinks_(ctx);
  flushLog_(ctx);
  if (ctx.dirty) {
    writeText_(ctx.stateId, JSON.stringify(ctx.state), 'application/json');
    ctx.dirty = false;
  }
  if (crawl) saveCrawl_(crawl);
  ctx.flushedActions = ctx.actions;
  ctx.lastFlush = Date.now();
}

function maybeFlush_(ctx, crawl) {
  if (ctx.actions - ctx.flushedActions >= CONFIG.FLUSH_EVERY_ACTIONS ||
      Date.now() - ctx.lastFlush >= CONFIG.FLUSH_EVERY_MS) {
    flush_(ctx, crawl);
  }
}

function flushLog_(ctx) {
  if (!ctx.logRows.length) return;
  if (!ctx.logFile) {
    ctx.logFile = findOrCreateTextFile_('log', ctx.metaId, CONFIG.LOG_FILE_NAME, 'text/csv', LOG_HEADER + '\n');
  }
  let lines = ctx.logFile.content.split('\n').filter(function (l) { return l; });
  if (!lines.length) lines = [LOG_HEADER];
  lines = lines.concat(ctx.logRows.map(csvRow_));
  if (lines.length > CONFIG.LOG_MAX_ROWS + 1) lines = [lines[0]].concat(lines.slice(-CONFIG.LOG_MAX_ROWS));
  const content = lines.join('\n') + '\n';
  writeText_(ctx.logFile.id, content, 'text/csv');
  ctx.logFile.content = content;
  ctx.logRows = [];
}

function csvRow_(row) {
  return row.map(function (v) {
    const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

// =============================== DRIVE ===============================

// Returns the folder for `key`, creating it if needed. Folders are tagged with
// appProperties.mirrorKey so they can be found again without state.json.
function ensureFolder_(ctx, key, parentId, name, altName) {
  const cached = ctx.state.folders[key];
  if (cached) {
    if (ctx.verified[cached]) return cached;
    const f = getMetaOrNull_(cached, 'id,trashed');
    if (f && !f.trashed) {
      ctx.verified[cached] = true;
      return cached;
    }
    delete ctx.state.folders[key];
    ctx.dirty = true;
  }

  let q = "mimeType='" + FOLDER_MIME + "' and trashed=false and " + appPropQuery_('mirrorKey', key);
  if (parentId) q += " and '" + parentId + "' in parents";
  const found = listFiles_(q, 'id');
  let id;
  if (found.length) {
    id = found[0].id;
  } else {
    const parent = parentId || 'root';
    let finalName = name;
    if (key === 'root') {
      if (nameTaken_(parent, name)) {
        throw new Error('A folder named "' + name + '" already exists in My Drive but was not created by this script. ' +
          'Rename or delete it (or change CONFIG.ROOT_FOLDER_NAME) and run again.');
      }
    } else {
      finalName = uniqueName_(parent, name, altName, true);
    }
    id = retry_(function () {
      return Drive.Files.create({ name: finalName, mimeType: FOLDER_MIME, parents: [parent], appProperties: { mirrorKey: key } });
    }).id;
  }
  ctx.state.folders[key] = id;
  ctx.verified[id] = true;
  ctx.dirty = true;
  return id;
}

function findOrCreateTextFile_(key, parentId, name, mime, initial) {
  const found = listFiles_("'" + parentId + "' in parents and trashed=false and " + appPropQuery_('mirrorKey', key), 'id');
  if (found.length) return { id: found[0].id, content: readText_(found[0].id) || '' };
  const f = createTextFile_(key, parentId, name, mime, initial);
  return { id: f.id, content: initial };
}

function createTextFile_(key, parentId, name, mime, content) {
  const finalName = uniqueName_(parentId, name, null, false);
  return retry_(function () {
    return Drive.Files.create(
      { name: finalName, mimeType: mime, parents: [parentId], appProperties: { mirrorKey: key } },
      Utilities.newBlob(content, mime, finalName));
  });
}

// Returns file text, or null if the file is gone/trashed. Other errors throw, so
// a temporary failure can never make us overwrite a file with empty content.
function readText_(id) {
  try {
    const f = DriveApp.getFileById(id);
    if (f.isTrashed()) return null;
    return f.getBlob().getDataAsString('UTF-8');
  } catch (e) {
    if (isNotFound_(e)) return null;
    throw e;
  }
}

function writeText_(id, content, mime) {
  retry_(function () { return Drive.Files.update({}, id, Utilities.newBlob(content, mime)); });
}

function getMetaOrNull_(id, fields) {
  try {
    return retry_(function () { return Drive.Files.get(id, { fields: fields, supportsAllDrives: true }); });
  } catch (e) {
    if (isNotFound_(e)) return null;
    throw e;
  }
}

function listFiles_(q, fields) {
  const r = retry_(function () { return Drive.Files.list({ q: q, fields: 'files(' + fields + ')', pageSize: 100 }); });
  return r.files || [];
}

function nameTaken_(parentId, name) {
  return listFiles_("name='" + esc_(name) + "' and '" + parentId + "' in parents and trashed=false", 'id').length > 0;
}

function uniqueName_(parentId, name, altName, isFolder) {
  if (!nameTaken_(parentId, name)) return name;
  if (altName && altName !== name && !nameTaken_(parentId, altName)) return altName;
  for (let i = 2; i < 100; i++) {
    const candidate = withSuffix_(name, ' (' + i + ')', !isFolder);
    if (!nameTaken_(parentId, candidate)) return candidate;
  }
  return withSuffix_(name, ' (' + Date.now() + ')', !isFolder);
}

function appPropQuery_(k, v) {
  return "appProperties has { key='" + k + "' and value='" + esc_(v) + "' }";
}

function esc_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// "Service invoked too many times for one day: ..." won't clear until tomorrow.
function isDailyQuota_(e) {
  return /for one day|daily/i.test(String((e && e.message) || e));
}

function isNotFound_(e) {
  return /not ?found|404|could not be found|no item with the given id/i.test(String((e && e.message) || e));
}

// ============================== HELPERS ==============================

// Retries temporary API errors (rate limits, 5xx) with backoff; rethrows the rest.
function retry_(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const transient = /rate ?limit|too many|429|500|502|503|backend error|internal error|timed? ?out|try again|temporar/i.test(msg) &&
        !/storage quota/i.test(msg) && !isDailyQuota_(e);
      if (!transient || attempt >= 3) throw e;
      Utilities.sleep(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
    }
  }
}

// Removes characters that are illegal or troublesome on macOS/Windows/Drive.
function cleanName_(name) {
  return String(name || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function folderName_(name) {
  return cleanName_(cleanName_(name).slice(0, CONFIG.MAX_NAME_LENGTH)) || 'Untitled';
}

function fileName_(name, forcedExt) {
  const s = cleanName_(name) || 'Untitled';
  let base = s;
  let ext = '';
  if (forcedExt) {
    ext = forcedExt;
    if (base.toLowerCase().slice(-ext.length) === ext) base = base.slice(0, -ext.length);
  } else {
    const m = s.match(/^(.+?)(\.[A-Za-z0-9]{1,8})$/);
    if (m) {
      base = m[1];
      ext = m[2];
    }
  }
  return (cleanName_(base.slice(0, CONFIG.MAX_NAME_LENGTH)) || 'Untitled') + ext;
}

function withSuffix_(name, suffix, splitExt) {
  const m = splitExt ? name.match(/^(.+?)(\.[A-Za-z0-9]{1,8})$/) : null;
  return m ? m[1] + suffix + m[2] : name + suffix;
}

function mdText_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().replace(/([\\`*_\[\]<>])/g, '\\$1');
}

function formatDate_(ctx, iso) {
  const d = iso ? new Date(iso) : new Date();
  return Utilities.formatDate(isNaN(d.getTime()) ? new Date() : d, ctx.tz, 'yyyy-MM-dd');
}

function hash8_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8)
    .slice(0, 4)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
    .join('');
}

function shortErr_(e) {
  return String((e && e.message) || e).slice(0, 200);
}
