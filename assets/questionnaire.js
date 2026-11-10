/* The couple's questionnaire page:  index.html?w=<wedding id> */
(function () {
  'use strict';
  const W = window.WQ;
  const { t, h } = W;

  const params = new URLSearchParams(location.search);
  const weddingId = (params.get('w') || '').trim().toLowerCase();
  const isPreview = params.get('preview') === '1'; // florist checking the link – don't mark it as opened
  const app = document.getElementById('app');
  const DRAFT_KEY = 'wq_draft_' + weddingId;
  const SAVE_DELAY = 2000;
  const RETRY_DELAY = 15000;
  const autoSizingSupported = window.CSS && CSS.supports && CSS.supports('field-sizing', 'content');

  const state = {
    phase: 'loading', // loading | missing | notFound | notConfigured | error | ready
    wedding: null,
    answers: {},
    photos: [], // { id?, name, status: 'ready' | 'loading' | 'uploading' | 'error', src?, errorKey? }
    view: 'form', // form | thanks
    dirty: false,
    saveStatus: 'idle', // idle | pending | saving | saved | error
  };

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */

  async function load() {
    state.phase = 'loading';
    render();
    try {
      const { wedding } = await W.api('getWedding', { id: weddingId, preview: isPreview });
      state.wedding = wedding;
      W.initLang(wedding.lang);
      state.answers = startingAnswers(wedding);
      state.photos = (wedding.photos || []).map((p) => ({ id: p.id, name: p.name, status: 'loading' }));
      state.phase = 'ready';
      render();
      state.photos.forEach(loadPhoto);
      if (state.dirty) scheduleSave(0); // local changes that never reached the server
    } catch (err) {
      state.phase = { not_found: 'notFound', not_configured: 'notConfigured' }[err.code] || 'error';
      render();
    }
  }

  /** Server answers, unless this browser holds newer unsaved ones (e.g. the tab was closed while offline). */
  function startingAnswers(wedding) {
    let draft = null;
    try {
      draft = JSON.parse(W.store.get('localStorage', DRAFT_KEY) || 'null');
    } catch (e) {
      draft = null;
    }
    const serverTime = Date.parse(wedding.updatedAt || '') || 0;
    if (draft && !draft.synced && draft.answers && draft.savedAt > serverTime) {
      state.dirty = true;
      return draft.answers;
    }
    return wedding.answers || {};
  }

  function writeDraft(synced) {
    W.store.set('localStorage', DRAFT_KEY, JSON.stringify({ answers: state.answers, savedAt: Date.now(), synced }));
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function render(keepScroll) {
    const y = window.scrollY;
    document.title = t('meta.title') + (W.cfg.brandName ? ' · ' + W.cfg.brandName : '');
    let main;
    switch (state.phase) {
      case 'loading':
        main = [renderHero(), renderSteps(), message(null, t('ui.loading'), { spinner: true })];
        break;
      case 'missing':
        main = [message(t('ui.missingLink.title'), t('ui.missingLink.text'))];
        break;
      case 'notFound':
        main = [message(t('ui.notFound.title'), t('ui.notFound.text'))];
        break;
      case 'notConfigured':
        main = [message(t('ui.error.title'), t('ui.notConfigured'))];
        break;
      case 'error':
        main = [message(t('ui.error.title'), t('ui.error.text'), { retry: true })];
        break;
      default:
        main = [renderHero(), renderSteps(), state.view === 'thanks' ? renderThanks() : renderForm()];
    }
    app.replaceChildren(...main, renderFooter());
    if (!autoSizingSupported) app.querySelectorAll('textarea').forEach(autosize);
    setSaveStatus(state.saveStatus);
    if (keepScroll) window.scrollTo(0, y);
  }

  function message(title, text, opts) {
    opts = opts || {};
    return h('section', { class: 'card message' + (opts.spinner ? ' is-loading' : '') },
      opts.spinner ? h('div', { class: 'spinner', 'aria-hidden': 'true' }) : null,
      title ? h('h2', null, title) : null,
      h('p', null, text),
      opts.retry ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: load }, t('ui.retry')) : null);
  }

  function renderHero() {
    const w = state.wedding;
    return h('section', { class: 'hero' },
      W.sprig('hero-sprig'),
      h('h1', null, t('intro.title')),
      w && w.couple
        ? h('p', { class: 'prepared' }, t('ui.preparedFor') + ' ', h('strong', null, w.couple), w.weddingDate ? ' · ' + W.fmtDate(w.weddingDate) : '')
        : null,
      h('div', { class: 'intro' }, t('intro.p').map((p) => h('p', null, p))),
      h('blockquote', { class: 'motto' }, t('intro.motto')),
      state.phase === 'ready' ? h('a', { class: 'btn btn-primary', href: '#questionnaire' }, t('ui.start')) : null);
  }

  function renderSteps() {
    return h('section', { class: 'steps' },
      h('h2', null, t('steps.title')),
      h('ol', { class: 'steps-list' }, t('steps').map((s, i) =>
        h('li', { class: 'step' },
          h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
          h('div', { class: 'step-body' }, h('h3', null, s.title), h('p', null, s.text))))));
  }

  function renderForm() {
    const w = state.wedding;
    const submitted = w.status === 'submitted' && w.submittedAt;
    const form = h('form', { id: 'questionnaire', class: 'questionnaire', novalidate: true });
    W.append(form, [
      h('header', { class: 'form-head' },
        h('h2', null, '🌸 ' + t('form.title')),
        h('p', { class: 'lead' }, t('form.subtitle')),
        h('p', { class: 'note' }, t('ui.autosaveNote'))),
      submitted ? h('p', { class: 'banner', role: 'status' }, t('ui.submittedBanner', { date: W.fmtDate(w.submittedAt) })) : null,
      W.FORM.map(renderSection),
      h('div', { class: 'form-actions' },
        h('button', { type: 'submit', class: 'btn btn-primary btn-lg', id: 'submitBtn' }, t(submitted ? 'ui.resubmit' : 'ui.submit')),
        h('p', { class: 'form-error', id: 'submitError', role: 'alert', hidden: true }, t('ui.submitError'))),
      h('div', { class: 'save-status', id: 'saveStatus', 'aria-live': 'polite' }),
    ]);
    form.addEventListener('input', onInput);
    form.addEventListener('submit', onSubmit);
    return form;
  }

  function renderSection(section) {
    return h('section', { class: 'card q-section', 'aria-labelledby': 'sec-' + section.id },
      h('h3', { class: 'section-title', id: 'sec-' + section.id }, t('s.' + section.id)),
      section.items.map(renderItem));
  }

  function renderItem(item) {
    const attrs = { class: 'q q-' + item.type };
    if (item.showIf) {
      attrs.class += ' q-conditional';
      attrs.dataset = { showKey: item.showIf[0], showVal: item.showIf[1] };
      attrs.hidden = !W.isVisible(item, state.answers);
    }
    let body;
    switch (item.type) {
      case 'yesno':
        body = choiceGroup(item, ['yes', 'no'], 'radio', (v) => t('ui.' + v));
        break;
      case 'radio':
        body = choiceGroup(item, item.options, 'radio', (v) => t('o.' + item.key + '.' + v));
        break;
      case 'checkbox':
        body = choiceGroup(item, item.options, 'checkbox', (v) => t('o.' + item.key + '.' + v));
        break;
      case 'textarea':
        body = [h('label', { class: 'q-label', for: 'f-' + item.key }, t('q.' + item.key)), textarea(item.key)];
        break;
      case 'fields':
        body = h('fieldset', { class: 'q-fields' },
          h('legend', { class: 'q-label' }, t('q.' + item.key)),
          item.fields.map((k) => h('div', { class: 'sub-field' },
            h('label', { class: 'sub-label', for: 'f-' + k }, t('q.' + k)),
            textarea(k))));
        break;
      case 'photos':
        body = renderPhotos();
        break;
    }
    return h('div', attrs, body);
  }

  function textarea(key) {
    return h('textarea', { id: 'f-' + key, name: key, rows: 2, maxlength: 3000, placeholder: t('ui.answerPlaceholder'), value: state.answers[key] || '' });
  }

  function choiceGroup(item, values, type, labelFor) {
    const current = state.answers[item.key];
    const isChecked = (v) => (type === 'checkbox' ? Array.isArray(current) && current.includes(v) : current === v);
    return h('fieldset', { class: 'choices' + (item.type === 'yesno' ? ' choices-yesno' : '') },
      h('legend', { class: 'q-label' }, t('q.' + item.key)),
      type === 'checkbox' ? h('p', { class: 'q-hint' }, t('ui.chooseMany')) : null,
      h('div', { class: 'choice-list' }, values.map((v) =>
        h('label', { class: 'choice' },
          h('input', { type, name: item.key, value: v, checked: isChecked(v) }),
          h('span', { class: 'choice-text' }, labelFor(v))))),
      item.other
        ? h('div', { class: 'other-field', dataset: { otherFor: item.key }, hidden: !W.hasOther(item, state.answers) },
          h('label', { class: 'sub-label', for: 'f-' + item.other }, t('q.' + item.other)),
          h('input', { type: 'text', id: 'f-' + item.other, name: item.other, maxlength: 300, value: state.answers[item.other] || '' }))
        : null);
  }

  function renderThanks() {
    return h('section', { class: 'card thanks', id: 'thanks', tabindex: '-1' },
      W.sprig('thanks-sprig'),
      h('h2', null, t('ui.thanks.title')),
      h('p', null, t('thanks.text')),
      h('button', {
        type: 'button',
        class: 'btn btn-secondary',
        onclick: () => {
          state.view = 'form';
          render();
          document.getElementById('questionnaire').scrollIntoView({ block: 'start' });
        },
      }, t('ui.thanks.edit')));
  }

  function renderFooter() {
    const email = W.cfg.contactEmail;
    return h('footer', { class: 'site-footer' },
      W.sprig('footer-sprig'),
      email ? h('p', null, t('ui.contact') + ' ', h('a', { href: 'mailto:' + email }, email)) : null,
      W.cfg.brandName ? h('p', { class: 'muted' }, '© ' + new Date().getFullYear() + ' ' + W.cfg.brandName) : null);
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }

  /* ------------------------------------------------------------------ */
  /* Answers & autosave                                                  */
  /* ------------------------------------------------------------------ */

  function onInput(e) {
    const el = e.target;
    if (!el.name || el.type === 'file') return;
    const form = e.currentTarget;
    if (el.type === 'checkbox') {
      setAnswer(el.name, Array.from(form.querySelectorAll('input[type="checkbox"][name="' + el.name + '"]:checked'), (i) => i.value));
    } else if (el.type === 'radio') {
      if (el.checked) setAnswer(el.name, el.value);
    } else {
      setAnswer(el.name, el.value);
      if (el.tagName === 'TEXTAREA' && !autoSizingSupported) autosize(el);
    }
    updateConditionals(form);
    markDirty();
  }

  function setAnswer(key, value) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete state.answers[key];
    else state.answers[key] = value;
  }

  function updateConditionals(root) {
    root.querySelectorAll('[data-show-key]').forEach((el) => {
      el.hidden = state.answers[el.dataset.showKey] !== el.dataset.showVal;
    });
    root.querySelectorAll('[data-other-for]').forEach((el) => {
      const v = state.answers[el.dataset.otherFor];
      el.hidden = !(Array.isArray(v) ? v.includes('other') : v === 'other');
    });
  }

  /** Only the answers to questions that are currently shown (sent on final submit). */
  function visibleAnswers() {
    const a = state.answers;
    const out = {};
    const copy = (k) => {
      if (a[k] !== undefined) out[k] = a[k];
    };
    W.FORM.forEach((section) => section.items.forEach((item) => {
      if (!W.isVisible(item, a)) return;
      if (item.type === 'fields') item.fields.forEach(copy);
      else if (item.type !== 'photos') copy(item.key);
      if (item.other && W.hasOther(item, a)) copy(item.other);
    }));
    return out;
  }

  let saveTimer = null;
  let inFlight = null;

  function markDirty() {
    state.dirty = true;
    writeDraft(false);
    scheduleSave(SAVE_DELAY);
  }

  function scheduleSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, delay);
    setSaveStatus('pending');
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (inFlight) await inFlight.catch(() => {});
    if (!state.dirty) return;
    state.dirty = false;
    setSaveStatus('saving');
    const request = W.api('saveAnswers', { id: weddingId, answers: state.answers });
    inFlight = request;
    try {
      const res = await request;
      mergeWedding(res.wedding);
      if (!state.dirty) {
        writeDraft(true);
        setSaveStatus('saved');
      }
    } catch (err) {
      state.dirty = true;
      setSaveStatus('error');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, RETRY_DELAY);
    } finally {
      if (inFlight === request) inFlight = null;
    }
  }

  function mergeWedding(w) {
    if (!w || !state.wedding) return;
    state.wedding.status = w.status;
    state.wedding.updatedAt = w.updatedAt;
    state.wedding.submittedAt = w.submittedAt;
  }

  function setSaveStatus(status) {
    state.saveStatus = status;
    const el = document.getElementById('saveStatus');
    if (!el) return;
    const text = { pending: 'ui.status.saving', saving: 'ui.status.saving', saved: 'ui.status.saved', error: 'ui.status.error' }[status];
    el.className = 'save-status is-' + status;
    el.textContent = text ? (status === 'saved' ? '✓ ' : '') + t(text) : '';
  }

  // Last chance to save when the tab is hidden or closed.
  function saveOnLeave() {
    if (state.phase === 'ready' && state.dirty) W.beacon('saveAnswers', { id: weddingId, answers: state.answers });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveOnLeave();
  });
  window.addEventListener('pagehide', saveOnLeave);

  async function onSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('submitBtn');
    const errorEl = document.getElementById('submitError');
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('ui.sending');
    errorEl.hidden = true;
    clearTimeout(saveTimer);
    try {
      await Promise.allSettled(Array.from(uploads));
      if (inFlight) await inFlight.catch(() => {});
      const res = await W.api('saveAnswers', { id: weddingId, answers: visibleAnswers(), submit: true });
      state.dirty = false;
      mergeWedding(res.wedding);
      writeDraft(true);
      state.saveStatus = 'idle';
      state.view = 'thanks';
      render();
      const thanks = document.getElementById('thanks');
      thanks.scrollIntoView({ behavior: 'smooth', block: 'start' });
      thanks.focus({ preventScroll: true });
    } catch (err) {
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Inspiration photos                                                  */
  /* ------------------------------------------------------------------ */

  const uploads = new Set();
  let uploadQueue = Promise.resolve();
  let downloadQueue = Promise.resolve();

  function renderPhotos() {
    const full = state.photos.length >= W.MAX_PHOTOS;
    return h('div', { class: 'photos' },
      h('p', { class: 'q-label', id: 'photos-label' }, t('q.photos')),
      h('p', { class: 'q-hint' }, t('ui.photos.hint', { max: W.MAX_PHOTOS })),
      h('div', { class: 'photo-grid', id: 'photoGrid', role: 'list', 'aria-labelledby': 'photos-label' }, photoTiles()),
      h('div', { class: 'photo-actions' },
        h('label', { class: 'btn btn-secondary photo-add' + (full ? ' is-disabled' : ''), id: 'photoAdd' },
          h('input', {
            type: 'file',
            accept: 'image/*',
            multiple: true,
            class: 'visually-hidden',
            disabled: full,
            onchange: (e) => {
              addFiles(e.target.files);
              e.target.value = '';
            },
          }),
          '+ ' + t('ui.photos.add')),
        h('span', { class: 'photo-count', id: 'photoCount' }, state.photos.length + ' / ' + W.MAX_PHOTOS)),
      h('p', { class: 'photo-msg', id: 'photoMsg', role: 'status' }));
  }

  function photoTiles() {
    return state.photos.map((p) => {
      const busy = p.status === 'uploading' || p.status === 'loading';
      return h('figure', { class: 'photo' + (busy ? ' is-busy' : '') + (p.status === 'error' ? ' is-error' : ''), role: 'listitem' },
        p.src ? h('img', { src: p.src, alt: p.name || '' }) : null,
        busy ? h('div', { class: 'photo-overlay' }, h('div', { class: 'spinner small', 'aria-label': t('ui.photos.uploading') })) : null,
        p.status === 'error' ? h('figcaption', null, t(p.errorKey || 'ui.photos.error')) : null,
        p.status !== 'uploading'
          ? h('button', { type: 'button', class: 'photo-remove', 'aria-label': t('ui.photos.remove'), title: t('ui.photos.remove'), onclick: () => removePhoto(p) }, '×')
          : null);
    });
  }

  function refreshPhotos() {
    const grid = document.getElementById('photoGrid');
    if (!grid) return;
    grid.replaceChildren(...photoTiles());
    const full = state.photos.length >= W.MAX_PHOTOS;
    document.getElementById('photoCount').textContent = state.photos.length + ' / ' + W.MAX_PHOTOS;
    const add = document.getElementById('photoAdd');
    add.classList.toggle('is-disabled', full);
    add.querySelector('input').disabled = full;
  }

  function setPhotoMsg(text) {
    const el = document.getElementById('photoMsg');
    if (el) el.textContent = text || '';
  }

  function addFiles(fileList) {
    const files = Array.from(fileList);
    const room = Math.max(0, W.MAX_PHOTOS - state.photos.length);
    setPhotoMsg(files.length > room ? t('ui.photos.limit', { max: W.MAX_PHOTOS }) : '');
    files.slice(0, room).forEach((file) => {
      const p = { name: file.name, status: 'uploading' };
      state.photos.push(p);
      const job = uploadQueue.then(() => uploadOne(p, file)); // one at a time – gentle on phones
      uploadQueue = job;
      uploads.add(job);
      job.finally(() => uploads.delete(job));
    });
    refreshPhotos();
  }

  async function uploadOne(p, file) {
    try {
      p.src = await resizeImage(file);
      refreshPhotos();
      const res = await W.api('uploadPhoto', {
        id: weddingId,
        name: file.name,
        mimeType: 'image/jpeg',
        data: p.src.slice(p.src.indexOf(',') + 1),
      });
      p.id = res.photo.id;
      p.name = res.photo.name;
      p.status = 'ready';
    } catch (err) {
      p.status = 'error';
      p.errorKey = err && err.code === 'decode' ? 'ui.photos.unsupported' : 'ui.photos.error';
    }
    refreshPhotos();
  }

  function loadPhoto(p) {
    downloadQueue = downloadQueue.then(async () => {
      if (!state.photos.includes(p)) return;
      try {
        const res = await W.api('getPhoto', { id: weddingId, photoId: p.id });
        p.src = 'data:' + res.mimeType + ';base64,' + res.data;
      } catch (err) {
        /* tile stays empty but can still be removed */
      }
      p.status = 'ready';
      refreshPhotos();
    });
  }

  async function removePhoto(p) {
    if (!window.confirm(t('ui.photos.removeConfirm'))) return;
    if (p.id) {
      const before = p.status;
      p.status = 'loading';
      refreshPhotos();
      try {
        await W.api('deletePhoto', { id: weddingId, photoId: p.id });
      } catch (err) {
        if (err.code !== 'photo_not_found') {
          p.status = before;
          refreshPhotos();
          setPhotoMsg(t('ui.photos.error'));
          return;
        }
      }
    }
    state.photos = state.photos.filter((x) => x !== p);
    setPhotoMsg('');
    refreshPhotos();
  }

  /** Shrinks the picture to max 1600 px and re-encodes it as JPEG (also strips most metadata). */
  function resizeImage(file, maxSide, quality) {
    maxSide = maxSide || 1600;
    quality = quality || 0.82;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const width = Math.max(1, Math.round(img.naturalWidth * scale));
          const height = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (e) {
          reject(new W.ApiError('decode'));
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new W.ApiError('decode'));
      };
      img.src = url;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  W.initChrome();
  W.initLang();
  W.onLangChange(() => render(true));

  if (weddingId) load();
  else {
    state.phase = 'missing';
    render();
  }
})();
