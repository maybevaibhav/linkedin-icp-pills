// Settings page logic.

const $ = (id) => document.getElementById(id);
const S = ICPX;

let settings = Object.assign({}, S.DEFAULT_SETTINGS);
let manualTags = {};

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: 'No response' });
    });
  });
}

function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.className = 'status' + (kind ? ` status--${kind}` : '');
}

function fmtTime(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  await S.storageSet({ settings });
}

// ---------- HubSpot section ----------

async function loadPropertyOptions(token, preselect) {
  const res = await send({ type: 'detectProperties', token });
  const sel = $('linkedinProperty');
  sel.innerHTML = '';
  if (!res.ok) throw new Error(res.error);
  const props = res.data || [];
  if (!props.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No LinkedIn field found — will match by name only';
    sel.appendChild(o);
  }
  for (const p of props) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = `${p.label}  (${p.name})`;
    sel.appendChild(o);
  }
  const wanted = preselect && props.some((p) => p.name === preselect) ? preselect : (props[0] ? props[0].name : '');
  sel.value = wanted;
  $('propField').hidden = false;
  return wanted;
}

$('testToken').addEventListener('click', async () => {
  const token = $('token').value.trim();
  const st = $('tokenStatus');
  if (!token) return setStatus(st, 'Paste your token first.', 'err');
  setStatus(st, 'Testing…');
  const res = await send({ type: 'testConnection', token });
  if (!res.ok) return setStatus(st, res.error, 'err');
  try {
    const prop = await loadPropertyOptions(token, settings.linkedinProperty);
    await saveSettings({ token, linkedinProperty: prop });
    setStatus(st, 'Connected to HubSpot. Token saved. Starting first sync…', 'ok');
    runSync();
  } catch (e) {
    await saveSettings({ token });
    setStatus(st, `Connected, but could not read fields: ${e.message}`, 'warn');
  }
});

$('toggleToken').addEventListener('click', () => {
  const i = $('token');
  i.type = i.type === 'password' ? 'text' : 'password';
});

$('linkedinProperty').addEventListener('change', async (e) => {
  await saveSettings({ linkedinProperty: e.target.value });
  runSync();
});
$('nameMatching').addEventListener('change', (e) => saveSettings({ nameMatching: e.target.checked }));
$('hubspotLabel').addEventListener('change', (e) => saveSettings({ hubspotLabel: e.target.value.trim() || 'ICP' }));
$('syncDays').addEventListener('change', (e) => {
  let d = parseInt(e.target.value, 10);
  if (!(d >= 1)) d = 1;
  if (d > 90) d = 90;
  e.target.value = d;
  saveSettings({ syncDays: d });
});

async function runSync() {
  setStatus($('syncStatus'), 'Syncing…');
  const res = await send({ type: 'syncNow' });
  if (!res.ok) setStatus($('syncStatus'), res.error, 'err');
  // Final status text comes via storage change (syncStatus).
}
$('syncNow').addEventListener('click', runSync);

function renderSyncStatus(ss) {
  const el = $('syncStatus');
  if (!ss) return setStatus(el, 'Not synced yet.');
  if (ss.state === 'running') return setStatus(el, ss.message || 'Syncing…');
  if (ss.state === 'error') return setStatus(el, `Error: ${ss.message}`, 'err');
  setStatus(el, `${ss.message} Last sync: ${fmtTime(ss.lastSync)}.`, 'ok');
}

// ---------- Manual tags section ----------

