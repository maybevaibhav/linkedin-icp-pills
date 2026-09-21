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
        case 'previewCard': {
          const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
          const tab = tabs.find((t) => t.active) || tabs.find((t) => /\/feed\//.test(t.url)) || tabs[0];
          if (!tab) return sendResponse({ ok: false, error: 'Open a LinkedIn tab first.' });
          const r = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: 'previewCard' }, (res) => {
              resolve(chrome.runtime.lastError ? null : res);
            });
          });
          return sendResponse(r ? { ok: true } : { ok: false, error: 'That LinkedIn tab is not running the extension. Refresh it (Cmd+R) and try again.' });
        }
        case 'diag':
          return sendResponse({ ok: true, data: await collectDiagnostics() });
        case 'syncNowDevices':
          await pushToSync();
          await pullFromSync();
          return sendResponse({ ok: true });
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

// ---------- Cross-device sync ------------------------------------------------
// Labels and settings ride Chrome's own profile sync so both of your computers
// agree. The HubSpot contact copy is deliberately NOT synced: thousands of
// records blow past the 100KB sync quota, and each machine rebuilds it from
// HubSpot in about a minute.
//
// Everything here is written to survive the trap that caused the scroll jump:
// a write that triggers a change event that triggers another write. Every path
// compares content first and refuses to write when nothing actually differs.

const SYNC_TAG_PREFIX = 'tags_';
const SYNC_SETTINGS_KEY = 'cfg';
let applyingRemote = false;
let pushTimer = null;

// Stable stringify so key order never makes identical data look different.
function stableStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}';
}

function tagShardKeys() {
  const keys = [];
  for (let i = 0; i < ICPX.SYNC_SHARDS; i++) keys.push(SYNC_TAG_PREFIX + i);
  return keys;
}

function splitIntoShards(map) {
  const shards = {};
  for (let i = 0; i < ICPX.SYNC_SHARDS; i++) shards[SYNC_TAG_PREFIX + i] = {};
  for (const slug of Object.keys(map || {})) {
    shards[SYNC_TAG_PREFIX + ICPX.shardOf(slug)][slug] = map[slug];
  }
  return shards;
}

function joinShards(obj) {
  const out = {};
  for (const k of tagShardKeys()) Object.assign(out, (obj || {})[k] || {});
  return out;
}

// Settings that belong on every machine. The HubSpot key only travels if the
// user explicitly asked for it, so the "nothing leaves your browser" promise
// holds by default.
function syncableSettings(settings) {
  const s = Object.assign({}, settings);
  delete s.token;
  if (settings.syncToken && settings.token) s.token = settings.token;
  return s;
}

async function setSyncStatus(patch) {
  const { deviceSync } = await ICPX.storageGet('deviceSync');
  await ICPX.storageSet({ deviceSync: Object.assign({}, deviceSync || {}, patch) });
}

function schedulePush() {
  if (applyingRemote) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; pushToSync().catch(() => {}); }, 1500);
}

async function pushToSync() {
  const { manualTags, settings } = await ICPX.storageGet(['manualTags', 'settings']);
  const cfg = Object.assign({}, ICPX.DEFAULT_SETTINGS, settings || {});
  if (cfg.syncAcrossDevices === false) return;

  const tags = ICPX.purgeTombstones(manualTags || {});
  const wantShards = splitIntoShards(tags);
  const wantCfg = syncableSettings(cfg);

  const have = await ICPX.syncGet(tagShardKeys().concat([SYNC_SETTINGS_KEY]));
  const changed = {};
  for (const k of tagShardKeys()) {
    if (stableStr(have[k] || {}) !== stableStr(wantShards[k])) changed[k] = wantShards[k];
  }
  if (stableStr(have[SYNC_SETTINGS_KEY] || {}) !== stableStr(wantCfg)) changed[SYNC_SETTINGS_KEY] = wantCfg;
  if (!Object.keys(changed).length) return; // nothing new, do not write

  try {
    await ICPX.syncSet(changed);
    await setSyncStatus({ state: 'ok', lastPush: Date.now(), message: `Sent ${Object.keys(ICPX.activeTags(tags)).length} labelled people to your other computers.` });
  } catch (e) {
    const quota = /QUOTA/i.test(e.message || '');
    await setSyncStatus({
      state: 'error',
      message: quota
        ? 'Your label list is too large for Chrome sync (about 100KB). Labels on this computer still work. Use Export backup to move them.'
        : `Sync failed: ${e.message}`,
    });
  }
}

async function pullFromSync() {
  const { manualTags, settings } = await ICPX.storageGet(['manualTags', 'settings']);
  const cfg = Object.assign({}, ICPX.DEFAULT_SETTINGS, settings || {});
  if (cfg.syncAcrossDevices === false) return;

  const remote = await ICPX.syncGet(tagShardKeys().concat([SYNC_SETTINGS_KEY]));
  const remoteTags = joinShards(remote);
  const merged = ICPX.purgeTombstones(ICPX.mergeTagMaps(manualTags || {}, remoteTags));

  const remoteCfg = remote[SYNC_SETTINGS_KEY] || null;
  let nextCfg = cfg;
  if (remoteCfg) {
    // Never let a remote copy blank out the key this machine already has.
    const token = (cfg.syncToken && remoteCfg.token) ? remoteCfg.token : cfg.token;
    nextCfg = Object.assign({}, cfg, remoteCfg, { token });
  }

  const writes = {};
  if (stableStr(merged) !== stableStr(manualTags || {})) writes.manualTags = merged;
  if (stableStr(nextCfg) !== stableStr(cfg)) writes.settings = nextCfg;
  if (!Object.keys(writes).length) return; // already in step, do not write

  applyingRemote = true;
  try {
    await ICPX.storageSet(writes);
    await setSyncStatus({ state: 'ok', lastPull: Date.now(), message: `Updated from your other computer: ${Object.keys(ICPX.activeTags(merged)).length} labelled people.` });
  } finally {
    // Release only after the resulting change events have been delivered.
    setTimeout(() => { applyingRemote = false; }, 500);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.manualTags || changes.settings)) schedulePush();
  if (area === 'sync') pullFromSync().catch(() => {});
});

// Catch up whenever this machine wakes up or the extension reloads.
chrome.runtime.onStartup.addListener(() => pullFromSync().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => pullFromSync().catch(() => {}));
