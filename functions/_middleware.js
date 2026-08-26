/* elizabeth.style - keep the homepage "Weekly Edit" grid current.
 *
 * Reads theedit.elizabeth.style/archive at the edge (cached) and rewrites the
 * nine cards inside #latest-grid. No API key. If anything at all goes wrong
 * -- archive down, markup changed, fewer than nine usable items -- the
 * response passes through untouched and the cards baked into index.html show
 * instead, which is exactly the behaviour before this file existed.
 *
 * Diagnostics: https://<host>/?__latest returns JSON showing which parse
 * strategy fired and what it extracted.
 */

const ARCHIVE = 'https://theedit.elizabeth.style/archive';
const ORIGIN = 'https://theedit.elizabeth.style';
const WANT = 9;
const TTL = 1800;        // seconds to cache the archive fetch at the edge
const BUDGET = 2500;     // ms before we give up and serve the static cards
const TZ = 'Australia/Brisbane';

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const home = url.pathname === '/' || url.pathname === '/index.html';
  const debug = url.searchParams.has('__latest');

  if (!home) return next();

  const resP = debug ? null : next();          // fetch the static page in parallel
  const report = await load();

  if (debug) {
    return new Response(JSON.stringify(report, null, 1), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-robots-tag': 'noindex, nofollow',
        'cache-control': 'no-store',
      },
    });
  }

  const res = await resP;
  const items = report.items || [];
  if (items.length < WANT) return res;
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;

  return new HTMLRewriter()
    .on('#latest-grid', new GridSwap(items.slice(0, WANT)))
    .transform(res);
}

/* ------------------------------------------------------------------ fetch */

