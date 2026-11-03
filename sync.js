/* SSL Staff - phone storage + upload engine. Used by the app page and by the background worker. */
var SSL_DB = 'ssl-staff', SSL_DBV = 1;
function sslDb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(SSL_DB, SSL_DBV);
    r.onupgradeneeded = function () {
      var db = r.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function sslTx(store, mode, fn) {
  return sslDb().then(function (db) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, mode), out;
      var r = fn(t.objectStore(store));
      if (r) r.onsuccess = function () { out = r.result; };
      t.oncomplete = function () { res(out); };
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error || new Error('Phone storage full')); };
    });
  });
}
function qAll() { return sslTx('queue', 'readonly', function (s) { return s.getAll(); }).then(function (a) { return (a || []).sort(function (x, y) { return x.seq - y.seq; }); }); }
function qPut(it) { return sslTx('queue', 'readwrite', function (s) { return s.put(it); }); }
function qDel(id) { return sslTx('queue', 'readwrite', function (s) { return s.delete(id); }); }
function metaGet(k) { return sslTx('meta', 'readonly', function (s) { return s.get(k); }); }
function metaSet(k, v) { return sslTx('meta', 'readwrite', function (s) { return s.put(v, k); }); }
function sslDay(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function newId() {
  var a = new Uint8Array(8); crypto.getRandomValues(a);
  return Date.now().toString(36) + '-' + Array.prototype.map.call(a, function (b) { return (b + 256).toString(16).slice(1); }).join('');
}
function netErr(m) { var e = new Error(m || 'No network - try again when you have signal.'); e.net = true; return e; }
function apiCall(url, fn, args, ms) {
  if (!url) return Promise.reject(netErr('App is not set up. Open the setup link from the office.'));
  var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var tm = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 30000);
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fn, args: args || [] }), redirect: 'follow', signal: ctl ? ctl.signal : undefined
  }).then(function (r) {
    clearTimeout(tm);
    if (!r.ok) throw netErr('Server not reachable (' + r.status + '). Will retry.');
    return r.json().catch(function () { throw netErr('Server not reachable. Will retry.'); });
  }, function () { clearTimeout(tm); throw netErr(); })
    .then(function (j) { if (!j.ok) { var e = new Error(j.error); e.server = true; throw e; } return j.result; });
}
// New login on this phone: give that person's waiting entries the fresh upload key
function qRetoken(email, token) {
  return qAll().then(function (a) {
    return Promise.all(a.filter(function (it) { return it.email === email && it.status === 'pending' && it.token !== token; })
      .map(function (it) { it.token = token; it.needLogin = false; return qPut(it); }));
  });
}
var sslSyncing = null;
function syncNow() {
  if (sslSyncing) return sslSyncing;
  sslSyncing = sslDoSync().then(function (r) { sslSyncing = null; return r; }, function (e) { sslSyncing = null; throw e; });
  return sslSyncing;
}
function sslDoSync() {
  return metaGet('api').then(function (url) {
    return qAll().then(function (items) {
      var i = 0, state = {}, offline = false;   // state[entryId] = 'done' | 'wait' | 'rejected'
      items.forEach(function (it) { if (it.kind === 'entry') state[it.id] = it.status === 'done' ? 'done' : it.status === 'rejected' ? 'rejected' : 'wait'; });
      function next() {
        if (i >= items.length || offline || !url) return finish();
        var it = items[i++];
        if (it.status !== 'pending') return next();
        if (it.kind === 'scan') {
          var st = state[it.entryId];
          if (st === 'rejected') { it.status = 'rejected'; it.error = 'The entry was not saved, so its scan was not uploaded.'; return qPut(it).then(next); }
          if (st === 'wait') return next();   // upload the entry first
        }
        var call = it.kind === 'entry'
          ? apiCall(url, 'submitQ', [it.token, { id: it.id, d: it.d, clientTime: it.clientTime }, Date.now()], 45000)
          : apiCall(url, 'scanQ', [it.token, it.entryId, it.b64, it.bill], 120000);
        return call.then(function (res) {
          // Uploaded: remove it from the phone. For entries only a small marker stays until midnight
          // (bill no. for the same-bill check) - store, amount, GPS and scan are deleted.
          if (it.kind === 'scan') return qDel(it.id).then(next);
          state[it.id] = 'done';
          var d = it.d || {};
          return qPut({ id: it.id, kind: 'entry', seq: it.seq, email: it.email, status: 'done', clientTime: it.clientTime, doneAt: Date.now(),
            d: { activeRole: d.activeRole, bill: d.bill || '' } }).then(next);
        }, function (e) {
          if (e.net) { offline = true; return finish(); }
          var m = String(e.message || '');
          it.tries = (it.tries || 0) + 1;
          if (/^RETRY/.test(m)) { it.error = 'Waiting to upload'; }
          else if (/^AUTH/.test(m)) { it.error = m.replace(/^AUTH: */, ''); it.needLogin = true; }
          else { it.status = 'rejected'; it.error = m; if (it.kind === 'entry') state[it.id] = 'rejected'; }
          return qPut(it).then(next);
        });
      }
      function finish() {
        return qAll().then(function (a) {
          var today = sslDay(Date.now()), dels = [], pending = 0, rejected = 0, login = 0;
          a.forEach(function (it) {
            // nothing from earlier days stays on the phone except items still waiting to upload
            if (it.status !== 'pending' && sslDay(it.clientTime || it.createdAt) !== today) dels.push(it.id);
            else if (it.status === 'done' && it.kind === 'scan') dels.push(it.id);
            else if (it.status === 'pending') { pending++; if (it.needLogin) login++; }
            else if (it.status === 'rejected') rejected++;
          });
          return Promise.all(dels.map(qDel)).then(function () { return { pending: pending, rejected: rejected, needLogin: login, offline: offline, noApi: !url }; });
        });
      }
      return next();
    });
  });
}
