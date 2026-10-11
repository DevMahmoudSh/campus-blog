/*
 * Netlify Function: /.netlify/functions/save-post
 * Actions (POST JSON):
 *   { action: "login",   password }                      -> { token }
 * All actions below need  Authorization: Bearer <token>
 *   { action: "list" }                                      -> { posts }   (read live from GitHub)
 *   { action: "get", slug }                                 -> { content } (HTML body of a post)
 *   { action: "publish" | "update", title, slug, category, tags[], excerpt, content }
 *   { action: "delete", slug }
 *
 * Environment variables (Netlify > Site settings > Environment variables):
 *   ADMIN_PASSWORD_HASH  "saltHex:hashHex"  (PBKDF2-SHA256, 210000 iterations, 32 bytes)
 *   SESSION_SECRET       long random string used to sign login tokens
 *   GITHUB_TOKEN         fine-grained token, repo Contents: read & write
 *   GITHUB_REPO          "owner/repo"
 *   GITHUB_BRANCH        optional, defaults to "main"
 */
const crypto = require('crypto');

const { ADMIN_PASSWORD_HASH, SESSION_SECRET, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH = 'main' } = process.env;

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/* ---------- Validation ---------- */
function cleanInput(b) {
  const title = String(b.title || '').trim();
  const slug = String(b.slug || '').trim().toLowerCase();
  const category = String(b.category || '').trim();
  const excerpt = String(b.excerpt || '').trim();
  const content = String(b.content || '').trim();
  const tags = (Array.isArray(b.tags) ? b.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);

  if (!title || title.length > 150) return { error: 'العنوان مطلوب (150 حرفًا كحد أقصى).' };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) return { error: 'الرابط المختصر: أحرف إنجليزية صغيرة وأرقام وشرطات فقط.' };
  if (!excerpt || excerpt.length > 300) return { error: 'الملخص مطلوب (300 حرف كحد أقصى).' };
  if (!content || content.length > 200000) return { error: 'محتوى الدرس مطلوب.' };
  if (category.length > 40 || tags.some((t) => t.length > 30)) return { error: 'التصنيف أو الوسوم أطول من المسموح.' };
  return { title, slug, category, excerpt, content, tags };
}