function colorOptions(selectEl, value) {
  selectEl.innerHTML = '';
  for (const key of Object.keys(S.COLORS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = key.charAt(0).toUpperCase() + key.slice(1);
    selectEl.appendChild(o);
  }
  selectEl.value = value || 'purple';
}

function pillEl(label, color) {
  const c = S.COLORS[color] || S.COLORS.purple;
  const span = document.createElement('span');
  span.className = 'pill';
  span.style.background = c.bg;
  span.style.color = c.fg;
  const dot = document.createElement('i');
  dot.style.background = c.dot;
  span.append(dot, document.createTextNode(label));
  return span;
}

function allLabels() {
  const set = new Set();
  for (const e of Object.values(manualTags)) for (const t of e.tags || []) set.add(t.label);
  return Array.from(set).sort();
}

function renderTags() {
  const tbody = $('tagsTable').querySelector('tbody');
  tbody.innerHTML = '';
  const q = $('filter').value.trim().toLowerCase();
  const entries = Object.entries(manualTags)
    .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0))
    .filter(([slug, e]) => {
      if (!q) return true;
      const hay = `${slug} ${e.name || ''} ${(e.tags || []).map((t) => t.label).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });

  $('count').textContent = `${Object.keys(manualTags).length} people`;
  $('empty').hidden = entries.length > 0;
  $('tagsTable').hidden = entries.length === 0;

  $('labelList').innerHTML = allLabels().map((l) => `<option value="${l.replace(/"/g, '&quot;')}"></option>`).join('');

  for (const [slug, e] of entries) {
    const tr = document.createElement('tr');

    const tdP = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = e.name || slug;
    const small = document.createElement('div');
    small.className = 'muted small';
    small.textContent = `linkedin.com/in/${slug}`;
    tdP.append(a, small);

    const tdT = document.createElement('td');
    tdT.className = 'pills';
    for (const t of e.tags || []) {
      const wrap = document.createElement('span');
      wrap.className = 'pillwrap';
      wrap.appendChild(pillEl(t.label, t.color));
      const x = document.createElement('button');
      x.className = 'x';
      x.title = 'Remove this label';
      x.textContent = '×';
      x.addEventListener('click', () => updateEntry(slug, e.name, (e.tags || []).filter((y) => y !== t)));
      wrap.appendChild(x);
      tdT.appendChild(wrap);
    }

    const tdA = document.createElement('td');
    tdA.className = 'right';
    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => renderEditRow(tr, slug, e));
    const del = document.createElement('button');
    del.className = 'btn btn--ghost';
    del.textContent = 'Remove person';
    del.addEventListener('click', () => {
      if (confirm(`Remove all labels for ${e.name || slug}?`)) updateEntry(slug, e.name, []);
    });
    tdA.append(edit, del);

    tr.append(tdP, tdT, tdA);
    tbody.appendChild(tr);
  }
}

// Turn a table row into an inline editor for that person.
function renderEditRow(tr, slug, e) {
  tr.innerHTML = '';
  tr.className = 'editing';
  const td = document.createElement('td');
  td.colSpan = 3;

  const form = document.createElement('form');
  form.className = 'editform';

  const head = document.createElement('div');
  head.className = 'editform__head';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Name';
  nameInput.value = e.name || '';
  nameInput.maxLength = 80;
  const urlNote = document.createElement('div');
  urlNote.className = 'muted small';
  urlNote.textContent = `linkedin.com/in/${slug}`;
  head.append(nameInput, urlNote);

  const list = document.createElement('div');
  list.className = 'editform__labels';

  function addLabelRow(t) {
    const row = document.createElement('div');
    row.className = 'editform__label';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Label';
    inp.maxLength = 40;
    inp.value = t ? t.label : '';
    inp.setAttribute('list', 'labelList');
    const sel = document.createElement('select');
    colorOptions(sel, t ? t.color : 'purple');
    const prev = pillEl(inp.value || 'preview', sel.value);
    const refresh = () => { const np = pillEl(inp.value || 'preview', sel.value); prev.replaceWith(np); row._prev = np; };
    row._prev = prev;
    inp.addEventListener('input', () => { const np = pillEl(inp.value || 'preview', sel.value); row._prev.replaceWith(np); row._prev = np; });
    sel.addEventListener('change', () => { const np = pillEl(inp.value || 'preview', sel.value); row._prev.replaceWith(np); row._prev = np; });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'x';
    rm.title = 'Remove this label';
    rm.textContent = '×';
    rm.addEventListener('click', () => row.remove());
    row.append(inp, sel, prev, rm);
    list.appendChild(row);
    return inp;
  }
  for (const t of e.tags || []) addLabelRow(t);
  if (!(e.tags || []).length) addLabelRow(null);

  const addMore = document.createElement('button');
  addMore.type = 'button';
  addMore.className = 'btn btn--ghost';
  addMore.textContent = '+ Add another label';
  addMore.addEventListener('click', () => addLabelRow(null).focus());

  const actions = document.createElement('div');
  actions.className = 'editform__actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', renderTags);
  actions.append(save, cancel);

  form.append(head, list, addMore, actions);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const seen = new Set();
    const tags = [];
    for (const row of list.querySelectorAll('.editform__label')) {
      const label = row.querySelector('input').value.trim();
      const color = row.querySelector('select').value;
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      tags.push({ label, color });
    }
    if (!tags.length && !confirm('No labels left. Remove this person from your list?')) return;
    await updateEntry(slug, nameInput.value.trim(), tags);
  });

  td.appendChild(form);
  tr.appendChild(td);
  nameInput.focus();
}

