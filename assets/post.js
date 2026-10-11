/* Wraps each <pre><code> in a header bar with a one-click copy button, then highlights. */
(function () {
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      var t = document.createElement('textarea');
      t.value = text;
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy') ? ok() : fail(); } catch (e) { fail(); }
      document.body.removeChild(t);
    });
  }

  document.querySelectorAll('.article pre').forEach(function (pre) {
    var code = pre.querySelector('code');
    if (!code) return;

    var lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'code';
    var box = document.createElement('div');
    var bar = document.createElement('div');
    var label = document.createElement('span');
    var btn = document.createElement('button');

    box.className = 'codebox';
    bar.className = 'codebar';
    label.textContent = lang;
    btn.type = 'button';
    btn.textContent = 'نسخ';
    btn.setAttribute('aria-label', 'نسخ الكود');

    btn.addEventListener('click', function () {
      copyText(code.textContent).then(
        function () { btn.textContent = 'تم النسخ ✓'; },
        function () { btn.textContent = 'تعذّر النسخ'; }
      );
      setTimeout(function () { btn.textContent = 'نسخ'; }, 1800);
    });

    pre.parentNode.insertBefore(box, pre);
    bar.appendChild(label);
    bar.appendChild(btn);
    box.appendChild(bar);
    box.appendChild(pre);
  });

  if (window.hljs) hljs.highlightAll();
})();
