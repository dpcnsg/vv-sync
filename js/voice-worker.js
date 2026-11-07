/* victorview 밑줄펜 — 우리 목소리 합성 일꾼(Web Worker). 2026-11-07 시장 "휴대폰이나 PC에서 받아서 바로 사용".
   Supertonic 3 (Supertone, 코드 MIT · 모델 OpenRAIL-M) 을 onnxruntime-web 으로 기기 안에서 돌린다. 서버·외부 전송 없음.
   모델·런타임 파일은 voice-engine.js 가 Cache Storage(mj-voice-model-v1)에 받아 둔 것을 읽는다(없으면 원래 주소에서 직접).
   흐름은 파이썬판 supertonic 1.3.1 core.py(Supertonic.__call__) · narrate.py(trim) 와 같다:
   글 다듬기(NFKD·부호 정리·<ko>…</ko>) → duration_predictor → text_encoder → vector_estimator × steps → vocoder → 앞뒤 무음 자르기. */
'use strict';
var CACHE = 'mj-voice-model-v1';
var ort = null, S = {}, cfg = null, indexer = null, styles = {}, backend = '', files = null, cancelled = {}, chain = Promise.resolve();

function getRes(url) {
  return caches.open(CACHE).then(function (c) { return c.match(url); }).catch(function () { return null; })
    .then(function (r) { return r || fetch(url).then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status + ' ' + url); return x; }); });
}
function getBuf(url) { return getRes(url).then(function (r) { return r.arrayBuffer(); }); }
function getJson(url) { return getRes(url).then(function (r) { return r.json(); }); }

