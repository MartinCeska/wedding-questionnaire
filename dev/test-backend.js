'use strict';
/* Runs apps-script/Code.gs against the fakes and checks every API action.  Usage: node dev/test-backend.js */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadBackend } = require('./gas-fakes');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-test-'));
const be = loadBackend(dir, { initialMaxRows: 3 }); // tiny sheet so appending must grow it
const PW = 'correct-horse';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}
const ok = (res) => {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
};
const err = (res, code) => {
  assert.equal(res.ok, false);
  assert.equal(res.error, code);
};

console.log('Code.gs backend');

test('doGet health check', () => assert.equal(JSON.parse(be.doGet()).ok, true));
test('bad JSON and unknown action', () => {
  err(JSON.parse(be.doPost('not json')), 'bad_request');
  err(be.call('nope'), 'unknown_action');
  err(be.call('hasOwnProperty'), 'unknown_action');
});
test('admin without password configured', () => err(be.call('adminLogin', { password: 'x' }), 'admin_not_configured'));
test('passwords shorter than 6 characters are refused', () => {
  be.setProperty('ADMIN_PASSWORD', 'short');
  err(be.call('adminLogin', { password: 'short' }), 'admin_not_configured');
  be.setProperty('ADMIN_PASSWORD', 'sixsix');
  ok(be.call('adminLogin', { password: 'sixsix' }));
});

be.setProperty('ADMIN_PASSWORD', PW);
test('setup creates sheet and photo folder', () => {
  be.runFunction('setup');
  const st = be.services.state();
  assert.ok(st.sheets.Weddings);
  assert.ok(st.properties.PHOTO_ROOT_ID);
});

test('admin login', () => {
  err(be.call('adminLogin', { password: 'wrong' }), 'unauthorized');
  be.services.clearCache();
  ok(be.call('adminLogin', { password: PW }));
});

let id;
test('create wedding (and grow sheet beyond max rows)', () => {
  err(be.call('adminCreate', { password: PW, wedding: { couple: '  ' } }), 'couple_required');
  const res = ok(be.call('adminCreate', {
    password: PW,
    wedding: { couple: 'Anna & Tom', weddingDate: '2027-06-12', venue: 'Zámek', contact: '=HYPERLINK("x")', note: 'VIP', lang: 'en' },
  }));
  id = res.wedding.id;
  assert.match(id, /^[a-z2-9]{12}$/);
  for (let i = 0; i < 4; i++) ok(be.call('adminCreate', { password: PW, wedding: { couple: 'Couple ' + i } }));
  assert.equal(ok(be.call('adminList', { password: PW })).weddings.length, 5);
});

test('formula-like values come back unchanged', () => {
  const w = ok(be.call('adminGet', { password: PW, id })).wedding;
  assert.equal(w.contact, '=HYPERLINK("x")');
  assert.equal(w.weddingDate, '2027-06-12');
  assert.equal(w.lang, 'en');
  assert.equal(w.note, 'VIP');
});

test('getWedding: unknown ids, public view, openedAt', () => {
  err(be.call('getWedding', { id: 'zzzzzzzzzzzz' }), 'not_found');
  err(be.call('getWedding', { id: '../etc' }), 'not_found');
  err(be.call('getWedding', {}), 'not_found');
  ok(be.call('getWedding', { id, preview: true }));
  assert.equal(ok(be.call('adminGet', { password: PW, id })).wedding.openedAt, '', 'preview must not mark as opened');
  const w = ok(be.call('getWedding', { id })).wedding;
  assert.equal(w.couple, 'Anna & Tom');
  assert.equal(w.note, undefined, 'internal note must not leak');
  assert.equal(w.contact, undefined);
  assert.equal(w.status, 'new');
  assert.ok(ok(be.call('adminGet', { password: PW, id })).wedding.openedAt);
});

