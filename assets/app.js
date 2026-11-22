/* Pheme — standalone broadsheet news dashboard. No build step, no dependencies. */
(function () {
  'use strict';

  var D = window.DAYBREAK;
  var app = document.getElementById('app');
  if (!D || !app) return;

  var STORE_KEY = 'daybreak:v2';
  var worldMap;
  var worldMarkerLayer;
  var mapPinById = Object.create(null);
  var MARKETS = [
    { id: 'london', city: 'London', index: 'FTSE 100 · CFD', symbol: 'FOREXCOM:UKXGBP', zone: 'Europe/London', url: 'https://www.tradingview.com/symbols/FOREXCOM-UKXGBP/' },
    { id: 'newyork', city: 'New York', index: 'S&P 500 · CFD', symbol: 'FOREXCOM:SPXUSD', zone: 'America/New_York', url: 'https://www.tradingview.com/symbols/FOREXCOM-SPXUSD/' },
    { id: 'shanghai', city: 'Shanghai', index: 'Shanghai Composite', symbol: 'SSE:000001', zone: 'Asia/Shanghai', url: 'https://www.tradingview.com/symbols/SSE-000001/' }
  ];
  var clockFormats = Object.create(null);
  var route = new URLSearchParams(location.search);
  var SEG_ORDER = ['L', 'LL', 'C', 'LR', 'R', 'S'];
  var labelOf = {};
  D.TOPICS.forEach(function (t) { labelOf[t.id] = t.label; });

  var MAP_REGIONS = {
    global: { label: 'Global', bounds: [[-28, -128], [62, 122]], maxZoom: 2 },
    uk: { label: 'UK & Ireland', bounds: [[49.8, -8.2], [56.5, 2.0]], maxZoom: 7 },
    europe: { label: 'Europe', bounds: [[44.8, -6.5], [61.2, 34.5]], maxZoom: 5 },
    mideast: { label: 'Middle East', bounds: [[22.0, 28.0], [39.5, 55.0]], maxZoom: 5 },
    asia: { label: 'Asia-Pacific', bounds: [[-10.0, 98.0], [42.0, 124.0]], maxZoom: 4 },
    americas: { label: 'North America', bounds: [[24.0, -125.5], [43.0, -72.0]], maxZoom: 4 },
    latam: { label: 'Latin America', bounds: [[-22.0, -112.0], [28.0, -42.0]], maxZoom: 4 },
    africa: { label: 'Africa', bounds: [[-31.0, 18.0], [-20.0, 36.0]], maxZoom: 6 }
  };

  /* ---------- state (saved choices persist in this browser) ---------- */
  var state = {
    view: 'briefing', topic: 'all', mapTopic: 'all', reading: null, readingSource: null, paper: null,
    settingsOpen: false, searchOpen: false, utilityOpen: null, srcQuery: '', query: '',
    headerPrefs: { showClock: true, markets: ['london', 'newyork', 'shanghai'] },
    saved: {}, added: {}, highlights: {},
    readerPrefs: { theme: 'newsprint', size: 'md', font: 'serif', measure: 'focused' },
    readerFocus: false, aaOpen: false, covFilter: 'all', copiedId: null,
    speaking: false, speechRate: 1, speakingIndex: -1
  };
  try {
    var stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!stored) {
      var legacy = JSON.parse(localStorage.getItem('daybreak:v1') || 'null');
      if (legacy) {
        var migrated = {};
        Object.keys(D.LEGACY_IDS || {}).forEach(function (id) {
          if (legacy.saved && legacy.saved[id]) migrated[D.LEGACY_IDS[id]] = true;
        });
        stored = { saved: migrated, added: legacy.added };
      }
    }
    if (stored) {
      if (stored.saved) state.saved = stored.saved;
      if (stored.added) state.added = stored.added;
      if (stored.highlights) state.highlights = stored.highlights;
      if (stored.readerPrefs) state.readerPrefs = Object.assign({}, state.readerPrefs, stored.readerPrefs);
      if (stored.headerPrefs) {
        if (typeof stored.headerPrefs.showClock === 'boolean') state.headerPrefs.showClock = stored.headerPrefs.showClock;
        if (Array.isArray(stored.headerPrefs.markets)) {
          state.headerPrefs.markets = MARKETS.filter(function (m) { return stored.headerPrefs.markets.indexOf(m.id) !== -1; }).map(function (m) { return m.id; });
        }
      }
    }
  } catch (e) { /* storage unavailable: keep defaults */ }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        saved: state.saved,
        added: state.added,
        highlights: state.highlights,
        readerPrefs: state.readerPrefs,
        headerPrefs: state.headerPrefs
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeAsset(u) { return /^assets\/images\/[a-z0-9._-]+$/i.test(u || '') ? u : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  var ICON = {
    bookmark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    bookmarkFilled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    search: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
    compare: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="7" height="16" rx="1.5"></rect><rect x="14" y="4" width="7" height="16" rx="1.5"></rect><path d="M5.5 8h2M5.5 11h2M16.5 8h2M16.5 11h2"></path></svg>',
    bookmarkLg: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    bookmarkLgFilled: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
    listen: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>',
    stop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>',
    focus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"></path></svg>',
    link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>'
  };

  /* ---------- coverage ---------- */
  function buildCoverage(id, archived) {
    var rows = (archived || D.COVERAGE[id] || []).map(function (r) {
      var code = D.OUTLETS[r[0]] || 'NC';
      return { name: r[0], date: r[1], url: r[2], title: r[3] || '', code: code };
    });
    var counts = {};
    rows.forEach(function (r) { counts[r.code] = (counts[r.code] || 0) + 1; });
    var other = (counts.P || 0) + (counts.NR || 0) + (counts.NC || 0);
    var present = SEG_ORDER.filter(function (k) { return counts[k]; });
    var legend = present.map(function (k) { return { cls: 'c-' + k, label: D.LEAN[k][0], n: counts[k] }; });
    if (other) legend.push({ cls: 'c-O', label: 'Other / unrated', n: other });
    var left = (counts.L || 0) + (counts.LL || 0);
    var right = (counts.LR || 0) + (counts.R || 0);
    var centre = counts.C || 0;
    var rated = left + right + centre;
    var note;
    if (rows.length && (counts.S || 0) > rows.length / 2) note = 'Mostly science outlets, which aren’t rated left–right.';
    else if (rated < 2) note = 'Too few rated outlets to judge the spread.';
    else if (right === 0 && left > 0) note = 'No right-leaning outlets in this sample.';
    else if (left === 0 && right > 0) note = 'No left-leaning outlets in this sample.';
    else if (left === 0 && right === 0) note = 'Only centre-rated outlets in this sample.';
    else note = 'Includes both left- and right-leaning outlets.';
    return {
      rows: rows, legend: legend, note: note, count: plural(rows.length, 'source', 'sources'),
      aria: 'Coverage mix: ' + legend.map(function (l) { return l.n + ' ' + l.label.toLowerCase(); }).join(', ')
    };
  }

  var CURRENT = D.STORIES.map(function (s) {
    var o = Object.assign({}, s);
    o.cov = buildCoverage(s.id);
    return o;
  });
  var STORIES = CURRENT.concat((window.DAYBREAK_ARCHIVE || []).map(function (s) {
    return Object.assign({}, s, { cov: buildCoverage(s.id, s.coverage) });
  })).filter(function (s, i, all) {
    return all.findIndex(function (item) { return item.id === s.id; }) === i;
  });
  var byId = Object.create(null);
  STORIES.forEach(function (s) { byId[s.id] = s; });

  state.reading = byId[route.get('story')] ? route.get('story') : null;
  state.readingSource = sourceForStory(state.reading, route.get('source'));
  if (route.has('q')) {
    state.query = route.get('q');
    if (state.query.trim()) state.searchOpen = true;
  }

  function storyHref(id) { return '?story=' + encodeURIComponent(id); }
  function sourceForStory(id, name) {
    var story = byId[id];
    return story && name && story.cov.rows.some(function (r) { return r.name === name; }) ? name : null;
  }
  function sourceHref(id, name) { return storyHref(id) + '&source=' + encodeURIComponent(name); }
  function nativeSourceLink(s, name, label, cls) {
    return '<a class="' + (cls || '') + '" href="' + esc(sourceHref(s.id, name)) + '" data-act="opensource" data-id="' + esc(s.id) + '" data-source="' + esc(name) + '" aria-label="Read ' + esc(name) + ' coverage in Pheme">' + esc(label || name) + '</a>';
  }
  function compareLink(s, cls, label) {
    return '<a class="' + cls + '" href="' + storyHref(s.id) +
      '" data-act="open" data-id="' + esc(s.id) + '">' + esc(label) + '</a>';
  }
  function stopSpeech() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
    state.speaking = false;
    state.speakingIndex = -1;
  }

  function changeStory(id, source) {
    stopSpeech();
    state.reading = id;
    state.readingSource = sourceForStory(id, source);
    state.covFilter = 'all';
    state.aaOpen = false;
    state.copiedId = null;
    if (!id) state.readerFocus = false;
    history.pushState(null, '', id ? (state.readingSource ? sourceHref(id, state.readingSource) : storyHref(id)) : location.pathname);
  }
  window.addEventListener('popstate', function () {
    stopSpeech();
    var params = new URLSearchParams(location.search);
    var id = params.get('story');
    state.reading = byId[id] ? id : null;
    state.readingSource = sourceForStory(state.reading, params.get('source'));
    if (!state.reading) state.readerFocus = false;
    state.aaOpen = false;
    render();
  });

  function covBar(cov, full) {
    return '<div class="covbar' + (full ? ' full' : '') + '" role="img" aria-label="' + esc(cov.aria) + '">' +
      cov.legend.map(function (l) { return '<span class="seg ' + l.cls + '" style="flex-grow:' + l.n + '"></span>'; }).join('') +
      '</div>';
  }
  function leanBadge(name) {
    var code = D.OUTLETS[name] || 'NC';
    var lean = D.LEAN[code] || D.LEAN.NC;
    var flagged = (D.QUESTIONABLE || []).indexOf(name) !== -1;
    return '<span class="lean lb-' + (D.LEAN[code] ? code : 'NC') + '" title="Media Bias/Fact Check: ' + esc(lean[1]) + (flagged ? ' · rated a questionable source' : '') + '">' +
      esc(lean[0]) + (flagged ? ' <span aria-hidden="true">⚠</span><span class="sr-only">(questionable source)</span>' : '') + '</span>';
  }
  function saveBtn(s) {
    var on = !!state.saved[s.id];
    return '<button class="save-link' + (on ? ' on' : '') + '" data-act="save" data-id="' + esc(s.id) + '" aria-pressed="' + on + '">' +
      (on ? ICON.bookmarkFilled : ICON.bookmark) + (on ? 'Saved' : 'Save') + '</button>';
  }

  /* Icon toolbar for story cards: compare coverage + save */
  function storyTools(s, saveOnly) {
    var on = !!state.saved[s.id];
    var n = s.cov.rows.length;
    var compareLabel = 'Compare coverage (' + plural(n, 'source', 'sources') + ')';
    var saveLabel = on ? 'Remove from saved' : 'Save story';
    return '<div class="story-tools" role="toolbar" aria-label="Story actions">' +
      (saveOnly ? '' : '<a class="tool-btn" href="' + storyHref(s.id) + '" data-act="open" data-id="' + esc(s.id) + '" aria-label="' + esc(compareLabel) + '" title="' + esc(compareLabel) + '">' +
        ICON.compare + '<span class="tool-count" aria-hidden="true">' + n + '</span></a>') +
      '<button class="tool-btn' + (on ? ' on' : '') + '" data-act="save" data-id="' + esc(s.id) + '" aria-pressed="' + on + '" aria-label="' + saveLabel + '" title="' + saveLabel + '">' +
        (on ? ICON.bookmarkLgFilled : ICON.bookmarkLg) + '</button>' +
      '</div>';
  }

  /* ---------- followed papers & catalogue ---------- */
  function catalogue() {
    var base = {};
    D.FOLLOWED.forEach(function (f) { base[f.name] = true; });
    return D.CATALOG.filter(function (r) { return !base[r[1]]; }).map(function (r) {
      var cat = D.CATS[r[2]];
      return { id: r[0], name: r[1], topic: cat.topic, catLabel: cat.label, paywall: !!r[3] };
    });
  }
  var CATALOGUE = catalogue();
  function followed() {
    return D.FOLLOWED.concat(CATALOGUE.filter(function (c) { return state.added[c.id]; })
      .map(function (c) { return { name: c.name, topic: c.topic, paywall: c.paywall }; }));
  }

  function matchesQuery(s) {
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    return (s.headline + ' ' + s.summary + ' ' + s.source + ' ' + labelOf[s.topic]).toLowerCase().indexOf(q) !== -1;
  }

  function displayDate() {
    return (D.META.dateLabel || '').replace(/\s+\d{4}$/, '');
  }

  function clockText(zone) {
    if (!clockFormats[zone]) clockFormats[zone] = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    return clockFormats[zone].format(new Date());
  }

  function renderClock(zone, label) {
    return '<time class="header-clock" data-clock-zone="' + zone + '" aria-label="' + esc(label) + '">' + clockText(zone) + '</time>';
  }

  function updateClocks() {
    app.querySelectorAll('[data-clock-zone]').forEach(function (el) { el.textContent = clockText(el.getAttribute('data-clock-zone')); });
  }

  function renderMarkets() {
    var selected = MARKETS.filter(function (m) { return state.headerPrefs.markets.indexOf(m.id) !== -1; });
    if (!selected.length) return '';
    var key = selected.map(function (m) { return m.id; }).join(',') + ':' + state.headerPrefs.showClock;
    var existing = document.getElementById('market-widgets');
    if (existing && existing.getAttribute('data-markets') === key) return '<div id="market-widgets" data-markets="' + key + '"></div>';
    return '<section id="market-widgets" class="market-strip" aria-label="Stock market widgets" data-markets="' + key + '">' +
      '<div class="market-grid">' + selected.map(function (m) {
        return '<article class="market-widget" aria-label="' + esc(m.city + ' ' + m.index) + '">' +
          '<div class="market-heading"><h2>' + m.city + '<span>' + esc(m.index) + '</span></h2>' +
          (state.headerPrefs.showClock ? renderClock(m.zone, m.city + ' time') : '') + '</div>' +
          '<tv-mini-chart symbol="' + m.symbol + '" theme="light" time-frame="6M" aria-label="' + esc(m.index + ' price and chart') + '">' +
          '<div class="market-fallback"><span class="market-loading">Loading market chart…</span><span class="market-unavailable">Market chart unavailable.</span> ' +
          '<a href="' + m.url + '" target="_blank" rel="noopener noreferrer">View ' + esc(m.index) + ' chart</a></div></tv-mini-chart></article>';
      }).join('') + '</div><p class="market-note">6-month charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> · UK/US: index CFDs · Shanghai: end-of-day · Data may be delayed. <button data-act="settings">Customise widgets</button></p></section>';
  }

  function renderHeaderMenu(id, label) {
    var open = state.utilityOpen === id;
    return '<div class="header-menu"><button id="menu-toggle-' + id + '" class="tab tab-subtle menu-toggle' + (open ? ' on' : '') + '" data-act="headermenu" data-id="' + id + '" aria-expanded="' + open + '" aria-controls="menu-' + id + '">' + label + '<span aria-hidden="true">⌄</span></button>' +
      (open ? '<section id="menu-' + id + '" class="header-dropdown" role="dialog" aria-labelledby="menu-title-' + id + '" tabindex="-1">' + renderHeaderMenuContent(id) + '</section>' : '') + '</div>';
  }

  /* ---------- Masthead & Topic Nav ---------- */
  function renderHeader() {
    var savedCount = STORIES.filter(function (s) { return state.saved[s.id]; }).length;
    var isBriefing = !state.reading && state.view === 'briefing';
    var isSaved = !state.reading && state.view === 'saved';

    var topicTabs = [{ id: 'all', label: 'All' }].concat(D.TOPICS).map(function (t) {
      var on = isBriefing && state.topic === t.id;
      return '<button class="tab' + (on ? ' on' : '') + '" data-act="topic" data-id="' + esc(t.id) + '" aria-pressed="' + on + '">' + esc(t.label) + '</button>';
    }).join('');

    var searchDrawer = state.searchOpen
      ? '<div class="search-drawer"><div class="wrap"><form class="search-form" role="search" data-form="search">' +
        ICON.search +
        '<label for="q" class="sr-only">Search stories, topics and sources</label>' +
        '<input id="q" type="search" placeholder="Search stories, topics and sources…" value="' + esc(state.query) + '" autocomplete="off">' +
        (state.query ? '<button type="button" class="search-clear" data-act="clearsearch">Clear</button>' : '') +
        '<button type="button" class="search-toggle" data-act="togglesearch" aria-label="Close search">' + ICON.close + '</button>' +
        '</form></div></div>'
      : '';

    return '<div class="masthead-wrap">' +
      '<div class="wrap"><header class="topbar">' +
      '<button class="brand" data-act="home" aria-label="Pheme home">' +
      '<img class="brand-logo" src="assets/images/pheme-logo.png" alt="" width="44" height="44" decoding="async">' +
      '</button>' +
      '<div class="topbar-date">' + esc(displayDate()) +
      (state.headerPrefs.showClock ? '<span class="masthead-time">' + renderClock('Europe/London', 'London time') + ' London</span>' : '') + '</div>' +
      '<div class="topbar-actions">' +
      '<button class="search-toggle' + (state.searchOpen ? ' on' : '') + '" data-act="togglesearch" aria-label="Search stories" aria-expanded="' + state.searchOpen + '">' + ICON.search + '</button>' +
      '<span class="vsep" aria-hidden="true"></span>' +
      '<button class="nav-link' + (isSaved ? ' on' : '') + '" data-act="view" data-view="saved" aria-pressed="' + isSaved + '">Saved' +
      (savedCount ? '<span class="badge-count">' + savedCount + '</span>' : '') + '</button>' +
      '<button id="settings-toggle" class="nav-link settings-toggle" data-act="settings" aria-expanded="' + state.settingsOpen + '">Settings</button>' +
      '</div></header>' + renderMarkets() + '</div>' +
      '<nav class="topicbar" aria-label="Topics"><div class="wrap topicbar-inner">' +
      '<div class="topic-tabs">' + topicTabs + '</div>' +
      '<div class="topic-utility">' +
      renderHeaderMenu('digest', 'Digest') + renderHeaderMenu('coverage', 'Coverage') + renderHeaderMenu('newspapers', 'Newspapers') +
      '</div></div></nav>' + searchDrawer + '</div>';
  }

  var TOPIC_FALLBACK_IMAGE = {
    uk: { src: 'assets/images/uk-westminster.jpg', alt: 'Palace of Westminster and Big Ben on the River Thames' },
    world: { src: 'assets/images/world-peace-palace.jpg', alt: 'International diplomacy and global coverage' },
    science: { src: 'assets/images/science-cern-detector.jpg', alt: 'Scientific research instrumentation' },
    tech: { src: 'assets/images/tech-mac-desk.jpg', alt: 'Modern technology workspace' },
    business: { src: 'assets/images/business-aerospace.jpg', alt: 'Industry and global commerce' },
    finance: { src: 'assets/images/finance-city-london.jpg', alt: 'Financial district and markets' }
  };

  /* ---------- Broadsheet Front Page / Topic / Saved ---------- */
  function renderLead(s) {
    var img = safeAsset(s.image);
    var fallback = !img && TOPIC_FALLBACK_IMAGE[s.topic] ? TOPIC_FALLBACK_IMAGE[s.topic] : null;
    var src = img || (fallback ? fallback.src : '');
    var alt = img ? (s.imageAlt || s.headline) : (fallback ? fallback.alt : s.headline);
    var figure = src
      ? '<figure class="hero-figure"><button class="hero-figure-btn" data-act="open" data-id="' + esc(s.id) + '" aria-label="Open ' + esc(s.headline) + '">' +
        '<img src="' + esc(src) + '" alt="' + esc(alt) + '" loading="eager" decoding="async"></button></figure>'
      : '';
    return '<article class="hero-lead">' + figure +
      '<p class="kicker">' + esc(labelOf[s.topic]) +
      '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.time) + '</span></p>' +
      '<h1 class="lead-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h1>' +
      '<p class="lead-summary">' + esc(s.summary) + '</p>' +
      '<div class="lead-cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      '<div class="hero-actions">' + compareLink(s, 'compare-btn', 'Compare coverage') + storyTools(s, true) + '</div>' +
      '</article>';
  }

  function renderSideItem(s) {
    return '<article class="side-item">' +
      '<p class="kicker">' + esc(labelOf[s.topic]) + '</p>' +
      '<h2 class="side-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h2>' +
      '<p class="side-summary">' + esc(s.summary) + '</p>' +
      storyTools(s) +
      '</article>';
  }

  function renderGridItem(s) {
    return '<article class="grid-item">' +
      '<p class="kicker">' + esc(labelOf[s.topic]) + '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.time) + '</span></p>' +
      '<h3 class="grid-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h3>' +
      '<p class="grid-summary">' + esc(s.summary) + '</p>' +
      '<div class="grid-cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      storyTools(s) +
      '</article>';
  }

  function getMapStories() {
    return CURRENT.filter(function (s) {
      if (!s.location) return false;
      if (state.mapTopic !== 'all' && s.topic !== state.mapTopic) return false;
      return matchesQuery(s);
    });
  }

  function renderWorldMapListHtml(stories) {
    if (!stories.length) {
      return '<li style="grid-column:1/-1"><span class="small">No geotagged stories in this map area. Zoom out or click Global to reset.</span></li>';
    }
    return stories.map(function (story) {
      return '<li>' +
        '<div class="world-loc-main">' +
        '<span class="world-loc-meta"><span class="tdot tdot-' + esc(story.topic) + '"></span>' +
        esc(labelOf[story.topic]) + ' · ' + esc(story.location.label) + '</span>' +
        compareLink(story, 'world-loc-link', story.headline) +
        '</div>' +
        '<button type="button" class="world-loc-pinbtn" data-act="focuspin" data-id="' + esc(story.id) + '">Locate</button>' +
        '</li>';
    }).join('');
  }

  function renderWorldMap() {
    var allLocated = CURRENT.filter(function (s) { return s.location && matchesQuery(s); });
    if (!allLocated.length) return '';
    var activeStories = getMapStories();

    var topicPills = [{ id: 'all', label: 'All topics' }].concat(D.TOPICS).map(function (t) {
      var count = t.id === 'all'
        ? allLocated.length
        : allLocated.filter(function (s) { return s.topic === t.id; }).length;
      if (t.id !== 'all' && count === 0) return '';
      var on = state.mapTopic === t.id;
      return '<button type="button" class="map-pill' + (on ? ' on' : '') + '" data-act="maptopic" data-id="' + esc(t.id) + '" aria-pressed="' + on + '">' +
        (t.id !== 'all' ? '<span class="tdot tdot-' + esc(t.id) + '"></span>' : '') +
        esc(t.label) + ' (' + count + ')</button>';
    }).join('');

    var regionBtns = Object.keys(MAP_REGIONS).map(function (key) {
      return '<button type="button" class="map-region-btn" data-act="mapregion" data-id="' + esc(key) + '">' + esc(MAP_REGIONS[key].label) + '</button>';
    }).join('');

    return '<section class="world-panel" aria-labelledby="world-map-title">' +
      '<div class="world-panel-head"><div>' +
      '<h1 id="world-map-title">Global coverage map</h1>' +
      '<p class="world-sub">All topics geotagged across today’s edition. Zoom into any region or click a cluster to reveal individual tags.</p>' +
      '</div></div>' +
      '<div class="map-toolbar">' +
      '<div class="map-row">' +
      '<div class="map-pills" role="group" aria-label="Filter map by topic">' + topicPills + '</div>' +
      '<div class="map-pills" role="group" aria-label="Zoom to region">' + regionBtns + '</div>' +
      '</div></div>' +
      '<div id="world-map" class="world-map" role="region" aria-label="Interactive geotagged story map" hidden></div>' +
      '<div class="map-status-bar">' +
      '<span id="world-map-status">Showing ' + esc(plural(activeStories.length, 'geotagged story', 'geotagged stories')) + '</span>' +
      '<button type="button" class="map-region-btn" data-act="mapregion" data-id="global">Reset global view</button>' +
      '</div>' +
      '<ul id="world-map-list" class="world-locations">' + renderWorldMapListHtml(activeStories) + '</ul>' +
      '</section>';
  }

  function clusterRadiusForZoom(zoom) {
    if (zoom <= 2) return 76;
    if (zoom === 3) return 62;
    if (zoom <= 5) return 46;
    if (zoom <= 8) return 32;
    return 0;
  }

  function buildPopupNode(story) {
    var box = document.createElement('div');
    box.className = 'map-popup';
    box.innerHTML =
      '<div class="map-popup-kicker">' + esc(labelOf[story.topic]) + ' · ' + esc(story.location.label) + '</div>' +
      '<h3 class="map-popup-title">' + esc(story.headline) + '</h3>' +
      covBar(story.cov) +
      '<div class="map-popup-meta">' + esc(story.source + ' · ' + story.cov.count) + '</div>';
    var link = document.createElement('a');
    link.className = 'textlink';
    link.href = storyHref(story.id);
    link.textContent = 'Compare coverage →';
    link.addEventListener('click', function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      changeStory(story.id);
      state.settingsOpen = false;
      render({ scrollReader: true });
    });
    box.appendChild(link);
    return box;
  }

  function refreshWorldMapMarkers() {
    if (!worldMap || !worldMarkerLayer || !window.L) return;
    var L = window.L;
    worldMarkerLayer.clearLayers();
    mapPinById = Object.create(null);

    var stories = getMapStories();
    var zoom = worldMap.getZoom();
    var radius = clusterRadiusForZoom(zoom);

    var projected = stories.map(function (s) {
      var pt = worldMap.latLngToContainerPoint([s.location.lat, s.location.lng]);
      return { story: s, x: pt.x, y: pt.y };
    });

    var clusters = [];
    if (radius > 0) {
      var used = new Array(projected.length);
      for (var i = 0; i < projected.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        var members = [projected[i]];
        var sumX = projected[i].x;
        var sumY = projected[i].y;
        for (var j = i + 1; j < projected.length; j++) {
          if (used[j]) continue;
          var cx = sumX / members.length;
          var cy = sumY / members.length;
          var dx = projected[j].x - cx;
          var dy = projected[j].y - cy;
          if (Math.hypot(dx, dy) <= radius) {
            used[j] = true;
            members.push(projected[j]);
            sumX += projected[j].x;
            sumY += projected[j].y;
          }
        }
        clusters.push(members.map(function (m) { return m.story; }));
      }
    } else {
      clusters = stories.map(function (s) { return [s]; });
    }

    var placedSinglePoints = [];
    clusters.forEach(function (group) {
      if (group.length > 1) {
        var avgLat = group.reduce(function (acc, s) { return acc + s.location.lat; }, 0) / group.length;
        var avgLng = group.reduce(function (acc, s) { return acc + s.location.lng; }, 0) / group.length;
        var uniqueTopics = [];
        group.forEach(function (s) {
          if (uniqueTopics.indexOf(s.topic) === -1) uniqueTopics.push(s.topic);
        });
        var dotsHtml = uniqueTopics.slice(0, 5).map(function (tid) {
          return '<span class="tdot tdot-' + esc(tid) + '"></span>';
        }).join('');
        var html = '<div class="geo-cluster" title="Click to zoom in and view all ' + group.length + ' tags">' +
          '<span class="geo-cluster-dots">' + dotsHtml + '</span>' +
          '<span>' + group.length + ' tags</span>' +
          '<span class="geo-cluster-hint">+</span></div>';
        var marker = L.marker([avgLat, avgLng], {
          icon: L.divIcon({ className: 'geo-marker-wrap', html: html, iconSize: [0, 0], iconAnchor: [0, 0] }),
          zIndexOffset: 200
        }).addTo(worldMarkerLayer);

        marker.on('click', function () {
          var bounds = L.latLngBounds(group.map(function (s) { return [s.location.lat, s.location.lng]; }));
          var span = Math.max(
            Math.abs(bounds.getNorth() - bounds.getSouth()),
            Math.abs(bounds.getEast() - bounds.getWest())
          );
          if (span < 0.08) {
            worldMap.setView([avgLat, avgLng], Math.min(13, Math.max(zoom + 3, 11)), { animate: true });
          } else {
            worldMap.fitBounds(bounds, { padding: [70, 70], maxZoom: Math.min(11, zoom + 4), animate: true });
          }
        });
      } else {
        var s = group[0];
        var place = s.location.shortLabel || s.location.label.split(',')[0];
        var pt = worldMap.latLngToContainerPoint([s.location.lat, s.location.lng]);
        var offsetY = 0;
        for (var k = 0; k < placedSinglePoints.length; k++) {
          if (Math.abs(placedSinglePoints[k].x - pt.x) < 110 && Math.abs(placedSinglePoints[k].y - (pt.y + offsetY)) < 26) {
            offsetY += 28;
          }
        }
        placedSinglePoints.push({ x: pt.x, y: pt.y + offsetY });
        var tagHtml = '<div class="geo-tag geo-tag-' + esc(s.topic) + '" style="margin-top:' + offsetY + 'px">' +
          '<span>' + esc(labelOf[s.topic]) + '</span>' +
          '<span class="geo-tag-city">· ' + esc(place) + '</span></div>';
        var single = L.marker([s.location.lat, s.location.lng], {
          title: labelOf[s.topic] + ' — ' + s.location.label + ': ' + s.headline,
          alt: s.headline,
          icon: L.divIcon({ className: 'geo-marker-wrap', html: tagHtml, iconSize: [0, 0], iconAnchor: [0, 0] })
        }).addTo(worldMarkerLayer).bindPopup(buildPopupNode(s), { maxWidth: 300 });
        mapPinById[s.id] = single;
      }
    });

    updateVisibleMapList(stories);
  }

  function updateVisibleMapList(allActiveStories) {
    if (!worldMap) return;
    var stories = allActiveStories || getMapStories();
    var bounds = worldMap.getBounds();
    var visible = stories.filter(function (s) {
      return bounds.contains([s.location.lat, s.location.lng]);
    });
    var statusEl = document.getElementById('world-map-status');
    var listEl = document.getElementById('world-map-list');
    var zoom = worldMap.getZoom();
    if (statusEl) {
      statusEl.textContent = 'Zoom ' + zoom + ' · ' + visible.length + ' of ' + stories.length +
        ' geotagged ' + (stories.length === 1 ? 'story' : 'stories') + ' in view · Zoom in or click a cluster to expand tags';
    }
    if (listEl) {
      listEl.innerHTML = renderWorldMapListHtml(visible);
    }
  }

  function mountWorldMap() {
    if (worldMap) return;
    var canvas = document.getElementById('world-map');
    if (!canvas || !window.L) return;
    var L = window.L;
    canvas.hidden = false;
    worldMap = L.map(canvas, { scrollWheelZoom: true, minZoom: 2, maxZoom: 15, worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 17
    }).addTo(worldMap);
    worldMarkerLayer = L.layerGroup().addTo(worldMap);

    var stories = getMapStories();
    if (stories.length > 1) {
      var bounds = L.latLngBounds(stories.map(function (s) { return [s.location.lat, s.location.lng]; }));
      worldMap.fitBounds(bounds, { padding: [44, 44], maxZoom: 3 });
    } else if (stories.length === 1) {
      worldMap.setView([stories[0].location.lat, stories[0].location.lng], 5);
    } else {
      worldMap.fitBounds(MAP_REGIONS.global.bounds, { maxZoom: 3 });
    }

    refreshWorldMapMarkers();
    worldMap.on('zoomend', refreshWorldMapMarkers);
    worldMap.on('moveend', function () { updateVisibleMapList(); });
  }

  function renderHeaderMenuContent(id) {
    if (id === 'digest') return '<h2 id="menu-title-digest">60-second digest</h2><ul class="digest-list">' +
      D.META.digest.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>';
    var papers = followed().map(function (p) {
      return '<button class="paper-row" data-act="paper" data-name="' + esc(p.name) + '"><span>' + esc(p.name) + '</span>' + leanBadge(p.name) + '</button>';
    }).join('');
    var swatches = [['c-L', 'Left'], ['c-LL', 'Lean left'], ['c-C', 'Centre'], ['c-LR', 'Lean right'], ['c-R', 'Right'], ['c-S', 'Science'], ['c-O', 'Other / unrated']]
      .map(function (x) { return '<span><span class="dotlg ' + x[0] + '"></span>' + x[1] + '</span>'; }).join('');
    if (id === 'newspapers') return '<h2 id="menu-title-newspapers">Newspapers you follow</h2><div class="dropdown-paper-actions"><button class="outline-sm" data-act="view" data-view="papers">Browse newspapers</button>' +
      '<button class="outline-sm" data-act="settings">Manage newspapers</button></div><div class="papers-list">' + papers + '</div>';
    return '<h2 id="menu-title-coverage">How coverage works</h2><ol class="algo">' +
      '<li>Pheme groups reporting about the same event across outlets.</li>' +
      '<li>Links include original reporting, follow-up coverage and primary sources.</li>' +
      '<li>Media Bias/Fact Check ratings describe each publisher’s leaning.</li>' +
      '<li>The coverage bar shows the spread in each sample.</li></ol>' +
      '<div class="legend">' + swatches + '</div>' +
      '<p class="small">Edition: ' + esc(D.META.rangeLong) + ' · Updated ' + esc(D.META.lastRun) + '.</p>';
  }

  function renderBriefing() {
    var isSaved = state.view === 'saved';
    var list = (isSaved ? STORIES : CURRENT).filter(function (s) {
      if (isSaved) return state.saved[s.id];
      return state.topic === 'all' || s.topic === state.topic;
    }).filter(matchesQuery);

    var headerHtml = '';
    if (isSaved) {
      headerHtml = '<div class="page-head"><h1>Saved stories</h1><p>' + esc(plural(list.length, 'saved story', 'saved stories')) + '</p></div>';
    } else if (state.query.trim()) {
      headerHtml = '<div class="page-head"><h1>Search results</h1><p>' + esc(plural(list.length, 'story', 'stories')) + ' matching “' + esc(state.query.trim()) + '”</p></div>';
    }

    if (!list.length) {
      return headerHtml + '<p class="notice">' +
        (isSaved ? 'Nothing saved yet. Click Save on any story to keep it in your reading list.' : 'No stories match that search.') +
        '</p>';
    }

    var lead = list[0];
    var side = list.slice(1, 3);
    var rest = list.slice(3);

    var heroHtml = side.length
      ? '<section class="hero-grid" aria-label="Featured stories">' + renderLead(lead) +
        '<div class="hero-side">' + side.map(renderSideItem).join('') + '</div></section>'
      : '<section aria-label="Featured story">' + renderLead(lead) + '</section>';

    var mapHtml = !isSaved && state.topic === 'world' ? renderWorldMap() : '';

    var restHtml = rest.length
      ? '<div class="section-rule"><h2>More in ' + esc(isSaved ? 'saved' : (state.topic === 'all' ? 'today’s briefing' : labelOf[state.topic])) + '</h2>' +
        '<span>Headlines from ' + esc(D.META.range) + '</span></div>' +
        '<section class="edition-grid" aria-label="More stories">' + rest.map(renderGridItem).join('') + '</section>'
      : '';

    return headerHtml + mapHtml + heroHtml + restHtml;
  }

  /* ---------- Newspapers View ---------- */
  function storiesForPaper(name) {
    return CURRENT.filter(function (s) {
      return s.source === name || s.cov.rows.some(function (r) { return r.name === name; });
    }).map(function (s) {
      var match = s.cov.rows.find(function (r) { return r.name === name; });
      return match && match.title && match.title !== s.headline
        ? Object.assign({}, s, { headline: match.title, source: name, time: match.date || s.time })
        : Object.assign({}, s, { source: name });
    });
  }

  function renderPapers() {
    var papers = followed();
    var name = state.paper && papers.some(function (p) { return p.name === state.paper; }) ? state.paper : papers[0].name;
    var meta = papers.filter(function (p) { return p.name === name; })[0] || {};
    var stories = storiesForPaper(name);
    var tabs = papers.map(function (p) {
      var on = p.name === name;
      var count = storiesForPaper(p.name).length;
      return '<button class="chip' + (on ? ' on' : '') + '" data-act="paper" data-name="' + esc(p.name) + '" aria-pressed="' + on + '">' +
        esc(p.name) + (count ? ' (' + count + ')' : '') + '</button>';
    }).join('') + '<button class="chip" data-act="settings">+ Add newspaper</button>';

    var body;
    if (stories.length) {
      var lead = stories[0];
      var rest = stories.slice(1);
      body = renderLead(lead) + (rest.length
        ? '<div class="section-rule"><h2>Also covered by ' + esc(name) + '</h2><span>' + esc(plural(stories.length, 'story', 'stories')) + ' in today’s edition</span></div>' +
          '<div class="edition-grid">' + rest.map(renderGridItem).join('') + '</div>'
        : '');
    } else {
      body = '<div class="notice"><strong>No featured stories from ' + esc(name) + ' today.</strong> ' +
        'When Pheme features a story from this outlet, it will appear here.' +
        (meta.paywall ? ' Full articles require a subscription to this paper.' : '') + '</div>';
    }

    return '<div class="page-head"><h1>Newspapers</h1><p>' + esc(plural(papers.length, 'newspaper', 'newspapers')) + ' followed · select one to view all stories it covered in today’s edition</p></div>' +
      '<div class="chips" role="group" aria-label="Choose a newspaper">' + tabs + '</div>' +
      '<section class="paper-sheet" aria-labelledby="paper-name">' +
      '<header class="paper-masthead"><h2 id="paper-name">' + esc(name) + '</h2>' +
      '<span class="paper-dateline">Edition coverage · ' + esc(D.META.rangeLong) + '</span></header>' + body + '</section>';
  }

  /* ---------- Native Story Reader & Coverage Comparison ---------- */
  function readerCopy(text) {
    return text.replace('or click any outlet link to open the full original report.', 'or select an outlet to read Pheme’s native briefing.')
      .replace('or open any original article directly.', 'or select an outlet to read in Pheme.')
      .replace('Open each outlet’s report below to compare their headlines and framing.', 'Select an outlet below to compare headlines and read in Pheme.');
  }

  function getArticleParagraphs(s) {
    if (s.article && s.article.length) return s.article.map(readerCopy);
    var cov = s.cov;
    var out = [];
    if (s.summary) out.push(s.summary);
    if (s.points && s.points.length) {
      out.push(s.points.join(' '));
    }
    if (cov && cov.rows.length > 1) {
      var names = cov.rows.slice(0, 6).map(function (r) { return r.name; }).join(', ');
      out.push('Pheme is tracking ' + cov.count + ' on this story (' + names + (cov.rows.length > 6 ? ', and more' : '') + '). ' + cov.note);
    }
    return out.filter(Boolean);
  }

  function estimateReadTime(s) {
    var parts = [s.headline, s.summary].concat(getArticleParagraphs(s)).concat(s.points || []);
    var words = parts.join(' ').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 210)) + ' min read';
  }

  function startSpeech(s) {
    if (!window.speechSynthesis) return;
    stopSpeech();
    var paras = getArticleParagraphs(s);
    var queue = [s.headline].concat(paras);
    state.speaking = true;
    var speakNext = function (idx) {
      if (!state.speaking || idx >= queue.length) {
        state.speaking = false;
        state.speakingIndex = -1;
        syncSpeakingDom();
        return;
      }
      state.speakingIndex = idx - 1;
      syncSpeakingDom();
      var utter = new SpeechSynthesisUtterance(queue[idx]);
      utter.lang = 'en-GB';
      utter.rate = state.speechRate;
      utter.onend = function () { if (state.speaking) speakNext(idx + 1); };
      utter.onerror = function () { state.speaking = false; state.speakingIndex = -1; syncSpeakingDom(); };
      window.speechSynthesis.speak(utter);
    };
    speakNext(0);
  }

  function syncSpeakingDom() {
    var btn = app.querySelector('[data-act="togglelisten"]');
    if (btn) {
      btn.classList.toggle('on', state.speaking);
      btn.innerHTML = (state.speaking ? ICON.stop + 'Stop' : ICON.listen + 'Listen');
    }
    var rateBtn = app.querySelector('[data-act="speechrate"]');
    if (rateBtn) {
      rateBtn.hidden = !state.speaking;
      rateBtn.textContent = state.speechRate + '×';
    }
    app.querySelectorAll('.reader-para').forEach(function (el) {
      var idx = Number(el.getAttribute('data-pidx'));
      el.classList.toggle('speaking', state.speaking && idx === state.speakingIndex);
    });
  }

  function updateReadProgress() {
    var fill = document.getElementById('read-progress-fill');
    if (!fill) return;
    if (!state.reading) { fill.style.width = '0%'; return; }
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    var pct = scrollable > 0 ? Math.min(100, Math.max(0, (window.scrollY / scrollable) * 100)) : 100;
    fill.style.width = pct.toFixed(1) + '%';
  }
  window.addEventListener('scroll', updateReadProgress, { passive: true });

  function syncBodyReaderClasses() {
    var b = document.body;
    b.classList.remove('reader-theme-white', 'reader-theme-sepia', 'reader-theme-night', 'reader-focus');
    if (state.reading) {
      if (state.readerPrefs.theme && state.readerPrefs.theme !== 'newsprint') {
        b.classList.add('reader-theme-' + state.readerPrefs.theme);
      }
      if (state.readerFocus) b.classList.add('reader-focus');
    }
  }

  function renderComparison(s) {
    return (s.comparison || []).map(function (group) {
      return '<section class="rsection"><h2>' + esc(group.label) + '</h2><ul class="points">' +
        group.points.map(function (point) {
          return '<li>' + esc(point.text) + ' ' + point.sources.map(function (name) {
            var row = s.cov.rows.find(function (item) { return item.name === name; });
            return row ? nativeSourceLink(s, name) : '';
          }).join(' · ') + '</li>';
        }).join('') + '</ul></section>';
    }).join('');
  }

  function covGroupMatches(code, filter) {
    if (filter === 'all') return true;
    if (filter === 'left') return code === 'L' || code === 'LL';
    if (filter === 'centre') return code === 'C';
    if (filter === 'right') return code === 'LR' || code === 'R';
    if (filter === 'other') return code === 'S' || code === 'P' || code === 'NR' || code === 'NC';
    return true;
  }

  function renderAaPopover() {
    if (!state.aaOpen) return '';
    var p = state.readerPrefs;
    var themes = [
      ['newsprint', 'Paper'],
      ['white', 'White'],
      ['sepia', 'Sepia'],
      ['night', 'Night']
    ];
    var sizes = [['sm', 'S'], ['md', 'M'], ['lg', 'L'], ['xl', 'XL']];
    return '<div class="aa-popover" role="dialog" aria-label="Reader appearance">' +
      '<div class="aa-group"><span class="aa-label">Paper theme</span><div class="aa-row">' +
      themes.map(function (t) {
        return '<button type="button" class="aa-opt swatch-' + t[0] + (p.theme === t[0] ? ' on' : '') + '" data-act="rpref" data-key="theme" data-val="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="aa-group"><span class="aa-label">Text size</span><div class="aa-row">' +
      sizes.map(function (sz) {
        return '<button type="button" class="aa-opt' + (p.size === sz[0] ? ' on' : '') + '" data-act="rpref" data-key="size" data-val="' + sz[0] + '">' + sz[1] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="aa-group"><span class="aa-label">Typeface</span><div class="aa-row two">' +
      '<button type="button" class="aa-opt' + (p.font === 'serif' ? ' on' : '') + '" data-act="rpref" data-key="font" data-val="serif" style="font-family:var(--serif)">Editorial Serif</button>' +
      '<button type="button" class="aa-opt' + (p.font === 'sans' ? ' on' : '') + '" data-act="rpref" data-key="font" data-val="sans" style="font-family:var(--sans)">Clean Sans</button>' +
      '</div></div>' +
      '<div class="aa-group"><span class="aa-label">Column width</span><div class="aa-row two">' +
      '<button type="button" class="aa-opt' + (p.measure === 'focused' ? ' on' : '') + '" data-act="rpref" data-key="measure" data-val="focused">Focused</button>' +
      '<button type="button" class="aa-opt' + (p.measure === 'wide' ? ' on' : '') + '" data-act="rpref" data-key="measure" data-val="wide">Wide</button>' +
      '</div></div></div>';
  }

  function renderReader(s) {
    var back = state.readingSource ? 'Back to story' : (state.view === 'papers' ? 'Back to ' + (state.paper || followed()[0].name) : (state.view === 'saved' ? 'Back to saved' : 'Back to Pheme'));
    var more = STORIES.filter(function (o) { return o.source === s.source && o.id !== s.id; }).slice(0, 3);
    var cov = s.cov;
    var selectedSource = cov.rows.find(function (r) { return r.name === state.readingSource; });
    var sourceContext = selectedSource ? '<aside class="source-context" aria-label="Selected publisher coverage"><p class="kicker">' + esc(selectedSource.name) + ' · ' + esc(selectedSource.date) + '</p>' +
      (selectedSource.title ? '<h2>' + esc(selectedSource.title) + '</h2>' : '') +
      '<p class="small">Read Pheme’s native briefing of this story below.' + (selectedSource.title ? ' The publisher’s headline is shown for reference.' : '') + '</p></aside>' : '';
    var img = safeAsset(s.image);
    var paras = getArticleParagraphs(s);
    var storyHighlights = state.highlights[s.id] || {};
    var hlCount = Object.keys(storyHighlights).filter(function (k) { return storyHighlights[k]; }).length;
    var p = state.readerPrefs;
    var canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

    var curIdx = CURRENT.findIndex(function (item) { return item.id === s.id; });
    var prevStory = curIdx > 0 ? CURRENT[curIdx - 1] : null;
    var nextStory = curIdx !== -1 && curIdx < CURRENT.length - 1 ? CURRENT[curIdx + 1] : null;

    var covFilterDefs = [
      ['all', 'All (' + cov.rows.length + ')'],
      ['left', 'Left / Lean left'],
      ['centre', 'Centre'],
      ['right', 'Lean right / Right'],
      ['other', 'Science / Other']
    ];
    var visibleCovRows = cov.rows.filter(function (r) { return covGroupMatches(r.code, state.covFilter); });
    var covTabsHtml = covFilterDefs.map(function (def) {
      var n = cov.rows.filter(function (r) { return covGroupMatches(r.code, def[0]); }).length;
      if (def[0] !== 'all' && n === 0) return '';
      var label = def[0] === 'all' ? def[1] : def[1] + ' (' + n + ')';
      return '<button type="button" class="cov-tab' + (state.covFilter === def[0] ? ' on' : '') + '" data-act="covfilter" data-id="' + def[0] + '">' + esc(label) + '</button>';
    }).join('');

    var readerClasses = 'reader font-' + p.font + ' size-' + p.size + (p.measure === 'wide' ? ' measure-wide' : '');

    return '<div class="read-progress" aria-hidden="true"><div class="read-progress-fill" id="read-progress-fill"></div></div>' +
      '<article class="' + readerClasses + '" id="reader" aria-labelledby="reader-title">' +
      '<div class="reader-bar">' +
      '<button class="backbtn" data-act="back">← ' + esc(back) + '</button>' +
      '<div class="reader-tools">' +
      '<span class="read-time">' + esc(estimateReadTime(s)) + '</span>' +
      (canSpeak
        ? '<button type="button" class="rtool' + (state.speaking ? ' on' : '') + '" data-act="togglelisten">' +
          (state.speaking ? ICON.stop + 'Stop' : ICON.listen + 'Listen') + '</button>' +
          '<button type="button" class="rtool" data-act="speechrate"' + (state.speaking ? '' : ' hidden') + '>' + state.speechRate + '×</button>'
        : '') +
      '<button type="button" class="rtool' + (state.aaOpen ? ' on' : '') + '" data-act="toggleaa" aria-expanded="' + state.aaOpen + '">Aa</button>' +
      '<button type="button" class="rtool' + (state.readerFocus ? ' on' : '') + '" data-act="togglefocus" title="Distraction-free Focus mode (F)">' + ICON.focus + (state.readerFocus ? 'Exit focus' : 'Focus') + '</button>' +
      '<button type="button" class="rtool" data-act="copylink" data-id="' + esc(s.id) + '">' + ICON.link + (state.copiedId === s.id ? 'Copied' : 'Share') + '</button>' +
      saveBtn(s) +
      renderAaPopover() +
      '</div></div>' +
      '<p class="kicker">' + esc(labelOf[s.topic]) +
      '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.publishedLabel || s.time) +
      (s.location ? ' · <button type="button" class="loc-chip" data-act="openonmap" data-id="' + esc(s.id) + '">' + esc(s.location.label) + '</button>' : '') +
      '</span></p>' +
      '<h1 id="reader-title">' + esc(s.headline) + '</h1>' +
      '<p class="standfirst">' + esc(s.summary) + '</p>' +
      sourceContext +
      (img ? '<figure class="reader-photo"><img src="' + esc(img) + '" alt="' + esc(s.imageAlt || s.headline) + '"><figcaption class="reader-caption">' + esc(s.imageAlt || '') + '</figcaption></figure>' : '') +
      '<div class="reader-body">' +
      paras.map(function (para, idx) {
        var hl = !!storyHighlights[idx];
        var sp = state.speaking && state.speakingIndex === idx;
        return '<p class="reader-para' + (hl ? ' hl-on' : '') + (sp ? ' speaking' : '') + '" data-act="highlight" data-id="' + esc(s.id) + '" data-pidx="' + idx + '" title="Click to highlight passage">' + esc(para) + '</p>';
      }).join('') +
      '</div>' +
      '<p class="reader-hint">Tip: click any paragraph to highlight' + (hlCount ? ' · ' + plural(hlCount, 'highlight', 'highlights') + ' saved' : '') + ' · press F for Focus mode · ← / → for previous &amp; next story.</p>' +
      (s.points && s.points.length
        ? '<section class="takeaways-box"><h2>Key takeaways</h2><ul class="points">' +
          s.points.map(function (pt) { return '<li>' + esc(readerCopy(pt)) + '</li>'; }).join('') +
          '</ul></section>'
        : '') +
      renderComparison(s) +
      '<section class="rsection" aria-labelledby="cov-title">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
      '<h2 id="cov-title">Full coverage · ' + esc(cov.count) + '</h2>' +
      '<span class="small">Leaning ratings: Media Bias/Fact Check</span></div>' +
      covBar(cov, true) +
      '<div class="legend">' + cov.legend.map(function (l) { return '<span><span class="dotlg ' + l.cls + '"></span>' + esc(l.label) + ' · ' + l.n + '</span>'; }).join('') + '</div>' +
      '<p style="margin:0;font-family:var(--sans);font-size:13.5px;font-weight:600;color:var(--ink)">' + esc(cov.note) + '</p>' +
      '<div class="cov-tabs" role="group" aria-label="Filter outlets by leaning">' + covTabsHtml + '</div>' +
      '<ul class="covlist">' + visibleCovRows.map(function (r) {
        return '<li>' + leanBadge(r.name) +
          '<div class="cov-outlet-col"><span class="name">' + esc(r.name) + '</span>' +
          (r.title ? '<span class="cov-outlet-hl">' + esc(r.title) + '</span>' : '') +
          '</div>' +
          '<span class="small">' + esc(r.date) + '</span>' +
          nativeSourceLink(s, r.name, 'Read in Pheme') + '</li>';
      }).join('') + '</ul></section>' +
      '<div class="rfoot"><p class="small" style="max-width:46ch">Native briefing written for Pheme from ' + esc(cov.count) + ' led by ' + esc(s.source) + '.</p>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' + saveBtn(s) +
      nativeSourceLink(s, s.source, 'Read ' + s.source + ' coverage', 'darkbtn') + '</div></div>' +
      ((prevStory || nextStory)
        ? '<nav class="story-pager" aria-label="Adjacent stories">' +
          (prevStory
            ? '<button type="button" class="pager-btn" data-act="open" data-id="' + esc(prevStory.id) + '"><span class="pager-dir">← Previous story</span><span class="pager-title">' + esc(prevStory.headline) + '</span></button>'
            : '<div></div>') +
          (nextStory
            ? '<button type="button" class="pager-btn next" data-act="open" data-id="' + esc(nextStory.id) + '"><span class="pager-dir">Next story →</span><span class="pager-title">' + esc(nextStory.headline) + '</span></button>'
            : '<div></div>') +
          '</nav>'
        : '') +
      (more.length ? '<section class="rsection"><h2>More from ' + esc(s.source) + '</h2><div class="papers-list">' +
        more.map(function (m) { return '<button class="more-link" data-act="open" data-id="' + esc(m.id) + '">' + esc(m.headline) + '</button>'; }).join('') +
        '</div></section>' : '') +
      '</article>';
  }

  /* ---------- Sources / Settings Drawer ---------- */
  function sourceListHtml() {
    var q = state.srcQuery.trim().toLowerCase();
    var list = CATALOGUE.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) !== -1 || c.catLabel.toLowerCase().indexOf(q) !== -1; });
    var addedN = CATALOGUE.filter(function (c) { return state.added[c.id]; }).length;
    var text = (q ? list.length + ' of ' + CATALOGUE.length + ' newspapers match' : CATALOGUE.length + ' newspapers available') + (addedN ? ' · ' + addedN + ' added' : '');
    var items = list.map(function (c) {
      var on = !!state.added[c.id];
      var words = c.name.replace(/^The /, '').split(' ');
      var initials = (words[0].charAt(0) + (words[1] ? words[1].charAt(0) : '')).toUpperCase();
      return '<li><span class="mono" aria-hidden="true">' + esc(initials) + '</span>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span style="font-family:var(--serif);font-size:15px;font-weight:600">' + esc(c.name) + '</span>' +
        '<span class="small">' + esc(c.catLabel + (c.paywall ? ' · Subscription' : '')) + '</span></div>' +
        '<button class="addbtn' + (on ? ' on' : '') + '" data-act="addsrc" data-id="' + esc(c.id) + '" aria-pressed="' + on + '">' + (on ? 'Added' : 'Add') + '</button></li>';
    }).join('');
    return '<p aria-live="polite" class="small">' + esc(text) + '</p><ul class="srclist">' + items + '</ul>' +
      (list.length ? '' : '<p class="notice">No newspapers match that search.</p>');
  }

  function renderSettings() {
    if (!state.settingsOpen) return '';
    var marketChoices = MARKETS.map(function (m) {
      return '<label class="widget-choice"><input id="market-' + m.id + '" type="checkbox" data-market="' + m.id + '"' + (state.headerPrefs.markets.indexOf(m.id) !== -1 ? ' checked' : '') + '><span>' + m.city + '<small>' + esc(m.index) + '</small></span></label>';
    }).join('');
    return '<div class="settings-backdrop" data-act="close"></div>' +
      '<div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">' +
      '<div class="settings-head"><h2 id="settings-title">Settings</h2>' +
      '<button class="search-toggle" data-act="close" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="settings-body">' +
      '<fieldset class="widget-settings"><legend>Header widgets</legend><label class="widget-choice"><input id="show-clock" type="checkbox"' + (state.headerPrefs.showClock ? ' checked' : '') + '><span>Show clocks<small>London time and each market’s local time</small></span></label></fieldset>' +
      '<fieldset class="widget-settings"><legend>Stock exchanges</legend><p class="small">Choose the markets shown in your toolbar. Your choices are saved in this browser.</p>' + marketChoices + '</fieldset>' +
      '<h3 class="settings-section-title">Newspapers</h3>' +
      '<p class="small">Pin newspapers for quick access to any stories featured in Pheme.</p>' +
      '<div class="settings-search">' + ICON.search + '<label for="src-q" class="sr-only">Search newspapers</label>' +
      '<input id="src-q" type="search" placeholder="Search newspapers, e.g. Telegraph" value="' + esc(state.srcQuery) + '" autocomplete="off"></div>' +
      '<div id="src-list">' + sourceListHtml() + '</div>' +
      '</div><div class="settings-foot"><button class="darkbtn" data-act="close">Done</button></div></div>';
  }

  function render(opts) {
    var previousMarkets = document.getElementById('market-widgets');
    var settingsScroll = app.querySelector('.settings-body');
    var previousSettingsScroll = settingsScroll ? settingsScroll.scrollTop : 0;
    if (worldMap) { worldMap.remove(); worldMap = null; worldMarkerLayer = null; mapPinById = Object.create(null); }
    var reading = state.reading ? byId[state.reading] : null;
    syncBodyReaderClasses();
    var main;
    if (reading) main = renderReader(reading);
    else if (state.view === 'papers') main = renderPapers();
    else main = renderBriefing();

    app.innerHTML = renderHeader() +
      '<main class="wrap page-main" id="main">' + main + '</main>' +
      renderSettings();

    var nextMarkets = document.getElementById('market-widgets');
    if (previousMarkets && nextMarkets && previousMarkets.getAttribute('data-markets') === nextMarkets.getAttribute('data-markets')) {
      nextMarkets.replaceWith(previousMarkets);
    }
    settingsScroll = app.querySelector('.settings-body');
    if (settingsScroll) settingsScroll.scrollTop = previousSettingsScroll;
    updateClocks();

    mountWorldMap();
    updateReadProgress();
    if (opts && opts.focus) {
      var el = document.getElementById(opts.focus);
      if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
    }
    if (opts && opts.scrollReader) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /* ---------- events ---------- */
  app.addEventListener('click', function (e) {
    if (state.aaOpen && !e.target.closest('.aa-popover') && !e.target.closest('[data-act="toggleaa"]')) {
      state.aaOpen = false;
      render();
      return;
    }
    var t = e.target.closest('[data-act]');
    if (state.utilityOpen && !e.target.closest('.header-menu')) {
      state.utilityOpen = null;
      if (!t) { render(); return; }
    }
    if (!t) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (act !== 'headermenu') state.utilityOpen = null;
    switch (act) {
      case 'headermenu':
        state.utilityOpen = state.utilityOpen === id ? null : id;
        render({ focus: state.utilityOpen ? 'menu-' + id : 'menu-toggle-' + id }); break;
      case 'home':
        state.view = 'briefing'; state.topic = 'all'; state.query = ''; state.searchOpen = false;
        if (state.reading) changeStory(null);
        render(); break;
      case 'topic':
        state.view = 'briefing'; state.topic = id;
        if (state.reading) changeStory(null);
        render(); break;
      case 'maptopic':
        state.mapTopic = id;
        if (worldMap) {
          var pills = app.querySelectorAll('[data-act="maptopic"]');
          pills.forEach(function (el) {
            var active = el.getAttribute('data-id') === id;
            el.classList.toggle('on', active);
            el.setAttribute('aria-pressed', String(active));
          });
          var filtered = getMapStories();
          if (filtered.length > 1) {
            worldMap.fitBounds(window.L.latLngBounds(filtered.map(function (s) { return [s.location.lat, s.location.lng]; })), { padding: [50, 50], maxZoom: 6, animate: true });
          } else if (filtered.length === 1) {
            worldMap.setView([filtered[0].location.lat, filtered[0].location.lng], 6, { animate: true });
          }
          refreshWorldMapMarkers();
        } else {
          render();
        }
        break;
      case 'mapregion':
        if (worldMap && MAP_REGIONS[id]) {
          var reg = MAP_REGIONS[id];
          worldMap.fitBounds(reg.bounds, { padding: [36, 36], maxZoom: reg.maxZoom, animate: true });
        }
        break;
      case 'focuspin':
        if (worldMap && byId[id] && byId[id].location) {
          var loc = byId[id].location;
          worldMap.once('moveend', function () {
            refreshWorldMapMarkers();
            if (mapPinById[id]) mapPinById[id].openPopup();
          });
          worldMap.setView([loc.lat, loc.lng], 11, { animate: true });
          var mapEl = document.getElementById('world-map');
          if (mapEl && mapEl.scrollIntoView) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        break;
      case 'openonmap':
        if (byId[id] && byId[id].location) {
          state.view = 'briefing';
          state.topic = 'world';
          state.mapTopic = 'all';
          changeStory(null);
          render();
          if (worldMap) {
            var targetLoc = byId[id].location;
            worldMap.once('moveend', function () {
              refreshWorldMapMarkers();
              if (mapPinById[id]) mapPinById[id].openPopup();
            });
            worldMap.setView([targetLoc.lat, targetLoc.lng], 11, { animate: true });
          }
        }
        break;
      case 'view':
        state.view = t.getAttribute('data-view');
        if (state.reading) changeStory(null);
        if (state.view === 'briefing') state.topic = state.topic || 'all';
        render(); break;
      case 'paper':
        state.view = 'papers'; state.paper = t.getAttribute('data-name');
        if (state.reading) changeStory(null);
        state.settingsOpen = false; render(); break;
      case 'open':
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); changeStory(id); state.settingsOpen = false;
        render({ scrollReader: true }); break;
      case 'opensource':
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); changeStory(id, t.getAttribute('data-source')); state.settingsOpen = false;
        render({ scrollReader: true }); break;
      case 'back':
        changeStory(state.readingSource ? state.reading : null); render({ scrollReader: true }); break;
      case 'save':
        state.saved[id] = !state.saved[id]; persist(); render(); break;
      case 'toggleaa':
        state.aaOpen = !state.aaOpen; render(); break;
      case 'rpref':
        var key = t.getAttribute('data-key');
        var val = t.getAttribute('data-val');
        if (key && val) {
          state.readerPrefs[key] = val;
          persist();
          render();
        }
        break;
      case 'togglefocus':
        state.readerFocus = !state.readerFocus;
        state.aaOpen = false;
        render(); break;
      case 'togglelisten':
        if (state.speaking) {
          stopSpeech();
          syncSpeakingDom();
        } else if (state.reading && byId[state.reading]) {
          startSpeech(byId[state.reading]);
        }
        break;
      case 'speechrate':
        var rates = [1, 1.25, 1.5];
        state.speechRate = rates[(rates.indexOf(state.speechRate) + 1) % rates.length];
        if (state.speaking && state.reading && byId[state.reading]) {
          startSpeech(byId[state.reading]);
        }
        break;
      case 'highlight':
        var pidx = t.getAttribute('data-pidx');
        if (id && pidx !== null) {
          if (!state.highlights[id]) state.highlights[id] = {};
          state.highlights[id][pidx] = !state.highlights[id][pidx];
          persist();
          t.classList.toggle('hl-on', !!state.highlights[id][pidx]);
        }
        break;
      case 'covfilter':
        state.covFilter = id || 'all';
        render(); break;
      case 'copylink':
        var fullUrl = location.origin + location.pathname + (state.readingSource ? sourceHref(id, state.readingSource) : storyHref(id));
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(fullUrl).catch(function () {});
        }
        state.copiedId = id;
        render();
        setTimeout(function () {
          if (state.copiedId === id) { state.copiedId = null; render(); }
        }, 1800);
        break;
      case 'togglesearch':
        state.searchOpen = !state.searchOpen;
        if (!state.searchOpen) state.query = '';
        render({ focus: state.searchOpen ? 'q' : null }); break;
      case 'clearsearch':
        state.query = ''; render({ focus: 'q' }); break;
      case 'settings':
        state.settingsOpen = true; render({ focus: 'show-clock' }); break;
      case 'close':
        state.settingsOpen = false; render({ focus: 'settings-toggle' }); break;
      case 'addsrc':
        state.added[id] = !state.added[id]; persist();
        render({ focus: null });
        var b = app.querySelector('[data-act="addsrc"][data-id="' + id + '"]');
        if (b) b.focus();
        break;
    }
  });

  app.addEventListener('change', function (e) {
    var marketId = e.target.getAttribute('data-market');
    if (marketId && MARKETS.some(function (m) { return m.id === marketId; })) {
      state.headerPrefs.markets = MARKETS.filter(function (m) {
        return m.id === marketId ? e.target.checked : state.headerPrefs.markets.indexOf(m.id) !== -1;
      }).map(function (m) { return m.id; });
      persist(); render({ focus: e.target.id });
    } else if (e.target.id === 'show-clock') {
      state.headerPrefs.showClock = e.target.checked;
      persist(); render({ focus: 'show-clock' });
    }
  });

  app.addEventListener('input', function (e) {
    if (e.target.id === 'src-q') {
      state.srcQuery = e.target.value;
      var box = document.getElementById('src-list');
      if (box) box.innerHTML = sourceListHtml();
    } else if (e.target.id === 'q') {
      state.query = e.target.value;
      if (state.reading) changeStory(null);
      if (state.view === 'papers') state.view = 'briefing';
      render({ focus: 'q' });
    }
  });

  app.addEventListener('submit', function (e) { e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Tab' && state.settingsOpen) {
      var controls = app.querySelectorAll('.settings button, .settings input');
      var first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && e.target === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
    }
    if (e.key === 'Escape') {
      if (state.settingsOpen) { state.settingsOpen = false; render({ focus: 'settings-toggle' }); }
      else if (state.utilityOpen) { var menuId = state.utilityOpen; state.utilityOpen = null; render({ focus: 'menu-toggle-' + menuId }); }
      else if (state.aaOpen) { state.aaOpen = false; render(); }
      else if (state.readerFocus) { state.readerFocus = false; render(); }
      else if (state.searchOpen) { state.searchOpen = false; state.query = ''; render(); }
      else if (state.reading) { changeStory(null); render(); }
    } else if (!typing && state.reading && !state.settingsOpen) {
      if (e.key === 'f' || e.key === 'F') {
        state.readerFocus = !state.readerFocus;
        state.aaOpen = false;
        render();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        var idx = CURRENT.findIndex(function (item) { return item.id === state.reading; });
        if (idx !== -1) {
          var nextIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
          if (CURRENT[nextIdx]) {
            changeStory(CURRENT[nextIdx].id);
            render({ scrollReader: true });
          }
        }
      }
    }
  });

  document.getElementById('world-map-library')?.addEventListener('load', mountWorldMap);
  render();
  setInterval(updateClocks, 1000);
})();