async function updateEntry(slug, name, tags) {
  const next = Object.assign({}, manualTags);
  if (tags.length) next[slug] = { name: name || (next[slug] && next[slug].name) || '', tags, updated: Date.now() };
  else delete next[slug];
  manualTags = next;
  await S.storageSet({ manualTags: next });
  renderTags();
}

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const slug = S.slugFromUrl($('addUrl').value);
  const label = $('addLabel').value.trim();
  const color = $('addColor').value;
  const name = $('addName').value.trim();
  if (!slug) { alert('That does not look like a LinkedIn profile URL. It should contain /in/…'); return; }
  if (!label) return;
  const existing = (manualTags[slug] && manualTags[slug].tags) || [];
  const tags = existing.filter((t) => t.label.toLowerCase() !== label.toLowerCase()).concat([{ label, color }]);
  await updateEntry(slug, name || (manualTags[slug] && manualTags[slug].name) || '', tags);
  $('addUrl').value = '';
  $('addName').value = '';
  $('addLabel').value = '';
  $('addUrl').focus();
});

$('filter').addEventListener('input', renderTags);

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ manualTags, exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkedin-icp-labels-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus($('ioStatus'), 'Backup downloaded.', 'ok');
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.manualTags || data;
    if (typeof incoming !== 'object') throw new Error('Not a valid backup file');
    let added = 0;
    const next = Object.assign({}, manualTags);
    for (const [slug, entry] of Object.entries(incoming)) {
      if (!entry || !Array.isArray(entry.tags)) continue;
      const cur = next[slug] || { name: entry.name || '', tags: [] };
      const labels = new Set(cur.tags.map((t) => t.label.toLowerCase()));
      for (const t of entry.tags) {
        if (t && t.label && !labels.has(t.label.toLowerCase())) { cur.tags.push({ label: t.label, color: t.color || 'purple' }); added++; }
      }
      cur.name = cur.name || entry.name || '';
      cur.updated = Date.now();
      next[slug] = cur;
    }
    manualTags = next;
    await S.storageSet({ manualTags: next });
    renderTags();
    setStatus($('ioStatus'), `Imported ${added} labels.`, 'ok');
  } catch (err) {
    setStatus($('ioStatus'), `Import failed: ${err.message}`, 'err');
  }
  e.target.value = '';
});

// ---------- Activity / insights ----------

function renderStats(stats) {
  const box = $('statsBox');
  box.innerHTML = '';
  const st = stats && stats.people ? stats : null;
  const slugs = st ? Object.keys(st.people || {}) : [];
  if (!slugs.length) {
    box.innerHTML = '<div class="statsbox__empty">Nothing counted yet. Browse LinkedIn with the extension running and come back.</div>';
    return;
  }
  let icp = 0;
  let manual = 0;
  for (const sl of slugs) {
    if (st.people[sl].icp) icp++;
    if (st.people[sl].manual) manual++;
  }
  const days = Math.max(1, Math.floor((Date.now() - st.periodStart) / 86400000));
  const cells = [
    [slugs.length, `people flagged in the last ${days} day${days === 1 ? '' : 's'}`],
    [icp, 'already in your HubSpot'],
    [manual, 'with your own labels'],
  ];
  for (const [n, l] of cells) {
    const d = document.createElement('div');
    d.className = 'statbox';
    d.innerHTML = `<div class="statbox__n"></div><div class="statbox__l"></div>`;
    d.querySelector('.statbox__n').textContent = n;
    d.querySelector('.statbox__l').textContent = l;
    box.appendChild(d);
  }
}

$('insightsEnabled').addEventListener('change', (e) => saveSettings({ insightsEnabled: e.target.checked }));
$('insightsDays').addEventListener('change', (e) => {
  let d = parseInt(e.target.value, 10);
  if (!(d >= 1)) d = 1;
  if (d > 90) d = 90;
  e.target.value = d;
  saveSettings({ insightsDays: d });
});
$('resetStats').addEventListener('click', async () => {
  await S.storageSet({ stats: S.EMPTY_STATS() });
  const { stats } = await S.storageGet('stats');
  renderStats(stats);
});

