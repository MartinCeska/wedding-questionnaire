/**
 * Wedding Floral Questionnaire – backend (Google Apps Script, bound to a Google Sheet).
 *
 * Storage
 *   - Sheet "Weddings": one row per wedding (answers kept as JSON in the "answers" column).
 *   - Google Drive folder "Wedding questionnaire – photos": one sub-folder per wedding.
 *
 * Setup (details in README.md)
 *   1. Paste this file into Extensions → Apps Script of a new Google Sheet.
 *   2. Project Settings → Script properties → add ADMIN_PASSWORD (at least 6 characters).
 *   3. Run `setup` once from the editor and allow the requested permissions.
 *   4. Deploy → New deployment → Web app; Execute as: Me; Who has access: Anyone.
 *   5. Put the web app URL (ending with /exec) into config.js as apiUrl.
 *
 * API: POST a JSON body {action, ...} as text/plain. Every response is JSON {ok: true, ...}
 * or {ok: false, error: '<code>'}.
 */

var SHEET_NAME = 'Weddings';
var COLUMNS = [
  'id', 'createdAt', 'couple', 'weddingDate', 'venue', 'contact', 'note', 'lang',
  'status', 'openedAt', 'updatedAt', 'submittedAt', 'answers', 'photos', 'folderId',
];
var PHOTO_ROOT_NAME = 'Wedding questionnaire – photos';
var MAX_PHOTOS = 10;
var MAX_PHOTO_BASE64_LENGTH = 4000000; // ≈ 3 MB image; the page uploads ≈ 0.3 MB JPEGs
var ALLOWED_PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
var MAX_ANSWERS_JSON_LENGTH = 45000; // a Sheet cell holds at most 50 000 characters
var MAX_FAILED_LOGINS = 10; // then admin sign-in is blocked for 15 minutes
var MIN_PASSWORD_LENGTH = 6;
var ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
var ID_LENGTH = 12;

var HANDLERS = {
  // Couple's page (the wedding id from the link is the only key)
  getWedding: getWedding_,
  saveAnswers: saveAnswers_,
  uploadPhoto: uploadPhoto_,
  deletePhoto: deletePhoto_,
  getPhoto: getPhoto_,
  // Admin page (every call carries the admin password)
  adminLogin: adminLogin_,
  adminList: adminList_,
  adminGet: adminGet_,
  adminCreate: adminCreate_,
  adminUpdate: adminUpdate_,
  adminDelete: adminDelete_,
};

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, service: 'wedding-questionnaire' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  if (!req || typeof req.action !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, req.action)) {
    return json_({ ok: false, error: 'unknown_action' });
  }
  try {
    var result = HANDLERS[req.action](req) || {};
    result.ok = true;
    return json_(result);
  } catch (err) {
    if (err && err.wqCode) return json_({ ok: false, error: err.wqCode });
    console.error(err && err.stack ? err.stack : String(err));
    return json_({ ok: false, error: 'server_error' });
  }
}

/** Run once from the Apps Script editor: creates the sheet and the photo folder, checks the password. */
function setup() {
  sheet_();
  photoRoot_();
  var pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  Logger.log(pw && pw.length >= MIN_PASSWORD_LENGTH
    ? 'Setup done. Admin password is set.'
    : 'Setup done, but ADMIN_PASSWORD is missing or shorter than ' + MIN_PASSWORD_LENGTH + ' characters. Add it in Project Settings → Script properties.');
}

/* ------------------------------------------------------------------ */
/* Couple's page                                                       */
/* ------------------------------------------------------------------ */

function getWedding_(req) {
  var found = findWedding_(req.id);
  if (!found.record.openedAt && req.preview !== true) {
    withLock_(function () {
      var fresh = findWedding_(req.id);
      if (!fresh.record.openedAt) {
        fresh.record.openedAt = now_();
        writeRow_(fresh.row, fresh.record);
      }
      found = fresh;
    });
  }
  return { wedding: publicView_(found.record) };
}

function saveAnswers_(req) {
  var answers = cleanAnswers_(req.answers);
  var json = JSON.stringify(answers);
  if (json.length > MAX_ANSWERS_JSON_LENGTH) throw fail_('too_large');
  var submit = req.submit === true;
  return withLock_(function () {
    var found = findWedding_(req.id);
    var w = found.record;
    var t = now_();
    w.answers = json;
    w.updatedAt = t;
    if (submit) {
      w.status = 'submitted';
      w.submittedAt = t;
    } else if (w.status !== 'submitted') {
      w.status = 'draft';
    }
    writeRow_(found.row, w);
    return { wedding: publicView_(w) };
  });
}

