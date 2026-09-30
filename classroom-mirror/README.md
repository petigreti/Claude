# Classroom Mirror

A Google Apps Script that copies your Google Classroom attachments into
`My Drive/Classroom Mirror/` every hour. Google Drive for desktop then keeps that
folder stored locally on your Mac.

```
Classroom Mirror/
  _meta/            state.json (bookkeeping), mirror-log.csv (what was copied, when)
  <Course>/
    links.md        YouTube videos, links, Forms, and files that can't be copied
    <Topic>/        materials and assignments that have a topic
    Announcements/  files attached to announcements
    (files without a topic sit directly in the course folder)
```

- Google Docs, Sheets, Slides and Drawings are saved as **PDF**. PDFs, Word files and
  other uploads are copied **as-is**.
- When a professor edits a file, the script saves a **new copy** named
  `Lecture 3 (updated 2026-10-02).pdf`. The older copy stays.
- The mirror only ever adds files. If something is removed from Classroom, your copy
  stays.

| File | What it is |
|---|---|
| `Code.gs` | The script. Paste it into the editor. |
| `appsscript.json` | The manifest: OAuth scopes and advanced services. Paste it into the editor. |
| `dev/mock-test.js` | An offline test that runs the script against simulated Google APIs (`node dev/mock-test.js`). You don't need it to use the script. |

---

## Design decisions

**Scopes (`drive.readonly` + `drive.file`, not full `drive`).**
- The script reads through Drive with `drive.readonly`. `DriveApp` is used only
  for reads: `getFileById`, `getAs`, `getBlob`, `isTrashed`.
- Every write goes through the Drive API v3 advanced service (`Drive.Files.create`,
  `copy`, `update`) under `drive.file`. That scope lets the script change only the
  files and folders it created itself.
- The script finds its own folders and files by hidden tags (`appProperties`), not
  by name.
- There are no `DriveApp` write calls anywhere (`createFolder`, `createFile`,
  `makeCopy`, `setContent`, `setTrashed`, `moveTo`), and nothing is ever trashed or
  deleted.
- Because `drive.file` is enforced by Google's servers, even a bug in the script
  can't modify files it didn't create.

| Scope | Needed for |
|---|---|
| `classroom.courses.readonly` | `Classroom.Courses.list` / `.get`: `listActiveCourses_`, `courseCtx_` |
| `classroom.courseworkmaterials.readonly` | `Classroom.Courses.CourseWorkMaterials.list`: `listStream_` |
| `classroom.coursework.me.readonly` | `Classroom.Courses.CourseWork.list`: `listStream_` |
| `classroom.announcements.readonly` | `Classroom.Courses.Announcements.list`: `listStream_` |
| `classroom.topics.readonly` | `Classroom.Courses.Topics.list`: `topicName_` |
| `drive.readonly` | `Drive.Files.get` (`getMetaOrNull_`), `Drive.Files.list` (`listFiles_`), `DriveApp.getFileById().getAs/getBlob/isTrashed` (`exportPdf_`, `copyBinary_` fallback, `readText_`) |
| `drive.file` | `Drive.Files.create` (folders, copies, PDFs, `links.md`, `state.json`, the log), `Drive.Files.update` (rewriting those three text files), `Drive.Files.copy` (`copyBinary_`) |
| `script.scriptapp` | `ScriptApp.newTrigger` / `getProjectTriggers` / `deleteTrigger`: `setup`, `removeTriggers`, continuation triggers |
| *(no scope)* | `PropertiesService`, `LockService`, `Utilities`, `Session`, `console` |

**Caveats:**
- `Drive.Files.copy` with this scope pair can't be confirmed until you run it. If
  Google refuses the copy, `copyBinary_` downloads the file (read) and uploads it
  (create) instead. That fallback works for files up to Apps Script's ~50 MB blob
  limit.
- If authorization fails with *"Required permissions:
  https://www.googleapis.com/auth/drive"*, replace the `drive.readonly` and
  `drive.file` lines with `"https://www.googleapis.com/auth/drive"` and authorize
  again.

