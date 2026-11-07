/* victorview 밑줄펜 — 우리 목소리 엔진(기기 안 합성). 2026-11-07 시장 "남자 처음 3음, 여자 나중 3음으로 밑줄펜에 적용".
   - 모델: Supertonic 3 (Supertone). 코드 MIT, 모델 OpenRAIL-M(상업 가능, 공개할 때 AI 음성 표시, 다른 사람 흉내 금지).
   - 모델 파일은 Hugging Face 공식 주소(고정 판)에서 직접 받아 Cache Storage 'mj-voice-model-v1' 에 둔다. 우리 깃허브에는 올리지 않는다.
   - 런타임: onnxruntime-web 1.22.0 (jsDelivr 고정 판). WebGPU 가 되면 쓰고, 안 되면 WASM. 합성은 js/voice-worker.js 에서.
   - 6 목소리 값은 산출물/읽어주기/낭독견본-20261107/만들기스크립트/spec.json · spec-차분.json 과 같다. */
(function (root) {
  'use strict';
  var CACHE = 'mj-voice-model-v1';
  var REV = '724fb5abbf5502583fb520898d45929e62f02c0b';   // supertonic 1.3.1 이 받는 판과 같음
  var HF = 'https://huggingface.co/Supertone/supertonic-3/resolve/' + REV + '/';
  var ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

  // 남자 먼저 3, 여자 나중 3 (시장 지시 순서). sample = 같은 값으로 미리 만든 견본(audio/samples/<id>.mp3)
  var VOICES = [
    { id: 'sm1', name: '남1 · 낮게', note: '가장 낮고 고른, 깊은 목소리예요', style: 'M5', speed: 0.86, steps: 16, sent: 0.65, para: 1.2, sample: 'm1' },
    { id: 'sm2', name: '남2 · 차분', note: '낮고 담담하고 또렷해요', style: 'M3', speed: 0.88, steps: 16, sent: 0.6, para: 1.2, sample: 'm2' },
    { id: 'sm3', name: '남3 · 따뜻하게', note: '낮고 따뜻해요. 쉼이 넉넉해요', style: 'M2', speed: 0.90, steps: 16, sent: 0.7, para: 1.2, sample: 'm3' },
    { id: 'sf2a', name: '여2-가 · 조금 차분', note: '낮고 차분해요. 쉼을 넉넉히', style: 'F5', speed: 0.82, steps: 16, sent: 0.8, para: 1.5, sample: 'f2a' },
    { id: 'sf2b', name: '여2-나 · 더 차분', note: '가장 느려요. 잠들기 전에', style: 'F5', speed: 0.78, steps: 16, sent: 0.9, para: 1.7, sample: 'f2b' },
    { id: 'sf2c', name: '여2-다 · 고요히', note: '쉼이 가장 길고 고요해요', style: 'F5', speed: 0.80, steps: 24, sent: 1.0, para: 1.8, sample: 'f2c' }
  ];
  function voiceById(id) { for (var i = 0; i < VOICES.length; i++) if (VOICES[i].id === id) return VOICES[i]; return null; }

  // 받을 파일과 크기(바이트). Hugging Face 파일 목록(2026-11-07)과 jsDelivr 1.22.0 dist 크기.
  var FILES = [
    { key: 'ortJs', url: ORT + 'ort.webgpu.min.js', size: 357648, type: 'text/javascript' },
    { key: 'ortMjs', url: ORT + 'ort-wasm-simd-threaded.jsep.mjs', size: 44677, type: 'text/javascript' },
    { key: 'ortWasm', url: ORT + 'ort-wasm-simd-threaded.jsep.wasm', size: 21872216, type: 'application/wasm' },
    { key: 'cfg', url: HF + 'onnx/tts.json', size: 8253, type: 'application/json' },
    { key: 'indexer', url: HF + 'onnx/unicode_indexer.json', size: 277676, type: 'application/json' },
    { key: 'M5', url: HF + 'voice_styles/M5.json', size: 291469, type: 'application/json' },
    { key: 'M3', url: HF + 'voice_styles/M3.json', size: 290198, type: 'application/json' },
    { key: 'M2', url: HF + 'voice_styles/M2.json', size: 292055, type: 'application/json' },
    { key: 'F5', url: HF + 'voice_styles/F5.json', size: 291479, type: 'application/json' },
    { key: 'dp', url: HF + 'onnx/duration_predictor.onnx', size: 3700147, type: 'application/octet-stream' },
    { key: 'te', url: HF + 'onnx/text_encoder.onnx', size: 36416150, type: 'application/octet-stream' },
    { key: 'voc', url: HF + 'onnx/vocoder.onnx', size: 101424195, type: 'application/octet-stream' },
    { key: 've', url: HF + 'onnx/vector_estimator.onnx', size: 256534781, type: 'application/octet-stream' }
  ];
  var TOTAL = FILES.reduce(function (t, f) { return t + f.size; }, 0);
  function fileUrl(k) { for (var i = 0; i < FILES.length; i++) if (FILES[i].key === k) return FILES[i].url; return ''; }
  function mb(b) { return Math.round(b / 1e6); }

  /* ---------- 받기 · 확인 ---------- */
  function openCache() { return root.caches ? root.caches.open(CACHE) : Promise.reject(new Error('no-cache')); }
  // 다 받았는지: 저장본마다 우리가 적어 둔 크기(x-mj-bytes)가 기대 크기와 같은지(본문은 읽지 않아 빠르다)
  function status() {
    return openCache().then(function (c) {
      return Promise.all(FILES.map(function (f) {
        return c.match(f.url).then(function (r) { return r && +r.headers.get('x-mj-bytes') === f.size ? f.size : 0; });
      }));
    }).then(function (a) {
      var have = a.reduce(function (t, x) { return t + x; }, 0);
      return { ready: have === TOTAL, have: have, total: TOTAL };
    }, function () { return { ready: false, have: 0, total: TOTAL, noCache: true }; });
  }

  var dl = null; // 받는 중인 일 { ctrl, p }
  function download(onProgress) {
    if (dl) return dl.p;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null, done = 0;
    function prog(file) { if (onProgress) try { onProgress(done, TOTAL, file); } catch (e) {} }
    var p = openCache().then(function (c) {
      return status().then(function (s) {
        if (s.ready) return true;
        var need = TOTAL - s.have;
        var est = root.navigator && navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null);
        return est.then(function (q) {
          if (q && q.quota && q.quota - (q.usage || 0) < need * 1.1) { var err = new Error('space'); err.needMB = mb(need); throw err; }
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
          return FILES.reduce(function (pr, f) {
            return pr.then(function () {
              return c.match(f.url).then(function (hit) {
                if (hit && +hit.headers.get('x-mj-bytes') === f.size) { done += f.size; prog(f.key); return; }
                return fetchOne(c, f, ctrl, function (n) { done += n; prog(f.key); });
              });
            });
          }, Promise.resolve());
        });
      });
    }).then(function () { return status(); }).then(function (s) {
      dl = null;
      if (!s.ready) throw new Error('size');
      return true;
    }, function (e) {
      dl = null;
      if (ctrl && ctrl.signal.aborted) { var a = new Error('aborted'); a.name = 'AbortError'; throw a; }   // 취소(저장 쪽 오류 이름은 브라우저마다 달라 직접 정함)
      throw e;
    });
    dl = { ctrl: ctrl, p: p };
    return p;
  }
  // 한 파일: 본문을 둘로 나눠(tee) 하나는 저장본으로, 하나는 세면서 진행률. 다 받은 뒤 크기가 다르면 그 저장본은 버린다.
  function fetchOne(c, f, ctrl, onBytes) {
    var got = 0;
    return fetch(f.url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store', credentials: 'omit' }).then(function (r) {
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      var two = r.body.tee();
      var put = c.put(f.url, new Response(two[0], { headers: { 'content-type': f.type, 'x-mj-bytes': String(f.size) } }));
      var reader = two[1].getReader();
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) return;
          got += x.value.byteLength; onBytes(x.value.byteLength);
          return pump();
        });
      }
      return Promise.all([put, pump()]);
    }).then(function () {
      if (got !== f.size) { return c.delete(f.url).then(function () { throw new Error('size'); }); }
    }, function (e) {
      onBytes(-got);
      return c.delete(f.url).catch(function () {}).then(function () { throw e; });
    });
  }
  function cancelDownload() { if (dl && dl.ctrl) dl.ctrl.abort(); }

  /* ---------- 일꾼(합성) ---------- */
  var W = null, seq = 0, waits = {}, initP = null, info = null;
  function worker() {
    if (W) return W;
    W = new Worker('js/voice-worker.js?v=20');
    W.onmessage = function (e) {
      var m = e.data || {}, w = waits[m.id]; if (!w) return; delete waits[m.id];
      if (m.ok) w.ok(m.r); else w.no(new Error(m.error));
    };
    W.onerror = function (e) { Object.keys(waits).forEach(function (k) { waits[k].no(new Error(e.message || 'worker')); delete waits[k]; }); initP = null; W = null; };
    return W;
  }
  function call(msg, transfer) {
    var id = ++seq; msg.id = id;
    return { id: id, p: new Promise(function (ok, no) { waits[id] = { ok: ok, no: no }; worker().postMessage(msg, transfer || []); }) };
  }
  function init(prefer) {
    if (initP) return initP;
    var files = { cfg: fileUrl('cfg'), indexer: fileUrl('indexer'), onnx: { dp: fileUrl('dp'), te: fileUrl('te'), ve: fileUrl('ve'), voc: fileUrl('voc') },
      styles: { M5: fileUrl('M5'), M3: fileUrl('M3'), M2: fileUrl('M2'), F5: fileUrl('F5') } };
    var c = call({ type: 'init', files: files, ortJs: fileUrl('ortJs'), ortMjs: fileUrl('ortMjs'), ortWasm: fileUrl('ortWasm'), prefer: prefer || '' });
    // 너무 오래 걸리면(일꾼이 멈춤·메모리 부족) 포기하고 기기 목소리로 넘기게 한다
    var to = new Promise(function (ok, no) { setTimeout(function () { no(new Error('init timeout')); }, 180000); });
    initP = Promise.race([c.p, to]).then(function (r) { info = r; return r; }, function (e) {
      initP = null; delete waits[c.id]; if (W) { W.terminate(); W = null; } throw e;
    });
    return initP;
  }

  // 책 읽기용 숫자 손질: narrate.py READ_FIX("8월 24일"→"팔월 이십사일")를 넓혀 날짜(년·월·일)만 한자어 수로 읽힌다. 원문은 그대로.
  var DIG = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  function sino(n) {
    n = parseInt(n, 10); if (!(n >= 0) || n > 99999) return null; if (n === 0) return '영';
    var out = '', units = [[10000, '만'], [1000, '천'], [100, '백'], [10, '십']];
    units.forEach(function (u) { var q = Math.floor(n / u[0]); if (q) { out += (q === 1 ? '' : DIG[q]) + u[1]; n %= u[0]; } });
    return out + DIG[n];
  }
  function month(a) { return a === '6' ? '유' : a === '10' ? '시' : sino(a); }   // 유월·시월
  function readFix(t) {
    return String(t).replace(/(^|[^\d])(\d{1,2})월(\s*)(\d{1,2})일/g, function (m, p, a, sp, b) { return p + month(a) + '월 ' + sino(b) + '일'; })
      .replace(/(^|[^\d])(\d{1,2})월/g, function (m, p, a) { return p + month(a) + '월'; })
      .replace(/(^|[^\d])(\d{1,2})일/g, function (m, p, a) { return p + sino(a) + '일'; })
      .replace(/(^|[^\d])(\d{1,5})년/g, function (m, p, a) { return p + sino(a) + '년'; });
  }

  // 한 문장 합성. rateMul = 빠르기 고르기(편지=1). 돌려줌: { pcm Float32Array, sr, dur, peak, ms }
  var last = null;
  function synth(text, voiceId, rateMul) {
    var v = voiceById(voiceId) || VOICES[0];
    var speed = Math.min(2, Math.max(0.7, Math.round(v.speed * (rateMul || 1) * 1000) / 1000));
    var c = call({ type: 'synth', text: readFix(text), style: v.style, speed: speed, steps: v.steps });
    last = c.id;
    var p = init().then(function () { return c.p; });
    p.cancel = function () { if (W) W.postMessage({ type: 'cancel', id: c.id }); };
    return p;
  }

  // 소리 → WAV(16비트 모노). gap 초만큼 뒤에 쉼을 붙인다. gain 은 부르는 쪽이 정한다(narrate.py 는 파일 전체 최고점을 0.89로).
  function wav(pcm, sr, gap, gain) {
    var tail = Math.floor((gap || 0) * sr), n = pcm.length + tail, buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf), i;
    function s(o, t) { for (var k = 0; k < t.length; k++) d.setUint8(o + k, t.charCodeAt(k)); }
    s(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
    d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); s(36, 'data'); d.setUint32(40, n * 2, true);
    var g = gain || 1;
    for (i = 0; i < pcm.length; i++) { var x = Math.max(-1, Math.min(1, pcm[i] * g)); d.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  root.MJVoice = { CACHE: CACHE, VOICES: VOICES, voiceById: voiceById, FILES: FILES, TOTAL: TOTAL, totalMB: mb(TOTAL),
    status: status, download: download, cancelDownload: cancelDownload, downloading: function () { return !!dl; },
    init: init, ready: function () { return !!info; }, info: function () { return info; }, synth: synth, wav: wav, readFix: readFix, sino: sino };
})(typeof window !== 'undefined' ? window : this);
