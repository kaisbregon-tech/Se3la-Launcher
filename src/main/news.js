// ============================================================================
//  ACTUS / PATCH NOTES
//  Le launcher lit un fichier news.json (sur ton serveur) et le nettoie
//  avant de l'afficher. Sans Internet, il affiche la dernière version reçue.
// ============================================================================

const fs = require('fs');

const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanUrl(value, base, { allowAssets = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const v = value.trim();
  if (allowAssets && /^assets\/[\w\-./]+$/.test(v) && !v.includes('..')) return v;
  try {
    const u = base ? new URL(v, base) : new URL(v);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function sanitizeNews(data, baseUrl, { allowAssets = false } = {}) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.news) ? data.news : [];
  return list
    .filter((n) => n && typeof n.title === 'string' && n.title.trim())
    .slice(0, 30)
    .map((n, i) => ({
      id: clip(n.id, 60) || `news-${i}`,
      title: clip(n.title, 140),
      date: clip(n.date, 30),
      tag: clip(n.tag, 30),
      summary: clip(n.summary, 400),
      content: clip(n.content, 8000),
      image: cleanUrl(n.image, baseUrl, { allowAssets }),
      url: (() => {
        const u = cleanUrl(n.url, baseUrl);
        return u;
      })(),
    }));
}

async function loadNews({ url, demoFile, cacheStore, fetchImpl = globalThis.fetch }) {
  if (!url) {
    try {
      const data = JSON.parse(fs.readFileSync(demoFile, 'utf8'));
      return { items: sanitizeNews(data, null, { allowAssets: true }), source: 'demo' };
    } catch {
      return { items: [], source: 'demo' };
    }
  }
  try {
    const u = new URL(url);
    u.searchParams.set('t', Date.now().toString());
    const res = await fetchImpl(u.href, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = sanitizeNews(await res.json(), url);
    cacheStore.write({ items, savedAt: Date.now() });
    return { items, source: 'online' };
  } catch {
    const cached = cacheStore.read(null);
    if (cached && Array.isArray(cached.items) && cached.items.length) return { items: cached.items, source: 'cache' };
    // jamais réussi à les télécharger : les actus livrées avec le launcher
    try {
      const data = JSON.parse(fs.readFileSync(demoFile, 'utf8'));
      return { items: sanitizeNews(data, null, { allowAssets: true }), source: 'demo' };
    } catch {
      return { items: [], source: 'cache' };
    }
  }
}

module.exports = { loadNews, sanitizeNews };