**PDF export: one path.**
- `exportPdf_()` is the only code that converts Docs, Sheets, Slides and Drawings.
  It calls `DriveApp.getFileById(id).getAs('application/pdf')`, a documented Apps
  Script conversion, then uploads the result with `Drive.Files.create`.
- No export URLs are used, and `script.external_request` isn't requested.
- **Conversions count toward Apps Script's daily conversion quota** (see Google's
  *Quotas for Google Services* page for the current number). When the quota is used
  up, the script stops converting for that run, logs one warning, and exports the
  rest on a later pass.
- Any other export failure (file too large or complex, server error) is logged, and
  the file is linked in `links.md`.

**Retry rules: nothing is marked done unless a copy was actually created.**
- A file is recorded as mirrored only after its copy exists. Every problem is
  re-checked on the next hourly pass: no access, owner disabled downloads, export
  failed, copy failed, API error, quota reached.
- A skip is *logged* only once, but it's still *retried* every pass.
- Attachments that can never become a file (YouTube, links, Forms, Drive folders,
  Sites) go to `links.md` instead.
- One temporary exception: if Apps Script kills the run **twice in a row while
  copying the same file**, that file is skipped for 7 days, or until the file
  changes, whichever comes first. Kills at different files, or ordinary errors,
  never skip a file.
- Dying twice at the same spot *outside* a copy only abandons that pass. The next
  hourly pass starts over.

**No duplicates, even after a crash.**
- Each copy is tagged with its source file ID and source revision.
- `state.json` is a fast cache of those tags, with one entry per *source file +
  destination folder*.
- If `state.json` is lost, or a run is killed before saving, the script reads the
  tags on the existing copies and recognises them.

**Resuming after the 6-minute limit.**
- Each run stops itself after about 4.5 minutes. It saves an exact cursor
  (course ID → stream → page → post → attachment) and schedules one continuation
  run a minute later.
- A script lock stops the hourly run and a continuation from ever running at the
  same time.
- Every run first deletes old continuation triggers of its own kind, matched by
  handler name, so there is never more than one. This cleanup never touches the
  hourly `mirrorClassroom` trigger. Only `setup` (which replaces it) and
  `removeTriggers` do.
- Every run also arms a safety continuation. If Apps Script kills a run anyway,
  the next run notices and retries. If the same file kills the run twice, that
  file is skipped from then on and linked in `links.md`.

---

## Setup (about 10 minutes)

### 1. Create the project
1. Go to <https://script.google.com> and click **New project**. Rename it to
   `Classroom Mirror`.
2. Click ⚙️ **Project Settings**. Tick **"Show 'appsscript.json' manifest file in
   editor"**. While you're there, note the **Time zone** shown.

### 2. Paste the two files
1. In the editor, open `appsscript.json` and replace its contents with this repo's
   `appsscript.json`. It's set to `"Europe/Prague"`, which controls the dates in
   filenames and in `links.md`.
2. Open `Code.gs` and replace its contents with this repo's `Code.gs`.
3. Save (⌘S).

### 3. Check the advanced services
The manifest enables them for you. In the left sidebar, under **Services**, you
should see **Classroom** and **Drive**. If either is missing, click **+** and add
*Google Classroom API* (v1) or *Drive API* (**v3**), using exactly the identifiers
`Classroom` and `Drive`.

### 4. First authorization
1. In the function dropdown, choose **`listMyCourses`** and click **Run**.
2. Click **Review permissions** and pick your university account.
3. If you see *"Google hasn't verified this app"*, click **Advanced → Go to
   Classroom Mirror (unsafe)**. It's your own script, so this is expected.
4. Approve the listed permissions. The execution log then prints lines like
   `612345678901  —  Biology 101 (Section A)`.

> **If you get "This app is blocked" or "Access denied by your administrator":**
> your university blocks Apps Script access to Classroom or Drive. The code can't
> work around this. Only the university's Google Workspace admin (IT) can allow it.

### 5. Test on one course
1. Copy one course ID from the log. Paste it at the top of `Code.gs`:
   `TEST_COURSE_ID: '612345678901',` and save.
