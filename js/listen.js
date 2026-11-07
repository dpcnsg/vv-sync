/* victorview 밑줄펜 — 듣기(소리 내어 읽기). 2026-11-07 시장 지시 "음성 기능 시험".
   무료: 브라우저 안의 목소리(speechSynthesis)만 쓴다. 서버·요금·외부 전송 없음.
   - 도구 줄에 "듣기" 단추. 누르면 지금 쪽 글을 문장 단위로 읽고 화면 아래 작은 막대(▶/⏸, ⏹, 빠르기, 목소리, 이어 읽기).
   - 쪽 끝까지 읽으면 다음 쪽으로 넘어가 이어 읽기(막대의 "이어" 단추로 켜고 끔, 기기에 기억).
   - 쪽 번호·머리글·꼬리글 같은 군더더기는 글자 위치(쪽 위·아래 띠)와 모양(숫자만, 짧은 줄 반복)으로 걸러 낸다.
   - app.js 와는 window.MJ_HOST(쪽 글자 빌려주기)로만 이어진다. 밑줄·메모·잠금 코드는 건드리지 않는다.
   편지 읽는 목소리: 빠르기 0.9, 높이 0.95 (읽어주기/readaloud.js 와 같은 기준). */
(function (root) {
  'use strict';

  /* ================= 1) 글 다듬기 (화면 없이도 시험할 수 있는 순수 함수) ================= */
  var BAND = 0.08; // 쪽 위·아래 8% 띠 = 머리글·꼬리글 자리

  function isPageNo(s) {
    s = s.replace(/\s+/g, ' ').trim();
    return /^[-–—·\s]*\d{1,4}[-–—·\s]*$/.test(s) ||                 // 12, - 12 -, · 12 ·
      /^\d{1,4}\s*\/\s*\d{1,4}$/.test(s) ||                          // 12 / 200
      /^(p\.?|page)\s*\d{1,4}$/i.test(s) ||                           // p.12, page 12
      /^\d{1,4}\s*쪽$/.test(s) ||                                     // 12쪽
      /^[ivxlcdm]{1,6}$/i.test(s);                                    // 로마 숫자 쪽 번호
  }

  // pdf.js getTextContent 의 items → 줄 목록 [{ text, y(0=위,1=아래), h }]
  function toLines(items, view) {
    var x0 = view ? view[0] : 0, y0 = view ? view[1] : 0, y1 = view ? view[3] : 842, pw = view ? (view[2] - view[0]) : 595;
    var ph = (y1 - y0) || 842, rows = [];
    (items || []).forEach(function (it) {
      if (!it || typeof it.str !== 'string') return;
      var t = it.transform || [1, 0, 0, 1, 0, 0];
      var h = Math.abs(it.height || t[3] || 10), x = t[4] - x0, y = (y1 - t[5]) / ph;
      var last = rows[rows.length - 1];
      if (last && Math.abs(last.yAbs - t[5]) <= Math.max(2, h * 0.45)) {
        var gap = x - last.xEnd;
        if (it.str && last.text && gap > h * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(it.str)) last.text += ' ';
        last.text += it.str; last.xEnd = x + (it.width || 0); last.h = Math.max(last.h, h);
        if (it.hasEOL) last.eol = true;
      } else {
        if (!it.str.trim() && !last) return;
        rows.push({ text: it.str, y: y, yAbs: t[5], h: h, xEnd: x + (it.width || 0), eol: !!it.hasEOL });
      }
    });
    return rows.map(function (r) { return { text: r.text.replace(/\s+/g, ' ').trim(), y: r.y, h: r.h / ph, w: pw }; })
      .filter(function (r) { return r.text; });
  }

  // 군더더기 거르기: 쪽 번호는 어디서든, 짧은 줄은 위·아래 띠에 있을 때만(또는 여러 쪽에 되풀이되는 머리글)
  function cleanLines(lines, seenHeads) {
    var n = lines.length;
    return lines.filter(function (l, i) {
      var t = l.text;
      if (isPageNo(t)) return false;
      // 띠 안이면서 본문과 떨어져 있어야(줄 높이의 2.2배 넘는 틈) 머리글·꼬리글로 본다
      var nb = l.y < 0.5 ? lines[i + 1] : lines[i - 1];
      var apart = !nb || Math.abs(nb.y - l.y) > Math.max(l.h, nb.h) * 2.2;
      var inBand = (l.y < BAND || l.y > 1 - BAND) && apart;
      var edge = i === 0 || i === n - 1 || inBand;
      var key = t.replace(/\d+/g, '#');
      if (edge && t.length <= 40 && !END.test(t) && seenHeads && seenHeads[key] >= 2) return false;   // 쪽마다 같은 머리글
      if (inBand && t.length <= 40 && !/[.?!。…]["”’』」)]*$/.test(t)) return false;  // 띠 안의 짧은 표제(문장 끝 아님)
      return true;
    });
  }
  function noteHeads(lines, seenHeads) {
    lines.forEach(function (l, i) {
      if ((l.y < BAND || l.y > 1 - BAND || i === 0 || i === lines.length - 1) && l.text.length <= 40 && !END.test(l.text)) {
        var key = l.text.replace(/\d+/g, '#'); seenHeads[key] = (seenHeads[key] || 0) + 1;
      }
    });
  }

  // 줄 → 문단(줄 사이가 크게 벌어지면 새 문단)
  function toParas(lines) {
    var paras = [], buf = [], prev = null;
    lines.forEach(function (l) {
      var gap = prev ? (l.y - prev.y) : 0, lh = prev ? prev.h : l.h;
      if (prev && (gap > lh * 2.1 || gap < 0)) { paras.push(buf.join(' ')); buf = []; }
      buf.push(l.text); prev = l;
    });
    if (buf.length) paras.push(buf.join(' '));
    return paras.map(function (p) { return p.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  }

  // 문장 나누기: . ? ! 。 … 기준(닫는 따옴표·괄호까지), 너무 긴 문장은 쉼표에서
  var END = /[.?!。…]["”’』」)\]]*$/;
  function splitSentences(text) {
    var out = [], parts = String(text || '').replace(/\s+/g, ' ').trim()
      .match(/[^.?!。…]+[.?!。…]+["”’』」)\]]*\s*|[^.?!。…]+$/g) || [];
    parts.forEach(function (p) {
      p = p.trim(); if (!p) return;
      if (/^[.?!。…"”’』」)\]\s]+$/.test(p) && out.length) { out[out.length - 1] += p; return; } // 홀로 남은 부호
      while (p.length > 160) { var c = p.lastIndexOf(',', 160); if (c < 40) c = p.lastIndexOf(' ', 160); if (c < 40) c = 160; out.push(p.slice(0, c + 1).trim()); p = p.slice(c + 1).trim(); }
      if (p) out.push(p);
    });
    return out.filter(function (s) { return /[0-9A-Za-z가-힣ㄱ-ㅎ一-龥]/.test(s); }); // 부호만 있는 조각은 읽지 않음
  }

  // 한 쪽 → 읽을 문장 목록 [{ text, gap }] (gap: 문단 끝이라 한 숨 쉼)
  function pageSentences(items, view, seenHeads) {
    var lines = toLines(items, view);
    var clean = cleanLines(lines, seenHeads);
    if (seenHeads) noteHeads(lines, seenHeads);
    var out = [];
    toParas(clean).forEach(function (p) {
      var ss = splitSentences(p);
      ss.forEach(function (s, k) { out.push({ text: s, gap: k === ss.length - 1 }); });
    });
    return out;
  }

  var Core = { isPageNo: isPageNo, toLines: toLines, cleanLines: cleanLines, toParas: toParas, splitSentences: splitSentences, pageSentences: pageSentences, END: END };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

  /* ================= 2) 화면: 단추·막대·읽기 ================= */
  var doc = root.document, synth = root.speechSynthesis;
  root.MJListen = { core: Core };
  if (!doc || !synth || typeof root.SpeechSynthesisUtterance === 'undefined') return; // 읽기 기능이 없는 기기: 단추를 만들지 않는다

  var KEY = 'mj:listen', PITCH = 0.95;
  var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var S = { queue: [], i: 0, page: 0, book: '', playing: false, paused: false, loading: false, voice: null,
    rate: saved.rate || 0.9, cont: saved.cont !== false, carry: '', heads: {}, timer: null, gen: 0, selfTurn: 0 };
  function host() { return root.MJ_HOST || null; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ rate: S.rate, cont: S.cont, voice: S.voice && S.voice.name })); } catch (e) {} }

  var css =
    '.tools{grid-template-columns:repeat(9,1fr)}' +
    '.tool#listenBtn[aria-pressed="true"]{color:var(--dahong);font-weight:700;box-shadow:inset 0 -3px 0 var(--dahong);background:#fff}' +
    '.lsbar{position:fixed;left:8px;right:8px;bottom:calc(var(--tools-h) + var(--safe-b) + 8px);z-index:28;max-width:560px;margin:0 auto;display:flex;align-items:center;gap:6px;padding:6px 8px;background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-layer);font-size:13px;color:var(--ink)}' +
    'body.paged .lsbar{bottom:calc(var(--tools-h) + var(--safe-b) + 58px)}' +
    '.lsbar button,.lsbar select{min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit;cursor:pointer}' +
    '.lsbar button{min-width:44px;font-size:17px;padding:0 8px}' +
    '.lsbar .ls-main{background:var(--dahong);border-color:var(--dahong);color:#fff}' +
    '.lsbar .ls-cont{font-size:13px;font-weight:700}.lsbar .ls-cont[aria-pressed="true"]{background:#FFF4F1;border-color:var(--dahong);color:var(--dahong)}' +
    '.lsbar select{padding:0 4px;max-width:30%}' +
    '.lsbar .ls-t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ink-2)}' +
    '@media (max-width:480px){.lsbar{gap:4px;padding:5px}.lsbar button{min-width:40px;padding:0 6px}.lsbar .ls-voice{display:none}}';
  var st = doc.createElement('style'); st.textContent = css; doc.head.appendChild(st);

  // 도구 줄 단추 (쪽 이동 단추 앞)
  var tools = doc.getElementById('tools'); if (!tools) return;
  var btn = doc.createElement('button');
  btn.id = 'listenBtn'; btn.className = 'tool'; btn.type = 'button'; btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-label', '이 쪽 소리 내어 듣기');
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>듣기</span>';
  var pg = doc.getElementById('pageBtn'); tools.insertBefore(btn, pg || null);

  var bar = doc.createElement('div'); bar.className = 'lsbar'; bar.hidden = true; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '듣기');
  bar.innerHTML = '<button type="button" class="ls-main" aria-label="재생">▶</button>' +
    '<button type="button" class="ls-stop" aria-label="정지">⏹</button>' +
    '<span class="ls-t" aria-live="polite"></span>' +
    '<button type="button" class="ls-cont" aria-pressed="true" aria-label="다음 쪽 이어 읽기">이어</button>' +
    '<select class="ls-rate" aria-label="읽는 빠르기"><option value="0.8">천천히</option><option value="0.9">편지</option><option value="1">보통</option><option value="1.15">빠르게</option></select>' +
    '<select class="ls-voice" aria-label="목소리"></select>';
  var reader = doc.getElementById('reader'); (reader || doc.body).appendChild(bar);
  var mainB = bar.querySelector('.ls-main'), stopB = bar.querySelector('.ls-stop'), info = bar.querySelector('.ls-t'),
    contB = bar.querySelector('.ls-cont'), rateSel = bar.querySelector('.ls-rate'), voiceSel = bar.querySelector('.ls-voice');
  rateSel.value = String(S.rate); if (!rateSel.value) { rateSel.value = '0.9'; S.rate = 0.9; }

  // 목소리: 자연스러운 한국어 목소리 먼저
  function rankVoice(v) {
    var n = (v.name || '').toLowerCase(), s = 0;
    if (!/^ko/i.test(v.lang || '')) return -1;
    if (/natural|neural|online/.test(n)) s += 50;
    if (/google/.test(n)) s += 30;
    if (/sunhi|선희|yuna|유나|heami/.test(n)) s += 10;
    if (v.localService) s += 2;
    return s;
  }
  function koVoices() { return synth.getVoices().filter(function (v) { return rankVoice(v) >= 0; }).sort(function (a, b) { return rankVoice(b) - rankVoice(a); }); }
  function pickVoice() {
    var list = koVoices();
    S.voice = list.find(function (v) { return v.name === saved.voice; }) || list[0] || null;
    voiceSel.innerHTML = '';
    list.forEach(function (v) { var o = doc.createElement('option'); o.value = v.name; o.textContent = v.name.replace(/Microsoft |Google |\(.*?\)| - .*$/g, '').trim() || v.name; voiceSel.appendChild(o); });
    voiceSel.style.display = list.length > 1 ? '' : 'none';
    if (S.voice) voiceSel.value = S.voice.name;
  }

  function show() {
    var on = S.playing && !S.paused;
    bar.hidden = !(S.playing || S.paused || S.loading);
    btn.setAttribute('aria-pressed', bar.hidden ? 'false' : 'true');
    mainB.textContent = on ? '⏸' : '▶'; mainB.setAttribute('aria-label', on ? '멈춤' : (S.paused ? '이어 듣기' : '재생'));
    contB.setAttribute('aria-pressed', S.cont ? 'true' : 'false');
    var it = S.queue[S.i];
    info.textContent = S.loading ? S.page + '쪽 읽을 준비…' : (S.page ? S.page + '쪽' : '') + (it ? ' · ' + it.text : '');
  }
  function toast(msg) { var t = doc.getElementById('toast'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2200); }

  // 쪽 글 불러오기 → 문장 목록 (앞 쪽에서 끝나지 않은 문장은 이어 붙임)
  function loadPage(n, gen) {
    var h = host(); if (!h || !h.isOpen()) return Promise.reject(new Error('closed'));
    S.loading = true; S.page = n; show();
    return h.text(n).then(function (r) {
      if (gen !== S.gen) return null;
      var q = pageSentences(r.items, r.view, S.heads);
      if (S.carry) {
        if (q.length) q[0].text = S.carry + ' ' + q[0].text; else q.push({ text: S.carry, gap: true });
        S.carry = '';
      }
      // 쪽 끝 문장이 끝나지 않았고 이어 읽기면 다음 쪽 첫 문장과 붙여 읽는다
      if (S.cont && q.length && n < h.pages() && !END.test(q[q.length - 1].text)) S.carry = q.pop().text;
      S.queue = q; S.i = 0; S.loading = false;
      return q;
    });
  }

  function startAt(n) {
    var h = host(); if (!h || !h.isOpen()) { toast('책을 연 뒤 들을 수 있어요.'); return; }
    synth.cancel(); clearTimeout(S.timer);
    var gen = ++S.gen; S.book = h.bookId(); S.carry = ''; S.playing = true; S.paused = false;
    loadPage(n, gen).then(function (q) {
      if (!q || gen !== S.gen) return;
      if (!q.length && !S.carry) { // 그림·빈 쪽
        if (S.cont && n < h.pages()) { nextPage(gen); return; }
        toast('이 쪽에는 읽을 글자가 없어요.'); stop(); return;
      }
      speakNext(gen);
    }).catch(function (e) { if (gen === S.gen) { console.warn('listen', e); toast('이 쪽 글을 읽지 못했어요.'); stop(); } });
  }

  function nextPage(gen) {
    var h = host(); if (!h || !h.isOpen() || gen !== S.gen) return;
    var n = S.page + 1;
    if (n > h.pages()) { toast('마지막 쪽까지 읽었어요.'); stop(); return; }
    S.selfTurn = n; h.go(n);
    loadPage(n, gen).then(function (q) {
      if (!q || gen !== S.gen) return;
      if (!q.length && !S.carry) { nextPage(gen); return; }
      S.timer = setTimeout(function () { speakNext(gen); }, 500);
    }).catch(function (e) { if (gen === S.gen) { console.warn('listen', e); stop(); } });
  }

  function speakNext(gen) {
    clearTimeout(S.timer);
    if (gen !== S.gen || !S.playing || S.paused) return;
    var h = host();
    if (!h || !h.isOpen() || h.bookId() !== S.book) { stop(); return; }           // 책을 닫았거나 바꿈
    var now = h.page();
    if (now !== S.page && now !== S.selfTurn) { startAt(now); return; }            // 사람이 쪽을 넘김 → 그 쪽부터
    if (S.i >= S.queue.length) {
      if (S.cont) { nextPage(gen); return; }
      if (S.carry) { S.queue.push({ text: S.carry, gap: true }); S.carry = ''; }
      else { stop(); return; }
    }
    var it = S.queue[S.i];
    var u = new root.SpeechSynthesisUtterance(it.text);
    u.lang = S.voice ? S.voice.lang : 'ko-KR'; if (S.voice) u.voice = S.voice;
    u.rate = S.rate; u.pitch = PITCH;
    u.onend = function () {
      if (gen !== S.gen || !S.playing || S.paused) return;
      S.i++; S.timer = setTimeout(function () { speakNext(gen); }, it.gap ? 650 : 180);
    };
    u.onerror = function (e) {
      if (e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      if (gen !== S.gen) return; S.i++; speakNext(gen);
    };
    show();
    synth.speak(u);
  }

  // 멈춤: 안드로이드 크롬의 pause()가 불안정해 지금 문장을 기억해 두고 끊었다가, 다시 누르면 그 문장부터
  function pause() { S.paused = true; clearTimeout(S.timer); synth.cancel(); show(); }
  function resume() { if (!S.paused) return; S.paused = false; S.playing = true; show(); speakNext(S.gen); }
  function stop() { S.gen++; S.playing = false; S.paused = false; S.loading = false; clearTimeout(S.timer); synth.cancel(); S.queue = []; S.i = 0; S.carry = ''; S.selfTurn = 0; show(); }

  btn.addEventListener('click', function () {
    if (S.playing || S.paused || S.loading) { stop(); return; }
    var h = host(); startAt(h && h.isOpen() ? h.page() : 1);
  });
  mainB.addEventListener('click', function () { if (S.playing && !S.paused) pause(); else if (S.paused) resume(); else { var h = host(); if (h) startAt(h.page()); } });
  stopB.addEventListener('click', stop);
  contB.addEventListener('click', function () {
    S.cont = !S.cont; save(); show();
    toast(S.cont ? '쪽 끝에서 다음 쪽으로 이어 읽어요.' : '이 쪽까지만 읽어요.');
  });
  rateSel.addEventListener('change', function () { S.rate = parseFloat(rateSel.value) || 0.9; save(); if (S.playing && !S.paused) { synth.cancel(); speakNext(S.gen); } });
  voiceSel.addEventListener('change', function () { S.voice = koVoices().find(function (v) { return v.name === voiceSel.value; }) || S.voice; save(); if (S.playing && !S.paused) { synth.cancel(); speakNext(S.gen); } });

  // 책 목록으로 나가면 멈춤
  root.addEventListener('hashchange', function () { setTimeout(function () { var h = host(); if ((S.playing || S.paused) && (!h || !h.isOpen())) stop(); }, 50); });
  root.addEventListener('pagehide', function () { synth.cancel(); });

  pickVoice();
  if (typeof synth.onvoiceschanged !== 'undefined') synth.addEventListener('voiceschanged', pickVoice);
  root.MJListen = { core: Core, start: startAt, pause: pause, resume: resume, stop: stop, state: function () { return { playing: S.playing, paused: S.paused, page: S.page, i: S.i, n: S.queue.length, cont: S.cont, speaking: synth.speaking, text: S.queue[S.i] && S.queue[S.i].text }; } };
})(typeof window !== 'undefined' ? window : this);
