// Background service worker: talks to HubSpot and keeps a local copy of your
// contacts so the LinkedIn page can match people instantly and offline.

importScripts('shared.js');

const HS_BASE = 'https://api.hubapi.com';
const ALARM = 'icpx-hubspot-sync';

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  if (details.reason === 'update') needsSync().then((yes) => { if (yes) syncContacts().catch(() => {}); });
});

async function needsSync() {
  const { hubspotIndex, settings } = await ICPX.storageGet(['hubspotIndex', 'settings']);
  if (!settings || !settings.token) return false;
  if (!hubspotIndex) return true;
  if (hubspotIndex.schema !== ICPX.INDEX_SCHEMA) return true;
  return ICPX.isStale(hubspotIndex.lastSync, settings.syncDays);
}
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (await needsSync()) syncContacts().catch(() => {});
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 6 * 60 });
}

// ---------- messages from options page / content script ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'testConnection':
          return sendResponse({ ok: true, data: await testConnection(msg.token) });
        case 'detectProperties':
          return sendResponse({ ok: true, data: await detectLinkedinProperties(msg.token) });
        case 'diag':
          return sendResponse({ ok: true, data: await collectDiagnostics() });
        case 'openOptions':
          chrome.runtime.openOptionsPage();
          return sendResponse({ ok: true });
        case 'syncNow':
          return sendResponse({ ok: true, data: await syncContacts() });
        case 'ensureFresh':
          if (await needsSync()) syncContacts().catch(() => {});
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: 'Unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // async response
});

// ---------- HubSpot HTTP ----------

