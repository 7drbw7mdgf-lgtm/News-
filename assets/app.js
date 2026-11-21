/* Pheme — standalone broadsheet news dashboard. No build step, no dependencies. */
(function () {
  'use strict';

  var D = window.DAYBREAK;
  var app = document.getElementById('app');
  if (!D || !app) return;

  var STORE_KEY = 'daybreak:v2';
  var worldMap;
  var route = new URLSearchParams(location.search);
  var SEG_ORDER = ['L', 'LL', 'C', 'LR', 'R', 'S'];
  var labelOf = {};
  D.TOPICS.forEach(function (t) { labelOf[t.id] = t.label; });

  /* ---------- state (saved choices persist in this browser) ---------- */
  var state = {
    view: 'briefing', topic: 'all', reading: null, paper: null,
    settingsOpen: false, searchOpen: false, srcQuery: '', query: '',
    saved: {}, added: {}
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
    }
  } catch (e) { /* storage unavailable: keep defaults */ }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ saved: state.saved, added: state.added }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }
  function safeAsset(u) { return /^assets\/images\/[a-z0-9._-]+$/i.test(u || '') ? u : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  var ICON = {
    bookmark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    bookmarkFilled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    search: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>'
  };

  /* ---------- coverage ---------- */
  function buildCoverage(id, archived) {
    var rows = (archived || D.COVERAGE[id] || []).map(function (r) {
      var code = D.OUTLETS[r[0]] || 'NC';
      return { name: r[0], date: r[1], url: r[2], code: code };
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
  if (route.has('q')) {
    state.query = route.get('q');
    if (state.query.trim()) state.searchOpen = true;
  }

  function storyHref(id) { return '?story=' + encodeURIComponent(id); }
  function compareLink(s, cls, label) {
    return '<a class="' + cls + '" href="' + storyHref(s.id) +
      '" data-act="open" data-id="' + esc(s.id) + '">' + esc(label) + '</a>';
  }
  function changeStory(id) {
    state.reading = id;
    history.pushState(null, '', id ? storyHref(id) : location.pathname);
  }
  window.addEventListener('popstate', function () {
    var id = new URLSearchParams(location.search).get('story');
    state.reading = byId[id] ? id : null;
    render();
  });

  function covBar(cov, full) {
    return '<div class="covbar' + (full ? ' full' : '') + '" role="img" aria-label="' + esc(cov.aria) + '">' +
      cov.legend.map(function (l) { return '<span class="seg ' + l.cls + '" style="flex-grow:' + l.n + '"></span>'; }).join('') +
      '</div>';
  }
  function leanBadge(name) {
    var code = D.OUTLETS[name] || 'NC';
    return '<span class="lean lb-' + code + '" title="Media Bias/Fact Check: ' + esc(D.LEAN[code][1]) + '">' + esc(D.LEAN[code][0]) + '</span>';
  }
  function saveBtn(s) {
    var on = !!state.saved[s.id];
    return '<button class="save-link' + (on ? ' on' : '') + '" data-act="save" data-id="' + esc(s.id) + '" aria-pressed="' + on + '">' +
      (on ? ICON.bookmarkFilled : ICON.bookmark) + (on ? 'Saved' : 'Save') + '</button>';
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

  /* ---------- Masthead & Topic Nav ---------- */
  function renderHeader() {
    var savedCount = STORIES.filter(function (s) { return state.saved[s.id]; }).length;
    var isBriefing = !state.reading && state.view === 'briefing';
    var isPapers = !state.reading && state.view === 'papers';
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
      '<button class="brand" data-act="home" aria-label="Pheme home">Pheme</button>' +
      '<div class="topbar-date">' + esc(displayDate()) + '</div>' +
      '<div class="topbar-actions">' +
      '<button class="search-toggle' + (state.searchOpen ? ' on' : '') + '" data-act="togglesearch" aria-label="Search stories" aria-expanded="' + state.searchOpen + '">' + ICON.search + '</button>' +
      '<span class="vsep" aria-hidden="true"></span>' +
      '<button class="nav-link' + (isSaved ? ' on' : '') + '" data-act="view" data-view="saved" aria-pressed="' + isSaved + '">Saved' +
      (savedCount ? '<span class="badge-count">' + savedCount + '</span>' : '') + '</button>' +
      '</div></header></div>' +
      '<nav class="topicbar" aria-label="Topics"><div class="wrap topicbar-inner">' +
      '<div class="topic-tabs">' + topicTabs + '</div>' +
      '<div class="topic-utility">' +
      '<button class="tab tab-subtle' + (isPapers ? ' on' : '') + '" data-act="view" data-view="papers" aria-pressed="' + isPapers + '">Newspapers</button>' +
      '<button class="tab tab-subtle" data-act="settings" aria-expanded="' + state.settingsOpen + '">Sources</button>' +
      '</div></div></nav>' + searchDrawer + '</div>';
  }

  /* ---------- Broadsheet Front Page / Topic / Saved ---------- */
  function renderLead(s) {
    var img = safeAsset(s.image);
    var figure = img
      ? '<figure class="hero-figure"><button class="hero-figure-btn" data-act="open" data-id="' + esc(s.id) + '" aria-label="Open ' + esc(s.headline) + '">' +
        '<img src="' + esc(img) + '" alt="' + esc(s.imageAlt || s.headline) + '" loading="eager" decoding="async"></button></figure>'
      : '';
    return '<article class="hero-lead">' + figure +
      '<p class="kicker">' + esc(labelOf[s.topic]) +
      '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.time) + '</span></p>' +
      '<h1 class="lead-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h1>' +
      '<p class="lead-summary">' + esc(s.summary) + '</p>' +
      '<div class="lead-cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      '<div class="hero-actions">' + compareLink(s, 'compare-btn', 'Compare coverage') + saveBtn(s) + '</div>' +
      '</article>';
  }

  function renderSideItem(s) {
    return '<article class="side-item">' +
      '<p class="kicker">' + esc(labelOf[s.topic]) + '</p>' +
      '<h2 class="side-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h2>' +
      '<p class="side-summary">' + esc(s.summary) + '</p>' +
      '<div class="inline-foot">' + compareLink(s, 'textlink', 'Compare coverage (' + s.cov.rows.length + ') →') + saveBtn(s) + '</div>' +
      '</article>';
  }

  function renderGridItem(s) {
    return '<article class="grid-item">' +
      '<p class="kicker">' + esc(labelOf[s.topic]) + '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.time) + '</span></p>' +
      '<h3 class="grid-hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h3>' +
      '<p class="grid-summary">' + esc(s.summary) + '</p>' +
      '<div class="grid-cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      '<div class="inline-foot">' + compareLink(s, 'textlink', 'Compare coverage →') + saveBtn(s) + '</div>' +
      '</article>';
  }

  function renderWorldMap(stories) {
    var located = stories.filter(function (story) { return story.location; });
    if (!located.length) return '';
    return '<section class="world-panel" aria-labelledby="world-map-title">' +
      '<div class="world-panel-head"><h2 id="world-map-title">World stories on the map</h2>' +
      '<span class="small">' + esc(plural(located.length, 'mapped location', 'mapped locations')) + '</span></div>' +
      '<div id="world-map" class="world-map" role="region" aria-label="Interactive World story map" hidden></div>' +
      '<ul class="world-locations">' + located.map(function (story) {
        return '<li><span>' + esc(story.location.label) + '</span>' +
          compareLink(story, 'textlink', story.headline + ' →') + '</li>';
      }).join('') + '</ul></section>';
  }

  function mountWorldMap() {
    if (worldMap) return;
    var canvas = document.getElementById('world-map');
    if (!canvas || !window.L) return;
    var L = window.L;
    canvas.hidden = false;
    worldMap = L.map(canvas, { scrollWheelZoom: false, minZoom: 2, maxZoom: 17 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 17
    }).addTo(worldMap);
    var markers = CURRENT.filter(function (s) {
      return s.topic === 'world' && s.location && matchesQuery(s);
    }).map(function (s) {
      var popup = document.createElement('div');
      var location = document.createElement('strong');
      location.textContent = s.location.label;
      popup.append(location);
      popup.insertAdjacentHTML('beforeend', '<br>' + compareLink(s, 'textlink', s.headline));
      return L.marker([s.location.lat, s.location.lng], {
        title: s.location.label,
        alt: s.headline,
        icon: L.divIcon({ className: 'world-pin', iconSize: [24, 24], iconAnchor: [12, 12] })
      }).addTo(worldMap).bindPopup(popup);
    });
    if (markers.length) {
      worldMap.fitBounds(L.featureGroup(markers).getBounds(), { padding: [32, 32], maxZoom: 6 });
    }
  }

  function renderEditorialBand() {
    var papers = followed().map(function (p) {
      return '<button class="paper-row" data-act="paper" data-name="' + esc(p.name) + '"><span>' + esc(p.name) + '</span>' + leanBadge(p.name) + '</button>';
    }).join('');
    var swatches = [['c-L', 'Left'], ['c-LL', 'Lean left'], ['c-C', 'Centre'], ['c-LR', 'Lean right'], ['c-R', 'Right'], ['c-S', 'Science'], ['c-O', 'Other / unrated']]
      .map(function (x) { return '<span><span class="dotlg ' + x[0] + '"></span>' + x[1] + '</span>'; }).join('');
    return '<aside class="editorial-band" aria-label="Briefing digest and methodology">' +
      '<section class="band-col"><h2>60-second digest</h2><ul class="digest-list">' +
      D.META.digest.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') +
      '</ul></section>' +
      '<section class="band-col"><h2>How coverage works</h2><ol class="algo">' +
      '<li>Pheme groups reporting about the same event across outlets.</li>' +
      '<li>Links include original reporting, follow-up coverage and primary sources.</li>' +
      '<li>Media Bias/Fact Check ratings describe each publisher’s leaning.</li>' +
      '<li>The coverage bar shows the spread in each sample.</li></ol>' +
      '<div class="legend">' + swatches + '</div>' +
      '<p class="small">Edition: ' + esc(D.META.rangeLong) + ' · Updated ' + esc(D.META.lastRun) + '.</p></section>' +
      '<section class="band-col"><h2>Newspapers you follow</h2><div class="papers-list">' + papers + '</div>' +
      '<button class="outline-sm" data-act="settings">Manage newspapers</button></section>' +
      '</aside>';
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
        '</p>' + renderEditorialBand();
    }

    var lead = list[0];
    var side = list.slice(1, 3);
    var rest = list.slice(3);

    var heroHtml = side.length
      ? '<section class="hero-grid" aria-label="Featured stories">' + renderLead(lead) +
        '<div class="hero-side">' + side.map(renderSideItem).join('') + '</div></section>'
      : '<section aria-label="Featured story">' + renderLead(lead) + '</section>';

    var mapHtml = !isSaved && state.topic === 'world' ? renderWorldMap(list) : '';

    var restHtml = rest.length
      ? '<div class="section-rule"><h2>More in ' + esc(isSaved ? 'saved' : (state.topic === 'all' ? 'today’s briefing' : labelOf[state.topic])) + '</h2>' +
        '<span>Headlines from ' + esc(D.META.range) + '</span></div>' +
        '<section class="edition-grid" aria-label="More stories">' + rest.map(renderGridItem).join('') + '</section>'
      : '';

    return headerHtml + heroHtml + mapHtml + restHtml + renderEditorialBand();
  }

  /* ---------- Newspapers View ---------- */
  function renderPapers() {
    var papers = followed();
    var name = state.paper && papers.some(function (p) { return p.name === state.paper; }) ? state.paper : papers[0].name;
    var meta = papers.filter(function (p) { return p.name === name; })[0] || {};
    var stories = CURRENT.filter(function (s) { return s.source === name; });
    var tabs = papers.map(function (p) {
      var on = p.name === name;
      return '<button class="chip' + (on ? ' on' : '') + '" data-act="paper" data-name="' + esc(p.name) + '" aria-pressed="' + on + '">' + esc(p.name) + '</button>';
    }).join('') + '<button class="chip" data-act="settings">+ Add newspaper</button>';

    var body;
    if (stories.length) {
      var lead = stories[0];
      var rest = stories.slice(1);
      body = renderLead(lead) + (rest.length
        ? '<div class="section-rule"><h2>Also in ' + esc(name) + '</h2><span>' + esc(plural(stories.length, 'story', 'stories')) + ' featured</span></div>' +
          '<div class="edition-grid">' + rest.map(renderGridItem).join('') + '</div>'
        : '');
    } else {
      body = '<div class="notice"><strong>No featured stories from ' + esc(name) + ' today.</strong> ' +
        'When Pheme features a story from this outlet, it will appear here.' +
        (meta.paywall ? ' Full articles require a subscription to this paper.' : '') + '</div>';
    }

    return '<div class="page-head"><h1>Newspapers</h1><p>' + esc(plural(papers.length, 'newspaper', 'newspapers')) + ' followed · select one to view its featured stories</p></div>' +
      '<div class="chips" role="group" aria-label="Choose a newspaper">' + tabs + '</div>' +
      '<section class="paper-sheet" aria-labelledby="paper-name">' +
      '<header class="paper-masthead"><h2 id="paper-name">' + esc(name) + '</h2>' +
      '<span class="paper-dateline">Featured stories · ' + esc(D.META.rangeLong) + '</span></header>' + body + '</section>';
  }

  /* ---------- Story Reader & Coverage Comparison ---------- */
  function renderComparison(s) {
    return (s.comparison || []).map(function (group) {
      return '<section class="rsection"><h2>' + esc(group.label) + '</h2><ul class="points">' +
        group.points.map(function (point) {
          return '<li>' + esc(point.text) + ' ' + point.sources.map(function (name) {
            var row = s.cov.rows.find(function (item) { return item.name === name; });
            return row ? '<a href="' + esc(safeUrl(row.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a>' : '';
          }).join(' · ') + '</li>';
        }).join('') + '</ul></section>';
    }).join('');
  }

  function renderReader(s) {
    var back = state.view === 'papers' ? 'Back to ' + (state.paper || followed()[0].name) : (state.view === 'saved' ? 'Back to saved' : 'Back to Pheme');
    var more = STORIES.filter(function (o) { return o.source === s.source && o.id !== s.id; }).slice(0, 3);
    var cov = s.cov;
    var img = safeAsset(s.image);
    return '<article class="reader" id="reader" aria-labelledby="reader-title">' +
      '<button class="backbtn" data-act="back">← ' + esc(back) + '</button>' +
      '<p class="kicker">' + esc(labelOf[s.topic]) + '<span class="kicker-meta">' + esc(s.source) + ' · ' + esc(s.publishedLabel || s.time) + '</span></p>' +
      '<h1 id="reader-title">' + esc(s.headline) + '</h1>' +
      '<p class="standfirst">' + esc(s.summary) + '</p>' +
      (img ? '<figure class="reader-photo"><img src="' + esc(img) + '" alt="' + esc(s.imageAlt || s.headline) + '"></figure>' : '') +
      renderComparison(s) +
      '<section class="rsection"><h2>Key points</h2><ul class="points">' +
      (s.points || []).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="rsection" aria-labelledby="cov-title">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
      '<h2 id="cov-title">Full coverage · ' + esc(cov.count) + '</h2>' +
      '<span class="small">Leaning ratings: Media Bias/Fact Check</span></div>' +
      covBar(cov, true) +
      '<div class="legend">' + cov.legend.map(function (l) { return '<span><span class="dotlg ' + l.cls + '"></span>' + esc(l.label) + ' · ' + l.n + '</span>'; }).join('') + '</div>' +
      '<p style="margin:0;font-family:var(--sans);font-size:13.5px;font-weight:600;color:var(--ink)">' + esc(cov.note) + '</p>' +
      '<ul class="covlist">' + cov.rows.map(function (r) {
        return '<li>' + leanBadge(r.name) + '<span class="name">' + esc(r.name) + '</span><span class="small">' + esc(r.date) + '</span>' +
          '<a href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer" aria-label="Open ' + esc(r.name) + ' article in a new tab">Open ↗</a></li>';
      }).join('') + '</ul></section>' +
      '<div class="rfoot"><p class="small" style="max-width:46ch">Summary written for Pheme from ' + esc(s.source) + '’s report. Follow the link for the full original article.</p>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' + saveBtn(s) +
      '<a class="darkbtn" href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">Original at ' + esc(s.source) + ' ↗</a></div></div>' +
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
    return '<div class="settings-backdrop" data-act="close"></div>' +
      '<div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">' +
      '<div class="settings-head"><h2 id="settings-title">Manage newspapers</h2>' +
      '<button class="search-toggle" data-act="close" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="settings-body">' +
      '<p class="small">Pin newspapers for quick access to any stories featured in Pheme.</p>' +
      '<div class="settings-search">' + ICON.search + '<label for="src-q" class="sr-only">Search newspapers</label>' +
      '<input id="src-q" type="search" placeholder="Search newspapers, e.g. Telegraph" value="' + esc(state.srcQuery) + '" autocomplete="off"></div>' +
      '<div id="src-list">' + sourceListHtml() + '</div>' +
      '</div><div class="settings-foot"><button class="darkbtn" data-act="close">Done</button></div></div>';
  }

  function render(opts) {
    if (worldMap) { worldMap.remove(); worldMap = null; }
    var reading = state.reading ? byId[state.reading] : null;
    var main;
    if (reading) main = renderReader(reading);
    else if (state.view === 'papers') main = renderPapers();
    else main = renderBriefing();

    app.innerHTML = renderHeader() +
      '<main class="wrap page-main" id="main">' + main + '</main>' +
      '<footer class="footer"><div class="wrap">Story summaries are written for Pheme from each outlet’s reporting; follow the links for the full articles. Leaning ratings from Media Bias/Fact Check.</div></footer>' +
      renderSettings();

    mountWorldMap();
    if (opts && opts.focus) {
      var el = document.getElementById(opts.focus);
      if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
    }
    if (opts && opts.scrollReader) {
      var r = document.getElementById('reader');
      if (r && r.scrollIntoView) r.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  /* ---------- events ---------- */
  app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    switch (act) {
      case 'home':
        state.view = 'briefing'; state.topic = 'all'; state.query = ''; state.searchOpen = false;
        if (state.reading) changeStory(null);
        render(); break;
      case 'topic':
        state.view = 'briefing'; state.topic = id;
        if (state.reading) changeStory(null);
        render(); break;
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
      case 'back':
        changeStory(null); render(); break;
      case 'save':
        state.saved[id] = !state.saved[id]; persist(); render(); break;
      case 'togglesearch':
        state.searchOpen = !state.searchOpen;
        if (!state.searchOpen) state.query = '';
        render({ focus: state.searchOpen ? 'q' : null }); break;
      case 'clearsearch':
        state.query = ''; render({ focus: 'q' }); break;
      case 'settings':
        state.settingsOpen = true; render({ focus: 'src-q' }); break;
      case 'close':
        state.settingsOpen = false; render(); break;
      case 'addsrc':
        state.added[id] = !state.added[id]; persist();
        render({ focus: null });
        var b = app.querySelector('[data-act="addsrc"][data-id="' + id + '"]');
        if (b) b.focus();
        break;
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
    if (e.key === 'Escape') {
      if (state.settingsOpen) { state.settingsOpen = false; render(); }
      else if (state.searchOpen) { state.searchOpen = false; state.query = ''; render(); }
    }
  });

  document.getElementById('world-map-library')?.addEventListener('load', mountWorldMap);
  render();
})();
