/*
 * Public view counter: /.netlify/functions/views
 *   GET  ?slug=lesson-1                -> { views }
 *   POST { slug, vid }                 -> { views }   (+1 view, and records vid as a unique reader)
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 * Keys: views:<slug> (counter), uniq:<slug> (HyperLogLog of visitor ids)
 */
const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VID = /^[\w-]{8,64}$/;

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

async function redis(commands) {
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error('Redis ' + res.status);
  return (await res.json()).map((x) => x.result);
}

// Only count real posts, so random slugs cannot fill the database
async function postExists(event, slug) {
  const res = await fetch(new URL('/posts.json', event.rawUrl).href);
  if (!res.ok) return false;
  return (await res.json()).some((p) => p.id === slug);
}

exports.handler = async (event) => {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return reply(503, { error: 'Counter not configured' });

  try {
    if (event.httpMethod === 'GET') {
      const slug = (event.queryStringParameters || {}).slug || '';
      if (!SLUG.test(slug) || slug.length > 60) return reply(400, { error: 'Bad slug' });
      const [views] = await redis([['GET', `views:${slug}`]]);
      return reply(200, { views: Number(views) || 0 });
    }

    if (event.httpMethod === 'POST') {
      let b;
      try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad JSON' }); }
      if (!SLUG.test(b.slug || '') || b.slug.length > 60 || !VID.test(b.vid || '')) return reply(400, { error: 'Bad input' });
      if (!(await postExists(event, b.slug))) return reply(404, { error: 'Unknown post' });
      const [views] = await redis([
        ['INCR', `views:${b.slug}`],
        ['PFADD', `uniq:${b.slug}`, b.vid]
      ]);
      return reply(200, { views: Number(views) || 0 });
    }

    return reply(405, { error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return reply(502, { error: 'Counter unavailable' });
  }
};
