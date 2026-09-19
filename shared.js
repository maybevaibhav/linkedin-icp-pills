// Shared helpers used by content script, options page and background worker.
// Loaded as a plain script (not a module) so it works in all three contexts.

const ICPX = (() => {
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const INDEX_SCHEMA = 2; // bump when the way contacts are indexed changes

  const COLORS = {
    orange: { bg: '#FFEDD5', fg: '#9A3412', dot: '#F97316' },
    purple: { bg: '#EDE9FE', fg: '#5B21B6', dot: '#8B5CF6' },
    blue:   { bg: '#DBEAFE', fg: '#1E40AF', dot: '#3B82F6' },
    green:  { bg: '#DCFCE7', fg: '#166534', dot: '#22C55E' },
    teal:   { bg: '#CCFBF1', fg: '#115E59', dot: '#14B8A6' },
    pink:   { bg: '#FCE7F3', fg: '#9D174D', dot: '#EC4899' },
    red:    { bg: '#FEE2E2', fg: '#991B1B', dot: '#EF4444' },
    gray:   { bg: '#E5E7EB', fg: '#374151', dot: '#6B7280' },
  };

  const LIFECYCLE_LABELS = {
    subscriber: 'Subscriber',
    lead: 'Lead',
    marketingqualifiedlead: 'Marketing Qualified Lead',
    salesqualifiedlead: 'Sales Qualified Lead',
    opportunity: 'Opportunity',
    customer: 'Customer',
    evangelist: 'Evangelist',
    other: 'Other',
  };

  // Extract the LinkedIn "slug" (the part after /in/) from any URL-ish string.
  // Works for full URLs, URLs without protocol, and bare slugs.
  function slugFromUrl(value) {
    if (!value) return null;
    let v = String(value).trim();
    if (!v) return null;
    const m = v.match(/\/in\/([^/?#\s]+)/i);
    let slug = m ? m[1] : null;
    if (!slug) {
      // Bare slug typed by the user (no slashes, no spaces)
      if (/^[A-Za-z0-9._%\-]+$/.test(v) && !v.includes('.com')) slug = v;
    }
    if (!slug) return null;
    try { slug = decodeURIComponent(slug); } catch (_) { /* keep raw */ }
    slug = slug.toLowerCase().replace(/\/+$/, '');
    // LinkedIn allows emoji in profile URLs (e.g. brennan-tobin-🦆-a5716b133) and
    // CRMs store them inconsistently, so strip pictographs before comparing.
    slug = slug.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, '')
      .replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return slug || null;
  }

  // Normalise a person's name for loose matching.
  function normName(name) {
    if (!name) return '';
    return String(name)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/[,|•·].*$/, ' ')          // drop ", PhD" / "| Founder" etc.
      .replace(/\b(mr|mrs|ms|dr|phd|mba|jr|sr|ii|iii)\b\.?/g, ' ')
      .replace(/[^a-z\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isStale(ts, days) {
    const d = Number(days) > 0 ? Number(days) : 7;
    return !ts || Date.now() - ts > d * 24 * 60 * 60 * 1000;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  const DEFAULT_SETTINGS = {
    token: '',
    linkedinProperty: '',
    nameMatching: true,
    hubspotLabel: 'ICP',
    syncDays: 7,
    insightsEnabled: true,
    insightsDays: 14,
    insightsMin: 5,
    syncAcrossDevices: true,
    syncToken: false,
  };

  async function getSettings() {
    const { settings } = await storageGet('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  // ---- Cross-device sync helpers -------------------------------------------
  // chrome.storage.sync caps each item at 8KB and the whole area at 100KB, so the
  // label list is spread over a few keys. The HubSpot contact copy is never synced:
  // it is thousands of records, far past the quota, and each machine can rebuild it
  // from HubSpot in about a minute.
  const SYNC_SHARDS = 8;
  const TOMBSTONE_MS = 60 * 24 * 60 * 60 * 1000; // remember a deletion for 60 days

  function shardOf(slug) {
    let h = 0;
    for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
    return Math.abs(h) % SYNC_SHARDS;
  }

  // Entries the user should actually see: not deleted, and carrying at least one label.
  function activeTags(map) {
    const out = {};
    for (const k of Object.keys(map || {})) {
      const v = map[k];
      if (v && !v.deleted && Array.isArray(v.tags) && v.tags.length) out[k] = v;
    }
    return out;
  }

  // Per-person last-write-wins. Each entry already carries an `updated` stamp.
  function mergeTagMaps(a, b) {
    const out = {};
    const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    for (const k of keys) {
      const x = (a || {})[k];
      const y = (b || {})[k];
      if (!x) out[k] = y;
      else if (!y) out[k] = x;
      else out[k] = (y.updated || 0) > (x.updated || 0) ? y : x;
    }
    return out;
  }

  function purgeTombstones(map) {
    const out = {};
    const cutoff = Date.now() - TOMBSTONE_MS;
    for (const k of Object.keys(map || {})) {
      const v = map[k];
      if (v && v.deleted && (v.updated || 0) < cutoff) continue;
      out[k] = v;
    }
    return out;
  }

  function syncGet(keys) {
    return new Promise((resolve) => chrome.storage.sync.get(keys, (r) => resolve(chrome.runtime.lastError ? {} : r)));
  }
  function syncSet(obj) {
    return new Promise((resolve, reject) => chrome.storage.sync.set(obj, () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()));
  }

  const EMPTY_STATS = () => ({ periodStart: Date.now(), people: {}, moments: 0, shown: 0, lastShown: 0 });

  return {
    EMPTY_STATS,
    SYNC_SHARDS, shardOf, activeTags, mergeTagMaps, purgeTombstones, syncGet, syncSet,
    STALE_MS, INDEX_SCHEMA, COLORS, LIFECYCLE_LABELS, DEFAULT_SETTINGS,
    slugFromUrl, normName, isStale, storageGet, storageSet, getSettings,
  };
})();

if (typeof self !== 'undefined') self.ICPX = ICPX;