test('save draft, then submit', () => {
  const answers = { bouquetShape: 'round', floralStyle: ['romantic', 'other'], floralStyleOther: 'x'.repeat(5000), 'bad key!': 'drop', n: 5 };
  const draft = ok(be.call('saveAnswers', { id, answers })).wedding;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.answers.bouquetShape, 'round');
  assert.deepEqual(draft.answers.floralStyle, ['romantic', 'other']);
  assert.equal(draft.answers.floralStyleOther.length, 3000);
  assert.equal(draft.answers['bad key!'], undefined);
  assert.equal(draft.answers.n, undefined);
  const sub = ok(be.call('saveAnswers', { id, answers: { bouquetShape: 'meadow' }, submit: true })).wedding;
  assert.equal(sub.status, 'submitted');
  assert.ok(sub.submittedAt);
  const again = ok(be.call('saveAnswers', { id, answers: { bouquetShape: 'round' } })).wedding;
  assert.equal(again.status, 'submitted', 'draft save after submit keeps submitted');
  err(be.call('saveAnswers', { id, answers: 'x' }), 'bad_answers');
  err(be.call('saveAnswers', { id, answers: [] }), 'bad_answers');
});

test('no notification e-mail while NOTIFY_EMAIL is not set', () => {
  assert.equal(be.services.mail().length, 0, 'the submit above must not have sent anything');
});

test('notification e-mail when a couple sends the questionnaire', () => {
  be.setProperty('NOTIFY_EMAIL', ' florist@example.com , helper@example.cz ');
  be.setProperty('ADMIN_URL', 'https://example.github.io/wq/admin.html');
  const nid = ok(be.call('adminCreate', {
    password: PW,
    wedding: { couple: 'Eva &\nPetr', weddingDate: '2027-09-04', venue: 'Mlýn', contact: 'Eva Nová, eva.nova@example.com, 777 123 456' },
  })).wedding.id;
  const mail = () => be.services.mail();

  ok(be.call('saveAnswers', { id: nid, answers: { bouquetShape: 'round' } }));
  assert.equal(mail().length, 0, 'a draft save sends nothing');

  ok(be.call('uploadPhoto', { id: nid, mimeType: 'image/png', data: PNG_1PX }));
  ok(be.call('saveAnswers', { id: nid, answers: { bouquetShape: 'round' }, submit: true }));
  assert.equal(mail().length, 1);
  const m = mail()[0];
  assert.equal(m.to, 'florist@example.com,helper@example.cz');
  assert.equal(m.subject, 'Questionnaire sent: Eva & Petr (4. 9. 2027)');
  assert.equal(m.replyTo, 'eva.nova@example.com');
  assert.match(m.body, /^Eva & Petr sent their floral questionnaire\./);
  assert.match(m.body, /Venue: Mlýn/);
  assert.match(m.body, /Inspiration photos: 1/);
  assert.match(m.body, new RegExp('Read the answers: https://example\\.github\\.io/wq/admin\\.html#/w/' + nid + '$'));

  ok(be.call('saveAnswers', { id: nid, answers: { bouquetShape: 'meadow' }, submit: true }));
  assert.equal(mail().length, 1, 'sending again within 5 minutes does not e-mail again');
  be.services.clearCache();
  ok(be.call('saveAnswers', { id: nid, answers: { bouquetShape: 'meadow' }, submit: true }));
  assert.equal(mail().length, 2);
  assert.match(mail()[1].subject, /^Questionnaire sent again: Eva & Petr/);
  assert.match(mail()[1].body, /sent their floral questionnaire again\./);
});

test('a failing or misconfigured e-mail never fails the submit', () => {
  const nid = ok(be.call('adminCreate', { password: PW, wedding: { couple: 'Jana & Karel', contact: '777 000 111' } })).wedding.id;
  const before = be.services.mail().length;
  be.services.setMailError('Service invoked too many times for one day: email.');
  const origError = console.error;
  let logged = '';
  console.error = (msg) => { logged += msg; };
  try {
    assert.equal(ok(be.call('saveAnswers', { id: nid, answers: {}, submit: true })).wedding.status, 'submitted');
  } finally {
    console.error = origError;
    be.services.setMailError(null);
  }
  assert.match(logged, /Notification e-mail failed/);
  assert.equal(be.services.mail().length, before);

  be.services.clearCache();
  ok(be.call('saveAnswers', { id: nid, answers: {}, submit: true }));
  const m = be.services.mail()[be.services.mail().length - 1];
  assert.equal(m.subject, 'Questionnaire sent again: Jana & Karel', 'no date → no brackets');
  assert.equal(m.replyTo, undefined, 'no e-mail in contact → no Reply-To');
  assert.match(m.body, /Wedding date: –/);

  be.setProperty('NOTIFY_EMAIL', 'not an address');
  be.services.clearCache();
  ok(be.call('saveAnswers', { id: nid, answers: {}, submit: true }));
  assert.equal(be.services.mail().length, before + 1, 'invalid NOTIFY_EMAIL sends nothing');
  be.setProperty('ADMIN_URL', 'javascript:alert(1)');
  be.setProperty('NOTIFY_EMAIL', 'florist@example.com');
  be.services.clearCache();
  ok(be.call('saveAnswers', { id: nid, answers: {}, submit: true }));
  assert.doesNotMatch(be.services.mail()[before + 1].body, /Read the answers/, 'a non-http ADMIN_URL is left out');
});

