/*
 * Netlify Function: /.netlify/functions/save-post
 * { action: "login", password }                         -> { token }
 * All other actions need  Authorization: Bearer <token>
 *   list                                                -> { posts, stats }  (stats: { slug: { views, unique } } or null)
 *   get {slug}                                          -> { content, contentEn }
 *   publish | update { slug, category, tags[],
 *        titleAr, excerptAr, contentAr,                 (required)
 *        titleEn, excerptEn, contentEn }                (optional, all three or none)
 *   delete {slug}
 *
 * Env: ADMIN_PASSWORD_HASH, SESSION_SECRET, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (optional),
 *      UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (optional: only needed for view statistics)
 */
const crypto = require('crypto');

const {
  ADMIN_PASSWORD_HASH, SESSION_SECRET, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main',
  UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
} = process.env;

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ---------- Auth ---------- */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function checkPassword(password) {
  const [salt, hash] = (ADMIN_PASSWORD_HASH || '').split(':');
  if (!salt || !hash) return false;
  const derived = crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex');
  return safeEqual(derived, hash);
}

const sign = (payload) => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 2 * 60 * 60 * 1000 })).toString('base64url');
  return payload + '.' + sign(payload);
}

function validToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}

/* ---------- Redis (Upstash REST) for statistics ---------- */
async function redis(commands) {
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('Redis ' + res.status);
  return (await res.json()).map((x) => x.result);
}

async function readStats(posts) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN || !posts.length) return null;
  try {
    const out = await redis(posts.flatMap((p) => [['GET', `views:${p.id}`], ['PFCOUNT', `uniq:${p.id}`]]));
    const stats = {};
    posts.forEach((p, i) => { stats[p.id] = { views: Number(out[2 * i]) || 0, unique: Number(out[2 * i + 1]) || 0 }; });
    return stats;
  } catch (e) { console.error(e); return null; }
}

/* ---------- Validation ---------- */
function cleanInput(b) {
  const s = (v) => String(v || '').trim();
  const slug = s(b.slug).toLowerCase();
  const category = s(b.category);
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(s).filter(Boolean).slice(0, 10);
  const ar = { title: s(b.titleAr), excerpt: s(b.excerptAr), content: s(b.contentAr) };
  const en = { title: s(b.titleEn), excerpt: s(b.excerptEn), content: s(b.contentEn) };
  const anyEn = en.title || en.excerpt || en.content;

  if (!SLUG.test(slug) || slug.length > 60) return { error: 'الرابط المختصر: أحرف إنجليزية صغيرة وأرقام وشرطات فقط.' };
  if (!ar.title || !ar.excerpt || !ar.content) return { error: 'العنوان والوصف والمحتوى بالعربية حقول مطلوبة.' };
  if (anyEn && !(en.title && en.excerpt && en.content)) return { error: 'أكمل حقول النسخة الإنجليزية الثلاثة أو اتركها فارغة.' };
  for (const t of anyEn ? [ar, en] : [ar]) {
    if (t.title.length > 150 || t.excerpt.length > 300 || t.content.length > 200000) return { error: 'أحد الحقول أطول من المسموح.' };
  }
  if (category.length > 40 || tags.some((t) => t.length > 30)) return { error: 'التصنيف أو الوسوم أطول من المسموح.' };
  return { slug, category, tags, ar, en: anyEn ? en : null };
}

/* ---------- Post HTML (Arabic + optional English in isolated containers) ---------- */
const T = {
  ar: { site: 'دفتر الدروس', read: (n) => `قراءة ${n} د`, views: 'مشاهدة', back: 'العودة إلى كل الدروس', loc: 'ar', dir: 'rtl' },
  en: { site: 'Lessons Notebook', read: (n) => `${n} min read`, views: 'views', back: 'Back to all lessons', loc: 'en-US', dir: 'ltr' }
};
const EYE = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

function section(code, t, p, date, minutes) {
  const L = T[code];
  const d = new Date(date).toLocaleDateString(L.loc, { year: 'numeric', month: 'long', day: 'numeric', numberingSystem: 'latn' });
  return `    <section id="lang-${code}" lang="${code}" dir="${L.dir}">
      <h1 class="heading font-extrabold text-3xl leading-snug">${esc(t.title)}</h1>
      <p class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink/60">
        ${p.category ? `<span class="rounded-md bg-brand/10 text-brand font-medium px-2 py-0.5">${esc(p.category)}</span>` : ''}
        <time datetime="${date}">${d}</time>
        <span>${L.read(minutes)}</span>
        <span class="views inline-flex items-center gap-1.5 rounded-full bg-white border border-rule px-2.5 py-0.5" hidden>${EYE}<b class="views-num text-ink"></b><span>${L.views}</span></span>
      </p>
      <div class="article mt-6">
<!--${code}-start-->
${t.content}
<!--${code}-end-->
      </div>
    </section>`;
}