async function load() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BUDGET);
  try {
    const r = await fetch(ARCHIVE, {
      signal: ac.signal,
      cf: { cacheTtl: TTL, cacheEverything: true },
      headers: { accept: 'text/html', 'user-agent': 'elizabeth.style-latest/1' },
    });
    if (!r.ok) return { error: 'archive HTTP ' + r.status, items: [] };
    return analyse(await r.text());
  } catch (e) {
    return { error: String((e && e.message) || e), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ parse */

function analyse(html) {
  const out = { len: html.length, strategies: {}, via: null, items: [] };
  const tries = [['jsonld', fromJsonLd], ['nextdata', fromNextData], ['anchors', fromAnchors]];

  for (const [name, fn] of tries) {
    let got;
    try {
      got = order(usable(fn(html) || []));
    } catch (e) {
      out.strategies[name] = 'error: ' + ((e && e.message) || e);
      continue;
    }
    out.strategies[name] = got.length;
    if (!out.via && got.length >= WANT) {
      out.via = name;
      out.items = got.slice(0, WANT).map(render);
    }
  }
  if (!out.via) out.fingerprint = fingerprint(html);
  return out;
}

function usable(list) {
  const seen = new Set(), out = [];
  for (const it of list) {
    if (!it || !it.url || !it.title || !it.img) continue;
    if (!/\/p\/[^/]+$/.test(it.url)) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

// Newest first when every item carries a readable date; document order otherwise.
function order(list) {
  const stamped = list.map(it => ({ it, t: Date.parse(it.date || '') }));
  if (stamped.length && stamped.every(s => !isNaN(s.t))) {
    stamped.sort((a, b) => b.t - a.t);
  }
  return stamped.map(s => s.it);
}

function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    walk(data, o => {
      const u = typeof o.url === 'string' ? o.url : (typeof o['@id'] === 'string' ? o['@id'] : null);
      const t = o.headline || o.name;
      if (!u || !/\/p\//.test(u) || typeof t !== 'string') return;
      out.push({ url: absolute(u), title: t, date: o.datePublished || o.dateCreated || null, img: pickImage(o.image || o.thumbnailUrl) });
    });
  }
  return out;
}

function fromNextData(html) {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
         || html.match(/<script[^>]+type=["']application\/json["'][^>]*>(\{[\s\S]*?"props"[\s\S]*?)<\/script>/i);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  const out = [];
  walk(data, o => {
    const title = str(o.title) || str(o.web_title) || str(o.headline);
    const slug = str(o.slug) || str(o.web_slug);
    const link = str(o.web_url) || str(o.url);
    if (!title) return;
    const url = slug ? ORIGIN + '/p/' + slug : (link && /\/p\//.test(link) ? absolute(link) : null);
    if (!url) return;
    out.push({
      url,
      title,
      date: str(o.publish_date) || str(o.published_at) || str(o.displayed_date) || str(o.scheduled_at) || str(o.created_at) || null,
      img: pickImage(o.thumbnail_url || o.thumbnail || o.image_url || o.image || o.cover_image),
    });
  });
  return out;
}

function fromAnchors(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const re = /href=["'](?:https?:\/\/theedit\.elizabeth\.style)?(\/p\/[A-Za-z0-9._~-]+)["']/g;
  const out = [], seen = new Set();
  let m;
  while ((m = re.exec(body))) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    // start just past the end of the opening <a ...> tag we matched inside
    const gt = body.indexOf('>', m.index);
    const win = body.slice(gt < 0 ? m.index : gt + 1, (gt < 0 ? m.index : gt + 1) + 4000);
    const img = (win.match(/<img[^>]+src=["']([^"']*media\.beehiiv\.com[^"']+)["']/i) || [])[1] || null;
    const date = (win.match(/>\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s*</)
              || win.match(/datetime=["']([^"']+)["']/i) || [])[1] || null;
    const text = win
      .replace(/<[^>]+>/g, '\n')
      .split('\n')
      .map(s => entities(s).trim())
      .filter(Boolean);
    const heading = (win.match(/<h[1-6][^>]*>([\s\S]{1,200}?)<\/h[1-6]>/i) || [])[1];
    const clean = s => s.length >= 8
      && !/^\d/.test(s)
      && !/^(read more|load more|see more|subscribe|sign up|share)\b/i.test(s);
    const head = heading ? entities(heading.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null;
    const title = (head && clean(head)) ? head : (text.find(clean) || null);
    out.push({ url: ORIGIN + path, title, date, img });
  }
  return out;
}

// Only reached when every strategy failed. Short strings, safe to eyeball.
function fingerprint(html) {
  const i = html.search(/href=["'](?:https?:\/\/theedit\.elizabeth\.style)?\/p\//);
  return {
    hasNextData: /__NEXT_DATA__/.test(html),
    ldJsonBlocks: (html.match(/application\/ld\+json/g) || []).length,
    pLinks: (html.match(/\/p\/[A-Za-z0-9._~-]+/g) || []).length,
    beehiivImages: (html.match(/media\.beehiiv\.com/g) || []).length,
    tagsNearFirstLink: i < 0 ? [] : (html.slice(Math.max(0, i - 400), i + 900).match(/<[a-z][a-z0-9]*/gi) || []).slice(0, 40),
    classesNearFirstLink: i < 0 ? [] : (html.slice(Math.max(0, i - 400), i + 900).match(/class=["'][^"']{0,80}["']/gi) || []).slice(0, 12),
  };
}

/* ----------------------------------------------------------------- render */

function render(it) {
  return {
    url: it.url,
    title: titleCase(it.title),
    date: formatDate(it.date) || '',
    img: it.img,
    raw: { title: it.title, date: it.date },
  };
}

class GridSwap {
  constructor(items) { this.items = items; }
  element(el) { el.setInnerContent(this.items.map(card).join('\n\n'), { html: true }); }
}

function card(it) {
  return '    <a class="post" href="' + esc(it.url) + '">\n'
       + '      <img src="' + esc(it.img) + '" alt="" loading="lazy" decoding="async">\n'
       + '      <span class="b"><span class="d">' + esc(it.date) + '</span>'
       + '<span class="t">' + esc(it.title) + '</span></span></a>';
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in',
  'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'up', 'via', 'vs', 'with']);

function titleCase(s) {
  s = String(s).replace(/\s+/g, ' ').trim().replace(/\s+-\s+/g, ' — ');
  if (s !== s.toUpperCase()) return s;              // already cased, leave it alone
  const parts = s.split(' ');
  return parts.map((w, i) => {
    const lower = w.toLowerCase();
    const first = i === 0 || parts[i - 1] === '—' || /[:.]$/.test(parts[i - 1] || '');
    const last = i === parts.length - 1;
    if (!first && !last && SMALL.has(lower)) return lower;
    return lower.replace(/^([a-zà-ÿ])/, c => c.toUpperCase());
  }).join(' ');
}

function formatDate(d) {
  if (!d) return null;
  const t = Date.parse(d);
  if (isNaN(t)) return String(d);
  try {
    return new Intl.DateTimeFormat('en-AU',
      { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(t));
  } catch {
    return String(d);
  }
}

/* ------------------------------------------------------------------ utils */

function walk(node, cb, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) { for (const v of node) walk(v, cb, depth + 1); return; }
  cb(node);
  for (const k in node) walk(node[k], cb, depth + 1);
}

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function pickImage(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const r = pickImage(x); if (r) return r; } return null; }
  if (v && typeof v === 'object') return str(v.url) || str(v.contentUrl) || str(v.src);
  return null;
}

function absolute(u) { return /^https?:/i.test(u) ? u : ORIGIN + (u.charAt(0) === '/' ? '' : '/') + u; }

function entities(s) {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
          .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
