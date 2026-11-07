/* victorview 밑줄펜 — 듣기(소리 내어 읽기). 2026-11-07 시장 지시 "음성 기능 시험".
   무료: 브라우저 안의 목소리(speechSynthesis)만 쓴다. 서버·요금·외부 전송 없음.
   - 도구 줄에 "듣기" 단추. 누르면 지금 쪽 글을 문장 단위로 읽고 화면 아래 작은 막대(▶/⏸, ⏹, 빠르기, 목소리, 이어 읽기).
   - 쪽 끝까지 읽으면 다음 쪽으로 넘어가 이어 읽기(막대의 "이어" 단추로 켜고 끔, 기기에 기억).
   - 쪽 번호·머리글·꼬리글 같은 군더더기는 글자 위치(쪽 위·아래 띠)와 모양(숫자만, 짧은 줄 반복)으로 걸러 낸다.
   - app.js 와는 window.MJ_HOST(쪽 글자 빌려주기)로만 이어진다. 밑줄·메모·잠금 코드는 건드리지 않는다.
   편지 읽는 목소리: 빠르기 0.9, 높이 0.95 (읽어주기/readaloud.js 와 같은 기준).
   2026-11-07 시장 "이번에 만든 목소리들을 선택하게": 막대의 목소리 단추 → 작은 창에서 기기 목소리(여자/남자)와
   우리 목소리(Supertonic 3 견본 9개, AI 음성 표시, ▶ 미리 듣기 audio/samples/*.mp3) 중 고른다.
   우리 목소리를 고르고 그 책에 books/audio/<책>/list.enc 가 있으면 장 단위로 튼다(앞뒤 장·빠르기=playbackRate·이어 듣기).
   잠긴 오디오는 app.js 의 MJ_HOST.unseal(오디오 용도만)로 풀고, 풀린 소리는 메모리(Blob)에만 둔다. 없으면 기기 목소리로. */
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

  /* ================= 1-2) 우리 목소리(장별 잠긴 오디오) — 순수 함수 ================= */
  // 견본 9개(Supertonic 3, AI 음성). 파일은 audio/samples/<id>.mp3 (공개 견본이라 잠그지 않음, 64kbps 모노, 앞 2분 남짓)
  var SAMPLES = [
    { id: 'f1', name: '여1 · 차분', note: '가장 고르고 담담하게 읽어요' },
    { id: 'f2', name: '여2 · 낮게', note: '낮고 차분해요. 조금 느리게 읽어요' },
    { id: 'f3', name: '여3 · 부드럽게', note: '낮고 부드러워요. 말끝이 살아 있어요' },
    { id: 'm1', name: '남1 · 낮게', note: '가장 낮고 고른, 깊은 목소리예요' },
    { id: 'm2', name: '남2 · 차분', note: '낮고 담담하고 또렷해요' },
    { id: 'm3', name: '남3 · 따뜻하게', note: '낮고 따뜻해요. 쉼이 넉넉해요' },
    { id: 'f2a', name: '여2 · 조금 차분', note: '여2를 조금 더 느리게, 쉼을 넉넉히' },
    { id: 'f2b', name: '여2 · 더 차분', note: '가장 느린 빠르기예요. 잠들기 전에' },
    { id: 'f2c', name: '여2 · 고요히', note: '쉼이 가장 길고 고요해요' }
  ];
  function sampleById(id) { for (var i = 0; i < SAMPLES.length; i++) if (SAMPLES[i].id === id) return SAMPLES[i]; return null; }

  // list.enc 를 푼 JSON → { book, voice, chapters:[{no,title,kind,page,file,sec}], total } (잘못된 항목은 버림, 장 번호 순)
  function parseAudioList(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.chapters)) return null;
    var ch = o.chapters.filter(function (c) { return c && /^c\d{3}\.enc$/.test(c.file || '') && typeof c.title === 'string'; })
      .map(function (c) {
        return { no: String(c.no || c.file.slice(1, 4)), title: c.title.trim() || ('장 ' + c.file.slice(1, 4)), kind: c.kind || '장',
          page: Math.max(0, parseInt(c.page, 10) || 0), file: c.file, sec: Math.max(0, +c.sec || 0), h: /^[0-9a-f]{6,64}$/.test(c.h || '') ? c.h : '' };
      })
      .sort(function (a, b) { return a.no < b.no ? -1 : a.no > b.no ? 1 : 0; });
    if (!ch.length) return null;
    return { book: String(o.book || ''), voice: sampleById(o.voice) ? o.voice : '', chapters: ch,
      total: ch.reduce(function (t, c) { return t + c.sec; }, 0) };
  }
  // 지금 쪽이 들어 있는 장: 시작 쪽이 지금 쪽 이하인 장 중 가장 뒤의 쪽(같은 쪽이면 앞 장). 쪽을 하나도 모르면 -1
  function chapterForPage(list, page) {
    if (!list) return -1;
    var best = -1, bestPage = 0, any = false;
    list.chapters.forEach(function (c, i) {
      if (c.page > 0) { any = true; if (c.page <= page && c.page > bestPage) { best = i; bestPage = c.page; } }
    });
    if (!any) return -1;
    return best < 0 ? 0 : best;
  }
  function stepChapter(list, i, d) { var j = i + d; return list && j >= 0 && j < list.chapters.length ? j : -1; }
  // 빠르기 고르기(천천히 0.8 · 편지 0.9 · 보통 1 · 빠르게 1.15) → 오디오 배속. 우리 목소리는 이미 편지 빠르기로 읽었으므로 '편지'=1배
  function playRate(r) { r = +r || 0.9; return Math.min(2, Math.max(0.5, Math.round(r / 0.9 * 100) / 100)); }
  function fmtTime(s) { s = Math.max(0, Math.floor(+s || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function audioUrl(book, file, ver) {
    if (!/^\d{2}$/.test(book || '') || !/^(list|c\d{3})\.enc$/.test(file || '')) return '';
    return 'books/audio/' + book + '/' + file + (ver ? '?v=' + encodeURIComponent(ver) : '');
  }

  var Core = { isPageNo: isPageNo, toLines: toLines, cleanLines: cleanLines, toParas: toParas, splitSentences: splitSentences, pageSentences: pageSentences, END: END,
    SAMPLES: SAMPLES, sampleById: sampleById, parseAudioList: parseAudioList, chapterForPage: chapterForPage, stepChapter: stepChapter, playRate: playRate, fmtTime: fmtTime, audioUrl: audioUrl };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }

  /* ================= 2) 화면: 단추·막대·읽기 ================= */
  var doc = root.document;
  root.MJListen = { core: Core };
  if (!doc) return;
  var hasSynth = !!(root.speechSynthesis && typeof root.SpeechSynthesisUtterance !== 'undefined');
  function noop() {}
  // 기기 목소리가 없는 기기에서도 우리 목소리는 들을 수 있게 빈 대역을 둔다
  var synth = hasSynth ? root.speechSynthesis : { cancel: noop, speak: noop, getVoices: function () { return []; }, speaking: false, addEventListener: noop };

  var KEY = 'mj:listen', POSKEY = 'mj:listen:pos', PITCH = 0.95;
  var PITCH_BY = { f: 0.92, m: 0.95 }; // 부드러운 책 읽기: 여자는 원래 높이, 남자는 살짝 낮게(2026-11-07 시장)
  var saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var S = { queue: [], i: 0, page: 0, book: '', playing: false, paused: false, loading: false, voice: null,
    rate: saved.rate || 0.9, gender: saved.gender || 'f', cont: saved.cont !== false, carry: '', heads: {}, timer: null, gen: 0, selfTurn: 0,
    src: (saved.src === 'ours' || !hasSynth) ? 'ours' : 'device', ours: sampleById(saved.ours) ? saved.ours : 'f2', mode: '' };
  function host() { return root.MJ_HOST || null; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ rate: S.rate, cont: S.cont, gender: S.gender, voice: S.voice && S.voice.name, src: S.src, ours: S.ours })); } catch (e) {} }

  var css =
    '.tools{grid-template-columns:repeat(8,1fr)}' +
    '.tool#listenBtn[aria-pressed="true"]{color:var(--dahong);font-weight:700;box-shadow:inset 0 -3px 0 var(--dahong);background:#fff}' +
    '.lsbar{position:fixed;left:8px;right:8px;bottom:calc(var(--tools-h) + var(--safe-b) + 8px);z-index:28;max-width:560px;margin:0 auto;display:flex;align-items:center;gap:6px;padding:6px 8px;background:#fff;border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-layer);font-size:13px;color:var(--ink)}' +
    'body.paged .lsbar{bottom:calc(var(--tools-h) + var(--safe-b) + 58px)}' +
    '.lsbar button,.lsbar select{min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);font:inherit;cursor:pointer}' +
    '.lsbar button{min-width:44px;font-size:17px;padding:0 8px}' +
    '.lsbar .ls-main{background:var(--dahong);border-color:var(--dahong);color:#fff}' +
    '.lsbar .ls-cont,.lsbar .ls-vbtn{font-size:13px;font-weight:700}.lsbar .ls-cont[aria-pressed="true"]{background:#FFF4F1;border-color:var(--dahong);color:var(--dahong)}' +
    '.lsbar select{padding:0 4px;max-width:30%}' +
    '.lsbar .ls-t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ink-2)}' +
    '.lsbar.ours{flex-wrap:wrap}.lsbar.ours .ls-t{flex:1 0 100%;order:-1;padding:0 4px}' +
    '@media (max-width:480px){.lsbar{gap:4px;padding:5px}.lsbar button{min-width:40px;padding:0 6px}}' +
    // 목소리 고르기 창
    '.ls-card h3{font-size:16px;margin:0 0 4px}.ls-card h3 small{font-size:12px;font-weight:700;color:var(--dahong);margin-left:6px}' +
    '.ls-card .ls-sec{display:flex;flex-direction:column;gap:8px}.ls-card .muted{margin:0}' +
    '.ls-seg{display:flex;gap:6px}.ls-seg button{flex:1;min-height:48px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink);font:inherit;font-weight:700;cursor:pointer}' +
    '.ls-seg button[aria-checked="true"],.ls-pick[aria-checked="true"]{border-color:var(--dahong);box-shadow:inset 0 0 0 1px var(--dahong);background:#FFF4F1;color:var(--dahong)}' +
    '.ls-card select{min-height:44px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);font:inherit;padding:0 8px}' +
    '.ls-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.ls-list li{display:flex;gap:6px}' +
    '.ls-pick{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;text-align:left;min-height:52px;padding:6px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink);font:inherit;cursor:pointer}' +
    '.ls-pick b{font-size:15px}.ls-pick span{font-size:13px;color:var(--ink-2);font-weight:400}.ls-pick i{font-style:normal;font-size:12px;font-weight:700;color:var(--green);margin-left:6px}' +
    '.ls-try{flex:none;width:52px;min-height:52px;border:1px solid var(--line);border-radius:12px;background:var(--paper);color:var(--ink);font-size:17px;cursor:pointer}.ls-try[aria-pressed="true"]{background:var(--dahong);border-color:var(--dahong);color:#fff}' +
    '.ls-ai{margin:0;font-size:13px;color:var(--ink-2)}';
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
    '<button type="button" class="ls-prev" aria-label="앞 장" hidden>⏮</button>' +
    '<button type="button" class="ls-next" aria-label="다음 장" hidden>⏭</button>' +
    '<span class="ls-t" aria-live="polite"></span>' +
    '<button type="button" class="ls-vbtn" aria-haspopup="dialog" aria-label="목소리 고르기">여자</button>' +
    '<button type="button" class="ls-cont" aria-pressed="true" aria-label="이어 읽기">이어</button>' +
    '<select class="ls-rate" aria-label="읽는 빠르기"><option value="0.8">천천히</option><option value="0.9">편지</option><option value="1">보통</option><option value="1.15">빠르게</option></select>';
  var reader = doc.getElementById('reader'); (reader || doc.body).appendChild(bar);
  var mainB = bar.querySelector('.ls-main'), stopB = bar.querySelector('.ls-stop'), info = bar.querySelector('.ls-t'), prevB = bar.querySelector('.ls-prev'), nextB = bar.querySelector('.ls-next'),
    contB = bar.querySelector('.ls-cont'), vBtn = bar.querySelector('.ls-vbtn'), rateSel = bar.querySelector('.ls-rate');
  rateSel.value = String(S.rate); if (!rateSel.value) { rateSel.value = '0.9'; S.rate = 0.9; }

  // 목소리 고르기 창: 기기 목소리(여자/남자) · 우리 목소리(견본 9개, 미리 듣기)
  var sheet = doc.createElement('div'); sheet.id = 'lsSheet'; sheet.className = 'sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'lsSheetT');
  sheet.innerHTML = '<div class="sheet-card ls-card">' +
    '<h2 id="lsSheetT">목소리 고르기</h2>' +
    '<section class="ls-sec"><h3>기기 목소리</h3><p class="muted">이 기기에 들어 있는 목소리예요. 모든 책을 읽어요.</p>' +
    '<div class="ls-seg" role="radiogroup" aria-label="기기 목소리"><button type="button" role="radio" data-dev="f">여자</button><button type="button" role="radio" data-dev="m">남자</button></div>' +
    '<select class="ls-voice" aria-label="기기 목소리 이름"></select></section>' +
    '<section class="ls-sec"><h3>우리 목소리<small>AI 음성</small></h3><p class="muted ls-note"></p>' +
    '<ul class="ls-list" role="radiogroup" aria-label="우리 목소리">' + SAMPLES.map(function (s) {
      return '<li><button type="button" class="ls-pick" role="radio" data-id="' + s.id + '"><b>' + s.name + '</b><span>' + s.note + '</span></button>' +
        '<button type="button" class="ls-try" data-try="' + s.id + '" aria-pressed="false" aria-label="' + s.name + ' 미리 듣기">▶</button></li>';
    }).join('') + '</ul>' +
    '<p class="ls-ai">AI 음성으로 읽었습니다.</p></section>' +
    '<button type="button" class="btn ghost wide ls-close">닫기</button></div>';
  doc.body.appendChild(sheet);
  var voiceSel = sheet.querySelector('.ls-voice'), noteEl = sheet.querySelector('.ls-note');

  // 목소리: 부드러운 한국어 목소리 먼저, 여자·남자로 나눈다(2026-11-07 시장 "최대한 부드러운 책 읽어주는 음성, 남자 여자로 구분")
  // 이름으로 성별을 가린다(읽기 API는 성별을 알려 주지 않음). 엣지: SunHi·InJoon·Hyunsu 신경망, 안드로이드 구글: ism·kob(여)·koc·kod(남), 삼성: f·m, 애플: Yuna·Sora(여)·Minsu(남)
  var F_RE = /sunhi|선희|heami|해미|yuna|유나|sora|소라|jimin|지민|seohyeon|서현|soonbok|순복|yujin|유진|seoyeon|서연|x-ism|x-kob|smtf|google 한국의|female|여성|여자/i;
  var M_RE = /injoon|인준|hyunsu|현수|bongjin|봉진|gookmin|국민|minsu|민수|jinho|진호|x-koc|x-kod|smtm|(^|[^e])male|남성|남자/i;
  function genderOf(v) { var n = (v.name || '') + ' ' + (v.voiceURI || ''); if (F_RE.test(n)) return 'f'; if (M_RE.test(n)) return 'm'; return ''; }
  function rankVoice(v) {
    var n = (v.name || '').toLowerCase(), s = 0;
    if (!/^ko/i.test(v.lang || '')) return -1;
    if (/natural|neural|online|multilingual|premium|enhanced|고품질/.test(n)) s += 50;  // 신경망·고품질이 가장 부드럽다
    if (/google/.test(n)) s += 30;
    if (/sunhi|선희|injoon|인준|hyunsu|현수|yuna|유나/.test(n)) s += 10;
    if (!v.localService) s += 3;   // 온라인 목소리가 대개 더 자연스럽다
    return s;
  }
  function koVoices() { return synth.getVoices().filter(function (v) { return rankVoice(v) >= 0; }).sort(function (a, b) { return rankVoice(b) - rankVoice(a); }); }
  function bestOf(g) { var l = koVoices().filter(function (v) { return genderOf(v) === g; }); return l[0] || null; }
  function pickVoice() {
    var list = koVoices();
    var keep = list.find(function (v) { return v.name === saved.voice && (genderOf(v) === S.gender || !genderOf(v)); });
    S.voice = keep || bestOf(S.gender) || list[0] || null;
    if (S.voice && genderOf(S.voice)) S.gender = genderOf(S.voice);
    voiceSel.innerHTML = '';
    list.forEach(function (v) { var g = genderOf(v); var o = doc.createElement('option'); o.value = v.name; o.textContent = (g === 'f' ? '여 · ' : g === 'm' ? '남 · ' : '') + (v.name.replace(/Microsoft |Google |\(.*?\)| - .*$/g, '').trim() || v.name); voiceSel.appendChild(o); });
    voiceSel.style.display = list.length > 1 ? '' : 'none';
    if (S.voice) voiceSel.value = S.voice.name;
    showVoice();
  }

  function oursActive() { return S.mode ? S.mode === 'ours' : S.src === 'ours'; }
  function showVoice() {
    vBtn.textContent = oursActive() ? '우리' : (S.gender === 'm' ? '남자' : '여자');
    vBtn.setAttribute('aria-label', '목소리 고르기 (지금: ' + (oursActive() ? '우리 목소리 ' + (sampleById(S.ours) || {}).name : '기기 ' + vBtn.textContent) + ')');
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-dev]'), function (b) { b.setAttribute('aria-checked', S.src === 'device' && b.getAttribute('data-dev') === S.gender ? 'true' : 'false'); b.disabled = !hasSynth; });
    Array.prototype.forEach.call(sheet.querySelectorAll('.ls-pick'), function (b) { b.setAttribute('aria-checked', S.src === 'ours' && b.getAttribute('data-id') === S.ours ? 'true' : 'false'); });
  }

  function show() {
    var on = S.playing && !S.paused, ours = S.mode === 'ours';
    bar.hidden = !(S.playing || S.paused || S.loading);
    bar.classList.toggle('ours', ours);
    prevB.hidden = nextB.hidden = !ours;
    btn.setAttribute('aria-pressed', bar.hidden ? 'false' : 'true');
    mainB.textContent = on ? '⏸' : '▶'; mainB.setAttribute('aria-label', on ? '멈춤' : (S.paused ? '이어 듣기' : '재생'));
    contB.setAttribute('aria-pressed', S.cont ? 'true' : 'false');
    contB.setAttribute('aria-label', ours ? '다음 장 이어 듣기' : '다음 쪽 이어 읽기');
    if (ours) {
      var c = A.list && A.list.chapters[A.i];
      info.textContent = (S.loading ? '불러오는 중… ' : '') + (c ? c.title : '') + ' · AI 음성';
      prevB.disabled = stepChapter(A.list, A.i, -1) < 0; nextB.disabled = stepChapter(A.list, A.i, 1) < 0;
    } else {
      var it = S.queue[S.i];
      info.textContent = S.loading ? S.page + '쪽 읽을 준비…' : (S.page ? S.page + '쪽' : '') + (it ? ' · ' + it.text : '');
    }
    showVoice();
  }
  function toast(msg) { var t = doc.getElementById('toast'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2600); }

  /* ---------- 기기 목소리: 쪽 글을 문장 단위로 ---------- */
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
    var h = host(); if (!h || !h.isOpen()) { toast(h ? '책을 연 뒤 들을 수 있어요.' : '새 판을 받는 중이에요. 앱을 닫았다 다시 열어 주세요.'); return; }
    if (!hasSynth) { toast('이 기기에는 기기 목소리가 없어요.'); stop(); return; }
    stopOurs(); synth.cancel(); clearTimeout(S.timer);
    var gen = ++S.gen; S.mode = 'device'; S.book = h.bookId(); S.carry = ''; S.playing = true; S.paused = false;
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
    if (gen !== S.gen || !S.playing || S.paused || S.mode !== 'device') return;
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
    u.rate = S.rate; u.pitch = PITCH_BY[S.voice && genderOf(S.voice) || S.gender] || PITCH;
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

  /* ---------- 우리 목소리: 책의 장별 잠긴 오디오 (books/audio/<책>/list.enc · cNNN.enc) ---------- */
  var SILENT = 'data:audio/mpeg;base64,/+MYxAAAAANIAAAAAExBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
  var au = new root.Audio(); au.preload = 'auto';
  var A = { list: null, book: '', i: 0, url: '', gen: 0, lists: {}, unlocked: false, saveT: 0 };
  function getPos(book) { try { return (JSON.parse(localStorage.getItem(POSKEY) || '{}') || {})[book] || null; } catch (e) { return null; } }
  function setPos(book, i, t) { try { var all = JSON.parse(localStorage.getItem(POSKEY) || '{}') || {}; all[book] = { i: i, t: Math.floor(t) }; localStorage.setItem(POSKEY, JSON.stringify(all)); } catch (e) {} }
  // 아이폰은 사람이 누른 그 순간에 한 번 소리를 내야 그 뒤 재생이 된다: 아주 짧은 무음으로 길을 터 둔다
  function unlockAudio() { if (A.unlocked) return; A.unlocked = true; try { au.src = SILENT; var p = au.play(); if (p && p.catch) p.catch(noop); } catch (e) {} }

  function fetchSealed(url, kind) {
    var h = host();
    return fetch(url).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer().then(function (b) { return h.unseal(b, kind); });
    });
  }
  // 낭독이 있는 책 번호(books/audio/index.json, 번호만·제목 없음). 없는 책에 list.enc 를 물어 404를 내지 않으려고 먼저 본다
  var idxP = null;
  function audioIndex() {
    if (!idxP) idxP = fetch('books/audio/index.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : { books: [] }; })
      .then(function (j) { return j && Array.isArray(j.books) ? j.books.map(String) : []; })
      .catch(function (e) { idxP = null; throw e; });
    return idxP;
  }
  // 책의 낭독 목록: 없으면(목록에 없음·404·못 풂) null 로 기억, 인터넷 끊김은 기억하지 않고 다음에 다시
  function getList(book) {
    var h = host();
    if (!h || typeof h.unseal !== 'function') return Promise.resolve(null);
    if (A.lists[book] !== undefined) return Promise.resolve(A.lists[book]);
    var url = audioUrl(book, 'list.enc', h.lockVer && h.lockVer());
    if (!url) return Promise.resolve(null);
    return audioIndex().then(function (ids) {
      if (ids.indexOf(book) < 0) return null;
      return fetchSealed(url, 'list');
    }).then(function (buf) {
      var l = null;
      if (buf) { try { l = parseAudioList(JSON.parse(new TextDecoder().decode(buf))); } catch (e) { l = null; } }
      A.lists[book] = l; return l;
    }, function (e) {
      if (e && e.message === 'locked') return null;
      if (/^HTTP|Failed|NetworkError|Load failed/i.test(e && e.message || '')) throw e;   // 인터넷 문제: 기억하지 않음
      A.lists[book] = null; return null;                                                // 못 푸는 파일(다른 잠금) = 낭독 없음
    });
  }

  function startOurs() {
    var h = host(); if (!h || !h.isOpen()) { toast(h ? '책을 연 뒤 들을 수 있어요.' : '새 판을 받는 중이에요. 앱을 닫았다 다시 열어 주세요.'); return; }
    unlockAudio();
    synth.cancel(); clearTimeout(S.timer);
    var gen = ++A.gen, book = h.bookId();
    S.gen++; S.mode = 'ours'; S.book = book; S.playing = true; S.paused = false; S.loading = true; A.list = null; show();
    getList(book).then(function (l) {
      if (gen !== A.gen) return;
      if (!l) {
        S.loading = false; S.mode = '';
        toast('이 책은 아직 우리 목소리 낭독이 없어요. 기기 목소리로 읽을게요.');
        if (hasSynth) startAt(h.page()); else stop();
        return;
      }
      A.list = l; A.book = book;
      if (l.voice && l.voice !== S.ours) toast('이 책은 ' + sampleById(l.voice).name + ' 목소리로 낭독돼 있어요. AI 음성이에요.');
      var byPage = chapterForPage(l, h.page()), pos = getPos(book), i = 0, t = 0;
      if (pos && pos.i >= 0 && pos.i < l.chapters.length && (byPage < 0 || byPage === pos.i)) { i = pos.i; t = pos.t || 0; }
      else if (byPage >= 0) i = byPage;
      playChapter(i, t);
    }, function (e) {
      if (gen !== A.gen) return;
      console.warn('listen', e); toast('인터넷이 없어 낭독 목록을 불러오지 못했어요.'); stop();
    });
  }

  function playChapter(i, t) {
    var h = host(), l = A.list;
    if (!l || i < 0 || i >= l.chapters.length || !h || !h.isOpen() || h.bookId() !== A.book) { stop(); return; }
    var gen = ++A.gen, c = l.chapters[i];
    A.i = i; S.loading = true; S.playing = true; S.paused = false; show();
    if (c.page > 0 && c.page <= h.pages() && h.page() !== c.page) h.go(c.page);          // 그 장의 쪽으로 (추정)
    fetchSealed(audioUrl(A.book, c.file, c.h || h.lockVer()), 'audio').then(function (buf) {
      if (gen !== A.gen) return;
      if (!buf) throw new Error('없는 장');
      if (A.url) URL.revokeObjectURL(A.url);
      A.url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      au.src = A.url;
      au.playbackRate = playRate(S.rate);
      if (t > 0) { au.addEventListener('loadedmetadata', function seek() { au.removeEventListener('loadedmetadata', seek); if (t < (au.duration || 0) - 2) au.currentTime = t; }); }
      S.loading = false; show();
      var p = au.play();
      if (p && p.catch) p.catch(function (e) { if (gen === A.gen && e && e.name === 'NotAllowedError') { S.paused = true; show(); toast('▶를 눌러 들어 주세요.'); } });
      au.playbackRate = playRate(S.rate);
      var nx = stepChapter(l, i, 1);   // 다음 장을 미리 받아 둔다(한 번 받으면 오프라인에서도)
      if (nx >= 0) setTimeout(function () { if (gen === A.gen) fetch(audioUrl(A.book, l.chapters[nx].file, l.chapters[nx].h || h.lockVer())).catch(noop); }, 4000);
    }).catch(function (e) {
      if (gen !== A.gen) return;
      console.warn('listen', e); toast(/없는 장/.test(e.message) ? '이 장의 낭독 파일이 없어요.' : '이 장을 불러오지 못했어요. 인터넷을 확인해 주세요.'); stop();
    });
  }
  au.addEventListener('ended', function () {
    if (S.mode !== 'ours' || !A.list) return;
    var nx = stepChapter(A.list, A.i, 1);
    if (S.cont && nx >= 0) { setPos(A.book, nx, 0); playChapter(nx, 0); return; }
    setPos(A.book, nx >= 0 ? nx : 0, 0);
    toast(nx >= 0 ? '이 장을 다 들었어요.' : '마지막 장까지 들었어요.'); stop();
  });
  au.addEventListener('timeupdate', function () {
    if (S.mode !== 'ours' || S.loading || !A.list || au.src === SILENT) return;
    var now = Date.now(); if (now - A.saveT > 4000) { A.saveT = now; setPos(A.book, A.i, au.currentTime); }
  });
  au.addEventListener('error', function () {
    if (S.mode !== 'ours' || S.loading || !A.url || au.src !== A.url) return;
    toast('이 장을 재생하지 못했어요.'); stop();
  });
  function stopOurs() {
    A.gen++;
    if (S.mode === 'ours' && A.list && au.currentTime > 0 && !au.ended) setPos(A.book, A.i, au.currentTime);
    try { au.pause(); } catch (e) {}
    if (A.url) { au.removeAttribute('src'); try { au.load(); } catch (e) {} URL.revokeObjectURL(A.url); A.url = ''; }
  }

  // 멈춤: 안드로이드 크롬의 pause()가 불안정해 지금 문장을 기억해 두고 끊었다가, 다시 누르면 그 문장부터
  function pause() {
    S.paused = true; clearTimeout(S.timer);
    if (S.mode === 'ours') { au.pause(); if (A.list) setPos(A.book, A.i, au.currentTime); } else synth.cancel();
    show();
  }
  function resume() {
    if (!S.paused) return; S.paused = false; S.playing = true; show();
    if (S.mode === 'ours') { var p = au.play(); if (p && p.catch) p.catch(function () { S.paused = true; show(); }); }
    else speakNext(S.gen);
  }
  function stop() { stopOurs(); S.gen++; S.mode = ''; S.playing = false; S.paused = false; S.loading = false; clearTimeout(S.timer); synth.cancel(); S.queue = []; S.i = 0; S.carry = ''; S.selfTurn = 0; show(); }
  function start() { var h = host(); if (S.src === 'ours') startOurs(); else startAt(h && h.isOpen() ? h.page() : 1); }

  btn.addEventListener('click', function () { if (S.playing || S.paused || S.loading) { stop(); return; } start(); });
  mainB.addEventListener('click', function () { if (S.playing && !S.paused) pause(); else if (S.paused) resume(); else start(); });
  stopB.addEventListener('click', stop);
  prevB.addEventListener('click', function () { var j = stepChapter(A.list, A.i, -1); if (j >= 0) playChapter(j, 0); });
  nextB.addEventListener('click', function () { var j = stepChapter(A.list, A.i, 1); if (j >= 0) playChapter(j, 0); });
  contB.addEventListener('click', function () {
    S.cont = !S.cont; save(); show();
    if (S.mode === 'ours') toast(S.cont ? '장 끝에서 다음 장으로 이어 들어요.' : '이 장까지만 들어요.');
    else toast(S.cont ? '쪽 끝에서 다음 쪽으로 이어 읽어요.' : '이 쪽까지만 읽어요.');
  });
  rateSel.addEventListener('change', function () {
    S.rate = parseFloat(rateSel.value) || 0.9; save();
    if (S.mode === 'ours') au.playbackRate = playRate(S.rate);
    else if (S.playing && !S.paused) { synth.cancel(); speakNext(S.gen); }
  });

  /* ---------- 목소리 고르기 창 ---------- */
  var pv = new root.Audio(), pvId = '', pvUrls = {};
  function stopPreview() { try { pv.pause(); } catch (e) {} pvId = ''; Array.prototype.forEach.call(sheet.querySelectorAll('.ls-try'), function (b) { b.setAttribute('aria-pressed', 'false'); b.textContent = '▶'; }); }
  pv.addEventListener('ended', stopPreview);
  function preview(id, b) {
    if (pvId === id) { stopPreview(); return; }
    stopPreview();
    if (S.playing && !S.paused) pause();                 // 책 읽기는 멈춰 두고 견본만
    pvId = id; b.setAttribute('aria-pressed', 'true'); b.textContent = '⏸';
    try { pv.src = SILENT; var p0 = pv.play(); if (p0 && p0.catch) p0.catch(noop); } catch (e) {}   // 누른 순간에 길 트기(아이폰)
    var go = pvUrls[id] ? Promise.resolve(pvUrls[id]) : fetch('audio/samples/' + id + '.mp3').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (bl) { return (pvUrls[id] = URL.createObjectURL(bl)); });
    go.then(function (u) {
      if (pvId !== id) return;
      pv.src = u; var p = pv.play(); if (p && p.catch) p.catch(function (e) { if (pvId === id && e && e.name !== 'AbortError') stopPreview(); });
    }).catch(function (e) { console.warn('listen', e); if (pvId === id) { stopPreview(); toast('견본을 불러오지 못했어요. 인터넷을 확인해 주세요.'); } });
  }
  function openSheet() {
    var h = host(), book = h && h.isOpen() ? h.bookId() : '';
    noteEl.textContent = '플리니우스 편지 앞부분을 2분쯤 들어 볼 수 있어요.';
    sheet.hidden = false; showVoice();
    var mark = function (l) {
      Array.prototype.forEach.call(sheet.querySelectorAll('.ls-pick i'), function (x) { x.remove(); });
      if (l === undefined || !book) return;
      if (!l) { noteEl.textContent = '이 책은 아직 우리 목소리 낭독이 없어요. 견본만 들어 볼 수 있어요(플리니우스 편지 앞부분 2분).'; return; }
      var s = sampleById(l.voice);
      noteEl.textContent = '이 책은 우리 목소리 낭독이 있어요(' + l.chapters.length + '장' + (s ? ', ' + s.name : '') + '). 고르면 장마다 이어서 들려 드려요.';
      if (s) { var pick = sheet.querySelector('.ls-pick[data-id="' + s.id + '"] b'); if (pick) { var tag = doc.createElement('i'); tag.textContent = '이 책 낭독'; pick.appendChild(tag); } }
    };
    if (book) getList(book).then(mark, function () { mark(undefined); });
    var cur = sheet.querySelector('[aria-checked="true"]'); setTimeout(function () { (cur || sheet.querySelector('.ls-close')).focus(); }, 60);
  }
  function closeSheet() { stopPreview(); sheet.hidden = true; vBtn.focus(); }
  vBtn.addEventListener('click', openSheet);
  sheet.addEventListener('click', function (e) {
    if (e.target === sheet || e.target.closest('.ls-close')) { closeSheet(); return; }
    var t = e.target.closest('.ls-try'); if (t) { preview(t.getAttribute('data-try'), t); return; }
    var p = e.target.closest('.ls-pick');
    if (p) {
      stopPreview();
      S.src = 'ours'; S.ours = p.getAttribute('data-id'); save(); showVoice();
      if ((S.playing || S.paused) && S.mode !== 'ours') startOurs();
      else if (S.mode === 'ours' && A.list && A.list.voice && A.list.voice !== S.ours) toast('이 책은 ' + sampleById(A.list.voice).name + ' 목소리로만 낭독돼 있어요.');
      return;
    }
    var d = e.target.closest('[data-dev]');
    if (d) {
      var want = d.getAttribute('data-dev'), v = bestOf(want);
      if (!v) { toast(want === 'm' ? '이 기기에는 남자 한국어 목소리가 없어요.' : '이 기기에는 여자 한국어 목소리가 없어요.'); return; }
      S.src = 'device'; S.gender = want; S.voice = v; voiceSel.value = v.name; save(); showVoice();
      if (S.mode === 'ours') { var h = host(); startAt(h && h.isOpen() ? h.page() : 1); }
      else if (S.playing && !S.paused) { synth.cancel(); speakNext(S.gen); }
    }
  });
  sheet.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  voiceSel.addEventListener('change', function () {
    S.voice = koVoices().find(function (v) { return v.name === voiceSel.value; }) || S.voice;
    if (genderOf(S.voice)) S.gender = genderOf(S.voice);
    S.src = 'device'; save(); showVoice();
    if (S.mode === 'ours') { var h = host(); startAt(h && h.isOpen() ? h.page() : 1); }
    else if (S.playing && !S.paused) { synth.cancel(); speakNext(S.gen); }
  });

  // 책 목록으로 나가면 멈춤
  root.addEventListener('hashchange', function () { setTimeout(function () { var h = host(); if ((S.playing || S.paused || S.loading) && (!h || !h.isOpen() || h.bookId() !== S.book)) stop(); }, 50); });
  root.addEventListener('pagehide', function () { synth.cancel(); if (S.mode === 'ours' && A.list) setPos(A.book, A.i, au.currentTime); });

  pickVoice();
  if (hasSynth && typeof synth.onvoiceschanged !== 'undefined') synth.addEventListener('voiceschanged', pickVoice);
  root.MJListen = { core: Core, start: startAt, startOurs: startOurs, pause: pause, resume: resume, stop: stop, openVoices: openSheet,
    state: function () {
      var c = A.list && A.list.chapters[A.i];
      return { mode: S.mode, src: S.src, ours: S.ours, playing: S.playing, paused: S.paused, loading: S.loading, page: S.page, i: S.i, n: S.queue.length, cont: S.cont, speaking: synth.speaking,
        text: S.queue[S.i] && S.queue[S.i].text, chapter: S.mode === 'ours' ? A.i : -1, chapterTitle: c ? c.title : '', chapters: A.list ? A.list.chapters.length : 0,
        audioTime: au.currentTime, audioPaused: au.paused, rate: au.playbackRate, preview: pvId, previewTime: pv.currentTime, previewPaused: pv.paused };
    } };
})(typeof window !== 'undefined' ? window : this);