function renderPost(p, date, readMinutes) {
  const hasEn = !!p.en;
  const meta = {
    slug: p.slug, hasEn, default: 'ar',
    site: { ar: T.ar.site, en: T.en.site },
    ar: { title: p.ar.title, description: p.ar.excerpt },
    en: hasEn ? { title: p.en.title, description: p.en.excerpt } : null
  };
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(p.ar.title)} | ${T.ar.site}</title>
  <meta name="description" content="${esc(p.ar.excerpt)}">
  <meta property="og:title" content="${esc(p.ar.title)}">
  <meta property="og:description" content="${esc(p.ar.excerpt)}">${hasEn ? `
  <script>try{if(localStorage.getItem('lang')==='en'){var h=document.documentElement;h.lang='en';h.dir='ltr'}}catch(e){}</script>` : ''}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@600;800&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdn.tailwindcss.com/3.4.17"></script>
  <script>
    tailwind.config = { theme: { extend: { colors: { ink: '#12263A', paper: '#F2F5F7', rule: '#CBD5DC', brand: '#0F766E' } } } };
  </script>
  <style>
    html[lang="ar"] { --body: Tajawal, system-ui, sans-serif; --head: Cairo, Tajawal, system-ui, sans-serif; }
    html[lang="en"] { --body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; --head: var(--body); }
    body { font-family: var(--body); }
    .heading, .article h2, .article h3 { font-family: var(--head); }
    [hidden] { display: none !important; }
    html[lang="ar"] #lang-en, html[lang="en"] #lang-ar { display: none; }
    .article { font-size: 1.0625rem; line-height: 1.95; }
    .article > * + * { margin-top: 1rem; }
    .article h2 { font-weight: 800; font-size: 1.5rem; line-height: 1.5; margin-top: 2.25rem; }
    .article h3 { font-weight: 800; font-size: 1.2rem; line-height: 1.5; margin-top: 1.75rem; }
    .article ul { list-style: disc; padding-inline-start: 1.5rem; }
    .article ol { list-style: decimal; padding-inline-start: 1.5rem; }
    .article a { color: #0F766E; text-decoration: underline; }
    .article img { max-width: 100%; height: auto; border-radius: .5rem; }
    .article :not(pre) > code { direction: ltr; unicode-bidi: isolate; background: #E3EAEE; padding: .1rem .4rem; border-radius: .25rem; font-size: .9em; }
    .codebox { direction: ltr; border-radius: .6rem; overflow: hidden; background: #0d1117; }
    .codebar { display: flex; justify-content: space-between; align-items: center; padding: .35rem .75rem; background: #161b22; color: #9aa7b4; font: 500 .8rem/1 ui-monospace, monospace; }
    .codebar button { font: 700 .8rem/1 system-ui, sans-serif; color: #fff; background: #0F766E; border: 0; border-radius: .4rem; padding: .45rem .8rem; cursor: pointer; }
    .codebar button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .codebox pre { margin: 0; text-align: left; overflow-x: auto; }
    .codebox pre code.hljs { padding: 1rem; font-size: .9rem; line-height: 1.7; }
  </style>
</head>
<body class="bg-paper text-ink antialiased">
  <header class="bg-ink text-white">
    <div class="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
      <a href="/" class="heading font-extrabold text-xl" data-ar="${T.ar.site}" data-en="${T.en.site}">${T.ar.site}</a>${hasEn ? `
      <button id="lang-toggle" type="button" class="h-10 px-4 rounded-full border border-white/40 text-sm font-bold hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" aria-label="Switch to English" lang="en">English</button>` : ''}
    </div>
  </header>
  <main class="max-w-3xl mx-auto px-4 py-8">
    <article>
${section('ar', p.ar, p, date, readMinutes)}${hasEn ? `
${section('en', p.en, p, date, readMinutes)}` : ''}
    </article>
    <a href="/" class="inline-block mt-10 text-brand font-bold underline" data-ar="${T.ar.back}" data-en="${T.en.back}">${T.ar.back}</a>
  </main>
  <script type="application/json" id="post-meta">${JSON.stringify(meta).replace(/</g, '\\u003c')}</script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="/assets/post.js"></script>
</body>
</html>
`;
}

/* ---------- GitHub (one commit = one Netlify deploy) ---------- */
const branchRef = encodeURIComponent(GITHUB_BRANCH);
const decode = (file) => Buffer.from(file.content, 'base64').toString('utf8');

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'netlify-blog-publisher',
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const readPosts = async () => JSON.parse(decode(await gh(`/contents/posts.json?ref=${branchRef}`)));

function between(html, a, b) {
  const m = html.match(new RegExp(`<!--${a}-->\\n([\\s\\S]*?)\\n<!--${b}-->`));
  return m ? m[1] : null;
}

// Reads editable bodies back out of a generated page (also understands pages from the earlier single-language version)
function extractContents(html) {
  let ar = between(html, 'ar-start', 'ar-end');
  if (ar == null) ar = between(html, 'content-start', 'content-end');
  if (ar == null) {
    const m = html.match(/<div class="article mt-6">\n([\s\S]*?)\n\s*<\/div>\s*<\/article>/);
    ar = m ? m[1] : null;
  }
  return { ar, en: between(html, 'en-start', 'en-end') };
}

function makePost(p, date) {
  const words = p.ar.content.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.round(words / 180));
  return {
    html: renderPost(p, date, readMinutes),
    entry: {
      id: p.slug, title: p.ar.title, excerpt: p.ar.excerpt,
      ...(p.en ? { title_en: p.en.title, excerpt_en: p.en.excerpt } : {}),
      langs: p.en ? ['ar', 'en'] : ['ar'],
      url: `/posts/${p.slug}.html`, category: p.category, tags: p.tags, date, readMinutes
    }
  };
}

/* mutate(posts) returns { error, status } or { posts, write: [{ path, content }], remove: [path] } */
async function commit(message, mutate) {
  const out = mutate(await readPosts());
  if (out.error) return out;

  const ref = await gh(`/git/ref/heads/${branchRef}`);
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const entries = [
    { path: 'posts.json', mode: '100644', type: 'blob', content: JSON.stringify(out.posts, null, 2) + '\n' },
    ...(out.write || []).map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    ...(out.remove || []).map((path) => ({ path, mode: '100644', type: 'blob', sha: null }))
  ];
  const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }) });
  const created = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head.sha] }) });
  await gh(`/git/refs/heads/${branchRef}`, { method: 'PATCH', body: JSON.stringify({ sha: created.sha }) });
  return { ok: true };
}

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET || !GITHUB_TOKEN || !GITHUB_REPO) {
    return reply(500, { error: 'متغيرات البيئة غير مكتملة في إعدادات Netlify.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'بيانات غير صالحة.' }); }

  if (body.action === 'login') {
    if (!checkPassword(body.password)) {
      await sleep(800);
      return reply(401, { error: 'كلمة المرور غير صحيحة.' });
    }
    return reply(200, { token: issueToken() });
  }

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!validToken(auth)) return reply(401, { error: 'انتهت الجلسة. سجّل الدخول من جديد.' });

  const today = new Date().toISOString().slice(0, 10);
  const finish = (r, extra) => (r.error ? reply(r.status || 400, { error: r.error }) : reply(200, { ok: true, ...extra }));

  try {
    switch (body.action) {
      case 'list': {
        const posts = await readPosts();
        return reply(200, { posts, stats: await readStats(posts) });
      }

      case 'get': {
        const slug = String(body.slug || '');
        if (!SLUG.test(slug)) return reply(400, { error: 'رابط غير صالح.' });
        let found;
        try { found = extractContents(decode(await gh(`/contents/posts/${slug}.html?ref=${branchRef}`))); }
        catch (e) { return reply(404, { error: 'لم يتم العثور على ملف الدرس.' }); }
        if (found.ar == null) return reply(422, { error: 'تعذّر قراءة محتوى الدرس.' });
        return reply(200, { content: found.ar, contentEn: found.en || '' });
      }

      case 'publish':
      case 'update': {
        const p = cleanInput(body);
        if (p.error) return reply(400, { error: p.error });
        const isNew = body.action === 'publish';
        const r = await commit(`${isNew ? 'Add' : 'Update'} post: ${p.ar.title}`, (posts) => {
          const i = posts.findIndex((x) => x.id === p.slug);
          if (isNew && i >= 0) return { error: 'يوجد درس بنفس الرابط المختصر. غيّره وأعد المحاولة.', status: 409 };
          if (!isNew && i < 0) return { error: 'الدرس غير موجود.', status: 404 };
          const made = makePost(p, isNew ? today : posts[i].date);
          if (isNew) posts.unshift(made.entry); else posts[i] = made.entry;
          return { posts, write: [{ path: `posts/${p.slug}.html`, content: made.html }] };
        });
        return finish(r, { url: `/posts/${p.slug}.html` });
      }

      case 'delete': {
        const slug = String(body.slug || '');
        if (!SLUG.test(slug)) return reply(400, { error: 'رابط غير صالح.' });
        const r = await commit(`Delete post: ${slug}`, (posts) =>
          posts.some((x) => x.id === slug)
            ? { posts: posts.filter((x) => x.id !== slug), remove: [`posts/${slug}.html`] }
            : { error: 'الدرس غير موجود.', status: 404 });
        if (!r.error && UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
          await redis([['DEL', `views:${slug}`, `uniq:${slug}`]]).catch(() => {});
        }
        return finish(r);
      }

      default:
        return reply(400, { error: 'إجراء غير معروف.' });
    }
  } catch (e) {
    console.error(e);
    return reply(502, { error: 'تعذّر الاتصال بـ GitHub. راجع التوكن وصلاحياته.' });
  }
};