function uploadPhoto_(req) {
  var mimeType = String(req.mimeType || '');
  if (!ALLOWED_PHOTO_TYPES.hasOwnProperty(mimeType)) throw fail_('bad_photo_type');
  var data = typeof req.data === 'string' ? req.data : '';
  if (!data || data.length > MAX_PHOTO_BASE64_LENGTH || !/^[A-Za-z0-9+\/]+={0,2}$/.test(data)) throw fail_('bad_photo');
  findWedding_(req.id); // fail fast before decoding
  var bytes = Utilities.base64Decode(data);
  return withLock_(function () {
    var found = findWedding_(req.id);
    var w = found.record;
    var photos = parseJson_(w.photos, []);
    if (photos.length >= MAX_PHOTOS) throw fail_('too_many_photos');
    var name = cleanFileName_(req.name, ALLOWED_PHOTO_TYPES[mimeType]);
    var file = weddingFolder_(w).createFile(Utilities.newBlob(bytes, mimeType, name));
    var photo = { id: file.getId(), name: name, uploadedAt: now_() };
    photos.push(photo);
    w.photos = JSON.stringify(photos);
    w.updatedAt = photo.uploadedAt;
    if (w.status === 'new') w.status = 'draft';
    writeRow_(found.row, w);
    return { photo: { id: photo.id, name: photo.name } };
  });
}

function deletePhoto_(req) {
  return withLock_(function () {
    var found = findWedding_(req.id);
    var photos = parseJson_(found.record.photos, []);
    var index = photoIndex_(photos, req.photoId);
    if (index < 0) throw fail_('photo_not_found');
    photos.splice(index, 1);
    found.record.photos = JSON.stringify(photos);
    found.record.updatedAt = now_();
    writeRow_(found.row, found.record);
    try {
      DriveApp.getFileById(String(req.photoId)).setTrashed(true);
    } catch (err) {
      console.warn('Could not trash photo ' + req.photoId + ': ' + err);
    }
    return {};
  });
}

function getPhoto_(req) {
  var found = findWedding_(req.id);
  if (photoIndex_(parseJson_(found.record.photos, []), req.photoId) < 0) throw fail_('photo_not_found');
  var blob = DriveApp.getFileById(String(req.photoId)).getBlob();
  return { mimeType: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/* ------------------------------------------------------------------ */
/* Admin page                                                          */
/* ------------------------------------------------------------------ */

function adminLogin_(req) {
  requireAdmin_(req);
  return {};
}

function adminList_(req) {
  requireAdmin_(req);
  return { weddings: readAll_().map(function (r) { return adminSummary_(r.record); }) };
}

function adminGet_(req) {
  requireAdmin_(req);
  return { wedding: adminDetail_(findWedding_(req.id).record) };
}

function adminCreate_(req) {
  requireAdmin_(req);
  var meta = cleanMeta_(req.wedding);
  return withLock_(function () {
    var taken = {};
    readAll_().forEach(function (r) { taken[r.record.id] = true; });
    var id;
    do { id = newId_(); } while (taken[id]);
    var w = { id: id, createdAt: now_(), status: 'new', answers: '{}', photos: '[]' };
    Object.keys(meta).forEach(function (k) { w[k] = meta[k]; });
    appendRow_(w);
    return { wedding: adminSummary_(w) };
  });
}

function adminUpdate_(req) {
  requireAdmin_(req);
  var meta = cleanMeta_(req.wedding);
  return withLock_(function () {
    var found = findWedding_(req.id);
    Object.keys(meta).forEach(function (k) { found.record[k] = meta[k]; });
    writeRow_(found.row, found.record);
    return { wedding: adminDetail_(found.record) };
  });
}

function adminDelete_(req) {
  requireAdmin_(req);
  return withLock_(function () {
    var found = findWedding_(req.id);
    sheet_().deleteRow(found.row);
    if (found.record.folderId) {
      try {
        DriveApp.getFolderById(found.record.folderId).setTrashed(true);
      } catch (err) {
        console.warn('Could not trash folder ' + found.record.folderId + ': ' + err);
      }
    }
    return {};
  });
}

function requireAdmin_(req) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('wq_admin_fails') || 0);
  if (fails >= MAX_FAILED_LOGINS) throw fail_('too_many_attempts');
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!expected || expected.length < MIN_PASSWORD_LENGTH) throw fail_('admin_not_configured');
  if (typeof req.password !== 'string' || !sameString_(req.password, expected)) {
    cache.put('wq_admin_fails', String(fails + 1), 900);
    throw fail_('unauthorized');
  }
}

/* ------------------------------------------------------------------ */
/* Views and input cleaning                                            */
/* ------------------------------------------------------------------ */

function publicView_(w) {
  return {
    id: w.id,
    couple: w.couple,
    weddingDate: w.weddingDate,
    lang: w.lang,
    status: w.status,
    updatedAt: w.updatedAt,
    submittedAt: w.submittedAt,
    answers: parseJson_(w.answers, {}),
    photos: parseJson_(w.photos, []).map(function (p) { return { id: p.id, name: p.name }; }),
  };
}

