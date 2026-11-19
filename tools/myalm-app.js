/* MYALM App Layer v1 — makes any MYALM lesson work everywhere.
   - Web (https): registers the offline service worker, shows "Install app" + offline-download progress,
     asks the browser to keep the lesson's saved progress/recordings (persistent storage).
   - Offline file (opened from WhatsApp / Files = file:// or content://): recording falls back to the
     phone's own voice recorder, speech-check is switched off cleanly, and a small "Get the app" button
     explains how to install the full app so it keeps working forever.
   - Any page: if the microphone can't be opened, recording still works through the phone recorder.
   Runs before the lesson code. Self-contained, no network needed. */
(function () {
  'use strict';
  if (window.MYALM_APP) return;
  var W = window, D = document, N = navigator;
  var meta = function (n) { var m = D.querySelector('meta[name="' + n + '"]'); return m ? m.getAttribute('content') : ''; };
  var WEB = meta('myalm-web');
  var proto = location.protocol;
  var isHttp = proto === 'https:' || proto === 'http:';
  var secure = !!W.isSecureContext;
  var standalone = (W.matchMedia && W.matchMedia('(display-mode: standalone)').matches) || N.standalone === true;
  var isIOS = /iPad|iPhone|iPod/.test(N.userAgent) || (N.platform === 'MacIntel' && N.maxTouchPoints > 1);
  var KEY = 'myalmApp_' + (location.pathname.replace(/[^a-z0-9]+/gi, '_').slice(-60) || 'x');
  var ls = { get: function (k) { try { return localStorage.getItem(KEY + k); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(KEY + k, v); } catch (e) {} } };
  var APP = W.MYALM_APP = { web: WEB, secure: secure, file: !isHttp, standalone: standalone, phoneRecorder: false };

  /* ---------- 1. Speech check: switch off where it can never work (insecure page) ---------- */
  if (!secure) {
    ['SpeechRecognition', 'webkitSpeechRecognition'].forEach(function (k) {
      try { Object.defineProperty(W, k, { value: undefined, configurable: true, writable: true }); } catch (e) {}
    });
  }

  /* ---------- 2. Recording that never fails: phone-recorder fallback ---------- */
  var actx = null;
  function silentStream() {
    try {
      var AC = W.AudioContext || W.webkitAudioContext;
      actx = actx || new AC();
      var dst = actx.createMediaStreamDestination();
      var s = dst.stream; s.__myalmFake = true; return s;
    } catch (e) {
      var t = { kind: 'audio', enabled: true, stop: function () {} };
      return { __myalmFake: true, active: true, getTracks: function () { return [t]; }, getAudioTracks: function () { return [t]; } };
    }
  }
  var picker = null;
  /* Opens the phone's recorder (or file picker). Resolves only when a recording comes back;
     if the student backs out, onCancel runs and the same picker can be reopened by the next tap. */
  function pickAudio(onCancel) {
    return new Promise(function (resolve) {
      if (picker && picker.parentNode) picker.parentNode.removeChild(picker);
      var inp = picker = D.createElement('input');
      inp.type = 'file'; inp.accept = 'audio/*'; inp.setAttribute('capture', 'user');
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px';
      var left = false, t = 0;
      function cancelled() { if (!inp.files || !inp.files.length) onCancel && onCancel(); }
      inp.addEventListener('change', function () { clearTimeout(t); if (inp.files && inp.files[0]) { cleanup(); resolve(inp.files[0]); } });
      inp.addEventListener('cancel', function () { clearTimeout(t); cancelled(); });
      function onBlur() { left = true; }
      function onBack() { if (D.hidden) { left = true; return; } if (left) { left = false; clearTimeout(t); t = setTimeout(cancelled, 4000); } }
      function cleanup() { W.removeEventListener('blur', onBlur); W.removeEventListener('focus', onBack); D.removeEventListener('visibilitychange', onBack); }
      W.addEventListener('blur', onBlur); W.addEventListener('focus', onBack); D.addEventListener('visibilitychange', onBack);
      (D.body || D.documentElement).appendChild(inp);
      inp.__open = function () { try { inp.click(); } catch (e) {} };
      inp.__open();
    });
  }
  function PhoneRecorder(stream) {
    this.stream = stream; this.state = 'inactive'; this.mimeType = ''; this._l = {};
    this.ondataavailable = this.onstop = this.onstart = this.onerror = this.onpause = this.onresume = null;
    this.audioBitsPerSecond = 0;
  }
  PhoneRecorder.prototype = {
    addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener: function (t, f) { var a = this._l[t] || []; var i = a.indexOf(f); if (i > -1) a.splice(i, 1); },
    dispatchEvent: function () { return true; },
    _emit: function (t, ev) { ev = ev || {}; ev.type = t; ev.target = this; if (typeof this['on' + t] === 'function') try { this['on' + t](ev); } catch (e) { console.error(e); }
      (this._l[t] || []).slice().forEach(function (f) { try { f(ev); } catch (e) { console.error(e); } }); },
    start: function () {
      var me = this; if (me.state === 'recording') return;
      me.state = 'recording'; me._emit('start');
      tip('🎙 Your phone recorder opens now — record, then tap ✓ / Done.', 'سيفتح مسجّل الهاتف: سجّل صوتك ثم اضغط ✓ أو تم');
      me._p = pickAudio(function () {
        tip('No recording yet — tap the record / mic button again to open the recorder.', 'ما تم التسجيل بعد — اضغط زر التسجيل مرة ثانية');
      }).then(function (f) {
        me.mimeType = f.type || 'audio/mp4'; me._emit('dataavailable', { data: f });
        me.state = 'inactive'; me._emit('stop');
      });
    },
    stop: function () {
      /* a tap on "Stop" gives a fresh user gesture: reopen the recorder if the phone blocked it */
      if (this.state === 'recording' && picker && !picker.files.length && picker.__open) picker.__open();
    },
    pause: function () {}, resume: function () {}, requestData: function () {}
  };
  var RealMR = W.MediaRecorder;
  function MR(stream, opts) {
    if (!RealMR || (stream && stream.__myalmFake)) return new PhoneRecorder(stream);
    return opts ? new RealMR(stream, opts) : new RealMR(stream);
  }
  MR.isTypeSupported = function (t) { return RealMR && RealMR.isTypeSupported ? RealMR.isTypeSupported(t) : /^audio\//.test(t || ''); };
  if (RealMR) MR.prototype = RealMR.prototype;
  try { W.MediaRecorder = MR; } catch (e) {}

  var md = N.mediaDevices;
  var realGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  function fallbackGUM(c) {
    if (c && c.video) return Promise.reject(new Error('NotSupported'));
    APP.phoneRecorder = true; return Promise.resolve(silentStream());
  }
  function gum(c) {
    if (!realGUM || !secure) return fallbackGUM(c);
    return realGUM(c).catch(function (err) {
      if (c && c.video) throw err;
      if (err && err.name === 'NotAllowedError') tip('Microphone is blocked — using your phone recorder instead.', 'الميكروفون مقفول، راح نستخدم مسجّل الهاتف');
      return fallbackGUM(c);
    });
  }
  try {
    if (!md) Object.defineProperty(N, 'mediaDevices', { value: { getUserMedia: gum, enumerateDevices: function () { return Promise.resolve([]); } }, configurable: true });
    else md.getUserMedia = gum;
  } catch (e) {}
  /* very old API some lessons may call */
  if (!N.getUserMedia) N.getUserMedia = function (c, ok, bad) { gum(c).then(ok, bad); };

  /* ---------- 3. UI: small toast + install / get-the-app sheet ---------- */
  var css = '.myalm-tip{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:2147483600;background:#1E2A5A;color:#fff;font:600 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:10px 16px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:88vw;text-align:center;opacity:0;transition:opacity .25s;pointer-events:none}'
    + '.myalm-tip.on{opacity:1}.myalm-tip .myalm-ar,.myalm-sh .myalm-ar{display:block;direction:rtl;font-weight:500;color:inherit;opacity:1;margin-top:2px;font-size:inherit}'
    + '.myalm-fab{position:fixed;left:12px;bottom:12px;z-index:2147483500;display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:8px 13px 8px 10px;background:#0FB5A6;color:#fff;font:800 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 18px rgba(15,181,166,.45);cursor:pointer;opacity:.95}'
    + '.myalm-fab svg{width:18px;height:18px;flex:none}.myalm-fab .pc{font-weight:700;opacity:.9}.myalm-fab.mini{padding:9px}.myalm-fab.mini .lb{display:none}'
    + '.myalm-sh{position:fixed;inset:0;z-index:2147483550;background:rgba(15,23,42,.55);display:flex;align-items:flex-end;justify-content:center;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '.myalm-sh .b{background:#fff;color:#1E2A5A;width:100%;max-width:520px;border-radius:22px 22px 0 0;padding:20px 20px 26px;box-shadow:0 -10px 40px rgba(0,0,0,.2);max-height:88vh;overflow:auto}'
    + '.myalm-sh h3{margin:0 0 6px;font-size:19px}.myalm-sh ol{margin:8px 0 12px;padding-left:22px}.myalm-sh li{margin:6px 0}'
    + '.myalm-sh .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.myalm-sh button,.myalm-sh a.btn{flex:1;min-width:130px;border:0;border-radius:14px;padding:12px 14px;font-weight:800;font-size:15px;cursor:pointer;text-align:center;text-decoration:none}'
    + '.myalm-sh .go{background:#0FB5A6;color:#fff}.myalm-sh .no{background:#EEF2F7;color:#1E2A5A}.myalm-sh .note{background:#FFF7E0;border-radius:12px;padding:8px 12px;font-size:13.5px;margin-top:10px}'
    + '.myalm-sh .k{display:inline-block;background:#EEF2F7;border-radius:6px;padding:0 6px;font-weight:700}';
  function addCss() { if (D.getElementById('myalm-app-css')) return; var s = D.createElement('style'); s.id = 'myalm-app-css'; s.textContent = css; (D.head || D.documentElement).appendChild(s); }
  var tipEl = null, tipT = 0;
  function tip(en, ar, ms) {
    if (!D.body) return;
    addCss();
    if (!tipEl) { tipEl = D.createElement('div'); tipEl.className = 'myalm-tip'; D.body.appendChild(tipEl); }
    tipEl.innerHTML = en + (ar ? '<span class="myalm-ar">' + ar + '</span>' : '');
    tipEl.classList.add('on'); clearTimeout(tipT); tipT = setTimeout(function () { tipEl.classList.remove('on'); }, ms || 4200);
  }
  APP.tip = tip;
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M12 7v7M9 11l3 3 3-3"/></svg>';
  var fab = null, deferred = null, pct = -1, offlineReady = ls.get('ready') === '1';

  function sheet(html) {
    addCss();
    var s = D.createElement('div'); s.className = 'myalm-sh';
    s.innerHTML = '<div class="b" role="dialog" aria-modal="true">' + html + '</div>';
    s.addEventListener('click', function (e) { if (e.target === s || (e.target.closest && e.target.closest('[data-close]'))) s.remove(); });
    D.body.appendChild(s); return s;
  }
  function steps() {
    if (isIOS) return '<ol><li>Open this link in <b>Safari</b>.</li><li>Tap <span class="k">Share ⬆</span> then <span class="k">Add to Home Screen</span>.</li><li>Open the lesson from its icon. It works without internet.</li></ol>'
      + '<p class="myalm-ar">افتح الرابط بسفاري ← زر المشاركة ⬆ ← «إضافة إلى الشاشة الرئيسية». بعدها افتح الدرس من الأيقونة، ويشتغل بدون إنترنت.</p>';
    return '<ol><li>Open this link in <b>Chrome</b>.</li><li>Tap <span class="k">Install</span> below, or <span class="k">⋮</span> → <span class="k">Add to Home screen / Install app</span>.</li><li>Open the lesson from its icon. It works without internet.</li></ol>'
      + '<p class="myalm-ar">افتح الرابط بكروم ← اضغط «تثبيت» أو ⋮ ← «إضافة إلى الشاشة الرئيسية». بعدها افتح الدرس من الأيقونة، ويشتغل بدون إنترنت.</p>';
  }
  function openInstall() {
    if (deferred) { var d = deferred; deferred = null; d.prompt(); (d.userChoice || Promise.resolve()).then(function (r) { if (r && r.outcome === 'accepted') hideFab(); }); return; }
    var s = sheet('<h3>📲 Save this lesson as an app</h3><p>One time only. Then it opens like an app, works <b>offline</b>, records your voice, checks your speaking and keeps your progress.</p>' + steps()
      + (pct >= 0 && pct < 100 ? '<div class="note">Downloading for offline use: <b>' + pct + '%</b> — keep this page open until it says “Ready offline”.</div>' : '')
      + (offlineReady ? '<div class="note">✓ Ready offline on this phone. <span class="myalm-ar">✓ جاهز بدون إنترنت على هذا الجهاز</span></div>' : '')
      + '<div class="row"><button class="no" data-close>OK</button></div>');
    return s;
  }
  function openGetApp() {
    var link = WEB ? '<a class="btn go" href="' + WEB + '" target="_blank" rel="noopener">Open the app link</a>' : '';
    sheet('<h3>📲 Get the full app (free)</h3>'
      + '<p>You opened the <b>file copy</b>. Phones only lend a file from WhatsApp for a short time, so it can stop opening later (“page can’t be reached”), and the microphone check is blocked.</p>'
      + '<p class="myalm-ar">إنت فاتح نسخة الملف. الواتساب يسمح بفتح الملف لفترة قصيرة، فممكن بعدين يطلع «لا يمكن الوصول للصفحة»، والميكروفون ما يشتغل بالكامل.</p>'
      + '<p><b>Best:</b> open the app link once and install it — it then works forever, even offline.</p>'
      + '<p class="myalm-ar"><b>الأفضل:</b> افتح رابط التطبيق مرة وحدة وثبّته — بعدها يشتغل دائماً حتى بدون إنترنت.</p>'
      + (WEB ? '' : '<div class="note">Ask your teacher for the app link. <span class="myalm-ar">اطلب رابط التطبيق من الأستاذ</span></div>')
      + '<div class="note">In this file copy, 🎙 recording still works: your phone’s recorder opens, you record, then tap ✓.<span class="myalm-ar">بهذي النسخة التسجيل يشتغل عن طريق مسجّل الهاتف: سجّل ثم اضغط ✓</span></div>'
      + '<div class="row">' + link + '<button class="no" data-close>Continue here</button></div>');
  }
  function hideFab() { if (fab) { fab.remove(); fab = null; } }
  function makeFab(label, onClick) {
    if (!D.body) return; addCss(); hideFab();
    fab = D.createElement('button'); fab.type = 'button'; fab.className = 'myalm-fab';
    fab.innerHTML = ICON + '<span class="lb">' + label + '</span><span class="pc"></span>';
    fab.addEventListener('click', onClick); D.body.appendChild(fab);
    setTimeout(function () { if (fab) fab.classList.add('mini'); }, 9000);
  }
  function setPct(p) {
    pct = p; if (!fab) return;
    var el = fab.querySelector('.pc'); if (el) el.textContent = p >= 0 && p < 100 ? p + '%' : '';
  }

  function onReady() {
    if (!isHttp || !secure) {
      /* file copy (WhatsApp / Files / USB) or an insecure page: always offer the app; open the explanation automatically the first time */
      makeFab('Get the app', openGetApp);
      if (ls.get('seen') !== '1') { ls.set('seen', '1'); setTimeout(openGetApp, 900); }
      return;
    }
    if (standalone) return; /* already installed */
    makeFab('Install', openInstall);
    if (offlineReady) setPct(-1);
  }

  /* ---------- 4. Offline service worker (web only) ---------- */
  if (isHttp && secure && 'serviceWorker' in N && meta('myalm-sw') !== 'off') {
    W.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
    W.addEventListener('appinstalled', function () { hideFab(); tip('✓ Installed! Open it from your home screen.', '✓ تم التثبيت! افتحه من الشاشة الرئيسية'); });
    N.serviceWorker.addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.type === 'myalm-progress') setPct(Math.floor(100 * m.done / Math.max(1, m.total)));
      if (m.type === 'myalm-ready') {
        setPct(-1);
        if (!offlineReady) { offlineReady = true; ls.set('ready', '1'); tip('✓ Ready offline — this lesson now works without internet.', '✓ جاهز بدون إنترنت — الدرس يشتغل الآن بدون نت'); }
      }
    });
    W.addEventListener('load', function () {
      N.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); });
      /* ask the worker to finish downloading any lesson files still missing (resumes after a bad connection) */
      N.serviceWorker.ready.then(function (reg) { try { reg.active && reg.active.postMessage({ type: 'myalm-check' }); } catch (e) {} });
      N.serviceWorker.addEventListener('controllerchange', function () {
        N.serviceWorker.ready.then(function (reg) { try { reg.active && reg.active.postMessage({ type: 'myalm-check' }); } catch (e) {} });
      });
      if (N.storage && N.storage.persist) N.storage.persist().catch(function () {});
    });
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', onReady); else onReady();
})();