/* ---------- 글 다듬기: core.py UnicodeProcessor._preprocess_text 와 같은 순서 ---------- */
var EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
var SYM = [['–', '-'], ['‑', '-'], ['—', '-'], ['¯', ' '], ['_', ' '], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['´', "'"], ['`', "'"], ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' ']];
function preprocess(text) {
  text = text.normalize('NFKD');
  text = text.replace(EMOJI, '');
  SYM.forEach(function (p) { text = text.split(p[0]).join(p[1]); });
  text = text.replace(/[♥☆♡©\\]/g, '');
  text = text.split('@').join(' at ').split('e.g.,').join('for example, ').split('i.e.,').join('that is, ');
  text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  text = text.replace(/(["'`])\1+/g, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
  return '<ko>' + text + '</ko>';
}
function toIds(text) {
  var ids = [], dropped = 0;
  for (var ch of text) {
    var cp = ch.codePointAt(0), v = cp < indexer.length ? indexer[cp] : -1;
    if (v >= 0) ids.push(v); else dropped++;   // 파이썬판은 여기서 멈추지만, 책 읽기는 모르는 글자만 건너뛴다
  }
  return { ids: ids, dropped: dropped };
}

/* ---------- 목소리(style json) ---------- */
function loadStyle(name) {
  if (styles[name]) return Promise.resolve(styles[name]);
  return getJson(files.styles[name]).then(function (j) {
    function t(o) { var d = new Float32Array(o.data.flat(Infinity)); return new ort.Tensor('float32', d, o.dims); }
    return (styles[name] = { ttl: t(j.style_ttl), dp: t(j.style_dp) });
  });
}

/* ---------- 런타임·모델 올리기 ---------- */
function loadOrt(o) {
  if (ort) return Promise.resolve();
  // 런타임 js·mjs 는 원래 주소로 부른다(오프라인일 때는 sw.js 가 같은 주소를 저장본에서 돌려준다). 큰 wasm 은 저장본을 바로 넘긴다.
  return getBuf(o.ortWasm).then(function (wasm) {
    importScripts(o.ortJs);
    ort = self.ort;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    ort.env.wasm.wasmPaths = o.ortJs.replace(/[^/]+$/, '');
    ort.env.wasm.wasmBinary = wasm;
    ort.env.logLevel = 'error';
  });
}
var NAMES = ['dp', 'te', 've', 'voc'];
function createAll(ep) {
  var out = {};
  return NAMES.reduce(function (p, k) {
    // WebGPU: 글 표현(te)과 잠재값(ve) 결과는 그래픽 메모리에 둔 채 다음 단계로 넘긴다(단계마다 꺼내 오지 않아 빠르다)
    var opts = { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 };   // 경고(노드 배치 안내)는 콘솔에 내지 않음
    if (ep === 'webgpu' && (k === 'te' || k === 've')) opts.preferredOutputLocation = 'gpu-buffer';
    return p.then(function () { return getBuf(files.onnx[k]); })
      .then(function (buf) { return ort.InferenceSession.create(new Uint8Array(buf), opts); })
      .then(function (s) { out[k] = s; });
  }, Promise.resolve()).then(function () { return out; }, function (e) {
    NAMES.forEach(function (k) { if (out[k] && out[k].release) out[k].release().catch(function () {}); });
    throw e;
  });
}
function release() { NAMES.forEach(function (k) { if (S[k] && S[k].release) S[k].release().catch(function () {}); }); S = {}; }

function init(o) {
  files = o.files;
  var t0 = Date.now();
  return loadOrt(o).then(function () { return Promise.all([getJson(files.cfg), getJson(files.indexer)]); }).then(function (a) {
    cfg = a[0]; indexer = a[1];
    var wantGpu = o.prefer !== 'wasm' && self.navigator && navigator.gpu;
    var gpu = wantGpu ? navigator.gpu.requestAdapter().then(function (ad) { if (!ad) throw new Error('no adapter'); return createAll('webgpu'); }) : Promise.reject(new Error('skip'));
    return gpu.then(function (s) { S = s; backend = 'webgpu'; }, function () { return createAll('wasm').then(function (s) { S = s; backend = 'wasm'; }); });
  }).then(function () {
    var t1 = Date.now();
    // 데우기: 아주 짧은 글로 한 번 돌려 둔다(WebGPU 셰이더 준비). 첫 문장이 덜 기다리게.
    return synth({ text: '네.', style: o.warmStyle || 'M5', speed: 1, steps: 2 }).then(function () {
      return { backend: backend, loadMs: t1 - t0, warmMs: Date.now() - t1, threads: ort.env.wasm.numThreads, coi: !!self.crossOriginIsolated };
    }, function (e) {
      if (backend !== 'webgpu') throw e;
      release(); // WebGPU 로는 돌지 않는 기기: WASM 으로 다시
      return createAll('wasm').then(function (s) { S = s; backend = 'wasm'; return synth({ text: '네.', style: o.warmStyle || 'M5', speed: 1, steps: 2 }); })
        .then(function () { return { backend: backend, loadMs: t1 - t0, warmMs: Date.now() - t1, threads: ort.env.wasm.numThreads, coi: !!self.crossOriginIsolated, gpuFailed: String(e && e.message || e) }; });
    });
  });
}

function randn(n) { // Box-Muller
  var a = new Float32Array(n);
  for (var i = 0; i < n; i += 2) {
    var u1 = Math.random() || 1e-12, u2 = Math.random(), r = Math.sqrt(-2 * Math.log(u1));
    a[i] = r * Math.cos(2 * Math.PI * u2); if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return a;
}

// narrate.py trim(): 가장 큰 소리의 약 2.7% 넘는 첫·끝 지점 ±60ms 만 남기고 10ms 페이드
function trim(w, sr) {
  var peak = 0, i;
  for (i = 0; i < w.length; i++) { var v = Math.abs(w[i]); if (v > peak) peak = v; }
  if (!peak) return { pcm: w, peak: 0 };
  var thr = 0.008 * peak / 0.3, s = -1, e = -1;
  for (i = 0; i < w.length; i++) if (Math.abs(w[i]) > thr) { s = i; break; }
  for (i = w.length - 1; i >= 0; i--) if (Math.abs(w[i]) > thr) { e = i; break; }
  if (s < 0) return { pcm: w, peak: peak };
  var m = Math.floor(0.06 * sr); s = Math.max(s - m, 0); e = Math.min(e + m, w.length);
  var out = w.slice(s, e), f = Math.min(Math.floor(0.01 * sr), Math.floor(out.length / 4));
  for (i = 0; i < f; i++) { var g = i / Math.max(1, f - 1); out[i] *= g; out[out.length - 1 - i] *= g; }
  return { pcm: out, peak: peak };
}

function run(sess, feeds) { return sess.run(feeds).then(function (o) { return o[sess.outputNames[0]]; }); }

function synth(m) {
  var t0 = Date.now(), sr = cfg.ae.sample_rate, steps = m.steps || 16, speed = m.speed || 1;
  var tx = toIds(preprocess(m.text)), L = tx.ids.length;
  return loadStyle(m.style).then(function (st) {
    var ids = new ort.Tensor('int64', BigInt64Array.from(tx.ids.map(function (x) { return BigInt(x); })), [1, L]);
    var mask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
    var dur, emb, latLen, lmask, xt, latDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor, chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
    return run(S.dp, { text_ids: ids, style_dp: st.dp, text_mask: mask }).then(function (d) {
      dur = d.data[0] / speed;
      return run(S.te, { text_ids: ids, style_ttl: st.ttl, text_mask: mask });
    }).then(function (e) {
      emb = e;
      var wavLen = dur * sr;
      latLen = Math.floor((wavLen + chunk - 1) / chunk);
      var valid = Math.floor((Math.floor(wavLen) + chunk - 1) / chunk);
      var lm = new Float32Array(latLen); for (var t = 0; t < latLen; t++) lm[t] = t < valid ? 1 : 0;
      lmask = new ort.Tensor('float32', lm, [1, 1, latLen]);
      var x = randn(latDim * latLen);
      for (var dI = 0; dI < latDim; dI++) for (var t2 = valid; t2 < latLen; t2++) x[dI * latLen + t2] = 0;
      xt = new ort.Tensor('float32', x, [1, latDim, latLen]);
      var total = new ort.Tensor('float32', new Float32Array([steps]), [1]);
      var step = 0;
      function loop() {
        if (m.id && cancelled[m.id]) { delete cancelled[m.id]; throw new Error('cancelled'); }
        if (step >= steps) return Promise.resolve();
        var cur = new ort.Tensor('float32', new Float32Array([step]), [1]);
        return run(S.ve, { noisy_latent: xt, text_emb: emb, style_ttl: st.ttl, text_mask: mask, latent_mask: lmask, current_step: cur, total_step: total })
          .then(function (o) { if (xt.location === 'gpu-buffer') xt.dispose(); xt = o; step++; return loop(); });
      }
      return loop();
    }).then(function () {
      return run(S.voc, { latent: xt });
    }).then(function (w) {
      if (xt.location === 'gpu-buffer') xt.dispose();
      if (emb.location === 'gpu-buffer') emb.dispose();
      var raw = new Float32Array(w.data), tr = trim(raw, sr);
      return { pcm: tr.pcm, sr: sr, dur: dur, peak: tr.peak, ms: Date.now() - t0, dropped: tx.dropped, rawSec: raw.length / sr };
    });
  });
}

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === 'cancel') { cancelled[m.id] = true; return; }
  // 한 번에 하나씩(같은 모델을 동시에 돌리지 않는다). 줄 서 있는 동안 취소되면 시작하지 않는다.
  function work() {
    if (m.type === 'init') return init(m);
    if (m.type !== 'synth') return Promise.reject(new Error('unknown'));
    if (cancelled[m.id]) { delete cancelled[m.id]; return Promise.reject(new Error('cancelled')); }
    return S.ve ? synth(m) : Promise.reject(new Error('not ready'));
  }
  var job = chain = chain.then(work, work);
  job.then(function (r) {
    if (r && r.pcm) self.postMessage({ id: m.id, ok: true, r: r }, [r.pcm.buffer]);
    else self.postMessage({ id: m.id, ok: true, r: r });
  }, function (err) {
    if (m.id) delete cancelled[m.id];
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  });
};
