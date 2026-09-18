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
  };

  async function getSettings() {
    const { settings } = await storageGet('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  return {
    STALE_MS, INDEX_SCHEMA, COLORS, LIFECYCLE_LABELS, DEFAULT_SETTINGS,
    slugFromUrl, normName, isStale, storageGet, storageSet, getSettings,
  };
})();

if (typeof self !== 'undefined') self.ICPX = ICPX;