/* ---------- Post HTML ---------- */
function renderPost(p, date, readMinutes) {
  const d = new Date(date).toLocaleDateString('ar', { year: 'numeric', month: 'long', day: 'numeric', numberingSystem: 'latn' });
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(p.title)} | دفتر الدروس</title>
  <meta name="description" content="${esc(p.excerpt)}">
  <meta property="og:title" content="${esc(p.title)}">
  <meta property="og:description" content="${esc(p.excerpt)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@600;800&family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdn.tailwindcss.com/3.4.17"></script>
  <script>
    tailwind.config = { theme: { extend: {
      fontFamily: { sans: ['Tajawal','system-ui','sans-serif'], display: ['Cairo','Tajawal','system-ui','sans-serif'] },
      colors: { ink: '#12263A', paper: '#F2F5F7', rule: '#CBD5DC', brand: '#0F766E' } } } };
  </script>
  <style>
    .article { font-size: 1.0625rem; line-height: 1.95; }
    .article > * + * { margin-top: 1rem; }
    .article h2 { font: 800 1.5rem/1.5 Cairo, Tajawal, sans-serif; margin-top: 2.25rem; }
    .article h3 { font: 800 1.2rem/1.5 Cairo, Tajawal, sans-serif; margin-top: 1.75rem; }
    .article ul { list-style: disc; padding-inline-start: 1.5rem; }
    .article ol { list-style: decimal; padding-inline-start: 1.5rem; }
    .article a { color: #0F766E; text-decoration: underline; }
    .article img { max-width: 100%; height: auto; border-radius: .5rem; }
    .article :not(pre) > code { direction: ltr; unicode-bidi: isolate; background: #E3EAEE; padding: .1rem .4rem; border-radius: .25rem; font-size: .9em; }
    .codebox { direction: ltr; border-radius: .6rem; overflow: hidden; background: #0d1117; }
    .codebar { display: flex; justify-content: space-between; align-items: center; padding: .35rem .75rem; background: #161b22; color: #9aa7b4; font: 500 .8rem/1 ui-monospace, monospace; }
    .codebar button { font: 700 .8rem/1 Tajawal, sans-serif; color: #fff; background: #0F766E; border: 0; border-radius: .4rem; padding: .45rem .8rem; cursor: pointer; }
    .codebar button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .codebox pre { margin: 0; text-align: left; overflow-x: auto; }
    .codebox pre code.hljs { padding: 1rem; font-size: .9rem; line-height: 1.7; }
  </style>
</head>
<body class="bg-paper text-ink font-sans antialiased">
  <header class="bg-ink text-white">
    <div class="max-w-3xl mx-auto px-4 py-3">
      <a href="/" class="font-display font-extrabold text-xl">دفتر الدروس</a>
    </div>
  </header>
  <main class="max-w-3xl mx-auto px-4 py-8">
    <article>
      <h1 class="font-display font-extrabold text-3xl leading-snug">${esc(p.title)}</h1>
      <p class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink/60">
        ${p.category ? `<span class="rounded-md bg-brand/10 text-brand font-medium px-2 py-0.5">${esc(p.category)}</span>` : ''}
        <time datetime="${date}">${d}</time>
        <span>قراءة ${readMinutes} د</span>
      </p>
      <div class="article mt-6">
<!--content-start-->
${p.content}
<!--content-end-->
      </div>
    </article>
    <a href="/" class="inline-block mt-10 text-brand font-bold underline">العودة إلى كل الدروس</a>
  </main>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="/assets/post.js"></script>
</body>
</html>
`;
}

/* ---------- GitHub (one commit = one Netlify deploy) ---------- */
const branchRef = encodeURIComponent(GITHUB_BRANCH);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

// Pulls the editable HTML body back out of a generated post page
function extractContent(html) {
  const m = html.match(/<!--content-start-->\n([\s\S]*?)\n<!--content-end-->/) ||
            html.match(/<div class="article mt-6">\n([\s\S]*?)\n\s*<\/div>\s*<\/article>/);
  return m ? m[1] : null;
}

async function readPostContent(slug) {
  return extractContent(decode(await gh(`/contents/posts/${slug}.html?ref=${branchRef}`)));
}

function makePost(p, date) {
  const words = p.content.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.round(words / 180));
  return {
    html: renderPost(p, date, readMinutes),
    entry: {
      id: p.slug, title: p.title, url: `/posts/${p.slug}.html`, excerpt: p.excerpt,
      category: p.category, tags: p.tags, date, readMinutes
    }
  };
}

/*
 * One commit for every change. mutate(posts) returns either
 *   { error, status }  or  { posts, write: [{ path, content }], remove: [path] }
 */
async function commit(message, mutate) {
  const out = mutate(await readPosts());
  if (out.error) return out;

  const ref = await gh(`/git/ref/heads/${branchRef}`);
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const entries = [
    { path: 'posts.json', mode: '100644', type: 'blob', content: JSON.stringify(out.posts, null, 2) + '\n' },
    ...(out.write || []).map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    ...(out.remove || []).map((path) => ({ path, mode: '100644', type: 'blob', sha: null })) // sha:null deletes
  ];
  const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }) });
  const created = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [head.sha] })
  });
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
      await sleep(800); // slow down guessing
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
      case 'list':
        return reply(200, { posts: await readPosts() });

      case 'get': {
        const slug = String(body.slug || '');
        if (!SLUG.test(slug)) return reply(400, { error: 'رابط غير صالح.' });
        let content;
        try { content = await readPostContent(slug); } catch (e) { return reply(404, { error: 'لم يتم العثور على ملف الدرس.' }); }
        if (content == null) return reply(422, { error: 'تعذّر قراءة محتوى الدرس.' });
        return reply(200, { content });
      }

      case 'publish':
      case 'update': {
        const p = cleanInput(body);
        if (p.error) return reply(400, { error: p.error });
        const isNew = body.action === 'publish';
        const r = await commit(`${isNew ? 'Add' : 'Update'} post: ${p.title}`, (posts) => {
          const i = posts.findIndex((x) => x.id === p.slug);
          if (isNew && i >= 0) return { error: 'يوجد درس بنفس الرابط المختصر. غيّره وأعد المحاولة.', status: 409 };
          if (!isNew && i < 0) return { error: 'الدرس غير موجود.', status: 404 };
          const made = makePost(p, isNew ? today : posts[i].date); // edits keep the original date
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
