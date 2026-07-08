// Mirrorframe — Asset Substrate (v0.2).
// Captures the binary assets a page's visual identity depends on — web fonts,
// <img> sources, CSS background-images — and rewrites their references so the
// reconstruction renders them locally. Inline SVG is serialized verbatim by
// the capture walk (it is already vector source); raster images are bundled
// as raster (automatic raster→vector tracing stays on the roadmap — it is a
// research problem, not a download).
//
// Bounded like everything else: per-asset and total byte caps. Assets that
// cannot be fetched are recorded as misses with a fixed reason, and their
// references fall back to the original absolute URL — never silently dropped.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { REASONS } = require('./reasons');

const ASSET_LIMITS = {
  perAssetBytes: 8 * 1024 * 1024,        // 8 MB per image/font asset
  perVideoBytes: 64 * 1024 * 1024,       // 64 MB per video asset (v0.2)
  totalBytes: 192 * 1024 * 1024,         // 192 MB per capture
};

const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif',
  'image/x-icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff',
  'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff2': '.woff2', 'application/font-woff': '.woff',
  'application/x-font-ttf': '.ttf',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
  'video/quicktime': '.mov',
};

function extFor(url, mime) {
  const m = (mime || '').split(';')[0].trim();
  if (EXT_BY_MIME[m]) return EXT_BY_MIME[m];
  const u = url.split(/[?#]/)[0];
  const e = path.extname(u);
  return e && e.length <= 6 ? e : '.bin';
}

class AssetStore {
  constructor(outDir) {
    this.dir = path.join(outDir, 'assets');
    fs.mkdirSync(this.dir, { recursive: true });
    this.map = new Map();     // absolute url -> relative path 'assets/xxxx.png'
    this.misses = new Map();  // absolute url -> reason
    this.totalBytes = 0;
  }
  has(url) { return this.map.has(url); }
  localFor(url) { return this.map.get(url) || null; }
  add(url, buf, mime) {
    if (this.map.has(url)) return this.map.get(url);
    if (!buf || buf.length === 0) return null;
    const isVideo = /^video\//.test((mime || '').split(';')[0].trim());
    const perCap = isVideo ? ASSET_LIMITS.perVideoBytes : ASSET_LIMITS.perAssetBytes;
    if (buf.length > perCap ||
        this.totalBytes + buf.length > ASSET_LIMITS.totalBytes) {
      this.misses.set(url, REASONS.SCALE_CAP_EXCEEDED);
      return null;
    }
    const name = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + extFor(url, mime);
    fs.writeFileSync(path.join(this.dir, name), buf);
    this.totalBytes += buf.length;
    const rel = 'assets/' + name;
    this.map.set(url, rel);
    this.misses.delete(url);
    return rel;
  }
  miss(url, reason) {
    if (!this.map.has(url) && !this.misses.has(url)) this.misses.set(url, reason);
  }
  manifest() {
    return {
      dir: 'assets',
      count: this.map.size,
      bytes: this.totalBytes,
      map: Object.fromEntries(this.map),
      misses: [...this.misses.entries()].map(([url, reason]) => ({ url, reason })),
    };
  }
}

// Fetch a URL through the page's own network stack (cookies, referer) with a
// bound; on failure record a miss with the fixed network reason.
async function fetchInto(store, page, url, timeoutMs = 10000) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:') || store.has(url))
    return store.localFor(url);
  try {
    const resp = await page.request.get(url, { timeout: timeoutMs });
    if (!resp.ok()) { store.miss(url, REASONS.NETWORK_TIMEOUT); return null; }
    const buf = await resp.body();
    return store.add(url, buf, resp.headers()['content-type']);
  } catch (e) {
    store.miss(url, REASONS.NETWORK_TIMEOUT);
    return null;
  }
}

// Extract url(...) references from a CSS value (computed background-image is
// absolute-URL'd by the browser).
function cssUrls(value) {
  const out = [];
  const re = /url\((['"]?)([^'")]+)\1\)/g;
  let m;
  while ((m = re.exec(value || ''))) if (!m[2].startsWith('data:')) out.push(m[2]);
  return out;
}

// Rewrite url(...) references using the asset map. `prefix` is the path from
// the emitted CSS file to the assets dir (e.g. '../'). Unfetched URLs keep
// their original absolute form (works online; reported as a miss).
function rewriteCssUrls(value, map, prefix) {
  return (value || '').replace(/url\((['"]?)([^'")]+)\1\)/g, (all, q, u) => {
    const local = map[u];
    return local ? `url("${prefix}${local}")` : all;
  });
}

// Parse @font-face blocks out of raw CSS text; resolve src URLs against base.
function parseFontFaces(cssText, baseUrl) {
  const faces = [];
  const re = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = re.exec(cssText))) {
    const body = m[1];
    const get = (prop) => {
      const r = new RegExp(prop + '\\s*:\\s*([^;]+);?', 'i').exec(body);
      return r ? r[1].trim() : null;
    };
    const src = get('src');
    if (!src) continue;
    const urls = [];
    const ure = /url\((['"]?)([^'")]+)\1\)(?:\s*format\((['"]?)([^'")]+)\3\))?/g;
    let um;
    while ((um = ure.exec(src))) {
      let u = um[2];
      if (!u.startsWith('data:')) {
        try { u = new URL(u, baseUrl).href; } catch (e) { continue; }
      }
      urls.push({ url: u, format: um[4] || null });
    }
    if (!urls.length) continue;
    faces.push({
      family: (get('font-family') || '').replace(/^['"]|['"]$/g, ''),
      weight: get('font-weight') || 'normal',
      style: get('font-style') || 'normal',
      display: get('font-display'),
      unicodeRange: get('unicode-range'),
      urls,
    });
  }
  return faces;
}

// Prefer woff2 > woff > anything.
function bestFontUrl(face) {
  const rank = (u) => /woff2/.test(u.format || u.url) ? 0 : /woff/.test(u.format || u.url) ? 1 : 2;
  return [...face.urls].sort((a, b) => rank(a) - rank(b))[0];
}

module.exports = { AssetStore, fetchInto, cssUrls, rewriteCssUrls, parseFontFaces, bestFontUrl, ASSET_LIMITS };
