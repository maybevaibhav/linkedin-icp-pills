// Content script: finds people on any LinkedIn page and adds pills under their names.

(() => {
  if (window.__icpxLoaded) return;
  window.__icpxLoaded = true;

  const S = ICPX;
  const VERSION = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  const errors = [];
  let clicksSeen = 0;
  function recordError(where, e) {
    const msg = `${where}: ${e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e)}`;
    errors.push(msg);
    if (errors.length > 10) errors.shift();
    console.warn('[ICP Pills]', msg);
  }
  let hubspotIndex = { bySlug: {}, byName: {} };
  let manualTags = {}; // slug -> { name, tags: [{label, color}] }
  let settings = Object.assign({}, S.DEFAULT_SETTINGS);
  let scanTimer = null;
  let lastUrl = location.href;

  // ---------- data loading ----------

  async function loadData() {
    const data = await S.storageGet(['hubspotIndex', 'manualTags', 'settings']);
    hubspotIndex = data.hubspotIndex || { bySlug: {}, byName: {} };
    manualTags = data.manualTags || {};
    settings = Object.assign({}, S.DEFAULT_SETTINGS, data.settings || {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hubspotIndex) hubspotIndex = changes.hubspotIndex.newValue || { bySlug: {}, byName: {} };
    if (changes.manualTags) manualTags = changes.manualTags.newValue || {};
    if (changes.settings) settings = Object.assign({}, S.DEFAULT_SETTINGS, changes.settings.newValue || {});
    rerenderAll();
  });

  // ---------- matching ----------

  function resolveTags(slug, name) {
    const tags = [];
    const seen = new Set();
    const push = (t) => {
      const key = t.label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(t);
    };

    const manual = slug && manualTags[slug];
    if (manual && Array.isArray(manual.tags)) {
      for (const t of manual.tags) push({ label: t.label, color: t.color || 'purple', source: 'manual', title: 'Your label' });
    }

    let hs = slug ? hubspotIndex.bySlug && hubspotIndex.bySlug[slug] : null;
    let matchedBy = 'LinkedIn URL';
    if (!hs && settings.nameMatching && name) {
      const list = hubspotIndex.byName && hubspotIndex.byName[S.normName(name)];
      if (list && list.length === 1) {
        hs = list[0];
        matchedBy = 'name';
      }
    }
    if (hs) {
      const stage = S.LIFECYCLE_LABELS[hs.stage] || hs.stage || '';
      const parts = [
        `In your HubSpot CRM — matched by ${matchedBy}`,
        hs.name ? `Contact: ${hs.name}` : '',
        hs.company ? `Company: ${hs.company}` : '',
        stage ? `Lifecycle stage: ${stage}` : '',
      ].filter(Boolean);
      push({
        label: settings.hubspotLabel || 'ICP',
        color: 'orange',
        source: 'hubspot',
        title: parts.join('\n'),
        soft: matchedBy !== 'LinkedIn URL',
      });
    }
    return tags;
  }

  // ---------- DOM helpers ----------

  function slugFromAnchor(a) {
    const href = a.getAttribute('href') || '';
    if (!/\/in\//.test(href)) return null;
    return S.slugFromUrl(href);
  }

  function cleanName(text) {
    if (!text) return '';
    let t = text.replace(/\s+/g, ' ').trim();
    t = t.replace(/^view\s+/i, '').replace(/['’]s profile.*$/i, '').replace(/\s*•.*$/, '');
    return t.trim();
  }

  function visibleText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.visually-hidden, .a11y-text, [aria-hidden="true"] ~ .visually-hidden, .icpx-pills').forEach((n) => n.remove());
    return cleanName(clone.textContent);
  }

  // Try to find where to place the pill and what the person's name is.
  // Returns { target, name, mode } or null. mode: 'after' (insert after target) or 'append'.
  function locate(anchor, slug) {
    // 1. Feed posts (and reposts)
    const actor = anchor.closest('.update-components-actor__container, .update-components-actor');
    if (actor) {
      const title = actor.querySelector('.update-components-actor__title');
      if (title) {
        const nameEl = title.querySelector('[aria-hidden="true"]') || title;
        return { key: actor, target: title, name: visibleText(nameEl), mode: 'after' };
      }
    }
    // 2. Comments
    const comment = anchor.closest('.comments-comment-meta, .comments-post-meta');
    if (comment) {
      const nameEl = comment.querySelector('.comments-comment-meta__description-title, .comments-post-meta__name-text, .comments-comment-meta__name-text');
      const target = nameEl || anchor;
      return { key: comment, target, name: visibleText(nameEl || anchor), mode: 'after' };
    }
    // 3. Search results / people lists
    const result = anchor.closest('.entity-result, .reusable-search__result-container, li[class*="search-result"], .search-results-container li');
    if (result) {
      const titleLine = result.querySelector('.entity-result__title-text, .entity-result__title-line, [class*="title-text"]');
      const nameEl = titleLine ? (titleLine.querySelector('[aria-hidden="true"]') || titleLine) : anchor;
      return { key: result, target: titleLine || anchor, name: visibleText(nameEl), mode: 'after' };
    }
    // On a profile page, every other link to the same person (Contact info,
    // buttons, sidebar) is handled by the header pill only.
    if (slug && slug === pageSlug()) return null;

    // 4. Messaging list / notifications / "people you may know" cards etc.
    const card = anchor.closest('li, article, .artdeco-entity-lockup, .discover-entity-type-card');
    if (card) {
      const nameEl = anchor.querySelector('[aria-hidden="true"]') || anchor;
      const name = visibleText(nameEl);
      if (looksLikeName(name)) return { key: card, target: anchor, name, mode: 'after' };
      return null;
    }
    // 5. Generic fallback: an anchor whose text is a person's name
    if (!anchor.querySelector('img')) {
      const name = visibleText(anchor);
      if (looksLikeName(name)) return { key: anchor, target: anchor, name, mode: 'after' };
    }
    return null;
  }

  const NOT_NAMES = /^(contact info|view profile|view|pending|message|follow|following|connect|see all|more|show all|reply|like|share|send|visit my website|view my newsletter)$/i;
  function looksLikeName(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 3 || t.length > 40) return false;
    if (/\d/.test(t)) return false;
    if (NOT_NAMES.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length >= 2 && words.length <= 5;
  }

  function pageSlug() {
    const m = location.pathname.match(/^\/in\/([^/?#]+)/);
    return m ? S.slugFromUrl(location.pathname) : null;
  }

  // ---------- rendering ----------

  function makePill(tag) {
    const c = S.COLORS[tag.color] || S.COLORS.purple;
    const pill = document.createElement('span');
    pill.className = 'icpx-pill' + (tag.soft ? ' icpx-pill--soft' : '');
    pill.style.setProperty('--icpx-bg', c.bg);
    pill.style.setProperty('--icpx-fg', c.fg);
    pill.style.setProperty('--icpx-dot', c.dot);
    pill.title = tag.title || tag.label;
    const dot = document.createElement('i');
    dot.className = 'icpx-dot';
    const text = document.createElement('span');
    text.textContent = tag.label + (tag.soft ? ' ?' : '');
    pill.append(dot, text);
    return pill;
  }

  function buildPillBar(slug, name, tags) {
    const bar = document.createElement('span');
    bar.className = 'icpx-pills';
    bar.dataset.icpxSlug = slug || '';
    bar.dataset.icpxName = name || '';
    for (const t of tags) bar.appendChild(makePill(t));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'icpx-add';
    add.title = 'Add or edit labels for this person';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Add or edit labels');
    bar.appendChild(add);
    if (!tags.length) bar.classList.add('icpx-pills--empty');
    return bar;
  }

  function renderFor(loc, slug) {
    if (!loc || !loc.target) return;
    const key = loc.key || loc.target;
    if (key.dataset.icpxDone === slug) return;
    // Remove a previous bar (e.g. LinkedIn re-rendered the same element)
    const old = key.querySelector(':scope .icpx-pills');
    if (old) old.remove();
    key.dataset.icpxDone = slug;

    // Already have a bar for this person inside this container? Don't add another.
    if (key.querySelector(`.icpx-pills[data-icpx-slug="${CSS.escape(slug)}"]`)) return;

    const tags = resolveTags(slug, loc.name);
    if (tags.length) recordFlag(slug, tags);
    const bar = buildPillBar(slug, loc.name, tags);

    if (!tags.length) {
      // Nothing to show for this person. Put the "+" inside the name element so it
      // sits just right of the name and adds no line of its own. An empty bar placed
      // after the name would reserve a whole row and leave a blank gap.
      loc.target.appendChild(bar);
      return;
    }
    if (loc.mode === 'append') loc.target.appendChild(bar);
    else loc.target.insertAdjacentElement('afterend', bar);
    requestAnimationFrame(() => fixOverlap(bar, loc.target, key));
  }

  // Some LinkedIn layouts position the name row absolutely or in a flex row, which
  // makes anything inserted next to it sit on top of or beside the name. If that happens,
  // move the bar one level up (below the whole row) until it no longer overlaps.
  function fixOverlap(bar, target, key) {
    for (let hops = 0; hops < 4; hops++) {
      if (!bar.isConnected) return;
      const b = bar.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      if (!b.height || !t.height) return;
      // Bar must sit below the name row, not on top of it or beside it.
      const notBelow = b.top < t.bottom - 2;
      if (!notBelow) return;
      const parent = bar.parentElement;
      if (!parent || parent === key || parent === document.body) { bar.style.position = 'static'; return; }
      parent.insertAdjacentElement('afterend', bar);
      target = parent;
    }
  }

  function scan() {
    const anchors = document.querySelectorAll('a[href*="/in/"]:not([data-icpx-seen])');
    for (const a of anchors) {
      try {
        a.dataset.icpxSeen = '1';
        if (a.closest('.icpx-pills, .icpx-editor')) continue;
        const slug = slugFromAnchor(a);
        if (!slug) continue;
        const loc = locate(a, slug);
        if (!loc) continue;
        renderFor(loc, slug);
      } catch (e) {
        recordError('scan element', e);
      }
    }
    try { renderProfileHeader(); } catch (e) { recordError('profile header', e); }
  }

  // The profile name: a real <h1> if LinkedIn renders one, otherwise the
  // largest short piece of text near the top of the page (the name is always
  // the biggest text on a profile, whatever LinkedIn calls the element).
  function findProfileNameEl() {
    const direct = document.querySelector('main h1, [class*="top-card"] h1, h1.text-heading-xlarge, main .text-heading-xlarge');
    if (direct && direct.textContent.trim()) return direct;
    const root = document.querySelector('main') || document.body;
    let best = null;
    let bestSize = 0;
    const els = root.querySelectorAll('h1, h2, h3, span, div, a, p');
    for (const el of els) {
      if (el.children.length > 4) continue;
      if (el.closest('.icpx-pills, .icpx-editor, nav, header, aside, code')) continue;
      const text = el.textContent.trim();
      if (text.length < 2 || text.length > 60) continue;
      const r = el.getBoundingClientRect();
      if (!r.height || r.width < 40 || r.top + window.scrollY > 1400) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > bestSize) { bestSize = fs; best = el; }
    }
    return bestSize >= 20 ? best : null;
  }

  let profileBar = null;
  let profileBarUrl = '';

  function renderProfileHeader() {
    const slug = pageSlug();
    if (!slug) return;
    if (profileBar && profileBar.isConnected && profileBarUrl === location.pathname) return;
    const nameEl = findProfileNameEl();
    if (!nameEl) return;
    // If the name element is an inline piece inside a row, treat the row as the target
    // so the bar goes under the whole row.
    let target = nameEl;
    for (let i = 0; i < 4; i++) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent.tagName === 'MAIN' || parent.tagName === 'SECTION') break;
      const own = getComputedStyle(target).display;
      const pd = getComputedStyle(parent).display;
      const inlineish = ['inline', 'inline-block', 'contents'].includes(own);
      const rowContainer = /flex|grid/.test(pd) && getComputedStyle(parent).flexDirection !== 'column';
      if (!inlineish && !rowContainer) break;
      target = parent;
    }
    const key = target.parentElement || target;
    if (key.querySelector(':scope > .icpx-pills')) key.querySelector(':scope > .icpx-pills').remove();
    delete key.dataset.icpxDone;
    renderFor({ key, target, name: visibleText(nameEl), mode: 'after' }, slug);
    profileBar = key.querySelector('.icpx-pills');
    profileBarUrl = location.pathname;
    if (profileBar) profileBar.classList.add('icpx-pills--profile');
  }

  function rerenderAll() {
    document.querySelectorAll('.icpx-pills').forEach((n) => n.remove());
    document.querySelectorAll('[data-icpx-done]').forEach((n) => delete n.dataset.icpxDone);
    document.querySelectorAll('[data-icpx-seen]').forEach((n) => delete n.dataset.icpxSeen);
    scheduleScan();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; try { scan(); } catch (e) { recordError('scan', e); } }, 150);
  }

  // ---------- quick-add editor ----------

  let editorEl = null;

  function closeEditor() {
    if (editorEl) { editorEl.remove(); editorEl = null; }
    document.removeEventListener('pointerdown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocMouseDown(e) {
    if (!editorEl) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (editorEl.contains(t) || t.closest('.icpx-add'))) return;
    closeEditor();
  }
  function onDocKey(e) {
    if (e.key === 'Escape') closeEditor();
  }

  function allKnownLabels() {
    const set = new Set();
    for (const slug of Object.keys(manualTags)) {
      for (const t of (manualTags[slug].tags || [])) set.add(t.label);
    }
    return Array.from(set).sort();
  }

  function openEditor(button, slug, name) {
    try { openEditorInner(button, slug, name); } catch (e) { recordError('open editor', e); }
  }

  function openEditorInner(button, slug, name) {
    closeEditor();
    const rect = button.getBoundingClientRect();
    const ed = document.createElement('div');
    ed.className = 'icpx-editor';
    ed.dataset.slug = slug || '';
    ed.style.top = `${rect.bottom + window.scrollY + 6}px`;
    ed.style.left = `${Math.min(rect.left + window.scrollX, window.innerWidth - 320)}px`;

    const entry = manualTags[slug] || { name, tags: [] };
    const hs = hubspotIndex.bySlug && hubspotIndex.bySlug[slug];

    ed.innerHTML = `
      <div class="icpx-ed-head">
        <div class="icpx-ed-name">${escapeHtml(name || slug)}</div>
        <div class="icpx-ed-sub">${escapeHtml('linkedin.com/in/' + slug)}</div>
        ${hs ? `<div class="icpx-ed-hs">In HubSpot${hs.company ? ' · ' + escapeHtml(hs.company) : ''}</div>` : '<div class="icpx-ed-hs icpx-ed-hs--no">Not in HubSpot</div>'}
      </div>
      <div class="icpx-ed-current"></div>
      <form class="icpx-ed-form">
        <input class="icpx-ed-label" list="icpx-labels" placeholder="Label, e.g. Top authority influencer" maxlength="40" autocomplete="off" />
        <datalist id="icpx-labels">${allKnownLabels().map((l) => `<option value="${escapeHtml(l)}"></option>`).join('')}</datalist>
        <div class="icpx-ed-colors"></div>
        <div class="icpx-ed-actions">
          <button type="submit" class="icpx-btn icpx-btn--primary">Add label</button>
          <button type="button" class="icpx-btn icpx-ed-settings">Settings</button>
        </div>
      </form>
    `;

    const current = ed.querySelector('.icpx-ed-current');
    if (!entry.tags.length) {
      current.innerHTML = '<div class="icpx-ed-empty">No custom labels yet.</div>';
    } else {
      for (const t of entry.tags) {
        const row = document.createElement('div');
        row.className = 'icpx-ed-row';
        row.appendChild(makePill({ label: t.label, color: t.color }));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icpx-ed-del';
        del.title = 'Remove label';
        del.textContent = '×';
        del.addEventListener('click', async () => {
          await saveManual(slug, name, entry.tags.filter((x) => x !== t));
          openEditor(button, slug, name);
        });
        row.appendChild(del);
        current.appendChild(row);
      }
    }

    let chosenColor = 'purple';
    const colorsEl = ed.querySelector('.icpx-ed-colors');
    for (const [key, c] of Object.entries(S.COLORS)) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'icpx-swatch' + (key === chosenColor ? ' icpx-swatch--on' : '');
      sw.style.background = c.dot;
      sw.title = key;
      sw.addEventListener('click', () => {
        chosenColor = key;
        colorsEl.querySelectorAll('.icpx-swatch').forEach((s) => s.classList.remove('icpx-swatch--on'));
        sw.classList.add('icpx-swatch--on');
      });
      colorsEl.appendChild(sw);
    }

    ed.querySelector('.icpx-ed-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = ed.querySelector('.icpx-ed-label').value.trim();
      if (!label) return;
      const tags = entry.tags.filter((t) => t.label.toLowerCase() !== label.toLowerCase());
      tags.push({ label, color: chosenColor });
      await saveManual(slug, name, tags);
      openEditor(button, slug, name);
    });
    ed.querySelector('.icpx-ed-settings').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'openOptions' }, () => void chrome.runtime.lastError);
      closeEditor();
    });

    document.body.appendChild(ed);
    editorEl = ed;
    setTimeout(() => ed.querySelector('.icpx-ed-label').focus(), 0);
    document.addEventListener('pointerdown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }

  async function saveManual(slug, name, tags) {
    const next = Object.assign({}, manualTags);
    if (tags.length) next[slug] = { name: name || (next[slug] && next[slug].name) || '', tags, updated: Date.now() };
    else delete next[slug];
    manualTags = next;
    await S.storageSet({ manualTags: next });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // LinkedIn listens for clicks on whole posts (capture phase) and navigates.
  // Window-level capture listeners run before those, so we can swallow
  // clicks on our own "+" button and editor.
  for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick']) {
    window.addEventListener(ev, (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      const add = t.closest('.icpx-add');
      if (add) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (ev === 'pointerdown' || (ev === 'mousedown' && !('PointerEvent' in window))) {
          clicksSeen++;
          const bar = add.closest('.icpx-pills');
          const slug = bar ? bar.dataset.icpxSlug : '';
          if (editorEl && editorEl.dataset.slug === slug) closeEditor();
          else openEditor(add, slug, bar ? bar.dataset.icpxName : '');
        }
        return;
      }
      if (t.closest('.icpx-editor')) e.stopImmediatePropagation();
    }, true);
  }
  for (const ev of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(ev, (e) => {
      if (e.target instanceof Element && e.target.closest('.icpx-editor')) {
        e.stopImmediatePropagation();
        if (ev === 'keydown' && e.key === 'Escape') closeEditor();
      }
    }, true);
  }

  // ---------- usage tracking (local only, never leaves the browser) ----------

  const pending = new Map(); // slug -> {icp, manual}
  let flushTimer = null;

  function recordFlag(slug, tags) {
    if (!slug) return;
    const cur = pending.get(slug) || { icp: false, manual: false };
    for (const t of tags) {
      if (t.source === 'hubspot') cur.icp = true;
      else cur.manual = true;
    }
    pending.set(slug, cur);
    if (!flushTimer) flushTimer = setTimeout(flushStats, 5000);
  }

  async function flushStats() {
    flushTimer = null;
    if (!pending.size) return;
    const batch = new Map(pending);
    pending.clear();
    try {
      const { stats } = await S.storageGet('stats');
      const st = stats && stats.people ? stats : S.EMPTY_STATS();
      for (const [slug, v] of batch) {
        const prev = st.people[slug] || { icp: false, manual: false };
        st.people[slug] = { icp: prev.icp || v.icp, manual: prev.manual || v.manual };
        st.moments = (st.moments || 0) + 1;
      }
      await S.storageSet({ stats: st });
    } catch (e) {
      recordError('flush stats', e);
    }
  }

  window.addEventListener('pagehide', () => { if (pending.size) flushStats(); });

  // ---------- the every-N-days insight card ----------

  let cardEl = null;

  function onFeedPage() {
    const p = location.pathname;
    return p === '/feed/' || p.startsWith('/feed') || p.startsWith('/search/results/content');
  }

  // Never interrupt: not while typing, not while a LinkedIn dialog is open.
  function userIsBusy() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return true;
    if (document.querySelector('[role="dialog"], .artdeco-modal')) return true;
    return false;
  }

  async function maybeShowCard() {
    try {
      if (cardEl || !settings.insightsEnabled || !onFeedPage()) return;
      const { stats } = await S.storageGet('stats');
      const st = stats && stats.people ? stats : null;
      if (!st) return;
      const days = Math.floor((Date.now() - st.periodStart) / 86400000);
      if (days < (settings.insightsDays || 14)) return;
      const slugs = Object.keys(st.people || {});
      if (slugs.length < (settings.insightsMin || 5)) return; // too quiet, wait longer
      if (userIsBusy()) { setTimeout(maybeShowCard, 20000); return; }
      showCard(st, days, slugs);
    } catch (e) {
      recordError('insight card', e);
    }
  }

  function showCard(st, days, slugs) {
    let icp = 0;
    let manual = 0;
    for (const sl of slugs) {
      if (st.people[sl].icp) icp++;
      if (st.people[sl].manual) manual++;
    }
    const total = slugs.length;

    const card = document.createElement('div');
    card.className = 'icpx-card';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', 'LinkedIn ICP Pills, your last ' + days + ' days');

    const detail = [
      icp ? `${icp} already in your CRM` : '',
      manual ? `${manual} with your own labels` : '',
    ].filter(Boolean).join(' · ');

    card.innerHTML = `
      <button class="icpx-card__x" aria-label="Close">&times;</button>
      <div class="icpx-card__eyebrow">YOUR LAST ${days} DAYS</div>
      <div class="icpx-card__big">${total} <span>${total === 1 ? 'person' : 'people'}</span></div>
      <div class="icpx-card__sub">ICP Pills told you who they were before you commented.${detail ? ` <span class="icpx-card__detail">${detail}</span>` : ''}</div>
      <div class="icpx-card__rule"></div>
      <div class="icpx-card__pitch">
        That is ${total} times you did not stop to check HubSpot.
        I'm Vai. I find boring tasks like that and end them, almost always without writing any code.
      </div>
      <a class="icpx-card__btn" href="https://efficialabs.com/ai-boring-task-fix/" target="_blank" rel="noopener">What is yours? Let's kill it</a>
      <div class="icpx-card__foot">
        <button class="icpx-card__link" data-act="later">Not now</button>
        <button class="icpx-card__link" data-act="off">Stop showing these</button>
      </div>
    `;

    card.addEventListener('click', (e) => e.stopPropagation());
    card.querySelector('.icpx-card__x').addEventListener('click', () => closeCard('later'));
    card.querySelector('[data-act="later"]').addEventListener('click', () => closeCard('later'));
    card.querySelector('[data-act="off"]').addEventListener('click', () => closeCard('off'));
    card.querySelector('.icpx-card__btn').addEventListener('click', () => closeCard('clicked'));

    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('icpx-card--in'));
    cardEl = card;
    document.addEventListener('keydown', cardKey, true);
    // Reset the period now, so it cannot reappear in another tab this session.
    resetPeriod();
  }

  function cardKey(e) {
    if (e.key === 'Escape' && cardEl) { e.stopPropagation(); closeCard('later'); }
  }

  async function closeCard(reason) {
    if (!cardEl) return;
    const el = cardEl;
    cardEl = null;
    document.removeEventListener('keydown', cardKey, true);
    el.classList.remove('icpx-card--in');
    setTimeout(() => el.remove(), 250);
    if (reason === 'off') {
      settings = Object.assign({}, settings, { insightsEnabled: false });
      await S.storageSet({ settings });
    }
  }

  async function resetPeriod() {
    try {
      const { stats } = await S.storageGet('stats');
      const st = stats && stats.people ? stats : S.EMPTY_STATS();
      await S.storageSet({
        stats: {
          periodStart: Date.now(),
          people: {},
          moments: 0,
          shown: (st.shown || 0) + 1,
          lastShown: Date.now(),
        },
      });
    } catch (e) {
      recordError('reset period', e);
    }
  }

  // ---------- boot ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'diag') return;
    const h1 = document.querySelector('main h1');
    const nameEl = pageSlug() ? findProfileNameEl() : null;
    sendResponse({
      nameEl: nameEl ? `${nameEl.tagName.toLowerCase()} "${nameEl.textContent.trim().slice(0, 40)}"` : null,
      clicksSeen,
      cardShowing: !!cardEl,
      insightsOn: settings.insightsEnabled !== false,
      version: VERSION,
      url: location.href,
      pageSlug: pageSlug(),
      h1Text: h1 ? h1.textContent.trim().slice(0, 60) : null,
      profileAnchors: document.querySelectorAll('a[href*="/in/"]').length,
      bars: document.querySelectorAll('.icpx-pills').length,
      pills: document.querySelectorAll('.icpx-pill').length,
      contactsBySlug: Object.keys((hubspotIndex && hubspotIndex.bySlug) || {}).length,
      contactsByName: Object.keys((hubspotIndex && hubspotIndex.byName) || {}).length,
      labels: Object.keys(manualTags || {}).length,
      nameMatching: settings.nameMatching,
      errors: errors.slice(),
    });
    return true;
  });

  (async () => {
    if (!chrome.runtime || !chrome.runtime.id) return; // orphaned after an extension reload
    try {
      await loadData();
    } catch (e) {
      recordError('load data', e);
    }
    try { scan(); } catch (e) { recordError('first scan', e); }

    // Make sure a counting period exists, then consider the card once,
    // well after the page has settled so it never competes with load.
    S.storageGet('stats').then(({ stats }) => {
      if (!stats || !stats.people) return S.storageSet({ stats: S.EMPTY_STATS() });
    }).catch(() => {});
    setTimeout(maybeShowCard, 8000);
    chrome.runtime.sendMessage({ type: 'ensureFresh' }, () => void chrome.runtime.lastError);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) { scheduleScan(); break; }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // LinkedIn is a single-page app; re-check the profile header when the URL changes.
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        closeEditor();
        scheduleScan();
      }
    }, 800);
  })();
})();