function adminSummary_(w) {
  return {
    id: w.id,
    couple: w.couple,
    weddingDate: w.weddingDate,
    venue: w.venue,
    contact: w.contact,
    lang: w.lang,
    status: w.status,
    createdAt: w.createdAt,
    openedAt: w.openedAt,
    updatedAt: w.updatedAt,
    submittedAt: w.submittedAt,
    photoCount: parseJson_(w.photos, []).length,
  };
}

function adminDetail_(w) {
  var d = adminSummary_(w);
  d.note = w.note;
  d.answers = parseJson_(w.answers, {});
  d.photos = parseJson_(w.photos, []);
  return d;
}

function cleanMeta_(m) {
  m = m && typeof m === 'object' ? m : {};
  var meta = {
    couple: text_(m.couple, 200),
    weddingDate: /^\d{4}-\d{2}-\d{2}$/.test(String(m.weddingDate || '')) ? String(m.weddingDate) : '',
    venue: text_(m.venue, 300),
    contact: text_(m.contact, 300),
    note: text_(m.note, 3000),
    lang: m.lang === 'en' ? 'en' : 'cs',
  };
  if (!meta.couple) throw fail_('couple_required');
  return meta;
}

function cleanAnswers_(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw fail_('bad_answers');
  var out = {};
  var keys = Object.keys(a);
  if (keys.length > 100) throw fail_('bad_answers');
  keys.forEach(function (k) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) return;
    var v = a[k];
    if (typeof v === 'string') {
      out[k] = v.slice(0, 3000);
    } else if (Array.isArray(v)) {
      out[k] = v.filter(function (x) { return typeof x === 'string'; }).slice(0, 20).map(function (x) { return x.slice(0, 100); });
    } else if (typeof v === 'boolean') {
      out[k] = v;
    }
  });
  return out;
}

function cleanFileName_(name, ext) {
  var base = String(name || 'photo').replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'photo';
  return base + '.' + ext;
}

function text_(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/* ------------------------------------------------------------------ */
/* Sheet storage                                                       */
/* ------------------------------------------------------------------ */

function sheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, COLUMNS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var rec = {};
    for (var c = 0; c < COLUMNS.length; c++) rec[COLUMNS[c]] = fromCell_(values[i][c]);
    if (rec.id) out.push({ row: i + 2, record: rec });
  }
  return out;
}

function findWedding_(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]{6,32}$/.test(id)) throw fail_('not_found');
  var all = readAll_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].record.id === id) return all[i];
  }
  throw fail_('not_found');
}

function writeRow_(row, rec) {
  var range = sheet_().getRange(row, 1, 1, COLUMNS.length);
  range.setNumberFormat('@'); // plain text: stops Sheets turning dates/numbers into other types
  range.setValues([COLUMNS.map(function (c) { return toCell_(rec[c]); })]);
}

function appendRow_(rec) {
  var sh = sheet_();
  var row = sh.getLastRow() + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 20);
  writeRow_(row, rec);
}

function toCell_(v) {
  var s = v === undefined || v === null ? '' : String(v);
  return s.charAt(0) === '=' ? "'" + s : s; // never let a value become a formula
}

function fromCell_(v) {
  if (v instanceof Date) return v.toISOString();
  var s = v === undefined || v === null ? '' : String(v);
  return s.indexOf("'=") === 0 ? s.slice(1) : s;
}

/* ------------------------------------------------------------------ */
/* Drive storage                                                       */
/* ------------------------------------------------------------------ */

function photoRoot_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PHOTO_ROOT_ID');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) {
      // folder deleted – create a new one below
    }
  }
  var folder = DriveApp.createFolder(PHOTO_ROOT_NAME);
  props.setProperty('PHOTO_ROOT_ID', folder.getId());
  return folder;
}

/** Returns the wedding's photo folder, creating it when needed (sets w.folderId; caller saves the row). */
function weddingFolder_(w) {
  if (w.folderId) {
    try {
      var existing = DriveApp.getFolderById(w.folderId);
      if (!existing.isTrashed()) return existing;
    } catch (err) {
      // folder deleted – create a new one below
    }
  }
  var folder = photoRoot_().createFolder((w.couple || 'Wedding') + ' – ' + w.id);
  w.folderId = folder.getId();
  return folder;
}

function photoIndex_(photos, photoId) {
  for (var i = 0; i < photos.length; i++) {
    if (photos[i].id === photoId) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('busy');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function newId_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + ':' + Date.now());
  var id = '';
  for (var i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET.charAt(bytes[i] & 31);
  return id;
}

function sameString_(a, b) {
  var diff = a.length ^ b.length;
  for (var i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson_(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch (err) {
    return fallback;
  }
}

function now_() {
  return new Date().toISOString();
}

function fail_(code) {
  var err = new Error(code);
  err.wqCode = code;
  return err;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
