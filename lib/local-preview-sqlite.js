'use strict';

// Disk-backed storage for the isolated local admin preview. Production keeps
// sql.js; this facade implements only the raw methods used by lib/db.js.
const { DatabaseSync } = require('node:sqlite');

module.exports = function openLocalPreview(file) {
  const native = new DatabaseSync(file);
  native.exec('PRAGMA busy_timeout=5000');
  function args(params) {
    if (Array.isArray(params)) return params.map(v => typeof v === 'boolean' ? Number(v) : v === undefined ? null : v);
    return [params];
  }
  return {
    isNativeLocalPreview: true,
    run(sql, params = []) {
      if (Array.isArray(params) && !params.length) native.exec(sql);
      else native.prepare(sql).run(...args(params));
      return this;
    },
    exec(sql) {
      const stmt = native.prepare(sql);
      const columns = stmt.columns().map(c => c.name);
      if (!columns.length) { stmt.run(); return []; }
      const rows = stmt.all();
      return rows.length ? [{ columns, values: rows.map(r => columns.map(c => r[c])) }] : [];
    },
    prepare(sql) {
      const stmt = native.prepare(sql);
      let iterator, current;
      return {
        bind(params = []) { iterator?.return?.(); iterator = stmt.iterate(...args(params)); },
        step() { if (!iterator) this.bind(); const next = iterator.next(); current = next.value; return !next.done; },
        getAsObject() { return { ...current }; },
        free() { iterator?.return?.(); iterator = null; current = null; },
      };
    },
    getRowsModified() { return native.prepare('SELECT changes() AS n').get().n; },
    close() { native.close(); },
  };
};
