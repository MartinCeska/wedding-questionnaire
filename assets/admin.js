/* Admin page: sign in, create questionnaires (= wedding links), read answers.   admin.html#/  and  admin.html#/w/<id> */
(function () {
  'use strict';
  const W = window.WQ;
  const { t, h } = W;

  const app = document.getElementById('app');
  const PW_KEY = 'wq_admin_pw';

  const emptyDraft = () => ({ couple: '', weddingDate: '', venue: '', contact: '', note: '', lang: W.cfg.defaultLang === 'en' ? 'en' : 'cs' });

  const state = {
    password: W.store.get('sessionStorage', PW_KEY) || '',
    loginError: null,
    weddings: null,
    listError: null,
    loadingList: false,
    draft: emptyDraft(),
    newOpen: false,
    lastCreated: null,
    details: new Map(),
    editing: null,
    photoUrls: new Map(),
    photoLoading: new Set(),
  };

  /* ------------------------------------------------------------------ */
  /* Plumbing                                                            */
  /* ------------------------------------------------------------------ */

  function adminApi(action, payload) {
    return W.api(action, Object.assign({ password: state.password }, payload)).catch((err) => {
      if (err.code === 'unauthorized' || err.code === 'admin_not_configured' || err.code === 'too_many_attempts') signOut(err.code);
      throw err;
    });
  }

  function signOut(code) {
    state.password = '';
    W.store.remove('sessionStorage', PW_KEY);
    state.weddings = null;
    state.details.clear();
    state.lastCreated = null;
    state.loginError = code || null;
    route();
  }

  function route() {
    document.title = t('admin.title') + ' · ' + t('admin.badge');
    document.getElementById('adminBadge').textContent = t('admin.badge');
    const logout = document.getElementById('logoutBtn');
    logout.textContent = t('admin.logout');
    logout.hidden = !state.password;
    if (!state.password) return renderLogin();
    const m = /^#\/w\/([a-z0-9]+)$/.exec(location.hash);
    return m ? renderDetail(m[1]) : renderList();
  }

  const coupleLink = (id) => new URL('./?w=' + encodeURIComponent(id), location.href).href;
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const isPast = (w) => !!w.weddingDate && w.weddingDate < todayIso();

  function statusOf(w) {
    if (w.status === 'submitted') return w.updatedAt && w.submittedAt && w.updatedAt > w.submittedAt ? 'edited' : 'submitted';
    if (w.status === 'draft') return 'draft';
    return w.openedAt ? 'opened' : 'new';
  }

  function badge(w) {
    const s = statusOf(w);
    return h('span', { class: 'badge badge-' + s }, t('admin.status.' + s));
  }

  function errorText(code) {
    return t('admin.error', { error: code });
  }

  function copyButton(text) {
    const btn = h('button', {
      type: 'button',
      class: 'btn btn-secondary btn-sm',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch (e) {
          const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
          document.body.append(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        btn.textContent = t('admin.copied');
        setTimeout(() => {
          btn.textContent = t('admin.copy');
        }, 1600);
      },
    }, t('admin.copy'));
    return btn;
  }

  function linkRow(id) {
    const url = coupleLink(id);
    return h('div', { class: 'link-row' },
      h('input', { type: 'text', readonly: true, value: url, 'aria-label': t('admin.link'), onfocus: (e) => e.target.select() }),
      copyButton(url),
      h('a', { class: 'btn btn-secondary btn-sm', href: url + '&preview=1', target: '_blank', rel: 'noopener' }, t('admin.open')));
  }

  /* ------------------------------------------------------------------ */
  /* Sign in                                                             */
  /* ------------------------------------------------------------------ */

  function loginErrorText(code) {
    return {
      unauthorized: t('admin.login.wrong'),
      too_many_attempts: t('admin.login.locked'),
      admin_not_configured: t('admin.login.notConfigured'),
      not_configured: t('ui.notConfigured'),
    }[code] || errorText(code);
  }

  function renderLogin() {
    const errorEl = h('p', { class: 'form-error-box', role: 'alert', hidden: !state.loginError }, state.loginError ? loginErrorText(state.loginError) : '');
    const input = h('input', {
      type: 'password',
      id: 'pw',
      name: 'password',
      autocomplete: 'current-password',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      required: true,
    });
    const toggle = h('button', {
      type: 'button',
      class: 'password-toggle',
      'aria-controls': 'pw',
      'aria-pressed': 'false',
      onclick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(show));
        toggle.textContent = t(show ? 'admin.login.hide' : 'admin.login.show');
        input.focus();
      },
    }, t('admin.login.show'));
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, t('admin.login.submit'));
    const form = h('form', {
      class: 'card login',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        errorEl.hidden = true;
        try {
          await W.api('adminLogin', { password: input.value });
          state.password = input.value;
          state.loginError = null;
          W.store.set('sessionStorage', PW_KEY, input.value);
          route();
        } catch (err) {
          state.loginError = err.code;
          errorEl.textContent = loginErrorText(err.code);
          errorEl.hidden = false;
          btn.disabled = false;
          input.select();
        }
      },
    },
      h('h1', null, t('admin.login.title')),
      errorEl,
      h('div', { class: 'field' },
        h('label', { for: 'pw' }, t('admin.login.password')),
        h('div', { class: 'password-wrap' }, input, toggle)),
      btn);
    app.replaceChildren(form);
    input.focus();
  }

  /* ------------------------------------------------------------------ */
  /* List + new questionnaire                                            */
  /* ------------------------------------------------------------------ */

  async function loadList(force) {
    state.loadingList = true;
    state.listError = null;
    if (force) {
      state.weddings = null;
      route();
    }
    try {
      state.weddings = (await adminApi('adminList', {})).weddings;
    } catch (err) {
      if (!state.password) return;
      state.listError = err.code;
      state.weddings = state.weddings || [];
    } finally {
      state.loadingList = false;
    }
    if (!/^#\/w\//.test(location.hash)) route();
  }

  function renderList() {
    if (!state.weddings && !state.loadingList) loadList();
    app.replaceChildren(
      h('div', { class: 'admin-head' },
        h('h1', null, t('admin.title')),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => loadList(true) }, t('admin.refresh'))),
      renderNewCard(),
      renderListCard());
  }

  function metaFields(d) {
    const field = (name, label, input, wide) =>
      h('div', { class: 'field' + (wide ? ' field-wide' : '') }, h('label', { for: 'm-' + name }, label), input);
    return h('div', { class: 'field-grid' },
      field('couple', t('admin.field.couple'),
        h('input', { type: 'text', id: 'm-couple', name: 'couple', required: true, maxlength: 200, placeholder: t('admin.field.couplePlaceholder'), value: d.couple || '' })),
      field('weddingDate', t('admin.field.weddingDate'), h('input', { type: 'date', id: 'm-weddingDate', name: 'weddingDate', value: d.weddingDate || '' })),
      field('venue', t('admin.field.venue'), h('input', { type: 'text', id: 'm-venue', name: 'venue', maxlength: 300, value: d.venue || '' })),
      field('contact', t('admin.field.contact'), h('input', { type: 'text', id: 'm-contact', name: 'contact', maxlength: 300, value: d.contact || '' })),
      field('lang', t('admin.field.lang'),
        h('select', { id: 'm-lang', name: 'lang' }, ['cs', 'en'].map((l) => h('option', { value: l, selected: d.lang === l }, t('admin.lang.' + l))))),
      field('note', t('admin.field.note'), h('textarea', { id: 'm-note', name: 'note', rows: 2, maxlength: 3000, value: d.note || '' }), true));
  }

  function renderNewCard() {
    const d = state.draft;
    const errorEl = h('p', { class: 'form-error-box', role: 'alert', hidden: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, t('admin.create'));
    const form = h('form', {
      oninput: (e) => {
        if (e.target.name) d[e.target.name] = e.target.value;
      },
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        errorEl.hidden = true;
        try {
          const { wedding } = await adminApi('adminCreate', { wedding: d });
          state.lastCreated = wedding;
          state.draft = emptyDraft();
          if (state.weddings) state.weddings.push(wedding);
          route();
        } catch (err) {
          if (!state.password) return;
          errorEl.textContent = errorText(err.code);
          errorEl.hidden = false;
          btn.disabled = false;
        }
      },
    }, metaFields(d), errorEl, btn);

    const created = state.lastCreated;
    const card = h('details', { class: 'card new-card', open: state.newOpen || !!created },
      h('summary', null, t('admin.new.title')),
      created
        ? h('div', { class: 'created-box', role: 'status' }, h('p', null, t('admin.createdMsg') + ' ', h('strong', null, created.couple)), linkRow(created.id))
        : null,
      form);
    card.addEventListener('toggle', () => {
      state.newOpen = card.open;
      if (!card.open) state.lastCreated = null;
    });
    return card;
  }

  function sortWeddings(list) {
    return list.slice().sort((a, b) => {
      const pa = isPast(a);
      const pb = isPast(b);
      if (pa !== pb) return pa ? 1 : -1; // upcoming first, past weddings at the bottom
      const da = a.weddingDate || '9999-12-31';
      const db = b.weddingDate || '9999-12-31';
      if (da !== db) return (da < db ? -1 : 1) * (pa ? -1 : 1);
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }

  function renderListCard() {
    const card = h('section', { class: 'card list-card', 'aria-busy': String(!state.weddings) });
    if (state.listError) card.append(h('p', { class: 'form-error-box', role: 'alert' }, errorText(state.listError)));
    if (!state.weddings) card.append(h('div', { class: 'spinner' }));
    else if (!state.weddings.length) card.append(h('p', { class: 'empty' }, t('admin.list.empty')));
    else card.append(h('ul', { class: 'wedding-list' }, sortWeddings(state.weddings).map(weddingRow)));
    return card;
  }

  function weddingRow(w) {
    return h('li', { class: 'wedding-row' + (isPast(w) ? ' is-past' : '') },
      h('div', { class: 'who' }, h('a', { href: '#/w/' + w.id }, w.couple || '—')),
      h('div', { class: 'actions' },
        copyButton(coupleLink(w.id)),
        h('a', { class: 'btn btn-primary btn-sm', href: '#/w/' + w.id }, t('admin.answersLink'))),
      h('div', { class: 'meta' },
        h('span', null, w.weddingDate ? W.fmtDate(w.weddingDate) : t('admin.noDate')),
        badge(w),
        w.updatedAt ? h('span', null, t('admin.col.updated') + ': ' + W.fmtDateTime(w.updatedAt)) : null,
        w.photoCount ? h('span', { title: t('admin.photos') }, '📷 ' + w.photoCount) : null));
  }

  /* ------------------------------------------------------------------ */
  /* Detail                                                              */
  /* ------------------------------------------------------------------ */

  function backLink() {
    return h('a', { class: 'back-link', href: '#/' }, t('admin.back'));
  }

  function syncListEntry(detail) {
    if (!state.weddings) return;
    const i = state.weddings.findIndex((x) => x.id === detail.id);
    if (i >= 0) state.weddings[i] = Object.assign({}, state.weddings[i], detail, { photoCount: detail.photos.length });
  }

  function renderDetail(id) {
    const w = state.details.get(id);
    if (!w) {
      app.replaceChildren(backLink(), h('div', { class: 'card message is-loading' }, h('div', { class: 'spinner' })));
      adminApi('adminGet', { id })
        .then((res) => {
          state.details.set(id, res.wedding);
          syncListEntry(res.wedding);
          if (location.hash === '#/w/' + id) route();
        })
        .catch((err) => {
          if (!state.password || location.hash !== '#/w/' + id) return;
          app.replaceChildren(backLink(), h('div', { class: 'card message' },
            h('p', null, err.code === 'not_found' ? t('ui.notFound.title') : errorText(err.code))));
        });
      return;
    }

    const head = state.editing === id ? editCard(w) : h('header', { class: 'detail-head' },
      h('h1', null, w.couple),
      h('div', { class: 'detail-meta' },
        h('span', null, w.weddingDate ? W.fmtDate(w.weddingDate) : t('admin.noDate')),
        w.venue ? h('span', null, w.venue) : null,
        w.contact ? h('span', null, w.contact) : null,
        h('span', null, t('admin.lang.' + (w.lang === 'en' ? 'en' : 'cs'))),
        badge(w)),
      h('div', { class: 'detail-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { state.editing = id; route(); } }, t('admin.edit')),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => window.print() }, t('admin.print')),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { state.details.delete(id); route(); } }, t('admin.refresh')),
        h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => deleteWedding(w) }, t('admin.delete'))));

    const when = (key) => (w[key] ? h('div', null, h('dt', null, t('admin.' + key)), h('dd', null, W.fmtDateTime(w[key]))) : null);
    const info = h('section', { class: 'card' },
      h('div', { class: 'no-print' }, h('p', { class: 'sub-label' }, t('admin.link')), linkRow(w.id)),
      h('dl', { class: 'timeline' }, when('createdAt'), when('openedAt'), when('updatedAt'), when('submittedAt')),
      w.note ? h('p', { class: 'note-box' }, w.note) : null);

    app.replaceChildren(backLink(), head, info, ...renderAnswers(w), renderAdminPhotos(w));
  }

  function editCard(w) {
    const d = { couple: w.couple, weddingDate: w.weddingDate, venue: w.venue, contact: w.contact, note: w.note, lang: w.lang === 'en' ? 'en' : 'cs' };
    const errorEl = h('p', { class: 'form-error-box', role: 'alert', hidden: true });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, t('admin.save'));
    return h('form', {
      class: 'card detail-edit',
      oninput: (e) => {
        if (e.target.name) d[e.target.name] = e.target.value;
      },
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        try {
          const res = await adminApi('adminUpdate', { id: w.id, wedding: d });
          state.details.set(w.id, res.wedding);
          syncListEntry(res.wedding);
          state.editing = null;
          route();
        } catch (err) {
          if (!state.password) return;
          errorEl.textContent = errorText(err.code);
          errorEl.hidden = false;
          save.disabled = false;
        }
      },
    },
      h('h2', null, t('admin.edit')),
      metaFields(d),
      errorEl,
      h('div', { class: 'detail-actions' },
        save,
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => { state.editing = null; route(); } }, t('admin.cancel'))));
  }

  function answerText(item, a) {
    const v = a[item.key];
    const option = (x) => (x === 'other' && a[item.other] ? t('o.' + item.key + '.other') + ': ' + a[item.other] : t('o.' + item.key + '.' + x));
    switch (item.type) {
      case 'yesno':
        return v === 'yes' || v === 'no' ? t('ui.' + v) : '';
      case 'radio':
        return typeof v === 'string' && v ? option(v) : '';
      case 'checkbox':
        return Array.isArray(v) && v.length ? v.map(option).join(', ') : '';
      default:
        return typeof v === 'string' ? v : '';
    }
  }

  function qa(question, answer) {
    return h('div', { class: 'qa' },
      h('dt', null, question),
      h('dd', { class: answer ? null : 'is-empty' }, answer || '—'));
  }

  function renderAnswers(w) {
    const a = w.answers || {};
    return W.FORM.map((section) => {
      const rows = [];
      section.items.forEach((item) => {
        if (item.type === 'photos' || !W.isVisible(item, a)) return;
        if (item.type === 'fields') item.fields.forEach((k) => rows.push(qa(t('q.' + k), typeof a[k] === 'string' ? a[k] : '')));
        else rows.push(qa(t('q.' + item.key), answerText(item, a)));
      });
      return h('section', { class: 'card answers-section' }, h('h2', null, t('s.' + section.id)), h('dl', { class: 'qa-list' }, rows));
    });
  }

  function renderAdminPhotos(w) {
    const photos = w.photos || [];
    return h('section', { class: 'card answers-section' },
      h('h2', null, t('admin.photos')),
      photos.length
        ? h('div', { class: 'admin-photos' }, photos.map((p) => adminPhotoTile(w.id, p)))
        : h('p', { class: 'muted' }, t('admin.noPhotos')));
  }

  function adminPhotoTile(weddingId, p) {
    const url = state.photoUrls.get(p.id);
    if (!url) loadAdminPhoto(weddingId, p);
    return h('a', {
      href: url || '#',
      target: '_blank',
      rel: 'noopener',
      dataset: { photo: p.id },
      onclick: (e) => {
        if (!state.photoUrls.get(p.id)) e.preventDefault();
      },
    }, h('figure', { class: 'photo' + (url ? '' : ' is-busy') },
      url ? h('img', { src: url, alt: p.name || '' }) : h('div', { class: 'photo-overlay' }, h('div', { class: 'spinner small' }))));
  }

  let photoQueue = Promise.resolve();
  function loadAdminPhoto(weddingId, p) {
    if (state.photoLoading.has(p.id)) return;
    state.photoLoading.add(p.id);
    photoQueue = photoQueue.then(async () => {
      try {
        const res = await W.api('getPhoto', { id: weddingId, photoId: p.id });
        const bin = atob(res.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        state.photoUrls.set(p.id, URL.createObjectURL(new Blob([bytes], { type: res.mimeType })));
        const old = document.querySelector('[data-photo="' + p.id + '"]');
        if (old) old.replaceWith(adminPhotoTile(weddingId, p));
      } catch (err) {
        /* leave the placeholder */
      } finally {
        state.photoLoading.delete(p.id);
      }
    });
  }

  async function deleteWedding(w) {
    if (!window.confirm(t('admin.deleteConfirm', { couple: w.couple }))) return;
    try {
      await adminApi('adminDelete', { id: w.id });
      state.details.delete(w.id);
      if (state.weddings) state.weddings = state.weddings.filter((x) => x.id !== w.id);
      location.hash = '#/';
    } catch (err) {
      if (state.password) window.alert(errorText(err.code));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  W.initChrome();
  W.initLang();
  W.onLangChange(route);
  document.getElementById('logoutBtn').addEventListener('click', () => signOut(null));
  window.addEventListener('hashchange', () => {
    const m = /^#\/w\/([a-z0-9]+)$/.exec(location.hash);
    if (m) state.details.delete(m[1]); // always show fresh answers when opening a wedding
    state.editing = null;
    route();
    window.scrollTo(0, 0);
  });
  route();
})();
