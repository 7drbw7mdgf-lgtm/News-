/* Daybreak — standalone news dashboard. No build step, no dependencies. */
(function () {
  'use strict';

  var D = window.DAYBREAK;
  var app = document.getElementById('app');
  if (!D || !app) return;

  var ACCENT = '#1E46C8';
  var STORE_KEY = 'daybreak:v2';
  var route = new URLSearchParams(location.search);
  var SEG_ORDER = ['L', 'LL', 'C', 'LR', 'R', 'S'];
  var labelOf = {};
  D.TOPICS.forEach(function (t) { labelOf[t.id] = t.label; });

  /* ---------- state (saved choices persist in this browser) ---------- */
  var state = {
    view: 'briefing', topic: 'all', reading: null, paper: null,
    settingsOpen: false, srcQuery: '', query: '',
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
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var ICON = {
    bookmark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
    search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5A5F6B" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
    close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>',
    sliders: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>',
    list: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10"></path></svg>',
    bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"></path></svg>',
    paper: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h13v14H6a2 2 0 0 1-2-2z"></path><path d="M17 9h3v8a2 2 0 0 1-2 2"></path><path d="M8 9h5M8 13h5"></path></svg>',
    logo: '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M5 19a9 9 0 0 1 18 0" stroke="' + ACCENT + '" stroke-width="2.4" stroke-linecap="round"></path><path d="M3 23h22" stroke="#15171C" stroke-width="2.4" stroke-linecap="round"></path><path d="M14 4v3M6.5 8.5l2 2M21.5 8.5l-2 2" stroke="' + ACCENT + '" stroke-width="2.4" stroke-linecap="round"></path></svg>'
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
  if (route.has('q')) state.query = route.get('q');

  function storyHref(id) {
    return '?story=' + encodeURIComponent(id);
  }
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

  function covBar(cov, large) {
    return '<div class="covbar' + (large ? ' lg' : '') + '" role="img" aria-label="' + esc(cov.aria) + '">' +
      cov.legend.map(function (l) { return '<span class="seg ' + l.cls + '" style="flex-grow:' + l.n + '"></span>'; }).join('') +
      '</div>';
  }
  function leanBadge(name) {
    var code = D.OUTLETS[name] || 'NC';
    return '<span class="lean lb-' + code + '" title="Media Bias/Fact Check: ' + esc(D.LEAN[code][1]) + '">' + esc(D.LEAN[code][0]) + '</span>';
  }
  function saveBtn(s) {
    var on = !!state.saved[s.id];
    return '<button class="savebtn' + (on ? ' on' : '') + '" data-act="save" data-id="' + esc(s.id) + '" aria-pressed="' + on + '">' + ICON.bookmark + (on ? 'Saved' : 'Save') + '</button>';
  }
  function storyMeta(s, withSource) {
    return '<div class="meta"><span class="tag tag-' + esc(s.topic) + '">' + esc(labelOf[s.topic]) + '</span>' +
      (withSource ? '<span>' + esc(s.source) + '</span><span aria-hidden="true">·</span>' : '') +
      '<span>' + esc(s.time) + '</span></div>';
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

  /* ---------- search filter (header search) ---------- */
  function matchesQuery(s) {
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    return (s.headline + ' ' + s.summary + ' ' + s.source + ' ' + labelOf[s.topic]).toLowerCase().indexOf(q) !== -1;
  }

  /* ---------- views ---------- */
  function renderHeader() {
    return '<header class="topbar">' +
      '<div class="brand">' + ICON.logo + '<span class="brand-name">Daybreak</span></div>' +
      '<form class="search" role="search" data-form="search">' + ICON.search +
      '<label for="q" class="sr-only">Search stories, topics and sources</label>' +
      '<input id="q" type="search" placeholder="Search stories, topics and sources" value="' + esc(state.query) + '" autocomplete="off"></form>' +
      '<div class="top-right"><span class="muted" style="font-size:14px">' + esc(D.META.dateLabel) + '</span>' +
      '<span class="pill">Headlines from ' + esc(D.META.range) + '</span>' +
      '<button class="iconbtn" data-act="settings" aria-label="Settings" aria-expanded="' + state.settingsOpen + '">' + ICON.sliders + '</button>' +
      '<button class="avatar" data-act="settings" aria-label="Account and settings" aria-expanded="' + state.settingsOpen + '">O</button></div>' +
      '</header>';
  }

  function renderNav() {
    var isPapers = state.view === 'papers';
    var savedCount = STORIES.filter(function (s) { return state.saved[s.id]; }).length;
    var topics = D.TOPICS.map(function (t) {
      var on = !isPapers && !state.reading && state.topic === t.id;
      var n = CURRENT.filter(function (s) { return s.topic === t.id; }).length;
      return '<button class="navbtn' + (on ? ' on' : '') + '" data-act="topic" data-id="' + esc(t.id) + '" aria-pressed="' + on + '">' +
        '<span class="dot dot-' + esc(t.id) + '"></span><span class="grow">' + esc(t.label) + '</span><span class="count">' + n + '</span></button>';
    }).join('');
    return '<nav class="sidenav" aria-label="Sections"><div class="navgroup">' +
      '<button class="navbtn' + (!isPapers && state.view !== 'saved' ? ' on' : '') + '" data-act="view" data-view="briefing">' + ICON.list + 'Briefing</button>' +
      '<button class="navbtn' + (state.view === 'saved' ? ' on' : '') + '" data-act="view" data-view="saved">' + ICON.bookmark + '<span class="grow">Saved</span><span class="count">' + savedCount + '</span></button>' +
      '<button class="navbtn' + (isPapers ? ' on' : '') + '" data-act="view" data-view="papers">' + ICON.paper + 'Newspapers</button>' +
      '</div><div class="navgroup"><h2 class="navhead">Topics</h2>' + topics + '</div></nav>';
  }

  function renderLead(s) {
    return '<article class="card lead">' +
      '<div class="meta"><span class="kicker">Top story</span><span class="tag tag-' + esc(s.topic) + '">' + esc(labelOf[s.topic]) + '</span>' +
      '<span>' + esc(s.source) + '</span><span aria-hidden="true">·</span><span>' + esc(s.time) + '</span></div>' +
      '<h2 class="hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h2>' +
      '<p class="summary">' + esc(s.summary) + '</p>' +
      '<div class="cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      '<div class="cardfoot">' + compareLink(s, "textbtn", "Compare coverage →") + saveBtn(s) + '</div>' +
      '</article>';
  }
  function renderCard(s) {
    return '<article class="card">' + storyMeta(s, true) +
      '<h3 class="hl"><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h3>' +
      '<p class="summary">' + esc(s.summary) + '</p>' +
      '<div class="cov">' + covBar(s.cov) + '<span class="covtext">' + esc(s.cov.count + ' · ' + s.cov.note) + '</span></div>' +
      '<div class="cardfoot">' + compareLink(s, "textbtn", "Compare coverage →") + saveBtn(s) + '</div>' +
      '</article>';
  }

  function renderBriefing() {
    var saved = state.view === 'saved';
    var list = (saved ? STORIES : CURRENT).filter(function (s) {
      if (saved) return state.saved[s.id];
      return state.topic === 'all' || s.topic === state.topic;
    }).filter(matchesQuery);
    var title = saved ? 'Saved stories' : (state.topic === 'all' ? 'Your briefing' : labelOf[state.topic]);
    var sub = saved ? plural(list.length, 'saved story', 'saved stories') :
      plural(list.length, 'story', 'stories') + ' · ' + (state.topic === 'all' ? '4 topics · headlines from ' + D.META.rangeLong : 'editor’s selection');
    if (state.query.trim()) sub = plural(list.length, 'story', 'stories') + ' matching “' + state.query.trim() + '”';
    var chips = saved ? '' : '<div class="chips" role="group" aria-label="Filter by topic">' +
      [{ id: 'all', label: 'All topics' }].concat(D.TOPICS).map(function (t) {
        var on = state.topic === t.id;
        return '<button class="chip' + (on ? ' on' : '') + '" data-act="topic" data-id="' + esc(t.id) + '" aria-pressed="' + on + '">' + esc(t.label) + '</button>';
      }).join('') + '</div>';
    var body;
    if (!list.length) {
      body = '<p class="notice">' + (saved ? 'Nothing saved yet. Use Save on any story to keep it here.' : 'No stories match that search.') + '</p>';
    } else {
      body = renderLead(list[0]) + (list.length > 1 ? '<div class="grid">' + list.slice(1).map(renderCard).join('') + '</div>' : '');
    }
    return '<div><h1 class="title">' + esc(title) + '</h1><p class="sub">' + esc(sub) + '</p></div>' + chips + body;
  }

  function renderPapers() {
    var papers = followed();
    var name = state.paper && papers.some(function (p) { return p.name === state.paper; }) ? state.paper : papers[0].name;
    var meta = papers.filter(function (p) { return p.name === name; })[0] || {};
    var stories = CURRENT.filter(function (s) { return s.source === name; });
    var tabs = papers.map(function (p) {
      var on = p.name === name;
      return '<button class="chip' + (on ? ' on' : '') + '" data-act="paper" data-name="' + esc(p.name) + '" aria-pressed="' + on + '">' + esc(p.name) + '</button>';
    }).join('') + '<button class="chip" data-act="settings" style="color:' + ACCENT + '">+ Add newspaper</button>';
    var inner;
    if (stories.length) {
      var lead = stories[0];
      inner = '<div class="stack" style="gap:24px"><div class="paper-lead">' +
        '<div class="meta"><span class="kicker">Front page</span><span class="tag tag-' + esc(lead.topic) + '">' + esc(labelOf[lead.topic]) + '</span><span>' + esc(lead.time) + '</span></div>' +
        '<h3 class="hl"><button class="storybtn" data-act="open" data-id="' + esc(lead.id) + '">' + esc(lead.headline) + '</button></h3>' +
        '<p class="summary">' + esc(lead.summary) + '</p>' +
        '<button class="textbtn" data-act="open" data-id="' + esc(lead.id) + '" style="align-self:flex-start">Read story →</button></div>' +
        (stories.length > 1 ? '<div class="paper-cols">' + stories.slice(1).map(function (o) {
          return '<div>' + storyMeta(o, false) +
            '<h4 class="hl"><button class="storybtn" data-act="open" data-id="' + esc(o.id) + '">' + esc(o.headline) + '</button></h4>' +
            '<p class="summary">' + esc(o.summary) + '</p></div>';
        }).join('') + '</div>' : '') +
        '<p class="small" style="padding-top:16px;border-top:1px solid #EEECE6;font-size:13px">' + esc(plural(stories.length, 'story', 'stories')) + ' in today’s edition</p></div>';
    } else {
      inner = '<div class="empty"><p class="serif" style="margin:0;font-size:24px;font-weight:600">No featured stories from this outlet</p>' +
        '<p style="margin:0;max-width:46ch;font-size:15px;line-height:1.55;color:#3A3E48">When Daybreak features a story from this outlet, it will appear here.</p>' +
        (meta.paywall ? '<p style="margin:0;font-size:13px;font-weight:600;color:#6B4A00">Full articles need a subscription to this paper.</p>' : '') + '</div>';
    }
    return '<div><h1 class="title">Newspapers</h1><p class="sub">' + esc(plural(papers.length, 'newspaper', 'newspapers')) + ' you follow · pick one to read today’s edition</p></div>' +
      '<div class="chips" role="group" aria-label="Choose a newspaper">' + tabs + '</div>' +
      '<article class="paper" aria-labelledby="paper-name"><header class="masthead"><h2 id="paper-name">' + esc(name) + '</h2>' +
      '<span class="dateline">Latest stories · ' + esc(D.META.rangeLong) + '</span></header>' + inner + '</article>';
  }

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
    var back = state.view === 'papers' ? 'Back to ' + (state.paper || followed()[0].name) : (state.view === 'saved' ? 'Back to saved' : 'Back to briefing');
    var more = STORIES.filter(function (o) { return o.source === s.source && o.id !== s.id; }).slice(0, 3);
    var cov = s.cov;
    return '<article class="reader" id="reader" aria-labelledby="reader-title">' +
      '<button class="backbtn" data-act="back">← ' + esc(back) + '</button>' +
      '<div class="meta"><span class="tag tag-' + esc(s.topic) + '">' + esc(labelOf[s.topic]) + '</span>' +
      '<span style="font-weight:600;color:#15171C">' + esc(s.source) + '</span><span aria-hidden="true">·</span><span>' + esc(s.publishedLabel || s.time) + '</span></div>' +
      '<h1 id="reader-title">' + esc(s.headline) + '</h1>' +
      '<p class="standfirst">' + esc(s.summary) + '</p>' +
      renderComparison(s) + '<section class="rsection"><h2>Key points</h2><ul class="points">' + (s.points || []).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="rsection" aria-labelledby="cov-title" style="gap:12px">' +
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap"><h2 id="cov-title">Full coverage · ' + esc(cov.count) + '</h2>' +
      '<span class="small">Leaning ratings: Media Bias/Fact Check</span></div>' + covBar(cov, true) +
      '<div class="legend">' + cov.legend.map(function (l) { return '<span><span class="dotlg ' + l.cls + '"></span>' + esc(l.label) + ' · ' + l.n + '</span>'; }).join('') + '</div>' +
      '<p style="margin:0;font-size:14px;font-weight:600;color:#2A2D35">' + esc(cov.note) + '</p>' +
      '<ul class="covlist">' + cov.rows.map(function (r) {
        return '<li>' + leanBadge(r.name) + '<span class="name">' + esc(r.name) + '</span><span class="small">' + esc(r.date) + '</span>' +
          '<a href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer" aria-label="Open ' + esc(r.name) + ' article in a new tab">Open ↗</a></li>';
      }).join('') + '</ul></section>' +
      '<div class="rfoot"><p class="small" style="font-size:13px;line-height:1.5;max-width:46ch">Summary written for Daybreak from ' + esc(s.source) + '’s report. The full article is on their site.</p>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + saveBtn(s) +
      '<a class="darkbtn" style="font-size:13px;padding:0 16px;border-radius:8px" href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">Original at ' + esc(s.source) + ' ↗</a></div></div>' +
      (more.length ? '<section class="rsection more" style="gap:4px"><h2 style="margin-bottom:6px">More from ' + esc(s.source) + '</h2><div class="papers-list">' +
        more.map(function (m) { return '<button class="navbtn" data-act="open" data-id="' + esc(m.id) + '">' + esc(m.headline) + '</button>'; }).join('') +
        '</div></section>' : '') +
      '</article>';
  }

  function renderRail() {
    var papers = followed().map(function (p) {
      return '<button class="navbtn" data-act="paper" data-name="' + esc(p.name) + '"><span class="dot dot-' + esc(p.topic) + '"></span><span class="grow">' + esc(p.name) + '</span>' + leanBadge(p.name) + '</button>';
    }).join('');
    var swatches = [['c-L', 'Left'], ['c-LL', 'Lean left'], ['c-C', 'Centre'], ['c-LR', 'Lean right'], ['c-R', 'Right'], ['c-S', 'Science'], ['c-O', 'Other / unrated']]
      .map(function (x) { return '<span><span class="dotlg ' + x[0] + '"></span>' + x[1] + '</span>'; }).join('');
    return '<aside class="rail" aria-label="Your digest and sources">' +
      '<section class="panel dark"><h2>Your 60-second digest</h2><ul>' + D.META.digest.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></section>' +
      '<section class="panel" aria-labelledby="algo-title"><h2 id="algo-title">How coverage works</h2><ol class="algo">' +
      '<li>Daybreak groups reporting about the same event.</li>' +
      '<li>Links can include original reporting, follow-up coverage and primary sources.</li>' +
      '<li>Where available, Media Bias/Fact Check labels describe publishers.</li>' +
      '<li>The bar describes the outlets in the displayed sample.</li></ol>' +
      '<div class="legend">' + swatches + '</div>' +
      '<p class="small">Last updated: ' + esc(D.META.lastRun) + '.</p></section>' +
      '<section class="panel"><h2>Newspapers you follow</h2><div class="papers-list">' + papers + '</div>' +
      '<button class="plainbtn" data-act="settings">Manage newspapers</button></section>' +
      '</aside>';
  }

  function sourceListHtml() {
    var q = state.srcQuery.trim().toLowerCase();
    var list = CATALOGUE.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) !== -1 || c.catLabel.toLowerCase().indexOf(q) !== -1; });
    var addedN = CATALOGUE.filter(function (c) { return state.added[c.id]; }).length;
    var text = (q ? list.length + ' of ' + CATALOGUE.length + ' newspapers match' : CATALOGUE.length + ' newspapers available') + (addedN ? ' · ' + addedN + ' added' : '');
    var items = list.map(function (c) {
      var on = !!state.added[c.id];
      var words = c.name.replace(/^The /, '').split(' ');
      var initials = (words[0].charAt(0) + (words[1] ? words[1].charAt(0) : '')).toUpperCase();
      return '<li><span class="mono tag-' + esc(c.topic) + '" aria-hidden="true">' + esc(initials) + '</span>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span style="font-size:14px;font-weight:600">' + esc(c.name) + '</span>' +
        '<span class="small">' + esc(c.catLabel + (c.paywall ? ' · Subscription' : '')) + '</span></div>' +
        '<button class="addbtn' + (on ? ' on' : '') + '" data-act="addsrc" data-id="' + esc(c.id) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Remove ' : 'Add ') + esc(c.name) + '">' + (on ? 'Added' : 'Add') + '</button></li>';
    }).join('');
    return '<p aria-live="polite" class="small">' + esc(text) + '</p><ul class="srclist">' + items + '</ul>' +
      (list.length ? '' : '<p class="notice">No newspapers match that search.</p>');
  }

  function renderSettings() {
    if (!state.settingsOpen) return '';
    return '<div class="settings" role="dialog" aria-modal="false" aria-labelledby="settings-title">' +
      '<div class="settings-head"><h2 id="settings-title">Settings</h2><button class="iconbtn" style="border:0" data-act="close" aria-label="Close settings">' + ICON.close + '</button></div>' +
      '<div class="settings-body">' +
      '<section><h3>Newspapers</h3><p style="margin:0;font-size:14px;color:#3A3E48">Pin newspapers for quick access to any stories featured in the briefing.</p>' +
      '<div class="search" style="max-width:none;flex:none">' + ICON.search + '<label for="src-q" class="sr-only">Search newspapers</label>' +
      '<input id="src-q" type="search" placeholder="Search newspapers, e.g. Telegraph" value="' + esc(state.srcQuery) + '" autocomplete="off"></div>' +
      '<div id="src-list">' + sourceListHtml() + '</div></section>' +
      '</div><div class="settings-foot"><button class="darkbtn" data-act="close">Done</button></div></div>';
  }

  function render(opts) {
    var reading = state.reading ? byId[state.reading] : null;
    var main;
    if (reading) main = renderReader(reading);
    else if (state.view === 'papers') main = renderPapers();
    else main = renderBriefing();
    app.innerHTML = renderHeader() +
      '<div class="shell">' + renderNav() +
      '<div class="content"><main class="main" id="main">' + main + '</main>' + renderRail() + '</div></div>' +
      '<footer class="footer">Story summaries are written for Daybreak from each outlet’s reporting; follow the links for the full articles. Leaning ratings from Media Bias/Fact Check.</footer>' +
      renderSettings();
    if (opts && opts.focus) {
      var el = document.getElementById(opts.focus);
      if (el) { el.focus(); if (el.type === 'text' && el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
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
      case 'topic': state.view = 'briefing'; state.topic = id; if (state.reading) changeStory(null); render(); break;
      case 'view': state.view = t.getAttribute('data-view'); if (state.reading) changeStory(null); if (state.view === 'briefing') state.topic = state.topic || 'all'; render(); break;
      case 'paper': state.view = 'papers'; state.paper = t.getAttribute('data-name'); if (state.reading) changeStory(null); state.settingsOpen = false; render(); break;
      case 'open': if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); changeStory(id); state.settingsOpen = false; render({ scrollReader: true }); break;
      case 'back': changeStory(null); render(); break;
      case 'save': state.saved[id] = !state.saved[id]; persist(); render(); break;
      case 'settings': state.settingsOpen = true; render({ focus: 'src-q' }); break;
      case 'close': state.settingsOpen = false; render(); break;
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
    if (e.key === 'Escape' && state.settingsOpen) { state.settingsOpen = false; render(); }
  });

  render();
})();