test('sendTestEmail sends a sample to NOTIFY_EMAIL', () => {
  const before = be.services.mail().length;
  be.runFunction('sendTestEmail');
  const m = be.services.mail()[before];
  assert.equal(m.to, 'florist@example.com');
  assert.match(m.subject, /^\[Test\] Questionnaire sent: /);
  assert.equal(m.replyTo, undefined);
});

let photoId;
test('photos: upload, read back, validation, limit, delete', () => {
  err(be.call('uploadPhoto', { id, mimeType: 'text/html', data: PNG_1PX }), 'bad_photo_type');
  err(be.call('uploadPhoto', { id, mimeType: 'image/png', data: '<script>' }), 'bad_photo');
  err(be.call('uploadPhoto', { id: 'zzzzzzzzzzzz', mimeType: 'image/png', data: PNG_1PX }), 'not_found');
  const up = ok(be.call('uploadPhoto', { id, mimeType: 'image/png', name: '../../evil name!.exe', data: PNG_1PX }));
  photoId = up.photo.id;
  assert.equal(up.photo.name, 'evil name.png');
  const back = ok(be.call('getPhoto', { id, photoId }));
  assert.equal(back.data, PNG_1PX);
  assert.equal(back.mimeType, 'image/png');
  for (let i = 0; i < 9; i++) ok(be.call('uploadPhoto', { id, mimeType: 'image/png', name: 'p' + i, data: PNG_1PX }));
  err(be.call('uploadPhoto', { id, mimeType: 'image/png', data: PNG_1PX }), 'too_many_photos');
  assert.equal(ok(be.call('getWedding', { id })).wedding.photos.length, 10);
  ok(be.call('deletePhoto', { id, photoId }));
  err(be.call('getPhoto', { id, photoId }), 'photo_not_found');
  assert.equal(be.services.state().files[photoId].trashed, true);
  // a photo of another wedding cannot be read through this wedding's id
  const other = ok(be.call('adminList', { password: PW })).weddings.find((w) => w.id !== id).id;
  const remaining = ok(be.call('getWedding', { id })).wedding.photos[0].id;
  err(be.call('getPhoto', { id: other, photoId: remaining }), 'photo_not_found');
});

test('admin update and delete', () => {
  const upd = ok(be.call('adminUpdate', { password: PW, id, wedding: { couple: 'Anna & Tomáš', weddingDate: 'not a date', lang: 'cs' } })).wedding;
  assert.equal(upd.couple, 'Anna & Tomáš');
  assert.equal(upd.weddingDate, '');
  assert.equal(upd.photos.length, 9);
  const folderId = be.services.state().sheets.Weddings.rows.find((r) => r[0] === id)[14];
  ok(be.call('adminDelete', { password: PW, id }));
  err(be.call('getWedding', { id }), 'not_found');
  assert.equal(be.services.state().folders[folderId].trashed, true);
  assert.equal(ok(be.call('adminList', { password: PW })).weddings.length, 6); // 5 + 2 from the e-mail tests − 1
});

test('admin endpoints reject missing password', () => {
  for (const a of ['adminList', 'adminGet', 'adminCreate', 'adminUpdate', 'adminDelete']) err(be.call(a, {}), 'unauthorized');
});

test('sign-in is blocked after 10 failed attempts', () => {
  be.services.clearCache();
  for (let i = 0; i < 10; i++) err(be.call('adminLogin', { password: 'guess' + i }), 'unauthorized');
  err(be.call('adminLogin', { password: PW }), 'too_many_attempts');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} tests passed`);
