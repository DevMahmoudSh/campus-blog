/*
 * Reader script for generated posts:
 *  - Arabic/English toggle (persisted in localStorage), swaps direction, fonts, title and meta description
 *  - copy buttons + Highlight.js, applied to whichever container becomes active
 *  - view counter (counted once per session per post)
 */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;

  var STR = {
    ar: { copy: 'نسخ', copied: 'تم النسخ ✓', fail: 'تعذّر النسخ', aria: 'نسخ الكود', num: 'ar-u-nu-latn' },
    en: { copy: 'Copy', copied: 'Copied ✓', fail: 'Copy failed', aria: 'Copy code', num: 'en-US' }
  };

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var t = doc.createElement('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;opacity:0';
      doc.body.appendChild(t);
      t.select();
      try { doc.execCommand('copy') ? ok() : fail(); } catch (e) { fail(); }
      doc.body.removeChild(t);
    });
  }

  // Safe to call repeatedly: wraps only new <pre> blocks and highlights only un-highlighted code.
  function enhance(scope) {
    var s = STR[scope.getAttribute('lang')] || STR.ar;

    scope.querySelectorAll('.article pre').forEach(function (pre) {
      if (pre.parentNode.classList.contains('codebox')) return;
      var code = pre.querySelector('code');
      if (!code) return;

      var lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'code';
      var box = doc.createElement('div'), bar = doc.createElement('div');
      var label = doc.createElement('span'), btn = doc.createElement('button');

      box.className = 'codebox';
      bar.className = 'codebar';
      label.textContent = lang;
      btn.type = 'button';
      btn.textContent = s.copy;
      btn.setAttribute('aria-label', s.aria);
      btn.addEventListener('click', function () {
        copyText(code.textContent).then(
          function () { btn.textContent = s.copied; },
          function () { btn.textContent = s.fail; }
        );
        setTimeout(function () { btn.textContent = s.copy; }, 1800);
      });

      pre.parentNode.insertBefore(box, pre);
      bar.appendChild(label);
      bar.appendChild(btn);
      box.appendChild(bar);
      box.appendChild(pre);
    });

    if (window.hljs) {
      scope.querySelectorAll('pre code:not(.hljs)').forEach(function (el) { hljs.highlightElement(el); });
    }
  }

  var metaEl = doc.getElementById('post-meta');
  if (!metaEl) { enhance(doc.body); return; } // older single-language pages: code blocks only

  var meta = JSON.parse(metaEl.textContent);
  var toggle = doc.getElementById('lang-toggle');

  function setMeta(selector, value) {
    var el = doc.querySelector(selector);
    if (el) el.setAttribute('content', value);
  }

  function setLang(lang, persist) {
    if (lang !== 'en' || !meta.hasEn) lang = 'ar';
    var m = meta[lang];

    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr'; // fonts switch through html[lang] in the page CSS

    ['ar', 'en'].forEach(function (code) {
      var c = doc.getElementById('lang-' + code);
      if (c) c.hidden = code !== lang;
    });

    doc.title = m.title + ' | ' + meta.site[lang];
    setMeta('meta[name="description"]', m.description);
    setMeta('meta[property="og:title"]', m.title);
    setMeta('meta[property="og:description"]', m.description);

    doc.querySelectorAll('[data-ar]').forEach(function (el) { el.textContent = el.getAttribute('data-' + lang); });

    if (toggle) {
      toggle.textContent = lang === 'ar' ? 'English' : 'العربية';
      toggle.lang = lang === 'ar' ? 'en' : 'ar';
      toggle.setAttribute('aria-label', lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية');
    }

    enhance(doc.getElementById('lang-' + lang));

    if (persist) { try { localStorage.setItem('lang', lang); } catch (e) {} }
  }

  var saved = null;
  try { saved = localStorage.getItem('lang'); } catch (e) {}
  setLang(saved || meta.default, false);

  if (toggle) toggle.addEventListener('click', function () { setLang(root.lang === 'ar' ? 'en' : 'ar', true); });

  /* ---------- View counter ---------- */
  function showViews(n) {
    doc.querySelectorAll('.views').forEach(function (badge) {
      var s = STR[badge.closest('[lang]').getAttribute('lang')] || STR.ar;
      badge.querySelector('.views-num').textContent = Number(n).toLocaleString(s.num);
      badge.hidden = false;
    });
  }

  function visitorId() {
    try {
      var v = localStorage.getItem('vid');
      if (!v) {
        v = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '' + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
        localStorage.setItem('vid', v);
      }
      return v;
    } catch (e) { return 'anon' + Math.random().toString(16).slice(2, 12); }
  }

  (function track() {
    var API = '/.netlify/functions/views', key = 'viewed:' + meta.slug, seen = false;
    try { seen = !!sessionStorage.getItem(key); } catch (e) {}

    var req = seen
      ? fetch(API + '?slug=' + encodeURIComponent(meta.slug))
      : fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: meta.slug, vid: visitorId() }) });

    req.then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        if (!seen) { try { sessionStorage.setItem(key, '1'); } catch (e) {} }
        showViews(d.views);
      })
      .catch(function () { /* counter is optional: stay silent */ });
  })();
})();
