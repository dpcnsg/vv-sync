/* victorview 밑줄펜 — 로그인 없이 책 PDF에 밑줄·메모를 남기고 한결에게 보낸다. */
(function () {
  'use strict';

  var PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var FORM_NAME = 'mitjul';
  var K = { name: 'mj:name', marks: 'mj:marks', guided: 'mj:guided', last: 'mj:last:', zoom: 'mj:zoom', review: 'mj:review', view: 'mj:view' };
  var MIN_ZOOM = 0.6, MAX_ZOOM = 4, MAX_RENDERED = 10, MAX_CANVAS_PX = 6e6;

  var $ = function (id) { return document.getElementById(id); };
  var BOOKS = (window.BOOKS && window.BOOKS.length) ? window.BOOKS : []; // 공개판은 빈 목록 → catalog.enc에서 채움
  var lib = window.pdfjsLib;

  /* ---------- 저장 (이 기기) ---------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('저장 공간이 모자라 저장하지 못했어요.'); return false; } }

  var marks = lsGet(K.marks, []);
  if (!Array.isArray(marks)) marks = [];
  function saveMarks() { lsSet(K.marks, marks); updateCounts(); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function bookById(id) { for (var i = 0; i < BOOKS.length; i++) if (BOOKS[i].id === id) return BOOKS[i]; return null; }
  function bookLabel(b) { return b ? b.id + ' ' + b.title : '일반'; } // 보내는 book 값: 번호 + 화면 제목 (시리즈·색 이름 없음)
  function bookShort(id) { var b = bookById(id); return b ? b.id + ' ' + b.title : (id === 'general' ? '일반 질문' : id); }
  // 표시 종류: text(밑줄) · hl(형광펜) · pen(펜 밑줄) · penhl(형광펜 펜) · q(질문)
  function isHl(m) { return m.kind === 'hl' || m.kind === 'penhl'; }
  function kindSend(m) { return m.kind === 'q' ? '질문' : isHl(m) ? '형광펜' : m.kind === 'pen' ? '펜' : '텍스트'; }
  function kindLabel(m) { return m.kind === 'q' ? '질문' : m.kind === 'hl' ? '형광펜' : m.kind === 'penhl' ? '형광펜(펜)' : m.kind === 'pen' ? '펜 밑줄' : '밑줄'; }
  function kindClass(m) { return m.kind === 'q' ? 'k-q' : isHl(m) ? 'k-hl' : 'k-line'; }
  function userName() { return ($('nameInput').value || '').trim() || '소란요요'; }

  /* ---------- 알림 ---------- */
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- 첫 화면 ---------- */
  function renderHome() {
    var ol = $('bookList'); var html = '';
    BOOKS.forEach(function (b) {
      var mine = marks.filter(function (m) { return m.book === b.id; });
      var unsent = mine.filter(function (m) { return !m.sent; }).length;
      var info = (b.series || '') + (mine.length ? (b.series ? ' · ' : '') + '표시 <span class="cnt">' + mine.length + '</span>' + (unsent ? ' (안 보냄 ' + unsent + ')' : '') : '');
      var rv = reviewLabel(b.id);
      html += '<li><a href="#b=' + b.id + '"><span class="no">' + b.id + '</span><span class="t"><b>' + esc(b.title) + '</b><small>' + info + '</small>' +
        allBookLine(b.id) + (rv ? '<small class="rv' + (/보냄\)$/.test(rv) && !/안 보냄/.test(rv) ? ' ok' : '') + '">' + rv + '</small>' : '') + '</span>' +
        '<span class="tag' + (b.status === '확정' ? ' done' : '') + '">' + b.status + '</span></a></li>';
    });
    ol.innerHTML = html;
    updateCounts();
  }
  function updateCounts() {
    $('homeCount').textContent = marks.length;
    var n = cur ? marks.filter(function (m) { return m.book === cur.book.id; }).length : 0;
    $('markCount').textContent = n;
  }

  var nameInput = $('nameInput');
  nameInput.value = lsGet(K.name, '소란요요') || '소란요요';
  nameInput.addEventListener('change', function () { lsSet(K.name, userName()); nameInput.value = userName(); toast('이름을 저장했어요.'); });

  /* ---------- 화면 이동 (주소 #b=03) ---------- */
  function route() {
    var m = /#b=(\d{2})/.exec(location.hash);
    var b = m && bookById(m[1]);
    closeAllSheets();
    if (b) { $('home').hidden = true; $('reader').hidden = false; if (!cur || cur.book.id !== b.id) openBook(b); }
    else { if (cur) closeBook(); $('reader').hidden = true; $('home').hidden = false; renderHome(); }
  }
  window.addEventListener('hashchange', route);
  $('backBtn').addEventListener('click', function () { if (history.length > 1 && /#b=/.test(location.hash)) history.back(); else location.hash = ''; });

  /* ---------- PDF.js 준비 (오프라인에서도 쓰도록 worker를 직접 받아 둔다) ---------- */
  var workerReady = null;
  function setupWorker() {
    if (workerReady) return workerReady;
    workerReady = fetch(PDFJS_BASE + 'pdf.worker.min.js').then(function (r) {
      if (!r.ok) throw new Error('worker ' + r.status);
      return r.text();
    }).then(function (src) {
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(url);
    }).catch(function () {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
    });
    return workerReady;
  }

  /* ---------- 책 잠금 (로그인 번호) ----------
     login.json: PBKDF2-SHA256(번호, 솔트, 600000회) → AES-GCM으로 검증용 암호문을 풀면 32바이트 책 열쇠(CK).
     bookNN.enc: "MJE1" + 책 솔트(16) + iv(12) + 암호문. 책 키 = HKDF-SHA256(CK, 책 솔트, "mitjul-book").
     CK는 IndexedDB에 꺼낼 수 없는(non-extractable) CryptoKey로 둔다. 안 되면 localStorage에 바이트로. */
  var LOCK = { meta: null, key: null };
  var subtle = window.crypto && window.crypto.subtle;
  var enc = new TextEncoder();
  function unb64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function tob64(buf) { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function lockError(msg) { var e = new Error('locked'); e.lock = true; e.msg = msg; return e; }

  function idb() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no idb'));
      var rq = indexedDB.open('mitjul', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('keys'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbDo(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('keys', mode), st = tx.objectStore('keys'), out = fn(st);
        tx.oncomplete = function () { db.close(); res(out && out.result); };
        tx.onerror = tx.onabort = function () { db.close(); rej(tx.error); };
      });
    });
  }
  function importCK(raw) { return subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']); }
  function saveKey(raw, key) {
    var ver = LOCK.meta.ver;
    return idbDo('readwrite', function (st) { return st.put({ ver: ver, key: key }, 'ck'); })
      .then(function () { try { localStorage.removeItem('mj:ck'); } catch (e) {} })
      .catch(function () { lsSet('mj:ck', { ver: ver, raw: tob64(raw) }); });
  }
  function restoreKey() {
    var ver = LOCK.meta.ver;
    return idbDo('readonly', function (st) { return st.get('ck'); }).catch(function () { return null; }).then(function (v) {
      if (v && v.ver === ver && v.key) return v.key;
      var l = lsGet('mj:ck', null);
      if (l && l.ver === ver && l.raw) return importCK(unb64(l.raw));
      return null;
    });
  }
  function forgetKey() {
    LOCK.key = null;
    try { localStorage.removeItem('mj:ck'); } catch (e) {}
    return idbDo('readwrite', function (st) { return st.delete('ck'); }).catch(function () {});
  }
  function loadMeta() {
    return fetch('books/login.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('login.json ' + r.status);
      return r.json();
    }).then(function (m) { LOCK.meta = m; return m; });
  }
  function tryPin(pin) {
    var m = LOCK.meta, k = m.kdf;
    return subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(k.salt), iterations: k.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    }).then(function (kek) {
      return subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.check.iv), additionalData: enc.encode('mitjul-check') }, kek, unb64(m.check.ct));
    }).then(function (raw) {
      return importCK(raw).then(function (key) { LOCK.key = key; return saveKey(raw, key); });
    });
  }
  function decryptBook(buf) {
    var u = new Uint8Array(buf);
    if (u.length < 48 || String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'MJE1') return Promise.reject(new Error('책 파일 형식이 달라요'));
    var salt = u.slice(4, 20), iv = u.slice(20, 32);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: enc.encode('mitjul-book') }, LOCK.key, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      .then(function (k) { return subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode('mitjul-book') }, k, u.subarray(32)); })
      .catch(function () { throw lockError('책 잠금이 바뀌었어요. 새 번호를 넣어 주세요.'); });
  }

  // 번호 화면
  var LOCKFAIL = 'mj:lockfail', lockTimer = 0;
  function showLock(msg) {
    $('lock').hidden = false;
    $('lockMsg').textContent = msg || '';
    $('lockInput').value = '';
    lockCountdown();
    setTimeout(function () { $('lockInput').focus(); }, 60);
  }
  function lockCountdown() {
    clearTimeout(lockTimer);
    var f = lsGet(LOCKFAIL, { n: 0, until: 0 }), left = Math.ceil(((f.until || 0) - Date.now()) / 1000);
    var wait = left > 0;
    $('lockBtn').disabled = wait; $('lockInput').disabled = wait;
    if (wait) { $('lockMsg').textContent = '5번 틀렸어요. ' + left + '초 뒤에 다시 넣어 주세요.'; lockTimer = setTimeout(lockCountdown, 1000); }
    else if (f.until) { lsSet(LOCKFAIL, { n: 0, until: 0 }); $('lockMsg').textContent = ''; $('lockInput').focus(); }
  }
  $('lockInput').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 8); });
  $('lockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('lockInput').value;
    if (!LOCK.meta) { $('lockMsg').textContent = '책 파일을 불러오지 못했어요. 인터넷을 확인해 주세요.'; initLock(); return; }
    if (!/^\d{8}$/.test(pin)) { $('lockMsg').textContent = '숫자 8자리를 넣어 주세요.'; return; }
    $('lockBtn').disabled = true; $('lockBtn').textContent = '확인하는 중…'; $('lockMsg').textContent = '';
    tryPin(pin).then(loadCatalog).then(function () {
      loadAll();
      lsSet(LOCKFAIL, { n: 0, until: 0 });
      $('lock').hidden = true; $('lockInput').value = '';
      toast('열렸어요. 이 기기에서는 다시 묻지 않아요.');
      if (cur) closeBook();
      route();
    }, function () {
      var f = lsGet(LOCKFAIL, { n: 0, until: 0 }); f.n = (f.n || 0) + 1;
      if (f.n >= 5) { f.n = 0; f.until = Date.now() + 30000; }
      lsSet(LOCKFAIL, f);
      $('lockInput').value = '';
      $('lockMsg').textContent = '번호가 맞지 않아요.' + (f.until ? '' : ' (' + f.n + '/5)');
      lockCountdown();
    }).then(function () { $('lockBtn').textContent = '열기'; if (!lsGet(LOCKFAIL, {}).until) { $('lockBtn').disabled = false; } });
  });
  $('relockBtn').addEventListener('click', function () {
    if (!confirm('이 기기에서 잠금을 다시 걸까요? 다음에 열 때 로그인 번호를 다시 물어요.')) return;
    forgetKey().then(function () { if (cur) closeBook(); location.hash = ''; if (!window.BOOKS || !window.BOOKS.length) BOOKS.length = 0; showLock('잠금을 다시 걸었어요.'); });
  });
  // 11/6: 공개 저장소에는 책 제목도 잠가 둔다(books/catalog.enc). 번호가 맞은 뒤에 풀어 BOOKS를 채운다.
  function loadCatalog() {
    if (BOOKS.length || !LOCK.key || !LOCK.meta) return Promise.resolve();
    return fetch('books/catalog.enc?v=' + encodeURIComponent(LOCK.meta.ver)).then(function (r) { if (!r.ok) throw new Error('catalog ' + r.status); return r.arrayBuffer(); })
      .then(function (b) { return decryptBlob(b, 'mitjul-catalog'); })
      .then(function (list) { if (Array.isArray(list)) list.forEach(function (x) { BOOKS.push(x); }); })
      .catch(function (e) { console.warn(e); });
  }
  function initLock() {
    if (!subtle) { route(); showLock('이 브라우저에서는 잠긴 책을 열 수 없어요. 크롬이나 사파리 최신판으로 열어 주세요.'); return Promise.resolve(); }
    return loadMeta().then(restoreKey).then(function (key) {
      LOCK.key = key || null;
      if (LOCK.key) { loadAll(); return loadCatalog().then(route); }
      route();
      showLock();
    }).catch(function (e) {
      console.warn(e);
      route();
      showLock('책 파일을 불러오지 못했어요. 인터넷을 확인한 뒤 다시 열어 주세요.');
    });
  }

  /* ---------- 읽기 ---------- */
  var cur = null; // { book, pdf, pages[], zoom, baseScale, textCache{}, ... }
  var scroller = $('scroller'), pagesEl = $('pages');

  function openBook(b) {
    if (cur) closeBook();
    if (!lib) { toast('읽기 도구를 불러오지 못했어요. 인터넷을 확인해 주세요.', 5000); return; }
    var token = {};
    cur = { book: b, token: token, pdf: null, pages: [], zoom: lsGet(K.zoom, 1) || 1, textCache: {}, rendered: [], queue: [], busy: false, hits: null };
    $('bookTitle').textContent = b.id + ' ' + b.title;
    $('bookSub').textContent = (b.series ? b.series + ' · ' : '') + b.status;
    $('loading').hidden = false; $('loading').textContent = '책을 펼치는 중…';
    pagesEl.innerHTML = ''; updateCounts();
    setupWorker().then(function () {
      if (!LOCK.key) throw lockError();
      return fetch(b.file + '?v=' + encodeURIComponent(LOCK.meta.ver));
    }).then(function (r) {
      if (!r.ok) throw new Error('책 파일 ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return decryptBook(buf); // 풀린 PDF는 메모리에만 (캐시·저장 안 함)
    }).then(function (buf) {
      return lib.getDocument({ data: new Uint8Array(buf), cMapUrl: PDFJS_BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS_BASE + 'standard_fonts/' }).promise;
    }).then(function (pdf) {
      if (!cur || cur.token !== token) { pdf.destroy(); return; }
      cur.pdf = pdf;
      var ps = [];
      for (var i = 1; i <= pdf.numPages; i++) ps.push(pdf.getPage(i).then(function (p) { var v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height, vp: v }; }));
      return Promise.all(ps).then(function (sizes) {
        if (!cur || cur.token !== token) return;
        buildPages(sizes);
        $('pageTotal').textContent = pdf.numPages;
        $('loading').hidden = true;
        var last = lsGet(K.last + b.id, 1);
        goToPage(Math.min(Math.max(1, last | 0), pdf.numPages), true);
        if (!lsGet(K.guided, false)) $('guide').hidden = false;
      });
    }).catch(function (e) {
      if (e && e.lock) { // 열쇠가 없거나 맞지 않음 → 번호 다시 묻기
        $('loading').textContent = '로그인 번호가 필요해요.';
        forgetKey().then(function () { showLock(e.msg || ''); });
        return;
      }
      console.warn(e);
      $('loading').textContent = '책을 열지 못했어요. 인터넷을 확인한 뒤 다시 열어 주세요.';
    });
  }

  function closeBook() {
    if (!cur) return;
    try { cur.pdf && cur.pdf.destroy(); } catch (e) {}
    cur = null; pagesEl.innerHTML = ''; setPen(false); hideSelBar(); updateReviewUI();
  }

  function fitScale(size) {
    if (isPaged()) { // 한 장씩: 쪽 전체가 화면에 꽉 차게 (가로·세로 중 작은 쪽에 맞춤)
      var aw = Math.min(scroller.clientWidth - 16, 1000), ah = scroller.clientHeight - 16;
      return Math.max(0.2, Math.min(aw / size.w, ah / size.h));
    }
    var avail = Math.min(scroller.clientWidth - 16, 880);
    return Math.max(0.2, avail / size.w);
  }

  function buildPages(sizes) {
    var frag = document.createDocumentFragment();
    cur.base = fitScale(sizes[0]);
    cur.pages = sizes.map(function (s, i) {
      var div = document.createElement('div');
      div.className = 'page'; div.dataset.page = i + 1;
      div.innerHTML = '<span class="num">' + (i + 1) + '</span>';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'marks');
      var pen = document.createElement('div'); pen.className = 'penLayer';
      div.appendChild(svg); div.appendChild(pen);
      frag.appendChild(div);
      bindPen(pen, i + 1);
      return { num: i + 1, size: s, div: div, svg: svg, canvas: null, textDiv: null, textDivs: [], renderedScale: 0, visible: false };
    });
    // 마지막 쪽 아래: 이 책 검토 끝 칸
    var end = document.createElement('div');
    end.className = 'endcard';
    end.innerHTML = '<p class="endtitle">책 끝까지 읽으셨어요.</p><p id="endReviewState" class="muted"></p>' +
      '<button id="endReviewBtn" class="btn primary wide" type="button">이 책 검토 끝</button>';
    frag.appendChild(end);
    pagesEl.appendChild(frag);
    $('endReviewBtn').addEventListener('click', toggleReview);
    updateReviewUI();
    layoutPages();
  }

  // 화면 근처(위아래 한 화면씩 여유) 쪽만 그린다 — 위치 계산으로 직접 판단
  function updateVisible() {
    if (!cur || !cur.pages.length) return;
    if (isPaged()) { // 지금 쪽과 앞뒤 한 쪽씩 미리 그려 둔다
      var c = cur.pi || 1;
      cur.pages.forEach(function (p) { p.visible = Math.abs(p.num - c) <= 1; });
      [c, c + 1, c - 1].forEach(function (n) { var p = cur.pages[n - 1]; if (p) enqueue(p); });
      return;
    }
    var h = scroller.clientHeight, top = scroller.scrollTop - h * 1.0, bottom = scroller.scrollTop + h * 2.0;
    cur.pages.forEach(function (p) {
      var y = p.div.offsetTop, vis = y + p.cssH > top && y < bottom;
      p.visible = vis;
      if (vis) enqueue(p);
    });
  }

  function scaleNow() { return cur.base * cur.zoom; }
  function layoutPages() {
    var sc = scaleNow();
    cur.pages.forEach(function (p) {
      var w = Math.floor(p.size.w * sc), h = Math.floor(p.size.h * sc);
      p.div.style.width = w + 'px'; p.div.style.height = h + 'px';
      p.div.style.setProperty('--scale-factor', sc);
      p.cssW = w; p.cssH = h;
      drawMarks(p);
    });
  }

  function enqueue(p) {
    if (p.renderedScale === scaleNow() || cur.queue.indexOf(p) >= 0) return;
    cur.queue.push(p); pump();
  }
  function pump() {
    if (!cur || cur.busy) return;
    var c = currentPage();
    cur.queue = cur.queue.filter(function (p) { return p.visible && p.renderedScale !== scaleNow(); });
    cur.queue.sort(function (a, b) { return Math.abs(a.num - c) - Math.abs(b.num - c); });
    var p = cur.queue.shift(); if (!p) return;
    cur.busy = true;
    var token = cur.token;
    renderPage(p).catch(function (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); })
      .then(function () { if (cur && cur.token === token) { cur.busy = false; pump(); } });
  }

  function renderPage(p) {
    var sc = scaleNow(), token = cur.token;
    return cur.pdf.getPage(p.num).then(function (page) {
      if (!cur || cur.token !== token) return;
      var vp = page.getViewport({ scale: sc });
      var dpr = window.devicePixelRatio || 1;
      var os = Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height)));
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * os); canvas.height = Math.floor(vp.height * os);
      var ctx = canvas.getContext('2d', { alpha: false });
      return page.render({ canvasContext: ctx, viewport: vp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : null }).promise.then(function () {
        if (!cur || cur.token !== token) return;
        if (p.canvas) p.canvas.remove();
        p.div.insertBefore(canvas, p.div.firstChild); p.canvas = canvas;
        return getText(p.num, page);
      }).then(function (tc) {
        if (!cur || cur.token !== token || !tc) return;
        if (p.textDiv) p.textDiv.remove();
        var td = document.createElement('div'); td.className = 'textLayer';
        td.style.setProperty('--scale-factor', vp.scale); // 그리는 동안 배율이 바뀌어도 글자 층은 이 배율에 맞춤
        p.div.insertBefore(td, p.svg);
        p.textDiv = td; p.textDivs = [];
        var task = lib.renderTextLayer({ textContentSource: tc, container: td, viewport: vp, textDivs: p.textDivs });
        return task.promise.then(function () {
          var end = document.createElement('div'); end.className = 'endOfContent'; td.appendChild(end);
          // 글자 칸(div) ↔ PDF 글자 조각(item) 짝 맞추기: 빈 조각이 끼어도 어긋나지 않게 글자로 맞춘다
          var its = tc.items, j = 0; p.divItem = p.textDivs.map(function (d) {
            var s = d.textContent, k = j;
            while (k < its.length && its[k].str !== s) k++;
            if (k < its.length) { j = k + 1; return k; }
            return -1;
          });
          p.textScale = vp.scale; p._lines = null;
          td.addEventListener('mousedown', function () { end.classList.add('active'); });
          p.renderedScale = sc;
          if (cur.rendered.indexOf(p) < 0) cur.rendered.push(p);
          trimRendered();
          applyHits(p);
          if (allOn()) drawMarks(p); // 모두의 밑줄: 글자 층이 생긴 뒤 글자 찾기로 자리 잡기
        });
      });
    });
  }
  document.addEventListener('mouseup', function () { document.querySelectorAll('.endOfContent.active').forEach(function (e) { e.classList.remove('active'); }); });

  function trimRendered() {
    if (cur.rendered.length <= MAX_RENDERED) return;
    var c = currentPage();
    cur.rendered.sort(function (a, b) { return Math.abs(b.num - c) - Math.abs(a.num - c); });
    while (cur.rendered.length > MAX_RENDERED) {
      var p = cur.rendered[0]; if (p.visible) break;
      cur.rendered.shift();
      if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
      if (p.textDiv) { p.textDiv.remove(); p.textDiv = null; p.textDivs = []; }
      p.renderedScale = 0;
    }
  }

  function getText(num, page) {
    if (cur.textCache[num]) return Promise.resolve(cur.textCache[num]);
    var pr = page ? Promise.resolve(page) : cur.pdf.getPage(num);
    return pr.then(function (pg) { return pg.getTextContent(); }).then(function (tc) { if (cur) cur.textCache[num] = tc; return tc; });
  }

  function rerenderAll() {
    layoutPages();
    updateVisible();
  }

  /* ---------- 지금 쪽 · 마지막 쪽 기억 ---------- */
  function currentPage() {
    if (!cur || !cur.pages.length) return 1;
    if (isPaged()) return cur.pi || 1;
    var mid = scroller.scrollTop + scroller.clientHeight * 0.35;
    var lo = 0, hi = cur.pages.length - 1;
    while (lo < hi) { var m = (lo + hi + 1) >> 1; if (cur.pages[m].div.offsetTop <= mid) lo = m; else hi = m - 1; }
    return lo + 1;
  }
  var scrollT = 0, lastSaveT;
  function onScrollTick() {
    scrollT = 0; if (!cur) return;
    var n = currentPage(); $('pageNow').textContent = n;
    updateVisible();
    clearTimeout(lastSaveT); lastSaveT = setTimeout(function () { if (cur) lsSet(K.last + cur.book.id, currentPage()); }, 400);
  }
  scroller.addEventListener('scroll', function () {
    if (!scrollT) scrollT = setTimeout(onScrollTick, 60);
  }, { passive: true });

  function goToPage(n, instant) {
    var p = cur && cur.pages[n - 1]; if (!p) return;
    if (isPaged()) { showPaged(n, instant); return; }
    var far = Math.abs(n - currentPage()) > 2; // 멀리 갈 때는 바로 (중간 쪽을 그리지 않게)
    scroller.scrollTo({ top: p.div.offsetTop - 8, behavior: instant || far ? 'auto' : 'smooth' });
    $('pageNow').textContent = n;
    lsSet(K.last + cur.book.id, n);
    updateVisible();
  }

  /* ---------- 한 장씩 보기 ---------- */
  function isPaged() { return document.body.classList.contains('paged'); }
  function showPaged(n, instant) {
    var old = cur.pi, p = cur.pages[n - 1];
    cur.pi = n;
    cur.pages.forEach(function (q) { q.div.classList.toggle('cur', q.num === n); });
    document.body.classList.toggle('lastpage', n === cur.pages.length);
    scroller.scrollTop = 0;
    scroller.scrollLeft = Math.max(0, (pagesEl.scrollWidth - scroller.clientWidth) / 2);
    if (!instant && old && old !== n) {
      p.div.classList.remove('turn-next', 'turn-prev'); void p.div.offsetWidth;
      p.div.classList.add(n > old ? 'turn-next' : 'turn-prev');
    }
    if (old !== n) { var s = window.getSelection(); if (s && !s.isCollapsed) s.removeAllRanges(); hideSelBar(); }
    $('pageNow').textContent = n;
    lsSet(K.last + cur.book.id, n);
    if (allOn()) drawMarks(p); // 숨어 있던 쪽은 보일 때 모두의 밑줄 자리를 잡는다
    $('prevBtn').disabled = n <= 1; $('nextBtn').disabled = n >= cur.pages.length;
    updateVisible();
  }
  function selectionActive() {
    if (pendingSel) return true;
    var s = window.getSelection();
    return !!(s && !s.isCollapsed && s.rangeCount && pagesEl.contains(s.getRangeAt(0).commonAncestorContainer));
  }
  function anySheetOpen() { return ['memoSheet', 'searchSheet', 'pageSheet', 'copySheet', 'askSheet', 'panel', 'guide', 'lock', 'allPanel', 'allPop', 'ansPanel'].some(function (id) { return $(id) && !$(id).hidden; }); }
  // 밀기·가장자리 누르기로 넘겨도 되는가: 글자 고르는 중, 펜, 확대 중, 창이 열렸을 때는 안 된다
  function canTurnGesture() {
    return cur && cur.pdf && isPaged() && !document.body.classList.contains('pen') && !selectionActive() && cur.zoom <= 1.001 && !anySheetOpen();
  }
  function turn(d) {
    if (!cur || !cur.pdf || !isPaged()) return;
    var n = currentPage() + d;
    if (n < 1) { toast('첫 쪽이에요.', 1200); return; }
    if (n > cur.pages.length) { toast('마지막 쪽이에요.', 1200); return; }
    goToPage(n, false);
  }
  function setView(mode, quiet) {
    var paged = mode !== 'scroll';
    var n = cur && cur.pdf ? currentPage() : 1;
    document.body.classList.toggle('paged', paged);
    if (!paged) document.body.classList.remove('lastpage');
    lsSet(K.view, paged ? 'paged' : 'scroll');
    $('viewBtn').querySelector('span').textContent = paged ? '한 장씩' : '이어서';
    $('viewBtn').setAttribute('aria-label', paged ? '지금 한 장씩 보기 (누르면 이어서 보기)' : '지금 이어서 보기 (누르면 한 장씩 보기)');
    if (cur && cur.pages.length) {
      cur.pi = n; cur.base = fitScale(cur.pages[0].size);
      rerenderAll(); goToPage(n, true);
    }
    if (!quiet) toast(paged ? '한 장씩 넘겨 봐요.' : '위아래로 이어서 봐요.', 1600);
  }
  $('viewBtn').addEventListener('click', function () { setView(isPaged() ? 'scroll' : 'paged'); });

  // 좌우로 밀기 (한 손가락, 짧고 가로로)
  var swipe = null;
  scroller.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, lx: e.touches[0].clientX, ly: e.touches[0].clientY, t: Date.now(), multi: false };
    else if (swipe) swipe.multi = true;
  }, { passive: true });
  scroller.addEventListener('touchmove', function (e) {
    if (swipe && e.touches.length === 1) { swipe.lx = e.touches[0].clientX; swipe.ly = e.touches[0].clientY; }
    else if (swipe) swipe.multi = true;
  }, { passive: true });
  scroller.addEventListener('touchcancel', function () { // 웹뷰가 제스처를 가져가도 마지막 위치로 판정
    var s = swipe; swipe = null; if (!s || s.multi || !canTurnGesture()) return;
    var dx = s.lx - s.x, dy = s.ly - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 700) { edgeCancel(); turn(dx < 0 ? 1 : -1); }
  });
  scroller.addEventListener('touchend', function (e) {
    var s = swipe; if (!s || e.touches.length) return; swipe = null;
    if (s.multi || !canTurnGesture()) return;
    var t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 700) { edgeCancel(); turn(dx < 0 ? 1 : -1); }
  });
  // 화면 좌우 가장자리(각 20%) 누르기 — 두 번 눌러 낱말 고르기와 겹치지 않게 조금 기다렸다 넘긴다
  var edgeT = 0;
  function edgeCancel() { clearTimeout(edgeT); edgeT = 0; }
  scroller.addEventListener('click', function (e) {
    if (!canTurnGesture() || e.detail > 1) { edgeCancel(); return; }
    if (e.target.closest && e.target.closest('.badge, .allmark, button, a, .endcard')) return;
    var r = scroller.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
    var d = x < 0.2 ? -1 : x > 0.8 ? 1 : 0; if (!d) return;
    edgeCancel();
    edgeT = setTimeout(function () { edgeT = 0; if (canTurnGesture()) turn(d); }, 260);
  });
  scroller.addEventListener('dblclick', edgeCancel);

  /* ---------- 확대·축소 ---------- */
  function setZoom(z, focusX, focusY) {
    if (!cur) return;
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - cur.zoom) < 0.001) return;
    var fx = focusX == null ? scroller.clientWidth / 2 : focusX, fy = focusY == null ? scroller.clientHeight / 2 : focusY;
    var oldH = pagesEl.scrollHeight, oldW = pagesEl.scrollWidth;
    var ry = (scroller.scrollTop + fy) / oldH, rx = (scroller.scrollLeft + fx) / oldW;
    cur.zoom = z; lsSet(K.zoom, z);
    document.body.classList.toggle('zoomed', z > 1.001);
    rerenderAll();
    scroller.scrollTop = ry * pagesEl.scrollHeight - fy;
    scroller.scrollLeft = rx * pagesEl.scrollWidth - fx;
    toast(Math.round(z * 100) + '%', 900);
  }
  $('zoomIn').addEventListener('click', function () { cur && setZoom(cur.zoom * 1.25); });
  $('zoomOut').addEventListener('click', function () { cur && setZoom(cur.zoom / 1.25); });
  scroller.addEventListener('wheel', function (e) {
    if (!e.ctrlKey || !cur) return;
    e.preventDefault();
    var r = scroller.getBoundingClientRect();
    setZoom(cur.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // 두 손가락 벌리기·오므리기
  var pinch = null;
  function tdist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
  scroller.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2 && cur) {
      var r = scroller.getBoundingClientRect();
      var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
      pinch = { d0: tdist(e.touches), s: 1, cx: cx, cy: cy, mx: cx, my: cy, pen: document.body.classList.contains('pen') };
      pagesEl.style.transformOrigin = (scroller.scrollLeft + cx) + 'px ' + (scroller.scrollTop + cy) + 'px';
    }
  }, { passive: true });
  scroller.addEventListener('touchmove', function (e) {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    var r = scroller.getBoundingClientRect();
    var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    if (pinch.pen) { // 펜 모드: 두 손가락으로 넘기기
      scroller.scrollTop -= (my - pinch.my); scroller.scrollLeft -= (mx - pinch.mx);
      pinch.mx = mx; pinch.my = my; return;
    }
    pinch.s = Math.min(MAX_ZOOM / cur.zoom, Math.max(MIN_ZOOM / cur.zoom, tdist(e.touches) / pinch.d0));
    pagesEl.style.transform = 'scale(' + pinch.s + ')';
  }, { passive: false });
  function endPinch() {
    if (!pinch) return;
    var p = pinch; pinch = null;
    pagesEl.style.transform = '';
    if (!p.pen && Math.abs(p.s - 1) > 0.02) setZoom(cur.zoom * p.s, p.cx, p.cy);
  }
  scroller.addEventListener('touchend', function (e) { if (e.touches.length < 2) endPinch(); });
  scroller.addEventListener('touchcancel', endPinch);
  window.addEventListener('resize', function () {
    if (!cur || !cur.pages.length) return;
    var n = currentPage(); cur.base = fitScale(cur.pages[0].size); rerenderAll(); goToPage(n, true);
  });

  /* ---------- 글자 줄 정보 (PDF 좌표) ----------
     밑줄 위치는 PDF 단위(배율 1, 쪽 왼쪽 위 기준)로 저장한다: lines = [[x1, x2, 글자 바닥선 y, 글자 높이], …]
     그래서 확대·축소·새로고침 뒤에도 같은 자리에 그려진다. 글자 바닥선은 PDF 글자 정보(transform)에서 바로 읽는다. */
  var UL_GAP = 0.11;   // 바닥선 아래로 글자 높이의 몇 배에 밑줄을 둘지 (한글 글자 바닥 바로 아래)
  var UL_PX = 1.3;     // 거기서 화면 픽셀로 조금 더
  var SVGNS = 'http://www.w3.org/2000/svg';

  function pageScale(p) { return p.cssW / p.size.w; }
  function itemBase(p, k) { // k번째 글자 조각의 바닥선 y, 글자 높이 (PDF 단위)
    var tc = cur.textCache[p.num], ii = p.divItem ? p.divItem[k] : k, it = tc && ii >= 0 && tc.items[ii];
    if (!it || !it.transform) return null;
    var t = it.transform, fh = Math.sqrt(t[2] * t[2] + t[3] * t[3]) || it.height || 10;
    var pt = p.size.vp ? p.size.vp.convertToViewportPoint(t[4], t[5]) : [t[4], p.size.h - t[5]];
    return { y: pt[1], fh: fh };
  }
  function textNodeOf(div) { var n = div && div.firstChild; return n && n.nodeType === 3 ? n : null; }
  function charSpanX(p, tn, s, e) { // 글자 s~e 의 실제 가로 경계 (PDF 단위)
    var r = document.createRange(); r.setStart(tn, s); r.setEnd(tn, e);
    var rs = r.getClientRects(), pr = p.div.getBoundingClientRect(), sc = p.textScale || (pr.width / p.size.w); // 글자 층을 그린 배율 기준
    var x1 = Infinity, x2 = -Infinity;
    for (var i = 0; i < rs.length; i++) { if (rs[i].width <= 0) continue; x1 = Math.min(x1, rs[i].left); x2 = Math.max(x2, rs[i].right); }
    if (x1 === Infinity) return null;
    return [(x1 - pr.left) / sc, (x2 - pr.left) / sc];
  }
  function groupLines(pieces) { // 같은 바닥선끼리 한 줄로
    pieces.sort(function (a, b) { return a.y - b.y || a.x1 - b.x1; });
    var lines = [];
    pieces.forEach(function (q) {
      var L = lines[lines.length - 1];
      if (L && Math.abs(L.y - q.y) < Math.max(L.fh, q.fh) * 0.35) {
        L.x1 = Math.min(L.x1, q.x1); L.x2 = Math.max(L.x2, q.x2); L.fh = Math.max(L.fh, q.fh); L.y = Math.max(L.y, q.y); L.parts.push(q);
      } else lines.push({ x1: q.x1, x2: q.x2, y: q.y, fh: q.fh, parts: [q] });
    });
    return lines;
  }
  function packLines(lines) { return lines.map(function (L) { return [+L.x1.toFixed(2), +L.x2.toFixed(2), +L.y.toFixed(2), +L.fh.toFixed(2)]; }); }

  // 선택 범위 → 쪽마다 글자 줄(정확한 글자 경계)
  function selLines(range) {
    var out = [];
    cur.pages.forEach(function (p) {
      if (!p.textDiv || !p.textDivs.length || !range.intersectsNode(p.textDiv)) return;
      var pieces = [];
      p.textDivs.forEach(function (div, k) {
        var tn = textNodeOf(div); if (!tn || !range.intersectsNode(div)) return;
        var txt = tn.data, s = range.startContainer === tn ? range.startOffset : 0, e = range.endContainer === tn ? range.endOffset : txt.length;
        if (range.comparePoint(tn, 0) > 0 && range.endContainer !== tn) return; // 범위 뒤
        while (s < e && /\s/.test(txt[s])) s++;
        while (e > s && /\s/.test(txt[e - 1])) e--;
        if (s >= e) return;
        var b = itemBase(p, k), xs = charSpanX(p, tn, s, e); if (!b || !xs) return;
        pieces.push({ k: k, s: s, e: e, x1: xs[0], x2: xs[1], y: b.y, fh: b.fh });
      });
      if (!pieces.length) return;
      var lines = groupLines(pieces);
      out.push({ page: p.num, lines: lines, anchors: pieces.map(function (q) { return [q.k, q.s, q.e]; }) });
    });
    return out;
  }

  // 쪽의 모든 글자 줄 (펜 맞추기용)
  function pageLines(p) {
    if (p._lines && p._linesFor === p.textDiv) return p._lines;
    var pieces = [];
    p.textDivs.forEach(function (div, k) {
      var tn = textNodeOf(div); if (!tn || !tn.data.trim()) return;
      var b = itemBase(p, k), xs = charSpanX(p, tn, 0, tn.data.length); if (!b || !xs) return;
      pieces.push({ k: k, x1: xs[0], x2: xs[1], y: b.y, fh: b.fh });
    });
    p._lines = groupLines(pieces); p._linesFor = p.textDiv;
    return p._lines;
  }
  // 펜 선 → 가장 가까운 글자 줄에 맞춘 곧은 밑줄 (동그라미 등은 null)
  function snapPen(p, pts, hl) { // hl: 형광펜 펜(글자 가운데를 문지름)
    if (!p.textDivs.length) return null;
    var W = p.size.w, H = p.size.h;
    var xs = pts.map(function (q) { return q[0] * W; }), ys = pts.map(function (q) { return q[1] * H; });
    var x1 = Math.min.apply(null, xs), x2 = Math.max.apply(null, xs), y1 = Math.min.apply(null, ys), y2 = Math.max.apply(null, ys);
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var lines = pageLines(p); if (!lines.length) return null;
    var best = null, bd = Infinity;
    lines.forEach(function (L) {
      if (L.x2 < x1 - L.fh || L.x1 > x2 + L.fh) return; // 가로로 겹치지 않는 줄
      var d = hl ? Math.abs(my - (L.y - L.fh * 0.4)) : Math.abs(my - (L.y + L.fh * 0.15));
      if (!hl && my < L.y - L.fh * 0.9) d += L.fh; // 밑줄 펜: 글자 위쪽보다 아래쪽을 우선
      if (d < bd) { bd = d; best = L; }
    });
    if (!best) return null;
    var fh = best.fh;
    var hMax = hl ? fh * 1.8 : fh * 1.3, ratio = hl ? 0.7 : 0.45;
    if ((y2 - y1) > hMax || (y2 - y1) > (x2 - x1) * ratio || bd > fh * 1.0) return null; // 줄에서 많이 벗어남 → 그대로 둔다
    var tol = fh * 0.25, pieces = [], text = '';
    best.parts.forEach(function (q) {
      var tn = textNodeOf(p.textDivs[q.k]); if (!tn) return;
      var s = -1, e = -1;
      for (var c = 0; c < tn.data.length; c++) {
        if (/\s/.test(tn.data[c])) continue;
        var cx = charSpanX(p, tn, c, c + 1); if (!cx) continue;
        var mid = (cx[0] + cx[1]) / 2;
        if (mid >= x1 - tol && mid <= x2 + tol) { if (s < 0) s = c; e = c + 1; }
      }
      if (s < 0) return;
      var sx = charSpanX(p, tn, s, e);
      pieces.push({ k: q.k, s: s, e: e, x1: sx[0], x2: sx[1], y: q.y, fh: q.fh });
      text += (text ? ' ' : '') + tn.data.slice(s, e);
    });
    if (!pieces.length) return null;
    var L = groupLines(pieces)[0];
    return { lines: [L], anchors: pieces.map(function (q) { return [q.k, q.s, q.e]; }), text: text.replace(/\s+/g, ' ').trim() };
  }

  /* ---------- 밑줄 그리기 ---------- */
  function lineSvg(L, sc, lw, opacity, fill) {
    var x1 = L[0] * sc, x2 = L[1] * sc, base = L[2] * sc, fh = L[3] * sc;
    var uy = base + fh * UL_GAP + UL_PX + lw / 2;
    var h = '';
    if (fill) h += '<rect x="' + x1.toFixed(1) + '" y="' + (base - fh * 0.86).toFixed(1) + '" width="' + (x2 - x1).toFixed(1) + '" height="' + (fh * (0.86 + UL_GAP) + UL_PX).toFixed(1) + '" fill="rgba(200,69,59,.09)"/>';
    h += '<line x1="' + x1.toFixed(1) + '" y1="' + uy.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + uy.toFixed(1) + '" stroke="#C8453B" stroke-width="' + lw.toFixed(2) + '" stroke-linecap="butt"' + (opacity ? ' opacity="' + opacity + '"' : '') + '/>';
    return h;
  }
  function hlSvg(L, sc, opacity) { // 형광펜: 고른 글자 높이 전체를 연노랑 띠로
    var x1 = L[0] * sc, x2 = L[1] * sc, base = L[2] * sc, fh = L[3] * sc, top = base - fh * 0.9;
    return '<rect class="hlr" x="' + (x1 - 0.5).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + (x2 - x1 + 1).toFixed(1) + '" height="' + (base + fh * UL_GAP + 1 - top).toFixed(1) + '" rx="1.5" fill="#FFD60A" opacity="' + (opacity || 0.42) + '"/>';
  }
  function lineWidth(p) { return Math.max(1.5, Math.min(2.6, p.cssW / 300)); }
  function drawMarks(p) {
    var svg = p.svg, W = p.cssW, H = p.cssH;
    if (!W) return;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var html = '', sc = pageScale(p), lw = lineWidth(p);
    marks.forEach(function (m) {
      if (!cur || m.book !== cur.book.id || m.page !== p.num) return;
      var end = null;
      if (m.lines && m.lines.length) { // 정확한 글자 줄 (새 방식)
        m.lines.forEach(function (L) { html += isHl(m) ? hlSvg(L, sc) : lineSvg(L, sc, lw, 0, true); end = [L[1] * sc, (L[2] - L[3] * 0.86) * sc]; });
      } else if (m.kind === 'text' && m.rects) { // 예전 방식(쪽 비율 칸) — 이미 그은 밑줄도 그대로 보이게
        m.rects.forEach(function (r) {
          var x = r[0] * W, y = r[1] * H, w = r[2] * W, h = r[3] * H;
          html += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="rgba(200,69,59,.10)"/>';
          var ly = (y + h + lw * 0.3).toFixed(1);
          html += '<line x1="' + x.toFixed(1) + '" y1="' + ly + '" x2="' + (x + w).toFixed(1) + '" y2="' + ly + '" stroke="#C8453B" stroke-width="' + lw.toFixed(2) + '" stroke-linecap="round"/>';
          end = [x + w, y];
        });
      } else if ((m.kind === 'pen' || m.kind === 'penhl') && m.path) {
        var pts = m.path.map(function (q) { return (q[0] * W).toFixed(1) + ',' + (q[1] * H).toFixed(1); }).join(' ');
        if (m.kind === 'penhl') html += '<polyline points="' + pts + '" fill="none" stroke="#FFD60A" stroke-width="' + (11 * sc).toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round" opacity=".42"/>';
        else html += '<polyline points="' + pts + '" fill="none" stroke="#C8453B" stroke-width="' + (lw * 1.3).toFixed(2) + '" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>';
        var mx = -1, my = 0; m.path.forEach(function (q) { if (q[0] > mx) { mx = q[0]; my = q[1]; } });
        end = [mx * W, my * H];
      }
      if (end) {
        var bx = Math.min(W - 10, end[0] + 5), by = Math.max(10, end[1] - 2);
        html += '<g class="badge" data-id="' + m.id + '"><circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="13" fill="transparent"/>' +
          '<circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="' + (m.memo ? 6 : 4) + '" fill="' + (m.memo ? '#C8453B' : '#fff') + '" stroke="#C8453B" stroke-width="1.5"/></g>';
      }
    });
    if (allOn()) html += allMarksSvg(p);
    svg.innerHTML = html;
    drawPreview(p);
  }
  // 미리보기도 PDF 좌표로 들고 있다가 배율이 바뀌면 다시 그린다. kind: 'sel'(고르는 중) | 'pen'(펜 맞춤)
  function setPreview(p, lines, kind) { p.preview = lines && lines.length ? { lines: lines, kind: kind } : null; drawPreview(p); }
  function drawPreview(p) {
    var g = p.svg.querySelector('g.pv'); if (g) g.remove();
    if (!p.preview || !p.cssW) return;
    var sc = pageScale(p), lw = lineWidth(p), k = p.preview.kind;
    p.svg.insertAdjacentHTML('beforeend', '<g class="pv">' + p.preview.lines.map(function (L) {
      return k === 'penhl' ? hlSvg(L, sc, 0.25) : lineSvg(L, sc, k === 'pen' ? lw * 1.6 : lw, k === 'pen' ? 0.35 : 0.85, false);
    }).join('') + '</g>');
  }
  function clearPreviews() { if (cur) cur.pages.forEach(function (p) { if (p.preview) setPreview(p, null); }); }
  function redrawPage(num) { var p = cur && cur.pages[num - 1]; if (p) drawMarks(p); }
  pagesEl.addEventListener('click', function (e) {
    var g = e.target.closest && e.target.closest('.badge');
    if (g) { var m = findMark(g.getAttribute('data-id')); if (m) openMemo(m, false); return; }
    // 11/6 시장: 형광펜·밑줄 자체를 눌러도 메모 칸(고치기·지우기)이 열리게. 글자를 고르는 중이면 건드리지 않는다.
    if (!cur || document.body.classList.contains('pen') || selectionActive()) return;
    var pd = e.target.closest && e.target.closest('.page'); if (!pd) return;
    var p = null; cur.pages.forEach(function (q) { if (q.div === pd) p = q; }); if (!p || !p.cssW) return;
    var sc = pageScale(p), hit = null, x, y, ctm = p.svg.getScreenCTM && p.svg.getScreenCTM();
    if (ctm) { var pt = p.svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; pt = pt.matrixTransform(ctm.inverse()); x = pt.x; y = pt.y; } // 표시와 같은 좌표(svg viewBox)로
    else { var r = pd.getBoundingClientRect(); x = e.clientX - r.left; y = e.clientY - r.top; }
    marks.forEach(function (m) {
      if (hit || m.book !== cur.book.id || m.page !== p.num || !m.lines) return;
      m.lines.forEach(function (L) {
        var x1 = L[0] * sc, x2 = L[1] * sc, base = L[2] * sc, fh = L[3] * sc;
        if (x >= x1 - 4 && x <= x2 + 4 && y >= base - fh - 4 && y <= base + fh * 0.5 + 6) hit = m;
      });
    });
    if (hit) openMemo(hit, false);
  });
  function findMark(id) { for (var i = 0; i < marks.length; i++) if (marks[i].id === id) return marks[i]; return null; }

  /* ---------- 글자 고르기 → 밑줄 (고르는 동안 글자 바로 밑에 미리보기) ---------- */
  var pendingSel = null, selT, lastRange = null, barTouchUntil = 0;
  document.addEventListener('selectionchange', function () {
    if (!cur || document.body.classList.contains('pen')) return;
    livePreview();                                    // 바로 따라 그리기
    clearTimeout(selT); selT = setTimeout(checkSelection, 160);
  });
  function currentRange() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    return pagesEl.contains(r.commonAncestorContainer) ? r : null;
  }
  function livePreview() {
    var r = currentRange();
    clearPreviews();
    if (!r) return;
    selLines(r).forEach(function (g) {
      setPreview(cur.pages[g.page - 1], packLines(g.lines), 'sel');
    });
  }
  function checkSelection() {
    if (!cur || document.body.classList.contains('pen')) return;
    var range = currentRange();
    if (!range) { if (Date.now() < barTouchUntil && pendingSel) return; hideSelBar(); return; }
    var text = window.getSelection().toString().replace(/\s+/g, ' ').trim();
    var groups = selLines(range);
    if (!text || !groups.length) { hideSelBar(); return; }
    lastRange = range.cloneRange();
    pendingSel = { text: text, groups: groups };
    $('selPreview').textContent = '“' + (text.length > 80 ? text.slice(0, 80) + '…' : text) + '”';
    $('selBar').hidden = false; $('tools').style.visibility = 'hidden';
  }
  function hideSelBar() { pendingSel = null; lastRange = null; $('selBar').hidden = true; $('tools').style.visibility = ''; clearPreviews(); }

  // 앞·뒤 한 글자씩 늘리고 줄이기
  function allTextNodes() {
    var list = [];
    cur.pages.forEach(function (p) { p.textDivs.forEach(function (d) { var tn = textNodeOf(d); if (tn && tn.data.length) list.push(tn); }); });
    return list;
  }
  function stepPoint(list, node, off, dir) {
    var i = list.indexOf(node);
    if (i < 0) return [node, off];
    for (;;) {
      off += dir;
      if (off < 0) { if (i === 0) return [node, 0]; node = list[--i]; off = node.data.length; continue; }
      if (off > node.data.length) { if (i === list.length - 1) return [node, node.data.length]; node = list[++i]; off = 0; continue; }
      var ch = dir > 0 ? node.data[off - 1] : node.data[off];
      if (ch !== undefined && /\s/.test(ch)) continue; // 빈칸은 건너뛰어 글자 단위로
      return [node, off];
    }
  }
  function normPoint(list, r, which) {
    var c = which === 's' ? r.startContainer : r.endContainer, o = which === 's' ? r.startOffset : r.endOffset;
    if (c.nodeType === 3 && list.indexOf(c) >= 0) return [c, o];
    var hit = list.filter(function (tn) { return r.intersectsNode(tn); });
    if (!hit.length) return null;
    return which === 's' ? [hit[0], 0] : [hit[hit.length - 1], hit[hit.length - 1].data.length];
  }
  function adjustSel(which, dir) {
    var r = currentRange() || lastRange; if (!r || !cur) return;
    var list = allTextNodes(), s = normPoint(list, r, 's'), e = normPoint(list, r, 'e'); if (!s || !e) return;
    if (which === 's') s = stepPoint(list, s[0], s[1], dir); else e = stepPoint(list, e[0], e[1], dir);
    var nr = document.createRange();
    try { nr.setStart(s[0], s[1]); nr.setEnd(e[0], e[1]); } catch (x) { return; }
    if (nr.collapsed) return;
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(nr);
    lastRange = nr.cloneRange();
    livePreview(); checkSelection();
  }
  $('selBar').addEventListener('pointerdown', function () { barTouchUntil = Date.now() + 800; });
  document.querySelectorAll('#selBar [data-adj]').forEach(function (b) {
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () { var a = b.getAttribute('data-adj'); adjustSel(a[0], a[1] === '+' ? 1 : -1); });
  });

  // how: 'line'(밑줄) | 'hl'(형광펜) | 'memo'(밑줄 + 메모 쓰기)
  function addTextMarks(how) {
    if (!pendingSel || !cur) return;
    var made = [];
    pendingSel.groups.forEach(function (g) {
      var m = { id: uid(), book: cur.book.id, page: g.page, kind: how === 'hl' ? 'hl' : 'text', text: pendingSel.text, memo: '', lines: packLines(g.lines), anchors: g.anchors, created: new Date().toISOString(), sent: false };
      marks.push(m); made.push(m);
    });
    saveMarks();
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideSelBar();
    made.forEach(function (m) { redrawPage(m.page); });
    if (how === 'memo' && made[0]) openMemo(made[0], true);
    else toast(!made.length ? '다시 골라 주세요.' : how === 'hl' ? '형광펜을 칠했어요.' : '밑줄을 그었어요.');
  }
  $('selLine').addEventListener('click', function () { addTextMarks('line'); });
  $('selHl').addEventListener('click', function () { addTextMarks('hl'); });
  $('selMemo').addEventListener('click', function () { addTextMarks('memo'); });
  $('selCancel').addEventListener('click', function () { var s = window.getSelection(); if (s) s.removeAllRanges(); hideSelBar(); });
  // 단추를 눌러도 선택이 풀리지 않게
  ['selLine', 'selHl', 'selMemo', 'selCancel'].forEach(function (id) { $(id).addEventListener('mousedown', function (e) { e.preventDefault(); }); });

  /* ---------- 펜 모드 (손을 떼면 가장 가까운 글자 줄에 곧게 맞춤) ---------- */
  var penMode = 'line'; // 'line'(밑줄 펜) | 'hl'(형광펜 펜)
  function setPen(on, mode) {
    if (mode) penMode = mode;
    document.body.classList.toggle('pen', on);
    $('penBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('penBtn').querySelector('span').textContent = on ? '펜 끄기' : '펜';
    $('penBar').hidden = !on;
    $('penLine').classList.toggle('on', penMode === 'line'); $('penHl').classList.toggle('on', penMode === 'hl');
    $('penHint').textContent = penMode === 'hl' ? '글자 위를 문지르면 그 줄 글자 높이에 맞춰 칠해요. 두 손가락으로 넘겨요.' : '글자 밑을 그으면 그 줄에 맞춰 곧게 바로잡아요. 두 손가락으로 넘겨요.';
    if (on) { hideSelBar(); var s = window.getSelection(); if (s) s.removeAllRanges(); }
  }
  $('penBtn').addEventListener('click', function () { setPen(!document.body.classList.contains('pen')); });
  $('penLine').addEventListener('click', function () { setPen(true, 'line'); });
  $('penHl').addEventListener('click', function () { setPen(true, 'hl'); });
  $('penOff').addEventListener('click', function () { setPen(false); });

  function bindPen(layer, num) {
    var stroke = null, snapT = 0;
    layer.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' && !e.isPrimary) { cancel(); return; }
      if (e.button > 0) return;
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch (x) {}
      var r = layer.getBoundingClientRect(), hl = penMode === 'hl';
      stroke = { id: e.pointerId, r: r, hl: hl, pts: [[(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]], el: null };
      var p = cur.pages[num - 1];
      stroke.el = document.createElementNS(SVGNS, 'polyline');
      stroke.el.setAttribute('fill', 'none'); stroke.el.setAttribute('stroke', hl ? '#FFD60A' : '#C8453B');
      stroke.el.setAttribute('stroke-width', hl ? (11 * pageScale(p)).toFixed(1) : Math.max(2, Math.min(3.6, p.cssW / 216)));
      stroke.el.setAttribute('stroke-linecap', 'round'); stroke.el.setAttribute('stroke-linejoin', 'round');
      stroke.el.setAttribute('opacity', hl ? '.35' : '.55');
      p.svg.appendChild(stroke.el);
    });
    layer.addEventListener('pointermove', function (e) {
      if (!stroke || e.pointerId !== stroke.id) return;
      var r = stroke.r, evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (!evs.length) evs = [e];
      evs.forEach(function (ev) {
        var q = [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height];
        var l = stroke.pts[stroke.pts.length - 1];
        if (Math.abs(q[0] - l[0]) * r.width + Math.abs(q[1] - l[1]) * r.height >= 1.5) stroke.pts.push(q);
      });
      stroke.el.setAttribute('points', stroke.pts.map(function (q) { return (q[0] * r.width).toFixed(1) + ',' + (q[1] * r.height).toFixed(1); }).join(' '));
      var now = Date.now();
      if (now - snapT > 60 && stroke.pts.length > 2) { // 맞춰질 줄을 옅게 미리 보기
        snapT = now;
        var p = cur.pages[num - 1], sn = snapPen(p, stroke.pts, stroke.hl);
        setPreview(p, sn ? packLines(sn.lines) : null, stroke.hl ? 'penhl' : 'pen');
        if (stroke.el.parentNode !== p.svg) p.svg.appendChild(stroke.el);
      }
    });
    function cancel() { if (stroke && stroke.el) stroke.el.remove(); stroke = null; var p = cur && cur.pages[num - 1]; if (p) setPreview(p, null); }
    layer.addEventListener('pointercancel', cancel);
    layer.addEventListener('pointerup', function (e) {
      if (!stroke || e.pointerId !== stroke.id) return;
      var s = stroke; stroke = null; s.el.remove();
      var p = cur.pages[num - 1]; setPreview(p, null);
      var xs = s.pts.map(function (q) { return q[0]; }), ys = s.pts.map(function (q) { return q[1]; });
      var bw = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * s.r.width, bh = (Math.max.apply(null, ys) - Math.min.apply(null, ys)) * s.r.height;
      if (s.pts.length < 3 || Math.max(bw, bh) < 12) return; // 톡 친 것은 무시
      var path = simplify(s.pts, 0.0015).map(function (q) { return [+q[0].toFixed(4), +q[1].toFixed(4)]; });
      var sn = snapPen(p, s.pts, s.hl);
      var m = { id: uid(), book: cur.book.id, page: num, kind: s.hl ? 'penhl' : 'pen', memo: '', path: path, created: new Date().toISOString(), sent: false };
      if (sn) { m.lines = packLines(sn.lines); m.anchors = sn.anchors; m.text = sn.text; m.snapped = true; }
      else m.text = textUnderPen(num, s.pts);
      marks.push(m); saveMarks(); redrawPage(num);
      openMemo(m, true);
    });
  }
  // 점 줄이기 (Ramer–Douglas–Peucker)
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    var a = pts[0], b = pts[pts.length - 1], idx = 0, dmax = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = segDist(pts[i], a, b); if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) { var l = simplify(pts.slice(0, idx + 1), eps), r = simplify(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    var x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1]; return Math.sqrt(x * x + y * y);
  }
  // 줄에 맞추지 못한 펜 표시(동그라미 등): 그 안의 글자를 찾아 함께 적기
  function textUnderPen(num, pts) {
    var p = cur.pages[num - 1]; if (!p || !p.textDivs.length) return '';
    var pr = p.div.getBoundingClientRect();
    var xs = pts.map(function (q) { return q[0] * pr.width; }), ys = pts.map(function (q) { return q[1] * pr.height; });
    var x1 = Math.min.apply(null, xs), x2 = Math.max.apply(null, xs), y1 = Math.min.apply(null, ys), y2 = Math.max.apply(null, ys);
    var parts = [];
    p.textDivs.forEach(function (d) {
      var r = d.getBoundingClientRect(); if (!r.width) return;
      var cx = r.left - pr.left + r.width / 2, cy = r.top - pr.top + r.height / 2;
      var ox = Math.min(x2, r.right - pr.left) - Math.max(x1, r.left - pr.left);
      if (cy >= y1 && cy <= y2 && ox > Math.min(r.width * 0.3, 8)) parts.push(d.textContent);
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  /* ---------- 메모 칸 ---------- */
  var memoTarget = null;
  function openMemo(m, isNew) {
    memoTarget = m;
    $('memoTitle').textContent = isNew ? (isHl(m) ? '형광펜을 칠했어요' : m.kind === 'pen' ? '펜으로 표시했어요' : '밑줄을 그었어요') : bookShort(m.book) + ' · ' + m.page + '쪽 · ' + kindLabel(m);
    $('memoQuote').textContent = m.text || '(펜 표시 — 글자를 찾지 못했어요)';
    $('memoText').value = m.memo || '';
    $('memoSkip').textContent = isNew ? '메모 없이' : '닫기';
    $('memoDelete').hidden = false;
    $('memoSheet').hidden = false;
    setTimeout(function () { $('memoText').focus(); }, 60);
  }
  $('memoSave').addEventListener('click', function () {
    if (!memoTarget) return;
    var v = $('memoText').value.trim();
    if (v !== (memoTarget.memo || '')) { memoTarget.memo = v; if (memoTarget.sent) { memoTarget.sent = false; memoTarget.edited = true; } }
    saveMarks(); if (cur) redrawPage(memoTarget.page);
    $('memoSheet').hidden = true; memoTarget = null; renderPanel(); toast('저장했어요.');
  });
  $('memoSkip').addEventListener('click', function () { $('memoSheet').hidden = true; memoTarget = null; });
  $('memoDelete').addEventListener('click', function () {
    if (!memoTarget) return;
    if (!confirm(isHl(memoTarget) ? '이 형광펜을 지울까요?' : '이 밑줄을 지울까요?')) return;
    deleteMark(memoTarget.id); $('memoSheet').hidden = true; memoTarget = null;
  });
  function deleteMark(id) {
    var m = findMark(id); if (!m) return;
    marks = marks.filter(function (x) { return x.id !== id; });
    saveMarks(); if (cur && m.book === cur.book.id) redrawPage(m.page);
    renderPanel(); toast('지웠어요.');
  }

  /* ---------- 내 밑줄 목록 ---------- */
  var filterAll = false;
  function openPanel(all) {
    filterAll = all || !cur;
    $('fltBook').disabled = !cur;
    renderPanel(); $('panel').hidden = false;
  }
  // 보낸 기록을 작게: '11:34 보냄' / '11:34 실패(429)' / '11:34 카톡'
  function sendLogLabel(m) {
    var l = m.sendLog && m.sendLog[m.sendLog.length - 1]; if (!l) return '';
    var d = new Date(l.at), hm = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    var what = l.code === 'kakao' ? '카톡' : okCode(l.code) ? '보냄' : '실패(' + (l.code || '연결 안 됨') + ')';
    return '<small class="slog' + (l.code !== 'kakao' && !okCode(l.code) ? ' bad' : '') + '">' + hm + ' ' + what + (m.sendLog.length > 1 ? ' · ' + m.sendLog.length + '번째' : '') + '</small>';
  }
  function renderPanel() {
    $('fltBook').classList.toggle('on', !filterAll); $('fltAll').classList.toggle('on', filterAll);
    var list = marks.filter(function (m) { return filterAll || (cur && m.book === cur.book.id); });
    list.sort(function (a, b) { return a.book.localeCompare(b.book) || a.page - b.page || (a.created < b.created ? -1 : 1); });
    var ul = $('markList');
    if (!list.length) ul.innerHTML = '<li class="empty">아직 밑줄이 없어요.<br>글자를 길게 눌러 골라 보세요.</li>';
    else ul.innerHTML = list.map(function (m) {
      var q = m.kind === 'q', gen = m.book === 'general';
      var where = q && !m.page ? (gen ? '' : '책 전체') : m.page + '쪽';
      var body = q ? '<p class="q qq">(밑줄 없음)</p>' : '<p class="q' + (isHl(m) ? ' hlq' : '') + '">' + esc(m.text || '(펜 표시)') + '</p>';
      return '<li data-id="' + m.id + '"><div class="meta">' + (filterAll || gen ? '<b>' + esc(bookShort(m.book)) + '</b>' : '') +
        (where ? '<span>' + where + '</span>' : '') + '<span class="kind ' + kindClass(m) + '">' + kindLabel(m) + '</span>' +
        '<span class="st ' + (m.sent ? 'sent">' + (m.sentVia === 'kakao' ? '카톡 보냄' : '보냄') : 'unsent">안 보냄') + '</span>' + sendLogLabel(m) + '</div>' +
        body + (m.memo ? '<p class="m">' + esc(m.memo) + '</p>' : '') +
        '<div class="acts">' + (gen ? '' : '<button class="btn" data-act="go" type="button">그 쪽으로</button>') + '<button class="btn" data-act="edit" type="button">고치기</button><button class="btn" data-act="resend" type="button">' + (m.sent ? '다시 보내기' : '보내기') + '</button><button class="btn danger" data-act="del" type="button">지우기</button></div></li>';
    }).join('');
    var unsentM = marks.filter(function (m) { return !m.sent; }).length, unsentS = pendingSignals().length, unsent = unsentM + unsentS;
    $('unsentInfo').textContent = unsent ? '아직 안 보낸 표시 ' + unsentM + '개' + (unsentS ? ', 검토 신호 ' + unsentS + '개' : '') + ' (모든 책)' : '모두 보냈어요.';
    updateReviewUI();
    $('sendBtn').disabled = !unsent; $('copyBtn').disabled = !unsent;
  }
  $('markList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]'); if (!btn) return;
    var id = btn.closest('li').getAttribute('data-id'), m = findMark(id); if (!m) return;
    var act = btn.getAttribute('data-act');
    if (act === 'del') { if (confirm(m.kind === 'q' ? '이 질문을 지울까요?' : '이 표시를 지울까요?')) deleteMark(id); }
    else if (act === 'resend') {
      if (sending) return;
      btn.disabled = true; btn.textContent = '보내는 중…';
      var wasSent = m.sent;
      sendQueue(function (res) { // '보냄'인 항목도 다시 보낼 수 있다
        if (res.ok) toast('보냈어요.', 2000);
        else if (wasSent) toast('다시 보내지 못했어요 (응답 ' + (res.codes[0] || '없음') + '). 앞서 보낸 기록은 그대로예요.', 4500);
        else sendResultToast(res);
      }, [m]);
    }
    else if (act === 'edit') { if (m.kind === 'q') openAsk(m); else openMemo(m, false); }
    else if (act === 'go') {
      $('panel').hidden = true;
      var pg = m.page || 1;
      if (!cur || cur.book.id !== m.book) { lsSet(K.last + m.book, pg); location.hash = 'b=' + m.book; }
      else goToPage(pg);
    }
  });
  /* ---------- 질문 (밑줄 없이) ---------- */
  var askTarget = null, askBookId = null;
  function openAsk(m, bookId) {
    askTarget = m || null;
    askBookId = m ? m.book : bookId;
    var gen = askBookId === 'general';
    $('askTitle').textContent = m ? '질문 고치기' : '질문';
    $('askBook').textContent = gen ? '책과 상관없는 일반 질문이에요.' : bookShort(askBookId);
    $('askPageField').hidden = gen;
    $('askPage').value = m ? (m.page || '') : (gen || !cur ? '' : currentPage());
    $('askText').value = m ? (m.memo || '') : '';
    $('askDelete').hidden = !m;
    $('askSheet').hidden = false;
    setTimeout(function () { $('askText').focus(); }, 60);
  }
  $('askCancel').addEventListener('click', function () { $('askSheet').hidden = true; askTarget = null; });
  $('askDelete').addEventListener('click', function () {
    if (!askTarget || !confirm('이 질문을 지울까요?')) return;
    deleteMark(askTarget.id); $('askSheet').hidden = true; askTarget = null; renderHomeIfVisible();
  });
  $('askSave').addEventListener('click', function () {
    var q = $('askText').value.trim();
    if (!q) { toast('궁금한 것을 써 주세요.'); return; }
    var pg = askBookId === 'general' ? 0 : (parseInt($('askPage').value, 10) || 0);
    if (pg < 0) pg = 0;
    if (askTarget) {
      if (askTarget.memo !== q || askTarget.page !== pg) { askTarget.memo = q; askTarget.page = pg; if (askTarget.sent) { askTarget.sent = false; askTarget.edited = true; } }
    } else {
      marks.push({ id: uid(), book: askBookId, page: pg, kind: 'q', text: '', memo: q, created: new Date().toISOString(), sent: false });
    }
    saveMarks(); $('askSheet').hidden = true; askTarget = null;
    renderPanel(); renderHomeIfVisible(); toast('질문을 저장했어요. "한결에게 보내기"로 보내요.', 3200);
  });

  /* ---------- 작은 자료 받기 (공개 GitHub raw → 안 되면 넷리파이 같은 경로) ----------
     version.json(잠금 표시·자료 해시), answers.enc(한결 답), marks.enc(모두의 밑줄). 책(.enc)은 넷리파이에만 있다.
     모두 책과 같은 열쇠로 잠겨 있어 번호 없이는 내용을 볼 수 없다. */
  var SYNC_REPO = 'https://raw.githubusercontent.com/dpcnsg/vv-sync/main/';
  var SYNC_BASES = SYNC_REPO ? [SYNC_REPO, ''] : [''];
  (function () { // 시험용: ?data=http://localhost:포트/ (이 PC 주소만 허용)
    var m = /[?&]data=([^&#]+)/.exec(location.search); if (!m) return;
    try { var u = new URL(decodeURIComponent(m[1])); if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) SYNC_BASES = [u.href.replace(/\/?$/, '/'), '']; } catch (e) {}
  })();
  var SYNC = { v: null, checking: false };
  function fetchFirst(path, opts) {
    var i = 0;
    return (function next() {
      if (i >= SYNC_BASES.length) return Promise.reject(new Error('sync-none'));
      var b = SYNC_BASES[i++];
      return fetch(b + path, opts).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; }).catch(function () { return next(); });
    })();
  }
  function decryptBlob(buf, info) {
    var u = new Uint8Array(buf);
    if (u.length < 48 || String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'MJE1') return Promise.reject(new Error('형식'));
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: u.slice(4, 20), info: enc.encode(info) }, LOCK.key, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      .then(function (k) { return subtle.decrypt({ name: 'AES-GCM', iv: u.slice(20, 32), additionalData: enc.encode(info) }, k, u.subarray(32)); })
      .then(function (plain) { return JSON.parse(new TextDecoder().decode(plain)); });
  }
  function loadEnc(name, hash, info) {
    return fetchFirst(name + '?v=' + encodeURIComponent(hash), {}).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return decryptBlob(b, info); });
  }
  function syncCheck() {
    if (!LOCK.key || !LOCK.meta || SYNC.checking) return Promise.resolve();
    SYNC.checking = true;
    return fetchFirst('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) {
      if (!v || v.lock_ver !== LOCK.meta.ver) { ALL.missing = !ALL.items.length; return; } // 다른 잠금의 옛 자료는 쓰지 않는다
      SYNC.v = v;
      var jobs = [];
      if (v.answers && v.answers.hash !== ANS.hash) jobs.push(loadEnc('answers.enc', v.answers.hash, 'mitjul-answers').then(function (d) {
        ANS.items = Array.isArray(d.items) ? d.items : []; ANS.hash = v.answers.hash; ANS.gen = d.generated_at || '';
      }));
      if (v.marks && v.marks.hash !== ALL.hash) jobs.push(loadEnc('marks.enc', v.marks.hash, 'mitjul-marks').then(function (d) {
        ALL.gen = d.generated_at || ''; ALL.items = Array.isArray(d.items) ? d.items : []; ALL.hash = v.marks.hash; ALL.loaded = true; ALL.missing = false;
        renderHomeIfVisible(); if (cur) cur.pages.forEach(drawMarks);
      }));
      if (!v.marks) ALL.missing = true;
      return Promise.all(jobs);
    }).catch(function () { if (!ALL.items.length) ALL.missing = true; }).then(function () {
      SYNC.checking = false; updateAnsUI(); if (!$('ansPanel').hidden) renderAns(false);
    });
  }
  setInterval(function () { if (!document.hidden) syncCheck(); }, 60000); // 열려 있는 동안 60초마다
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncCheck(); });

  /* ---------- 톡방 (질문 + 한결 답을 카톡 대화방처럼) ----------
     내 말: 이 기기에 저장 + 넷리파이 Forms 로 보냄. 한결 말: GitHub answers.enc 에서 받음. 시각 순서로 합친다. */
  var ANS = { items: [], hash: '', gen: '' };
  var READ = lsGet('mj:ansRead', {}); if (!READ || typeof READ !== 'object') READ = {};
  var BASE_TITLE = document.title;
  function myAnswers() { var me = userName(); return ANS.items.filter(function (a) { return a.answer && (!a.name || a.name === me); }); }
  function ansKey(a) { return a.id + '|' + (a.answered_at || ''); } // 답을 고치면 다시 '새 답'
  function unreadAns() { return myAnswers().filter(function (a) { return !READ[ansKey(a)]; }); }
  function updateAnsUI() {
    var n = unreadAns().length;
    document.querySelectorAll('.ansbtn').forEach(function (b) {
      b.classList.toggle('hasnew', n > 0);
      var c = b.querySelector('.ansn'); if (c) c.textContent = n ? (n > 99 ? '99+' : n) : '';
    });
    document.title = (n ? '(' + n + ') ' : '') + BASE_TITLE;
  }
  function matchAnswer(m) { // 이 기기 표시 ↔ 답: 보낸 시각이 같거나, 같은 책·쪽·문장(질문은 같은 내용)
    var ats = (m.sendLog || []).map(function (l) { return l.at; });
    return ANS.items.filter(function (a) {
      if (a.sent_at && ats.indexOf(a.sent_at) >= 0) return true;
      return a.book === m.book && +a.page === +(m.page || 0) && (m.kind === 'q' ? a.memo === m.memo : a.text === (m.text || '(펜 표시)'));
    });
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(iso) { var d = new Date(iso); return isNaN(d) ? '' : (d.getHours() < 12 ? '오전 ' : '오후 ') + ((d.getHours() + 11) % 12 + 1) + ':' + two(d.getMinutes()); }
  function dayKey(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  function dayLabel(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + '일월화수목금토'[d.getDay()] + '요일'; }
  function whereOf(book, page) { return book === 'general' ? '일반 질문' : bookShort(book) + (+page ? ' · ' + page + '쪽' : ''); }
  function sendState(m) { // 내 말풍선 옆 작은 상태
    var l = m.sendLog && m.sendLog[m.sendLog.length - 1];
    if (m.sent) return '<span class="cs ok">' + (m.sentVia === 'kakao' ? '카톡' : '보냄') + '</span>';
    if (l && l.code !== 'kakao' && !okCode(l.code)) return '<button class="cs bad" data-resend="' + m.id + '" type="button">실패 · 다시 보내기</button>';
    return '<button class="cs" data-resend="' + m.id + '" type="button">안 보냄 · 보내기</button>';
  }
  function myMsgHtml(o, m) { // o: {book,page,kind,kindLabel,text,memo,time}, m: 이 기기 표시(없으면 다른 기기에서 보낸 것)
    var meta = '<div class="cmeta">' + (m ? sendState(m) : '<span class="cs ok">보냄</span>') + '<span class="ct">' + hhmm(o.time) + '</span></div>';
    var body;
    if (o.kind === 'q' || o.kindLabel === '질문') {
      var tag = o.book !== 'general' ? '<span class="cref" data-go="' + esc(o.book) + ':' + (+o.page || 1) + '">' + esc(whereOf(o.book, o.page)) + '</span>' : '';
      body = '<div class="cb me">' + tag + esc(o.memo || '') + '</div>';
    } else {
      var hl = /형광/.test(o.kindLabel);
      body = '<div class="ccard" data-go="' + esc(o.book) + ':' + (+o.page || 1) + '" role="button" tabindex="0">' +
        '<div class="cch"><span>' + esc(whereOf(o.book, o.page)) + '</span><b class="' + (hl ? 'k-hl' : 'k-line') + '">' + esc(o.kindLabel) + ' ›</b></div>' +
        '<p class="ccq' + (hl ? ' hl' : '') + '">' + esc(o.text || '(펜 표시)') + '</p>' + (o.memo ? '<p class="ccm">' + esc(o.memo) + '</p>' : '') +
        '</div>'; // 11/6 시장: 아래 작은 글씨 대신 카드 전체를 누르면 그 쪽으로
    }
    return '<li class="crow me">' + meta + body + '</li>';
  }
  function hgMsgHtml(a) {
    var isNew = !READ[ansKey(a)] || !!ansSessionNew[ansKey(a)];
    return '<li class="crow hg' + (isNew ? ' new' : '') + '"><span class="cav" aria-hidden="true">한</span><div class="cwrap"><div class="cname">한결' + (isNew ? ' <i class="newtag">새 답</i>' : '') + '</div>' +
      '<div class="crowin"><div class="cb hg">' + esc(a.answer) + (a.basis ? '<small>근거: ' + esc(a.basis) + '</small>' : '') + (a.status && a.status !== '답함' ? '<span class="cst">' + statusBadge(a.status) + '</span>' : '') + '</div>' +
      '<span class="ct">' + hhmm(a.answered_at || ANS.gen) + '</span></div></div></li>';
  }
  function renderAns(markRead) {
    var used = {}, groups = [];
    marks.forEach(function (m) {
      var as = matchAnswer(m).filter(function (a) { return a.answer; }); as.forEach(function (a) { used[a.id] = 1; });
      groups.push({ t: m.created, m: m, as: as });
    });
    myAnswers().forEach(function (a) { if (!used[a.id]) groups.push({ t: a.sent_at || a.answered_at, a: a, as: [a] }); }); // 다른 기기에서 보낸 것
    groups.sort(function (x, y) { return String(x.t || '').localeCompare(String(y.t || '')); });
    var html = '', lastDay = '';
    groups.forEach(function (g) {
      var dk = dayKey(g.t); if (dk && dk !== lastDay) { html += '<li class="cday"><span>' + dayLabel(g.t) + '</span></li>'; lastDay = dk; }
      var o = g.m ? { book: g.m.book, page: g.m.page, kind: g.m.kind, kindLabel: kindLabel(g.m), text: g.m.text, memo: g.m.memo, time: g.m.created }
                  : { book: g.a.book, page: g.a.page, kind: g.a.kind === '질문' ? 'q' : '', kindLabel: ({ '텍스트': '밑줄', '펜': '펜 밑줄', '형광펜': '형광펜', '질문': '질문' })[g.a.kind] || g.a.kind || '', text: g.a.text, memo: g.a.memo, time: g.a.sent_at };
      html += myMsgHtml(o, g.m);
      g.as.slice().sort(function (x, y) { return String(x.answered_at).localeCompare(String(y.answered_at)); }).forEach(function (a) { html += hgMsgHtml(a); });
      if (!g.as.length && g.m && g.m.sent) html += '<li class="cwait">한결이 확인 중…</li>';
    });
    $('ansList').innerHTML = html || '<li class="cempty">궁금한 것을 아래에 써서 보내 보세요.<br>밑줄·형광펜·메모도 여기에 함께 보여요.</li>';
    $('ansGen').textContent = ANS.gen ? '한결 답 ' + hhmm(ANS.gen) + ' 기준 · 1분마다 새 답 확인' : '1분마다 새 답을 확인해요';
    updateAskCtx();
    if (markRead) { myAnswers().forEach(function (a) { READ[ansKey(a)] = 1; }); lsSet('mj:ansRead', READ); updateAnsUI(); }
  }
  function scrollChatBottom() { var l = $('ansList'); l.scrollTop = l.scrollHeight; }
  var ansSessionNew = {};
  function openAns() {
    ansSessionNew = {}; unreadAns().forEach(function (a) { ansSessionNew[ansKey(a)] = 1; });
    renderAns(true); $('ansPanel').hidden = false;
    requestAnimationFrame(scrollChatBottom); setTimeout(scrollChatBottom, 60); // 열면 맨 아래 최신 말로
    syncCheck();
  }
  // "이 쪽에 대해 묻기": 읽는 중일 때만 보이고, 끄면 일반 질문
  var askHere = lsGet('mj:askHere', true) !== false;
  function updateAskCtx() {
    var on = !!(cur && cur.pdf);
    $('askCtx').hidden = !on;
    if (on) { $('askCtx').classList.toggle('on', askHere); $('askCtx').setAttribute('aria-pressed', askHere ? 'true' : 'false'); $('askCtxLabel').textContent = '이 쪽에 대해 묻기 · ' + cur.book.id + ' ' + currentPage() + '쪽'; }
  }
  $('askCtx').addEventListener('click', function () { askHere = !askHere; lsSet('mj:askHere', askHere); updateAskCtx(); });
  function sendChat() {
    var q = $('ansQ').value.replace(/\s+$/, '').trim(); if (!q) return;
    var here = cur && cur.pdf && askHere;
    var m = { id: uid(), book: here ? cur.book.id : 'general', page: here ? currentPage() : 0, kind: 'q', text: '', memo: q, created: new Date().toISOString(), sent: false };
    marks.push(m); saveMarks(); $('ansQ').value = ''; growQ(); renderAns(false); scrollChatBottom();
    sendQueue(function () { renderAns(false); scrollChatBottom(); }, [m]);
  }
  function growQ() { var t = $('ansQ'); t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; t.classList.toggle('scroll', t.scrollHeight > 120); }
  $('ansQ').addEventListener('input', growQ);
  $('ansQ').addEventListener('keydown', function (e) { // Enter 보내기, Shift+Enter 줄바꿈 (한글 조합 중에는 보내지 않음)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(); }
  });
  $('ansQ').addEventListener('focus', function () { setTimeout(scrollChatBottom, 250); }); // 자판이 올라온 뒤에도 최신 말이 보이게
  $('ansSend').addEventListener('click', sendChat);
  document.querySelectorAll('.ansbtn').forEach(function (b) { b.addEventListener('click', openAns); });
  $('ansClose').addEventListener('click', function () { $('ansPanel').hidden = true; });
  $('ansList').addEventListener('click', function (e) {
    var r = e.target.closest('[data-resend]');
    if (r) { var m = findMark(r.getAttribute('data-resend')); if (m && !sending) { r.textContent = '보내는 중…'; sendQueue(function () { renderAns(false); }, [m]); } return; }
    var g = e.target.closest('[data-go]'); if (!g) return;
    var v = g.getAttribute('data-go').split(':'), id = v[0], pg = +v[1] || 1;
    if (id === 'general') return;
    $('ansPanel').hidden = true;
    if (!cur || cur.book.id !== id) { lsSet(K.last + id, pg); location.hash = 'b=' + id; } else goToPage(pg);
  });
  $('ansList').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('ccard')) e.target.click(); });

  /* ---------- 모두의 밑줄 (books/marks.enc, 책과 같은 열쇠로 잠금) ----------
     marks.enc 는 담당자가 Netlify 제출 CSV와 답 파일로 만들어 다시 올릴 때만 바뀐다(실시간 아님).
     항목: { id, name, book('04'|'general'), page, kind, text, memo, sent_at, lines?, answer, basis, status } */
  var ALL = { gen: '', items: [], loaded: false, missing: false, hash: '' };
  var MAIN_REVIEWER = '소란요요', MAIN_SHORT = '소란';
  var PALETTE = ['#2E7D6B', '#8A5A9E', '#B07A1E', '#4F7FA8', '#9C4A6B'];
  function allOn() { return document.body.classList.contains('showall') && ALL.items.length > 0; }
  function personColor(name) {
    if (name === MAIN_REVIEWER) return '#3B4C8C'; // 주 검토자는 남색
    var h = 0; for (var i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function loadAll() { return syncCheck(); } // 모두의 밑줄·한결 답: 작은 자료 받기로
  function genLabel() {
    if (!ALL.gen) return '';
    var d = new Date(ALL.gen); if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + d.getHours() + '시 기준';
  }
  function allBookLine(id) {
    if (!ALL.items.length) return '';
    var mine = ALL.items.filter(function (it) { return it.book === id && it.name === MAIN_REVIEWER; });
    if (!mine.length) return '';
    var done = mine.filter(function (it) { return it.status === '반영'; }).length;
    return '<small class="allline">' + MAIN_SHORT + ' 밑줄 ' + mine.length + ' · 반영 ' + done + '</small>';
  }
  // 옛 제출(위치 없음): 그 쪽 글자 층에서 text 를 찾아 글자 줄로 바꾼다. 못 찾으면 목록에만.
  function findTextLines(p, text) {
    var q = String(text || '').replace(/\s+/g, '').replace(/^[「“"']+|[」”"']+$/g, '');
    if (q.length < 2 || !p.textDivs.length) return null;
    var flat = '', own = [];
    p.textDivs.forEach(function (div, di) {
      var tn = textNodeOf(div); if (!tn) return;
      for (var c = 0; c < tn.data.length; c++) if (!/\s/.test(tn.data[c])) { flat += tn.data[c]; own.push([di, c]); }
    });
    var at = flat.indexOf(q), len = q.length;
    if (at < 0 && q.length > 16) { at = flat.indexOf(q.slice(0, 16)); len = 16; } // 길면 앞부분으로라도
    if (at < 0) return null;
    var by = {};
    for (var i = at; i < at + len; i++) { var o = own[i]; var b = by[o[0]] || (by[o[0]] = [o[1], o[1] + 1]); b[0] = Math.min(b[0], o[1]); b[1] = Math.max(b[1], o[1] + 1); }
    var pieces = [];
    Object.keys(by).forEach(function (k) {
      var di = +k, tn = textNodeOf(p.textDivs[di]), xs = charSpanX(p, tn, by[k][0], by[k][1]), b = itemBase(p, di);
      if (xs && b) pieces.push({ x1: xs[0], x2: xs[1], y: b.y, fh: b.fh });
    });
    return pieces.length ? packLines(groupLines(pieces)) : null;
  }
  function itemLines(p, it) {
    if (it.lines && it.lines.length) return it.lines;
    if (it._lines !== undefined) return it._lines;
    if (!p.textDiv || !p.textDivs.length || p.renderedScale !== scaleNow() || !p.div.offsetParent) return null; // 글자 층이 아직 없거나 옛 배율·숨은 쪽: 나중에 다시
    it._lines = it.kind === '질문' ? null : findTextLines(p, it.text);
    return it._lines;
  }
  function allMarksSvg(p) {
    var sc = pageScale(p), lw = lineWidth(p), h = '', qn = 0;
    ALL.items.forEach(function (it, idx) {
      if (!cur || it.book !== cur.book.id || +it.page !== p.num) return;
      var col = personColor(it.name);
      if (it.kind === '질문') { // 질문은 쪽 오른쪽 위에 작은 표시
        var qx = p.cssW - 14, qy = 16 + (qn++) * 26;
        h += '<g class="allmark" data-aidx="' + idx + '"><circle cx="' + qx + '" cy="' + qy + '" r="13" fill="transparent"/><circle cx="' + qx + '" cy="' + qy + '" r="9" fill="' + col + '"/><text x="' + qx + '" y="' + (qy + 4) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">?</text></g>';
        return;
      }
      var L = itemLines(p, it); if (!L) return;
      var hl = it.kind === '형광펜', end = null;
      L.forEach(function (l) {
        var x1 = l[0] * sc, x2 = l[1] * sc, base = l[2] * sc, fh = l[3] * sc, top = base - fh * 0.9;
        h += '<rect x="' + x1.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + (x2 - x1).toFixed(1) + '" height="' + (fh * (0.9 + UL_GAP) + 1).toFixed(1) + '" fill="' + col + '" opacity="' + (hl ? 0.24 : 0.1) + '"/>';
        if (!hl) { var uy = base + fh * UL_GAP + UL_PX + lw; h += '<line x1="' + x1.toFixed(1) + '" y1="' + uy.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + uy.toFixed(1) + '" stroke="' + col + '" stroke-width="' + lw.toFixed(2) + '" stroke-dasharray="4 2.5"/>'; }
        end = [x2, top];
      });
      if (end) {
        var bx = Math.min(p.cssW - 10, end[0] + 6), by = Math.max(10, end[1] - 2);
        h += '<g class="allmark" data-aidx="' + idx + '"><circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="13" fill="transparent"/><rect x="' + (bx - 5).toFixed(1) + '" y="' + (by - 5).toFixed(1) + '" width="10" height="10" rx="2.5" fill="' + col + '" stroke="#fff" stroke-width="1.2"/></g>';
      }
    });
    return h;
  }
  var STATUS_CLS = { '대기': 'wait', '답함': 'ans', '반영': 'done', '보류': 'hold' };
  function statusBadge(s) { s = s || '대기'; return '<span class="stb ' + (STATUS_CLS[s] || 'wait') + '">' + esc(s) + '</span>'; }
  function allItemHtml(it, withGo) {
    var col = personColor(it.name), gen = it.book === 'general';
    var where = it.kind === '질문' && !+it.page ? (gen ? '' : '책 전체') : it.page + '쪽';
    return '<div class="meta"><span class="who"><i style="background:' + col + '"></i>' + esc(it.name || '') + '</span>' +
      (where ? '<span>' + where + '</span>' : '') + '<span>' + esc(it.kind || '') + '</span>' + statusBadge(it.status) + '</div>' +
      (it.kind === '질문' ? '' : '<p class="q">' + esc(it.text || '') + '</p>') +
      (it.memo ? '<p class="m">' + esc(it.memo) + '</p>' : '') +
      (it.answer ? '<div class="ans"><b>답</b> ' + esc(it.answer) + (it.basis ? '<small>근거: ' + esc(it.basis) + '</small>' : '') + '</div>' : '<div class="ans none">아직 답이 없어요.</div>') +
      (withGo && !gen ? '<div class="acts"><button class="btn" data-go="' + esc(it.book) + ':' + (+it.page || 1) + '" type="button">그 쪽으로</button></div>' : '');
  }
  pagesEl.addEventListener('click', function (e) {
    var g = e.target.closest && e.target.closest('.allmark'); if (!g) return;
    var it = ALL.items[+g.getAttribute('data-aidx')]; if (!it) return;
    $('allPopBody').innerHTML = allItemHtml(it, false) + (ALL.gen ? '<p class="muted">' + genLabel() + '</p>' : '');
    $('allPop').hidden = false;
  });
  $('allPopClose').addEventListener('click', function () { $('allPop').hidden = true; });
  $('allBtn').addEventListener('click', function () {
    if (!ALL.loaded && !ALL.missing && LOCK.key) { loadAll().then(function () { if (ALL.items.length) $('allBtn').click(); else toast('아직 모두의 밑줄 자료가 없어요.', 2600); }); return; }
    if (!ALL.items.length) { toast(ALL.missing || !ALL.loaded ? '아직 모두의 밑줄 자료가 없어요.' : '모두의 밑줄이 비어 있어요.', 2600); return; }
    var on = !document.body.classList.contains('showall');
    document.body.classList.toggle('showall', on);
    $('allBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    lsSet('mj:all', on);
    if (cur) cur.pages.forEach(drawMarks);
    if (on) {
      var n = cur ? ALL.items.filter(function (it) { return it.book === cur.book.id; }).length : 0;
      toast('모두의 밑줄 ' + n + '개 · ' + genLabel() + ' (실시간 아님)', 3200);
    }
  });
  var allFilter = { status: '', scope: 'book' };
  function openAll(scope) {
    if (!ALL.items.length) { toast('아직 모두의 밑줄 자료가 없어요.', 2600); return; }
    if (scope === 'book') scope = cur ? cur.book.id : 'all';
    allFilter.scope = scope || (cur ? cur.book.id : 'all');
    renderAll(); $('allPanel').hidden = false;
  }
  function renderAll() {
    $('allGen').textContent = genLabel() ? genLabel() + ' · 실시간이 아니에요' : '';
    document.querySelectorAll('#allStatus button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-st') === allFilter.status); });
    // 11/6 시장: 첫 화면에서 '이 책'이 먹통 → 책 고르기 칸으로 바꿈(모든 책 + 밑줄 있는 책마다)
    var cnt = {}, order = [];
    ALL.items.forEach(function (it) { if (!(it.book in cnt)) { cnt[it.book] = 0; order.push(it.book); } cnt[it.book]++; });
    order.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    if (allFilter.scope !== 'all' && !(allFilter.scope in cnt)) { if (cur && allFilter.scope === cur.book.id) { cnt[allFilter.scope] = 0; order.unshift(allFilter.scope); } else allFilter.scope = 'all'; }
    $('allScopeSel').innerHTML = '<option value="all">모든 책 (' + ALL.items.length + ')</option>' + order.map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(bookShort(id)) + (cur && cur.book.id === id ? ' · 지금 책' : '') + ' (' + cnt[id] + ')</option>';
    }).join('');
    $('allScopeSel').value = allFilter.scope;
    var list = ALL.items.filter(function (it) {
      return (allFilter.scope === 'all' || it.book === allFilter.scope) && (!allFilter.status || (it.status || '대기') === allFilter.status);
    }).slice().sort(function (a, b) { return String(a.book).localeCompare(String(b.book)) || (+a.page - +b.page) || String(a.sent_at).localeCompare(String(b.sent_at)); });
    var html = '', last = null;
    list.forEach(function (it) {
      if (it.book !== last) { if (last !== null) html += '</ul>'; html += '<h3>' + esc(bookShort(it.book)) + '</h3><ul class="marks">'; last = it.book; }
      html += '<li>' + allItemHtml(it, true) + '</li>';
    });
    if (last !== null) html += '</ul>';
    $('allList').innerHTML = html || '<p class="empty">해당하는 표시가 없어요.</p>';
  }
  $('allStatus').addEventListener('click', function (e) { var b = e.target.closest('button[data-st]'); if (!b) return; allFilter.status = b.getAttribute('data-st'); renderAll(); });
  $('allScopeSel').addEventListener('change', function () { allFilter.scope = this.value || 'all'; renderAll(); });
  $('allClose').addEventListener('click', function () { $('allPanel').hidden = true; });
  $('allList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-go]'); if (!b) return;
    var v = b.getAttribute('data-go').split(':'), id = v[0], pg = +v[1] || 1;
    $('allPanel').hidden = true;
    if (!document.body.classList.contains('showall')) $('allBtn').click();
    if (!cur || cur.book.id !== id) { lsSet(K.last + id, pg); location.hash = 'b=' + id; } else goToPage(pg);
  });
  $('homeAllBtn').addEventListener('click', function () { openAll('all'); });
  $('panelAllBtn').addEventListener('click', function () { $('panel').hidden = true; openAll(cur ? 'book' : 'all'); });
  if (lsGet('mj:all', false)) { document.body.classList.add('showall'); $('allBtn').setAttribute('aria-pressed', 'true'); }

  $('listBtn').addEventListener('click', function () { openPanel(false); });
  $('reviewBtn').addEventListener('click', toggleReview);
  $('homeListBtn').addEventListener('click', function () { openPanel(true); });
  $('panelClose').addEventListener('click', function () { $('panel').hidden = true; });
  $('panel').addEventListener('click', function (e) { if (e.target === $('panel')) $('panel').hidden = true; });
  $('fltBook').addEventListener('click', function () { filterAll = false; renderPanel(); });
  $('fltAll').addEventListener('click', function () { filterAll = true; renderPanel(); });

  /* ---------- 한결에게 보내기 (Netlify Forms) ---------- */
  // 양식 필드는 숨은 form과 같게: name, book, page, text, memo, kind, sent_at (새 필드 없음)
  // 돌려주는 값: 응답 코드(200 등). 인터넷이 끊기는 등 응답이 없으면 0.
  var FORM_URL = 'https://silly-creponne-41e99c.netlify.app/';
  var ON_NETLIFY = /\.netlify\.app$/.test(location.hostname);
  var SEND_GAP = 450; // 연달아 보낼 때 사이 간격(ms) — 짧은 간격의 연속 제출이 걸러지지 않게
  function postForm(f) {
    var body = new URLSearchParams();
    body.append('form-name', FORM_NAME);
    body.append('name', userName());
    body.append('book', f.book);
    body.append('page', String(f.page));
    body.append('text', f.text);
    body.append('memo', f.memo || '');
    body.append('kind', f.kind);
    body.append('sent_at', f.sent_at || new Date().toISOString());
    body.append('bot-field', '');
    if (ON_NETLIFY) return fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), cache: 'no-store' })
      .then(function (r) { return r.status; }, function () { return 0; });
    // 깃허브 페이지 등 다른 주소에서 열었을 때: 받는 곳은 넷리파이 그대로. 응답 내용은 못 읽지만(opaque) 닿으면 성공으로 본다.
    return fetch(FORM_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), cache: 'no-store' })
      .then(function (r) { return r.type === 'opaque' || r.ok ? 200 : r.status; }, function () { return 0; });
  }
  function okCode(c) { return c >= 200 && c < 300; }
  function markFields(m) {
    if (m.kind === 'q') return { book: bookLabel(bookById(m.book)), page: m.page || 0, text: '(밑줄 없음)', memo: m.memo, kind: '질문' };
    return { book: bookLabel(bookById(m.book)), page: m.page, text: m.text || '(펜 표시)', memo: m.memo, kind: kindSend(m) };
  }
  // 항목 하나 보내기: 응답이 200대일 때만 '보냄'. 보낸 기록(시각·코드)을 항목에 남긴다.
  function sendMark(m) {
    var at = new Date().toISOString();
    var fields = markFields(m); fields.sent_at = at; // 보낸 시각을 제출값과 똑같이 남겨 답과 맞춘다
    return postForm(fields).then(function (code) {
      var cur2 = findMark(m.id) || m; // 보내는 동안 목록이 바뀌어도 같은 항목을 고친다
      cur2.sendLog = (cur2.sendLog || []).concat([{ at: at, code: code }]).slice(-10);
      if (okCode(code)) { cur2.sent = true; cur2.sentAt = at; cur2.sentVia = 'form'; delete cur2.edited; }
      saveMarks();
      return okCode(code);
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 검토 끝 상태: { '03': { done: true, sent: true, at: '...', pending: null | '검토끝' | '검토끝취소' } } */
  var review = lsGet(K.review, {});
  if (!review || typeof review !== 'object') review = {};
  function saveReview() { lsSet(K.review, review); }
  var SIG_TEXT = { '검토끝': '이 책 검토를 마쳤습니다', '검토끝취소': '이 책 검토 끝을 취소합니다' };
  function signalFields(bookId, kind) { return { book: bookLabel(bookById(bookId)), page: 0, text: SIG_TEXT[kind], memo: '', kind: kind }; }
  function pendingSignals() {
    return Object.keys(review).filter(function (id) { return review[id] && review[id].pending; }).sort()
      .map(function (id) { return { book: id, kind: review[id].pending }; });
  }
  function signalSent(sig) {
    var r = review[sig.book]; if (!r || r.pending !== sig.kind) return;
    if (sig.kind === '검토끝취소') delete review[sig.book];
    else { r.pending = null; r.sent = true; r.sentAt = new Date().toISOString(); }
    saveReview();
  }
  function unsentTotal() { return marks.filter(function (m) { return !m.sent; }).length + pendingSignals().length; }

  // 보낼 것(안 보낸 밑줄 → 남은 검토 신호)을 하나씩, 간격을 두고 보낸다. 실패해도 멈추지 않고 끝까지 간다.
  // cb({ ok: 보낸 수, fail: 실패 수, codes: [실패 코드…] })
  var sending = false;
  function sendQueue(cb, only) {
    if (sending) return;
    var list = only ? only : marks.filter(function (m) { return !m.sent; });
    var sigs = only ? [] : pendingSignals();
    lsSet(K.name, userName());
    sending = true; $('sendBtn').disabled = true;
    var res = { ok: 0, fail: 0, codes: [] }, total = list.length + sigs.length, n = 0;
    var steps = list.map(function (m) { return function () { return sendMark(m); }; })
      .concat(sigs.map(function (s) { return function () { return postForm(signalFields(s.book, s.kind)).then(function (code) { if (okCode(code)) signalSent(s); else res.codes.push(code); return okCode(code); }); }; }));
    var chain = Promise.resolve();
    steps.forEach(function (step, i) {
      chain = chain.then(function () {
        n++; $('sendBtn').textContent = '보내는 중… ' + n + '/' + total;
        return (i ? wait(SEND_GAP) : Promise.resolve()).then(step);
      }).then(function (ok) {
        if (ok) res.ok++; else { res.fail++; if (i < list.length) { var l = list[i].sendLog; res.codes.push(l && l.length ? l[l.length - 1].code : 0); } }
      });
    });
    chain.then(function () {
      sending = false; $('sendBtn').textContent = '한결에게 보내기';
      refreshAll();
      cb(res);
    });
  }
  function refreshAll() { renderPanel(); if (cur) cur.pages.forEach(drawMarks); renderHomeIfVisible(); updateReviewUI(); }
  function sendResultToast(res) {
    if (!res.fail) { toast(res.ok + '개를 한결에게 보냈어요. 고마워요!', 3500); return; }
    var why = !navigator.onLine || res.codes.every(function (c) { return c === 0; }) ? '인터넷 연결을 확인해 주세요.' : '(응답 ' + res.codes.filter(function (c, i, a) { return a.indexOf(c) === i; }).join(', ') + ')';
    toast((res.ok ? res.ok + '개는 보냈고, ' : '') + res.fail + '개는 보내지 못했어요 ' + why + ' "안 보냄"으로 남겨 두었어요. 잠시 뒤 다시 보내거나 카톡으로 복사해 주세요.', 6500);
  }

  $('sendBtn').addEventListener('click', function () {
    if (!unsentTotal()) return;
    sendQueue(sendResultToast); // 실패해도 카톡 창을 저절로 띄우지 않는다(잘못 '보냄'으로 표시되는 것을 막기)
  });
  function renderHomeIfVisible() { if (!$('home').hidden) renderHome(); }

  /* ---------- 이 책 검토 끝 ---------- */
  function reviewState(id) { return review[id] || null; }
  function reviewLabel(id) {
    var r = reviewState(id); if (!r) return '';
    if (r.pending === '검토끝취소') return '검토 끝 취소(안 보냄)';
    return r.sent ? '검토 끝(보냄)' : '검토 끝(안 보냄)';
  }
  function updateReviewUI() {
    var id = cur && cur.book.id, r = id && reviewState(id);
    var isDone = !!(r && r.pending !== '검토끝취소');
    [$('reviewBtn'), $('endReviewBtn')].forEach(function (b) {
      if (!b) return;
      b.hidden = !id;
      b.textContent = isDone ? '검토 끝 취소' : '이 책 검토 끝';
      b.classList.toggle('danger', isDone); b.classList.toggle('primary', !isDone && b.id === 'endReviewBtn');
    });
    var st = $('reviewState');
    if (st) { st.textContent = id ? reviewLabel(id) : ''; st.hidden = !(id && r); }
    var es = $('endReviewState');
    if (es) es.textContent = id && r ? reviewLabel(id) : '다 읽었으면 눌러 주세요. 한결에게 알려요.';
  }
  function toggleReview() {
    if (!cur || sending) return;
    var id = cur.book.id, r = reviewState(id);
    var isDone = !!(r && r.pending !== '검토끝취소');
    if (!isDone) {
      if (!confirm('이 책 검토를 마칠까요? 아직 안 보낸 밑줄이 있으면 함께 보냅니다.')) return;
      review[id] = { done: true, sent: false, at: new Date().toISOString(), pending: '검토끝' };
    } else {
      if (!confirm('검토 끝을 취소할까요? 한결에게 취소했다고 알려요.')) return;
      if (r.pending === '검토끝') { delete review[id]; saveReview(); refreshAll(); toast('검토 끝을 취소했어요. (아직 안 보낸 신호라 따로 알리지 않아요)', 4000); return; }
      review[id] = { done: false, sent: false, at: new Date().toISOString(), pending: '검토끝취소' };
    }
    saveReview(); refreshAll();
    sendQueue(function (res) {
      if (!res.fail) toast(isDone ? '검토 끝을 취소하고 한결에게 알렸어요.' : '검토 끝을 한결에게 알렸어요. 고마워요!', 4000);
      else { sendResultToast(res); copyForKakao(); } // 카톡 복사 창은 '직접 보냈다'고 한 번 더 확인해야 보냄 표시
    });
  }

  /* ---------- 카톡으로 복사 ---------- */
  function kakaoText(list, sigs) {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var head = list.length + '개' + (sigs.length ? ' · 검토 신호 ' + sigs.length + '개' : '');
    var lines = ['[victorview 밑줄펜] ' + userName(), d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + head, ''];
    var lastBook = null;
    list.slice().sort(function (a, b) { return a.book.localeCompare(b.book) || a.page - b.page; }).forEach(function (m) {
      if (m.book !== lastBook) { lines.push('■ ' + bookShort(m.book)); lastBook = m.book; }
      if (m.kind === 'q') lines.push('· 질문' + (m.page ? ' (' + m.page + '쪽)' : ''));
      else lines.push('· ' + m.page + '쪽' + (m.kind === 'text' ? '' : ' (' + kindLabel(m) + ')') + ' 「' + (m.text || '펜 표시') + '」');
      if (m.memo) lines.push('  → ' + m.memo);
    });
    if (sigs.length) {
      if (list.length) lines.push('');
      sigs.forEach(function (s) { var b = bookById(s.book); lines.push('★ ' + (b ? b.id + ' ' + b.title : s.book) + ' — ' + SIG_TEXT[s.kind]); });
    }
    return lines.join('\n');
  }
  var copyList = [], copySigs = [];
  function copyForKakao() {
    copyList = marks.filter(function (m) { return !m.sent; });
    copySigs = pendingSignals();
    if (!copyList.length && !copySigs.length) return;
    var text = kakaoText(copyList, copySigs);
    $('copyText').value = text;
    var after = function (how) { $('copySheet').hidden = false; toast(how, 3000); };
    if (navigator.share && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      navigator.share({ title: 'victorview 밑줄펜', text: text }).then(function () { after('카톡에 보냈으면 "보냈어요"를 눌러 주세요.'); }).catch(function () { tryClipboard(text, after); });
    } else tryClipboard(text, after);
  }
  function tryClipboard(text, after) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { after('복사했어요. 카톡 창에 붙여 넣어 주세요.'); }).catch(function () { after('아래 글을 길게 눌러 복사해 주세요.'); });
    } else after('아래 글을 길게 눌러 복사해 주세요.');
  }
  $('copyBtn').addEventListener('click', copyForKakao);
  $('copyMarkSent').addEventListener('click', function () {
    // 카톡으로 직접 보낸 경우에만 누르는 단추. 서버로 가지 않으므로 한 번 더 묻는다.
    if (!confirm('이 글을 카톡으로 직접 보내셨나요?\n"보냄"으로 표시하면 "한결에게 보내기"에서 빠져요.')) return;
    var now = new Date().toISOString();
    copyList.forEach(function (m) { m.sent = true; m.sentAt = now; m.sentVia = 'kakao'; m.sendLog = (m.sendLog || []).concat([{ at: now, code: 'kakao' }]).slice(-10); delete m.edited; });
    copySigs.forEach(signalSent);
    saveMarks(); $('copySheet').hidden = true; refreshAll(); toast('보냄으로 표시했어요.');
  });
  $('copyClose').addEventListener('click', function () { $('copySheet').hidden = true; });
  $('copyText').addEventListener('focus', function () { this.select(); });

  /* ---------- 책 안 찾기 ---------- */
  function norm(s) { return String(s).replace(/\s+/g, '').toLowerCase(); }
  $('searchBtn').addEventListener('click', function () { if (!cur || !cur.pdf) return; $('searchSheet').hidden = false; setTimeout(function () { $('searchInput').focus(); }, 60); });
  $('searchClose').addEventListener('click', function () { $('searchSheet').hidden = true; });
  $('searchForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('searchInput').value.trim(), nq = norm(q);
    if (!nq || !cur) return;
    var token = cur.token, n = cur.pdf.numPages, results = [];
    $('searchInfo').textContent = '찾는 중…'; $('searchResults').innerHTML = '';
    var i = 1;
    (function step() {
      if (!cur || cur.token !== token) return;
      if (i > n) return show();
      var num = i++;
      getText(num).then(function (tc) {
        var raw = tc.items.map(function (it) { return (it.str || '') + (it.hasEOL ? ' ' : ''); }).join('');
        var map = [], flat = '';
        for (var k = 0; k < raw.length; k++) if (!/\s/.test(raw[k])) { map.push(k); flat += raw[k].toLowerCase(); }
        var from = 0, at;
        while ((at = flat.indexOf(nq, from)) >= 0 && results.length < 200) {
          var s = map[at], e2 = map[at + nq.length - 1] + 1;
          results.push({ page: num, pre: raw.slice(Math.max(0, s - 24), s), hit: raw.slice(s, e2), post: raw.slice(e2, e2 + 24) });
          from = at + nq.length;
        }
        step();
      }).catch(step);
    })();
    function show() {
      $('searchInfo').textContent = results.length ? results.length + '곳을 찾았어요.' : '찾지 못했어요. 낱말을 줄여 보세요.';
      $('searchResults').innerHTML = results.map(function (r, idx) {
        return '<li><button type="button" data-i="' + idx + '"><b>' + r.page + '쪽</b>…' + esc(r.pre) + '<mark>' + esc(r.hit) + '</mark>' + esc(r.post) + '…</button></li>';
      }).join('');
      cur.hits = { q: nq };
      cur.pages.forEach(applyHits);
      $('searchResults').onclick = function (ev) {
        var bt = ev.target.closest('button[data-i]'); if (!bt) return;
        var r = results[bt.getAttribute('data-i') | 0];
        $('searchSheet').hidden = true; goToPage(r.page);
      };
    }
  });
  function applyHits(p) {
    if (!p.textDivs || !p.textDivs.length) return;
    p.textDivs.forEach(function (d) { d.classList.remove('hit'); });
    if (!cur.hits) return;
    var nq = cur.hits.q, flat = '', owner = [];
    p.textDivs.forEach(function (d, di) { var t = norm(d.textContent); for (var k = 0; k < t.length; k++) { flat += t[k]; owner.push(di); } });
    var from = 0, at;
    while ((at = flat.indexOf(nq, from)) >= 0) {
      for (var k = at; k < at + nq.length; k++) p.textDivs[owner[k]].classList.add('hit');
      from = at + nq.length;
    }
  }

  /* ---------- 쪽 이동 ---------- */
  $('pageBtn').addEventListener('click', function () {
    if (!cur || !cur.pdf) return;
    $('pageInput').max = cur.pdf.numPages; $('pageInput').value = currentPage();
    $('pageSheet').hidden = false; setTimeout(function () { $('pageInput').select(); }, 60);
  });
  $('pageForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = parseInt($('pageInput').value, 10);
    if (!(n >= 1 && n <= cur.pdf.numPages)) { toast('1부터 ' + cur.pdf.numPages + ' 사이로 넣어 주세요.'); return; }
    $('pageSheet').hidden = true; goToPage(n);
  });
  $('pageClose').addEventListener('click', function () { $('pageSheet').hidden = true; });

  /* ---------- 안내·닫기 ---------- */
  $('guideOk').addEventListener('click', function () { lsSet(K.guided, true); $('guide').hidden = true; });
  function closeAllSheets() { ['memoSheet', 'searchSheet', 'pageSheet', 'copySheet', 'askSheet', 'panel', 'allPanel', 'allPop', 'ansPanel'].forEach(function (id) { if ($(id)) $(id).hidden = true; }); }
  document.querySelectorAll('.sheet').forEach(function (s) {
    s.addEventListener('click', function (e) { if (e.target === s && s.id !== 'guide') s.hidden = true; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeAllSheets(); hideSelBar(); if (document.body.classList.contains('pen')) setPen(false); return; }
    // 한 장씩: ←/→, PageUp/PageDown 으로 넘기기 (글 쓰는 칸·창이 열려 있을 때는 빼고)
    if (!cur || !cur.pdf || !isPaged() || $('reader').hidden || anySheetOpen()) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
    var d = (e.key === 'ArrowRight' || e.key === 'PageDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'PageUp') ? -1 : 0;
    if (d) { e.preventDefault(); turn(d); }
  });

  /* ---------- 오프라인 앱 (service worker) ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('sw', e); }); });
  }

  /* ---------- 화면 높이 (인앱 웹뷰 대비): 실제 보이는 높이를 --app-h 로 ---------- */
  function fitViewport() {
    var vv = window.visualViewport, h = vv ? vv.height : window.innerHeight;
    var vb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    if (vv && vv.scale > 1.01) return; // 사용자가 화면을 확대한 동안은 그대로
    var nh = Math.round(h) + 'px', changed = document.documentElement.style.getPropertyValue('--app-h') !== nh;
    document.documentElement.style.setProperty('--app-h', nh);
    document.documentElement.style.setProperty('--vb', Math.round(vb) + 'px');
    if (changed && !$('ansPanel').hidden) setTimeout(scrollChatBottom, 60); // 자판이 올라오면 톡방 최신 말이 입력창 바로 위에 보이게
    if (changed && cur && cur.pages.length && isPaged()) { // 높이가 바뀌면 한 장이 꽉 차게 다시 맞춘다
      clearTimeout(fitViewport.t);
      fitViewport.t = setTimeout(function () { if (!cur || !cur.pages.length) return; var n = currentPage(); cur.base = fitScale(cur.pages[0].size); rerenderAll(); goToPage(n, true); }, 120);
    }
  }
  fitViewport();
  window.addEventListener('resize', fitViewport);
  window.addEventListener('orientationchange', function () { setTimeout(fitViewport, 300); });
  if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitViewport); window.visualViewport.addEventListener('scroll', fitViewport); }

  /* ---------- 카톡·네이버·인스타 등 앱 안의 브라우저 안내 ---------- */
  var UA = navigator.userAgent || '';
  var forcedInapp = /[?&]inapp=(\w+)/.exec(location.search); // 시험용: ?inapp=kakao
  var INAPP = forcedInapp ? forcedInapp[1] : /KAKAOTALK/i.test(UA) ? 'kakao' : /NAVER\(inapp|NAVER/i.test(UA) ? 'naver' : /Instagram/i.test(UA) ? 'instagram' : /FBAN|FBAV/i.test(UA) ? 'facebook' : /\bLine\//i.test(UA) ? 'line' : /; wv\)/.test(UA) ? 'webview' : '';
  var IS_ANDROID = /Android/i.test(UA) || (forcedInapp && !/iPhone|iPad|iPod/i.test(UA));
  function setBar(show) {
    $('inappBar').hidden = !show;
    document.documentElement.style.setProperty('--bar-h', show ? '44px' : '0px');
    if (cur && cur.pages.length) setTimeout(function () { var n = currentPage(); cur.base = fitScale(cur.pages[0].size); rerenderAll(); goToPage(n, true); }, 50);
  }
  if (INAPP && !lsGet('mj:inappHide', false)) setBar(true);
  $('inappClose').addEventListener('click', function () { lsSet('mj:inappHide', true); setBar(false); });
  $('inappOpen').addEventListener('click', function () {
    var url = location.href.split('#')[0];
    var intent = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=' + (location.protocol === 'http:' ? 'http' : 'https') + ';package=com.android.chrome;end';
    if (INAPP === 'kakao') {
      location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url); // 카톡: 바깥 브라우저로
      if (IS_ANDROID) setTimeout(function () { if (!document.hidden) location.href = intent; }, 900);
    } else if (IS_ANDROID) {
      location.href = intent;
    } else {
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).catch(function () {});
      toast('오른쪽 위 메뉴에서 "Safari로 열기"를 눌러 주세요. 주소도 복사해 두었어요.', 5000);
    }
  });

  $('prevBtn').addEventListener('click', function () { turn(-1); });
  $('nextBtn').addEventListener('click', function () { turn(1); });
  document.body.classList.toggle('zoomed', (lsGet(K.zoom, 1) || 1) > 1.001);

  setView(lsGet(K.view, 'paged'), true); // 기본은 한 장씩, 고른 값은 기기에 기억
  initLock();
})();