// ---------- Diagnostics ----------

function fmtDiag(d) {
  const lines = [];
  lines.push(`Extension version: ${d.version}`);
  lines.push(`HubSpot token saved: ${d.tokenSaved ? 'yes' : 'NO'}`);
  lines.push(`LinkedIn field: ${d.linkedinProperty}`);
  lines.push(`Contacts synced: ${d.contacts} (${d.withLinkedin} with LinkedIn URL), last sync: ${fmtTime(d.lastSync)}, refresh every ${d.syncDays} days`);
  lines.push(`Sync status: ${d.syncStatus ? `${d.syncStatus.state} – ${d.syncStatus.message}` : 'never ran'}`);
  lines.push(`Your labels: ${d.labels} people`);
  lines.push('');
  if (!d.tabs.length) lines.push('LinkedIn tabs: none open. Open linkedin.com in a tab, then click Check now again.');
  for (const t of d.tabs) {
    lines.push(`Tab: ${t.url}`);
    if (t.error) {
      lines.push(`  NOT RUNNING: ${t.error}`);
      lines.push('  -> Refresh this LinkedIn tab (Cmd+R). The extension only starts on pages loaded after it was installed or reloaded.');
      continue;
    }
    lines.push(`  script version ${t.version}, profile links on page: ${t.profileAnchors}, pill bars: ${t.bars}, pills: ${t.pills}`);
    lines.push(`  data in page: ${t.contactsBySlug} contacts by URL, ${t.contactsByName} by name, ${t.labels} labelled people, name matching ${t.nameMatching ? 'on' : 'off'}`);
    if (t.pageSlug) lines.push(`  profile page for: ${t.pageSlug}, name element: ${t.nameEl || 'NOT FOUND'}`);
    lines.push(`  "+" presses received: ${t.clicksSeen}, summary card showing: ${t.cardShowing ? 'yes' : 'no'}, card enabled: ${t.insightsOn ? 'yes' : 'no'}`);
    if (t.errors && t.errors.length) { lines.push('  errors:'); for (const e of t.errors) lines.push(`    ${e}`); }
    else lines.push('  errors: none');
  }
  return lines.join('\n');
}

let lastDiagText = '';
$('diagBtn').addEventListener('click', async () => {
  $('diagOut').textContent = 'Checking…';
  const res = await send({ type: 'diag' });
  lastDiagText = res.ok ? fmtDiag(res.data) : `Failed: ${res.error}`;
  $('diagOut').textContent = lastDiagText;
});
$('diagCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(lastDiagText || $('diagOut').textContent); setStatus($('ioStatus'), 'Copied.', 'ok'); } catch (_) { /* ignore */ }
});

// ---------- boot ----------

(async () => {
  const data = await S.storageGet(['settings', 'manualTags', 'syncStatus', 'stats']);
  settings = Object.assign({}, S.DEFAULT_SETTINGS, data.settings || {});
  manualTags = data.manualTags || {};

  $('token').value = settings.token || '';
  $('nameMatching').checked = settings.nameMatching !== false;
  $('hubspotLabel').value = settings.hubspotLabel || 'ICP';
  $('syncDays').value = settings.syncDays || 7;
  $('insightsEnabled').checked = settings.insightsEnabled !== false;
  $('insightsDays').value = settings.insightsDays || 14;
  renderStats(data.stats);
  colorOptions($('addColor'), 'purple');
  renderSyncStatus(data.syncStatus);
  renderTags();

  if (settings.token) {
    setStatus($('tokenStatus'), 'Token saved.', 'ok');
    loadPropertyOptions(settings.token, settings.linkedinProperty).catch((e) =>
      setStatus($('tokenStatus'), `Token saved, but HubSpot said: ${e.message}`, 'warn'));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.syncStatus) renderSyncStatus(changes.syncStatus.newValue);
    if (changes.manualTags) { manualTags = changes.manualTags.newValue || {}; renderTags(); }
    if (changes.stats) renderStats(changes.stats.newValue);
    if (changes.settings && changes.settings.newValue) {
      settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.settings.newValue);
      $('insightsEnabled').checked = settings.insightsEnabled !== false;
    }
  });
})();
