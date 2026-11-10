'use strict';
/*
 * Minimal in-process fakes of the Google Apps Script services used by apps-script/Code.gs,
 * so the real backend code can run locally (dev server + tests). Only the calls Code.gs
 * makes are implemented. State is persisted to <dataDir>/state.json, photos to <dataDir>/drive/.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE_GS = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function createServices(dataDir, options = {}) {
  const initialMaxRows = options.initialMaxRows || 1000;
  const stateFile = path.join(dataDir, 'state.json');
  const filesDir = path.join(dataDir, 'drive');
  fs.mkdirSync(filesDir, { recursive: true });

  let state = { sheets: {}, properties: {}, folders: {}, files: {} };
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));

  const newId = () => crypto.randomBytes(12).toString('hex');
  const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.map((b) => b & 255)));
  const toSignedBytes = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b)); // Apps Script uses Java signed bytes

  /* ---------------- SpreadsheetApp ---------------- */
  class Range {
    constructor(sheet, row, col, numRows, numCols) {
      Object.assign(this, { sheet, row, col, numRows, numCols });
    }
    getValues() {
      const rows = this.sheet.data.rows;
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const src = rows[this.row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < this.numCols; c++) {
          const v = src[this.col - 1 + c];
          line.push(v === undefined ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    setValues(values) {
      if (values.length !== this.numRows || values.some((l) => l.length !== this.numCols)) {
        throw new Error(`The number of rows/columns in the data does not match the range (${this.numRows}x${this.numCols})`);
      }
      const rows = this.sheet.data.rows;
      values.forEach((line, r) => {
        const idx = this.row - 1 + r;
        while (rows.length <= idx) rows.push([]);
        line.forEach((v, c) => {
          // Like Sheets: a leading apostrophe forces text and is not part of the stored value.
          rows[idx][this.col - 1 + c] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
        });
      });
      return this;
    }
    setNumberFormat() {
      return this;
    }
  }

  class Sheet {
    constructor(name) {
      this.name = name;
      this.data = state.sheets[name];
    }
    getLastRow() {
      const rows = this.data.rows;
      for (let i = rows.length - 1; i >= 0; i--) {
        if ((rows[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
      }
      return 0;
    }
    getMaxRows() {
      return this.data.maxRows;
    }
    insertRowsAfter(after, count) {
      this.data.maxRows += count;
      return this;
    }
    getRange(row, col, numRows = 1, numCols = 1) {
      if (row < 1 || col < 1 || row + numRows - 1 > this.data.maxRows) {
        throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      }
      return new Range(this, row, col, numRows, numCols);
    }
    deleteRow(row) {
      this.data.rows.splice(row - 1, 1);
      this.data.maxRows -= 1;
      return this;
    }
    setFrozenRows() {
      return this;
    }
  }

  const spreadsheet = {
    getSheetByName: (name) => (state.sheets[name] ? new Sheet(name) : null),
    insertSheet: (name) => {
      state.sheets[name] = { rows: [], maxRows: initialMaxRows };
      return new Sheet(name);
    },
  };
  const SpreadsheetApp = { getActive: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet };

  /* ---------------- DriveApp ---------------- */
  class Blob {
    constructor(buffer, contentType, name) {
      Object.assign(this, { buffer, contentType, name });
    }
    getBytes() {
      return toSignedBytes(this.buffer);
    }
    getContentType() {
      return this.contentType;
    }
    getName() {
      return this.name;
    }
  }

  class File {
    constructor(id) {
      this.id = id;
    }
    getId() {
      return this.id;
    }
    getName() {
      return state.files[this.id].name;
    }
    getBlob() {
      const meta = state.files[this.id];
      return new Blob(fs.readFileSync(path.join(filesDir, this.id)), meta.mimeType, meta.name);
    }
    isTrashed() {
      return state.files[this.id].trashed;
    }
    setTrashed(trashed) {
      state.files[this.id].trashed = !!trashed;
      return this;
    }
  }

  class Folder {
    constructor(id) {
      this.id = id;
    }
    getId() {
      return this.id;
    }
    getName() {
      return state.folders[this.id].name;
    }
    isTrashed() {
      return state.folders[this.id].trashed;
    }
    setTrashed(trashed) {
      state.folders[this.id].trashed = !!trashed;
      return this;
    }
    createFolder(name) {
      const id = newId();
      state.folders[id] = { name, parent: this.id, trashed: false };
      return new Folder(id);
    }
    createFile(blob) {
      const id = newId();
      fs.writeFileSync(path.join(filesDir, id), blob.buffer);
      state.files[id] = { name: blob.name, mimeType: blob.contentType, folder: this.id, trashed: false };
      return new File(id);
    }
  }

  const DriveApp = {
    createFolder: (name) => {
      const id = newId();
      state.folders[id] = { name, parent: null, trashed: false };
      return new Folder(id);
    },
    getFolderById: (id) => {
      if (!state.folders[id]) throw new Error('No item with the given ID could be found.');
      return new Folder(id);
    },
    getFileById: (id) => {
      if (!state.files[id]) throw new Error('No item with the given ID could be found.');
      return new File(id);
    },
  };

  /* ---------------- Utilities & co. ---------------- */
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (algorithm, value) => toSignedBytes(crypto.createHash(algorithm).update(String(value), 'utf8').digest()),
    base64Encode: (bytes) => toBuffer(bytes).toString('base64'),
    base64Decode: (text) => toSignedBytes(Buffer.from(text, 'base64')),
    newBlob: (bytes, contentType, name) => new Blob(toBuffer(bytes), contentType, name),
  };

  const ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput: (content) => ({
      content,
      mimeType: 'TEXT',
      setMimeType(m) {
        this.mimeType = m;
        return this;
      },
      getContent() {
        return this.content;
      },
    }),
  };

  // Node runs one request at a time, so the lock always succeeds.
  const LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };

  const cache = new Map();
  const CacheService = {
    getScriptCache: () => ({
      get: (key) => {
        const hit = cache.get(key);
        if (!hit || hit.expires < Date.now()) return null;
        return hit.value;
      },
      put: (key, value, seconds = 600) => cache.set(key, { value: String(value), expires: Date.now() + seconds * 1000 }),
      remove: (key) => cache.delete(key),
    }),
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null),
      setProperty: (key, value) => {
        state.properties[key] = String(value);
      },
      deleteProperty: (key) => {
        delete state.properties[key];
      },
    }),
  };

  const Logger = { log: (...args) => console.log('[Logger]', ...args) };

  return {
    globals: { SpreadsheetApp, DriveApp, Utilities, ContentService, LockService, CacheService, PropertiesService, Logger, console },
    state: () => state,
    save,
    clearCache: () => cache.clear(),
  };
}

/** Loads apps-script/Code.gs into a sandbox wired to the fakes. */
function loadBackend(dataDir, options) {
  const services = createServices(dataDir, options);
  const context = vm.createContext({ ...services.globals });
  vm.runInContext(fs.readFileSync(CODE_GS, 'utf8'), context, { filename: 'Code.gs' });

  const run = (fn) => {
    try {
      return fn();
    } finally {
      services.save();
    }
  };
  return {
    doPost: (body) => run(() => context.doPost({ postData: { contents: body, type: 'text/plain' } }).getContent()),
    doGet: () => run(() => context.doGet({}).getContent()),
    call: (action, payload = {}) => JSON.parse(run(() => context.doPost({ postData: { contents: JSON.stringify({ action, ...payload }) } }).getContent())),
    runFunction: (name) => run(() => context[name]()),
    setProperty: (key, value) => run(() => services.globals.PropertiesService.getScriptProperties().setProperty(key, value)),
    services,
  };
}

module.exports = { loadBackend };