async function hsFetch(path, token, attempt = 0) {
  const res = await fetch(HS_BASE + path, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 429 && attempt < 5) {
    // Rate limited: wait and retry.
    await sleep(1500 * (attempt + 1));
    return hsFetch(path, token, attempt + 1);
  }
  if (res.status === 401) throw new Error('HubSpot rejected the token. Check that you copied the whole Private App access token.');
  if (res.status === 403) throw new Error('The token does not have the right permissions. In HubSpot, give the Private App the scopes crm.objects.contacts.read and crm.schemas.contacts.read.');
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) { /* ignore */ }
    throw new Error(`HubSpot error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testConnection(tokenArg) {
  const token = tokenArg || (await ICPX.getSettings()).token;
  if (!token) throw new Error('Paste your HubSpot Private App token first.');
  const data = await hsFetch('/crm/v3/objects/contacts?limit=1&properties=firstname', token);
  return { reachable: true, sample: (data.results || []).length };
}

// Find contact properties that look like they hold a LinkedIn URL.
async function detectLinkedinProperties(tokenArg) {
  const token = tokenArg || (await ICPX.getSettings()).token;
  if (!token) throw new Error('Paste your HubSpot Private App token first.');
  const data = await hsFetch('/crm/v3/properties/contacts', token);
  const props = (data.results || [])
    .filter((p) => /linkedin/i.test(p.name) || /linkedin/i.test(p.label || ''))
    .filter((p) => p.type === 'string')
    .map((p) => ({ name: p.name, label: p.label || p.name }));

  // Rank: names mentioning both "linkedin" and "url" first, hs_linkedin_url on top.
  const score = (p) => {
    const n = p.name.toLowerCase();
    let s = 0;
    if (n === 'hs_linkedin_url') s += 100;
    if (n.includes('url') || n.includes('link')) s += 10;
    if (n.includes('company') || n.includes('org')) s -= 50; // company LinkedIn page, not the person
    return s;
  };
  props.sort((a, b) => score(b) - score(a));
  return props;
}

// ---------- Sync ----------

let syncing = false;

async function setStatus(patch) {
  const { syncStatus } = await ICPX.storageGet('syncStatus');
  await ICPX.storageSet({ syncStatus: Object.assign({}, syncStatus || {}, patch) });
}

async function syncContacts() {
  if (syncing) return { skipped: true };
  syncing = true;
  try {
    const settings = await ICPX.getSettings();
    if (!settings.token) throw new Error('No HubSpot token saved yet.');

    let liProps = [];
    if (settings.linkedinProperty) {
      liProps = [settings.linkedinProperty];
    } else {
      // Not chosen yet: use every LinkedIn-looking property we can find.
      liProps = (await detectLinkedinProperties(settings.token)).map((p) => p.name);
    }

    const baseProps = ['firstname', 'lastname', 'lifecyclestage', 'company', 'jobtitle', 'email', 'createdate'];
    const properties = Array.from(new Set(baseProps.concat(liProps))).join(',');

    await setStatus({ state: 'running', message: 'Downloading contacts from HubSpot…', progress: 0 });

    const bySlug = {};
    const byName = {};
    let total = 0;
    let withLinkedin = 0;
    let after = null;
    let pages = 0;

    do {
      const qs = `limit=100&properties=${encodeURIComponent(properties)}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const page = await hsFetch(`/crm/v3/objects/contacts?${qs}`, settings.token);
      for (const c of page.results || []) {
        total++;
        const p = c.properties || {};
        const first = (p.firstname || '').trim();
        const last = (p.lastname || '').trim();
        const record = {
          id: c.id,
          name: `${first} ${last}`.trim(),
          stage: p.lifecyclestage || '',
          company: p.company || '',
          title: p.jobtitle || '',
          created: p.createdate || '',
        };
        let slug = null;
        for (const lp of liProps) {
          slug = ICPX.slugFromUrl(p[lp]);
          if (slug) break;
        }
        if (slug) {
          withLinkedin++;
          record.slug = slug;
          bySlug[slug] = record;
        }
        const nn = ICPX.normName(record.name);
        if (nn && nn.includes(' ')) {
          (byName[nn] = byName[nn] || []).push(record);
        }
      }
      after = page.paging && page.paging.next && page.paging.next.after ? page.paging.next.after : null;
      pages++;
      if (pages % 5 === 0) await setStatus({ progress: total, message: `Downloaded ${total} contacts…` });
      if (after) await sleep(120); // stay well under HubSpot rate limits
    } while (after);

    const index = { schema: ICPX.INDEX_SCHEMA, bySlug, byName, lastSync: Date.now(), total, withLinkedin, properties: liProps };
    await ICPX.storageSet({ hubspotIndex: index });
    await setStatus({
      state: 'ok',
      message: `Synced ${total} contacts (${withLinkedin} with a LinkedIn URL).`,
      lastSync: index.lastSync,
      total,
      withLinkedin,
    });
    return { total, withLinkedin };
  } catch (e) {
    await setStatus({ state: 'error', message: e.message || String(e) });
    throw e;
  } finally {
    syncing = false;
  }
}


// ---------- Diagnostics ----------

async function collectDiagnostics() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  const results = [];
  for (const t of tabs) {
    const r = await new Promise((resolve) => {
      chrome.tabs.sendMessage(t.id, { type: 'diag' }, (res) => {
        if (chrome.runtime.lastError) resolve({ url: t.url, error: chrome.runtime.lastError.message });
        else resolve(res || { url: t.url, error: 'no reply' });
      });
    });
    results.push(r);
  }
  const { hubspotIndex, manualTags, settings, syncStatus } = await ICPX.storageGet(['hubspotIndex', 'manualTags', 'settings', 'syncStatus']);
  return {
    version: chrome.runtime.getManifest().version,
    tokenSaved: !!(settings && settings.token),
    linkedinProperty: (settings && settings.linkedinProperty) || '(none)',
    syncDays: (settings && settings.syncDays) || 7,
    contacts: hubspotIndex ? hubspotIndex.total : 0,
    withLinkedin: hubspotIndex ? hubspotIndex.withLinkedin : 0,
    lastSync: hubspotIndex ? hubspotIndex.lastSync : null,
    labels: manualTags ? Object.keys(manualTags).length : 0,
    syncStatus: syncStatus || null,
    tabs: results,
  };
}