2. Run **`testOneCourse`**. For a big course, the log may end with *"continuing in
   about a minute"*. The script finishes on its own through a separate
   `continueTestCourse` trigger; run **`showStatus`** to watch progress.
   - The test never installs the hourly trigger. It has its own saved position, so
     it never disturbs a full pass that's in progress.
   - It shares `state.json` and the tags with the full mirror on purpose: files it
     copies are real, and the full pass recognises them instead of copying them
     again.
3. Check in Drive (<https://drive.google.com>) that you have:
   - `Classroom Mirror/<Course>/…` with topic folders, PDFs, and `links.md`
   - `Classroom Mirror/_meta/mirror-log.csv` listing each copy, link and skip
4. Run **`testOneCourse`** again. Nothing new should be created, and the log
   shouldn't grow.

### 6. Turn it on
1. Optionally set `TEST_COURSE_ID` back to `''`.
2. Run **`setup`**. This creates the hourly trigger. Running it twice is safe.
3. To start the big backfill now instead of within the hour, run
   **`mirrorClassroom`**. It carries on by itself in about 4.5-minute chunks until
   everything is copied.
4. Check on it any time with **`showStatus`**, or on the ⏱ **Executions** page.

### Everyday commands
| Run | Does |
|---|---|
| `showStatus` | Shows the last completed pass, current progress, and active triggers |
| `removeTriggers` | Stops everything: deletes the hourly trigger and both kinds of continuation trigger |
| `setup` | Turns it back on |
| `resetState` | Clears `state.json`. Existing copies are recognised by their tags, so nothing is duplicated. Use it if the state looks wrong, or to retry a timed-out file before its 7 days are up. |

---

## Google Drive for desktop on macOS (keep only this folder offline)

With **Stream files**, the rest of My Drive stays in the cloud. Only
`Classroom Mirror` is kept on your disk, and files added to it later are kept
offline too.

1. Install Google Drive for desktop from <https://www.google.com/drive/download/>
   and sign in with your **university** account.
2. Click the Drive icon in the menu bar, then ⚙️ **Settings → Preferences**.
3. Under **Google Drive**, choose **Stream files**.
4. In Finder, open **Google Drive → My Drive** in the sidebar.
5. Right-click **Classroom Mirror** and choose **Available offline** (on some
   versions it's under the **Google Drive** submenu). A filled-in checkmark or
   offline icon on the folder means it's stored locally.
6. The local path is
   `~/Library/CloudStorage/GoogleDrive-<your email>/My Drive/Classroom Mirror`.
   Drag it to the Finder sidebar for quick access.

Use **Mirror files** only if you want *all* of My Drive on your Mac. It isn't
needed for this.

---

## Things to know

- **"Each student gets a copy" assignment templates** show up as *No access*
  skips. Your own copy lives in your submission, not in the teacher's attachment.
- **Owner disabled download/copy:** a professor can turn off downloading for
  viewers. Those files can't be copied by any method, so they go into `links.md`.
- **Attached Drive folders, Forms, Sites** and other files with no PDF version
  become links in `links.md`.
- **Renamed courses or topics** keep their original folder name, so your local
  paths don't jump around.
- **Deleting a mirrored copy yourself:** it isn't re-created, unless you later run
  `resetState`.
- **Storage:** the copies count toward your university Drive quota.
- **Log size:** `mirror-log.csv` keeps the latest 5,000 rows.
- **Wrong dates:** change `timeZone` in `appsscript.json`.
- **Quotas:** Apps Script limits daily file conversions and total trigger runtime.
  Hourly passes use a tiny share of both. Only the first backfill is heavy, and it
  spreads over several runs if needed.

### Troubleshooting
| Symptom | Fix |
|---|---|
| "Required permissions: …/auth/drive" | See the *Scopes* caveat above: switch to the full `drive` scope. |
| "A folder named "Classroom Mirror" already exists…" | That folder wasn't created by the script. Rename or delete it, then run again. |
| "Classroom is not defined" / "Drive is not defined" | Add the advanced service (step 3). |
| 403 on Classroom calls | Admin restriction; see the note in step 4. |
| Nothing happens hourly | Run `showStatus` and check the trigger is listed. If not, run `setup`. |
