/* Pheme — standalone broadsheet news dashboard. No build step, no dependencies. */
(function () {
  'use strict';

  var D = window.DAYBREAK;
  var app = document.getElementById('app');
  if (!D || !app) return;

  var STORE_KEY = 'daybreak:v2';
  var worldMap;
  var publisherMap;
  var publisherMapLayer;
  var exchangeMap;
  var exchangeMapLayer;
  var worldMarkerLayer;
  var mapPinById = Object.create(null);
  var MARKETS = [
    { id: 'london', city: 'London', index: 'FTSE 100', zone: 'Europe/London', url: 'https://finance.yahoo.com/quote/%5EFTSE/history/' },
    { id: 'newyork', city: 'New York', index: 'S&P 500', zone: 'America/New_York', url: 'https://finance.yahoo.com/quote/%5EGSPC/history/' },
    { id: 'shanghai', city: 'Shanghai', index: 'Shanghai Composite', zone: 'Asia/Shanghai', url: 'https://finance.yahoo.com/quote/000001.SS/history/' },
    { id: 'india', city: 'Mumbai', index: 'NIFTY 50', zone: 'Asia/Kolkata', url: 'https://finance.yahoo.com/quote/%5ENSEI/history/' }
  ];
  var clockFormats = Object.create(null);
  var clockPartsFormats = Object.create(null);
  var marketData = null;
  var marketLoadFailed = false;
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
    publisherArticle: null,
    settingsOpen: false, searchOpen: false, utilityOpen: null, srcQuery: '', query: '',
    headerPrefs: { showClock: true, markets: ['london', 'newyork', 'shanghai'] },
    marketOpen: null, marketRange: '6M', marketHover: null, tradingMarket: 'london', marketNewsFocus: 'all', marketWatch: ['Apple', 'Microsoft', 'Nvidia'], marketWorkspaceTab: 'overview', marketSearch: '', marketSelectedCompany: 'AAPL', marketCompanyPanel: 'chart',
    saved: {}, added: {}, highlights: {},
    readerPrefs: { theme: 'newsprint', size: 'md', font: 'serif', measure: 'focused', voice: 'ava', rate: 1 },
    readerFocus: false, aaOpen: false, covFilter: 'all', copiedId: null,
    audioOpen: false, audioStoryId: null, audioVoice: 'ava', audioLoading: false, audioError: null,
    audioTime: 0, audioDuration: 0,
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
      if (Array.isArray(stored.marketWatch)) state.marketWatch = stored.marketWatch.filter(function (name) { return typeof name === 'string' && name.length < 55; }).slice(0, 32);
      if (stored.readerPrefs) state.readerPrefs = Object.assign({}, state.readerPrefs, stored.readerPrefs);
      if (state.readerPrefs.rate && [0.9, 1, 1.15, 1.25, 1.5].indexOf(state.readerPrefs.rate) !== -1) {
        state.speechRate = state.readerPrefs.rate;
      }
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
        headerPrefs: state.headerPrefs,
        marketWatch: state.marketWatch
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeAsset(u) {
    if (!u || typeof u !== 'string') return '';
    if (/^assets\/images\/[a-z0-9._-]+$/i.test(u)) return u;
    if (/^https:\/\//i.test(u)) {
      try {
        var parsed = new URL(u);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
      } catch (e) { /* invalid URL */ }
    }
    return '';
  }
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
    play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.2v13.6a1 1 0 0 0 1.52.85l11-6.8a1 1 0 0 0 0-1.7l-11-6.8A1 1 0 0 0 7 5.2z"></path></svg>',
    pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.5" height="14" rx="1.4"></rect><rect x="13.5" y="5" width="4.5" height="14" rx="1.4"></rect></svg>',
    stop: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>',
    focus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"></path></svg>',
    link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>'
  };

  /* ---------- coverage ---------- */
  var EXCLUDED_FROM_LEANING = ['End Time Headlines'];
  function buildCoverage(id, archived) {
    var flaggedNames = (D.QUESTIONABLE || []).concat(EXCLUDED_FROM_LEANING);
    var rows = (archived || D.COVERAGE[id] || []).map(function (r) {
      var code = D.OUTLETS[r[0]] || 'NC';
      return { name: r[0], date: r[1], url: r[2], title: r[3] || '', code: code,
        excludedFromLeaning: flaggedNames.indexOf(r[0]) !== -1 };
    });
    // Keep every publisher in the source list, but don't allow flagged/fringe
    // or unrated outlets to skew political leaning visualisations.
    var ratedRows = rows.filter(function (r) {
      return !r.excludedFromLeaning && SEG_ORDER.indexOf(r.code) !== -1;
    });
    var counts = {};
    ratedRows.forEach(function (r) { counts[r.code] = (counts[r.code] || 0) + 1; });
    var other = rows.length - ratedRows.length;
    var present = SEG_ORDER.filter(function (k) { return counts[k]; });
    var legend = present.map(function (k) { return { cls: 'c-' + k, label: D.LEAN[k][0], n: counts[k] }; });
    if (other) legend.push({ cls: 'c-O', label: 'Excluded / unrated', n: other });
    var left = (counts.L || 0) + (counts.LL || 0);
    var right = (counts.LR || 0) + (counts.R || 0);
    var centre = counts.C || 0;
    var rated = left + right + centre;
    var note;
    if (!ratedRows.length) note = 'No unflagged outlets with a usable left-right rating.';
    else if (rated < 2) note = 'Too few unflagged politically rated outlets to judge the spread.';
    else if (right === 0 && left > 0) note = 'No right-leaning outlets in the unflagged sample.';
    else if (left === 0 && right > 0) note = 'No left-leaning outlets in the unflagged sample.';
    else if (left === 0 && right === 0) note = 'Only centre-rated outlets in the unflagged sample.';
    else note = 'Leaning mix excludes flagged/fringe and unrated outlets. All original links remain listed.';
    return {
      rows: rows, legend: legend, note: note,
      count: ratedRows.length + ' assessed · ' + other + ' excluded/unrated',
      aria: 'Based on ' + ratedRows.length + ' assessed sources; ' + other + ' excluded or unrated. Coverage mix: ' +
        legend.map(function (l) { return l.n + ' ' + l.label.toLowerCase(); }).join(', ')
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
  var routePublisher = route.get('publisher');
  var routeArticle = safeExternalUrl(route.get('article'));
  if (routePublisher) {
    state.view = 'papers';
    state.paper = routePublisher;
  }
  if (routePublisher && routeArticle) {
    state.publisherArticle = {
      name: routePublisher, url: routeArticle, title: route.get('title') || '',
      summary: route.get('excerpt') || '', published: route.get('published') || ''
    };
  }
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
  function leavePublisherArticle(href) {
    if (!state.publisherArticle) return;
    state.publisherArticle = null;
    history.pushState(null, '', href || location.pathname);
  }
  function safeExternalUrl(u) {
    if (!u || typeof u !== 'string' || !/^https:\/\//i.test(u)) return '';
    try {
      var parsed = new URL(u);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
    } catch (e) { /* invalid URL */ }
    return '';
  }
  function publisherArticleHref(article, name) {
    var params = new URLSearchParams();
    params.set('publisher', name);
    params.set('article', safeExternalUrl(article.url));
    if (article.title) params.set('title', article.title);
    if (article.published) params.set('published', article.published);
    return '?' + params.toString();
  }
  function nativePublisherArticleLink(article, name, label, cls) {
    var safe = safeExternalUrl(article && article.url);
    if (!safe) return '';
    return '<a class="' + (cls || '') + '" href="' + esc(publisherArticleHref(article, name)) + '" data-act="publisherarticle" data-name="' + esc(name) + '" data-url="' + esc(safe) + '" data-title="' + esc(article.title || '') + '" data-published="' + esc(article.published || '') + '" aria-label="Read ' + esc(article.title || 'publisher article') + ' in Pheme">' + esc(label || 'Read in Pheme') + '</a>';
  }
  function nativePublisherImageLink(article, name, image) {
    var safe = safeExternalUrl(article && article.url);
    if (!safe) return '';
    return '<a class="paper-source-image" href="' + esc(publisherArticleHref(article, name)) + '" data-act="publisherarticle" data-name="' + esc(name) + '" data-url="' + esc(safe) + '" data-title="' + esc(article.title || '') + '" data-published="' + esc(article.published || '') + '" aria-label="Read ' + esc(article.title || 'publisher article') + ' in Pheme"><img src="' + esc(image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>';
  }
  function originalArticleLink(url, name, label, cls) {
    var safe = safeExternalUrl(url);
    if (!safe) return '';
    return '<a class="' + (cls || '') + '" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer" aria-label="Read original article on ' + esc(name) + ' (opens in new tab)">' + esc(label || 'Read original ↗') + '</a>';
  }
  function nativeSourceLink(s, name, label, cls) {
    return '<a class="' + (cls || '') + '" href="' + esc(sourceHref(s.id, name)) + '" data-act="opensource" data-id="' + esc(s.id) + '" data-source="' + esc(name) + '" aria-label="Read ' + esc(name) + ' coverage in Pheme">' + esc(label || name) + '</a>';
  }
  function compareLink(s, cls, label) {
    return '<a class="' + cls + '" href="' + storyHref(s.id) +
      '" data-act="open" data-id="' + esc(s.id) + '">' + esc(label) + '</a>';
  }
  var audioManifest = null;
  var audioManifestLoaded = false;
  var voiceAudio = typeof Audio !== 'undefined' ? new Audio() : null;
  var pendingSeek = null;

  function buildCacheSuffix() {
    var buildMeta = document.querySelector('meta[name="daybreak-build"]');
    var buildId = buildMeta && buildMeta.getAttribute('content');
    return buildId && buildId !== 'dev' ? '?v=' + encodeURIComponent(buildId) : '';
  }

  function loadAudioManifest() {
    fetch('assets/audio/manifest.json' + buildCacheSuffix(), { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) throw new Error('Audio manifest unavailable');
      return resp.json();
    }).then(function (data) {
      if (data && data.stories && Array.isArray(data.voices)) {
        audioManifest = data;
      }
      audioManifestLoaded = true;
      if (state.reading) render();
    }).catch(function () {
      audioManifestLoaded = true;
    });
  }

  function audioVoices() {
    return (audioManifest && Array.isArray(audioManifest.voices) && audioManifest.voices.length)
      ? audioManifest.voices
      : [
          { id: 'ava', label: 'Ava', accent: 'US', tagline: 'Warm & expressive' },
          { id: 'andrew', label: 'Andrew', accent: 'US', tagline: 'Calm & conversational' },
          { id: 'sonia', label: 'Sonia', accent: 'UK', tagline: 'British Southern · Crisp & warm' },
          { id: 'libby', label: 'Libby', accent: 'UK', tagline: 'British London · Modern & friendly' },
          { id: 'amelia', label: 'Amelia', accent: 'UK', tagline: 'British · Young & expressive' },
          { id: 'allison', label: 'Allison', accent: 'UK', tagline: 'British · Smooth & velvety' },
          { id: 'bradford', label: 'Bradford', accent: 'UK', tagline: 'British · Expressive storyteller' },
          { id: 'sally', label: 'Sally Ford', accent: 'UK', tagline: 'British · Calm & well-spoken' },
          { id: 'emily', label: 'Emily', accent: 'IE', tagline: 'Irish · Warm & lyrical' },
          { id: 'ernesto', label: 'Ernesto', accent: 'MX', tagline: 'Mexican-American · Warm & conversational' },
          { id: 'ximena', label: 'Ximena', accent: 'ES', tagline: 'Spanish English · Warm & natural' },
          { id: 'alvaro', label: 'Alvaro', accent: 'ES', tagline: 'Spanish English · Castilian & clear' }
        ];
  }

  function audioTrackFor(storyId, voiceId) {
    if (!audioManifest || !audioManifest.stories || !audioManifest.stories[storyId]) return null;
    var voices = audioManifest.stories[storyId].voices || {};
    var chosen = voiceId && voices[voiceId] ? voiceId : Object.keys(voices)[0];
    return chosen ? Object.assign({ voiceId: chosen }, voices[chosen]) : null;
  }

  function formatAudioTime(sec) {
    var total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    var mins = Math.floor(total / 60);
    var rem = total % 60;
    return mins + ':' + (rem < 10 ? '0' : '') + rem;
  }

  function cueIndexForTime(cues, t) {
    if (!Array.isArray(cues) || !cues.length) return -1;
    var idx = -1;
    for (var i = 0; i < cues.length; i++) {
      if (t + 0.12 >= cues[i]) idx = i;
      else break;
    }
    return idx;
  }

  function applyPlaybackRate(rate) {
    if (!voiceAudio) return;
    voiceAudio.playbackRate = rate;
    if ('preservesPitch' in voiceAudio) voiceAudio.preservesPitch = true;
    if ('mozPreservesPitch' in voiceAudio) voiceAudio.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in voiceAudio) voiceAudio.webkitPreservesPitch = true;
  }

  function stopSpeech() {
    pendingSeek = null;
    if (voiceAudio) {
      try { voiceAudio.pause(); } catch (e) { /* ignore */ }
    }
    state.speaking = false;
    state.audioLoading = false;
    state.audioOpen = false;
    state.audioError = null;
    state.speakingIndex = -1;
    state.audioTime = 0;
  }

  function pauseStoryAudio() {
    if (voiceAudio) {
      try { voiceAudio.pause(); } catch (e) { /* ignore */ }
    }
    state.speaking = false;
    state.audioLoading = false;
    syncSpeakingDom();
  }

  function startSpeech(s, opts) {
    if (!s) return;
    opts = opts || {};
    var desiredVoice = opts.voice || state.readerPrefs.voice || 'ava';
    var track = audioTrackFor(s.id, desiredVoice);
    state.audioOpen = true;
    state.audioError = null;
    if (!voiceAudio || !track) {
      state.speaking = false;
      state.audioLoading = false;
      state.audioError = audioManifestLoaded
        ? 'Natural voice narration isn’t available for this archived story yet.'
        : 'Loading natural voice narration…';
      render();
      return;
    }
    var url = 'assets/audio/' + track.file + (track.hash ? '?v=' + encodeURIComponent(track.hash) : '');
    var sameTrack = state.audioStoryId === s.id && state.audioVoice === track.voiceId && voiceAudio.src && voiceAudio.src.indexOf(track.file) !== -1;
    state.audioStoryId = s.id;
    state.audioVoice = track.voiceId;
    state.audioDuration = track.duration || 0;
    if (!sameTrack) {
      state.audioLoading = true;
      state.audioTime = typeof opts.seekTo === 'number' ? opts.seekTo : 0;
      pendingSeek = typeof opts.seekTo === 'number' ? opts.seekTo : null;
      voiceAudio.src = url;
      voiceAudio.load();
    } else if (typeof opts.seekTo === 'number') {
      try { voiceAudio.currentTime = Math.max(0, Math.min(voiceAudio.duration || track.duration || 0, opts.seekTo)); } catch (e) { /* ignore */ }
      state.audioTime = voiceAudio.currentTime || 0;
    }
    applyPlaybackRate(state.speechRate);
    if (opts.autoplay !== false) {
      var p = voiceAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () {
          state.speaking = false;
          state.audioLoading = false;
          syncSpeakingDom();
        });
      }
    }
    render();
    syncSpeakingDom();
  }

  if (voiceAudio) {
    voiceAudio.preload = 'metadata';
    voiceAudio.addEventListener('loadedmetadata', function () {
      if (Number.isFinite(voiceAudio.duration) && voiceAudio.duration > 0) {
        state.audioDuration = voiceAudio.duration;
      }
      if (pendingSeek !== null) {
        try {
          voiceAudio.currentTime = Math.max(0, Math.min(state.audioDuration || pendingSeek, pendingSeek));
        } catch (e) { /* ignore */ }
        pendingSeek = null;
      }
      applyPlaybackRate(state.speechRate);
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('waiting', function () {
      state.audioLoading = true;
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('canplay', function () {
      state.audioLoading = false;
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('play', function () {
      state.speaking = true;
      state.audioLoading = false;
      state.audioError = null;
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('pause', function () {
      state.speaking = false;
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('timeupdate', function () {
      state.audioTime = voiceAudio.currentTime || 0;
      if (Number.isFinite(voiceAudio.duration) && voiceAudio.duration > 0) {
        state.audioDuration = voiceAudio.duration;
      }
      var track = state.audioStoryId ? audioTrackFor(state.audioStoryId, state.audioVoice) : null;
      state.speakingIndex = track ? cueIndexForTime(track.cues, state.audioTime) : -1;
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('ended', function () {
      state.speaking = false;
      state.speakingIndex = -1;
      state.audioTime = 0;
      try { voiceAudio.currentTime = 0; } catch (e) { /* ignore */ }
      syncSpeakingDom();
    });
    voiceAudio.addEventListener('error', function () {
      state.speaking = false;
      state.audioLoading = false;
      state.audioError = 'Could not load audio right now. Try again in a moment.';
      if (state.reading && state.audioOpen) render();
    });
  }

  function changeStory(id, source) {
    stopSpeech();
    state.publisherArticle = null;
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
    var publisher = params.get('publisher');
    var articleUrl = safeExternalUrl(params.get('article'));
    state.publisherArticle = publisher && articleUrl ? {
      name: publisher, url: articleUrl, title: params.get('title') || '',
      summary: params.get('excerpt') || '', published: params.get('published') || ''
    } : null;
    if (publisher) { state.view = 'papers'; state.paper = publisher; }
    state.reading = byId[id] ? id : null;
    if (state.reading && !publisher) state.view = 'briefing';
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
    var flagged = (D.QUESTIONABLE || []).concat(EXCLUDED_FROM_LEANING).indexOf(name) !== -1;
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

  function clockParts(zone, now) {
    if (!clockPartsFormats[zone]) clockPartsFormats[zone] = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    return clockPartsFormats[zone].formatToParts(now || new Date()).reduce(function (parts, item) {
      if (item.type === 'hour' || item.type === 'minute' || item.type === 'second') parts[item.type] = Number(item.value);
      return parts;
    }, {});
  }

  function clockAngle(parts, hand) {
    if (hand === 'hour') return ((parts.hour % 12) + parts.minute / 60) * 30;
    if (hand === 'minute') return (parts.minute + parts.second / 60) * 6;
    return parts.second * 6;
  }

  function renderAnalogClock(city, zone) {
    var parts = clockParts(zone);
    return '<div class="world-clock" data-analog-clock-zone="' + zone + '">' +
      '<span class="world-clock-face" role="img" aria-label="' + esc(city + ' local time, ' + clockText(zone)) + '">' +
      '<span class="world-clock-hand world-clock-hour" data-clock-hand="hour" style="--hand-angle:' + clockAngle(parts, 'hour') + 'deg"></span>' +
      '<span class="world-clock-hand world-clock-minute" data-clock-hand="minute" style="--hand-angle:' + clockAngle(parts, 'minute') + 'deg"></span>' +
      '<span class="world-clock-hand world-clock-second" data-clock-hand="second" style="--hand-angle:' + clockAngle(parts, 'second') + 'deg"></span>' +
      '<span class="world-clock-pin"></span></span>' +
      '<span class="world-clock-copy"><span class="world-clock-city">' + esc(city) + '</span>' +
      '<time class="world-clock-time" data-clock-zone="' + zone + '">' + clockText(zone) + '</time></span></div>';
  }

  function renderWorldClocks() {
    if (!state.headerPrefs.showClock) return '';
    return '<div class="world-clock-strip" aria-label="World clocks">' +
      renderAnalogClock('London', 'Europe/London') +
      renderAnalogClock('New York', 'America/New_York') +
      renderAnalogClock('Shanghai', 'Asia/Shanghai') + '</div>';
  }

  function renderClock(zone, label) {
    return '<time class="header-clock" data-clock-zone="' + zone + '" aria-label="' + esc(label) + '">' + clockText(zone) + '</time>';
  }

  function updateClocks() {
    var now = new Date();
    app.querySelectorAll('[data-clock-zone]').forEach(function (el) { el.textContent = clockFormats[el.getAttribute('data-clock-zone')] ? clockFormats[el.getAttribute('data-clock-zone')].format(now) : clockText(el.getAttribute('data-clock-zone')); });
    app.querySelectorAll('[data-analog-clock-zone]').forEach(function (clock) {
      var zone = clock.getAttribute('data-analog-clock-zone'), parts = clockParts(zone, now);
      clock.querySelectorAll('[data-clock-hand]').forEach(function (hand) {
        hand.style.setProperty('--hand-angle', clockAngle(parts, hand.getAttribute('data-clock-hand')) + 'deg');
      });
      var face = clock.querySelector('.world-clock-face');
      if (face) face.setAttribute('aria-label', clock.querySelector('.world-clock-city').textContent + ' local time, ' + clockText(zone));
    });
  }

  function marketNumber(value) { return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function marketDate(date, long) { return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' }); }
  function marketPoints(id) { return marketData && marketData.markets[id] ? marketData.markets[id].points : []; }
  function marketChange(points) {
    var change = points.length > 1 ? (points[points.length - 1].close / points[points.length - 2].close - 1) * 100 : 0;
    return '<span class="market-change ' + (change >= 0 ? 'market-up' : 'market-down') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>';
  }
  function chartGeometry(points, width, height, inset) {
    var values = points.map(function (p) { return p.close; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var padding = (max - min) * .1 || max * .01;
    min -= padding; max += padding;
    var coords = points.map(function (p, i) {
      return { x: inset.left + i / Math.max(1, points.length - 1) * (width - inset.left - inset.right), y: inset.top + (max - p.close) / (max - min) * (height - inset.top - inset.bottom) };
    });
    var line = coords.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(' ');
    var baseline = height - inset.bottom;
    return { coords: coords, min: min, max: max, line: line, area: line + ' L' + coords[coords.length - 1].x.toFixed(2) + ',' + baseline + ' L' + coords[0].x.toFixed(2) + ',' + baseline + ' Z' };
  }

  function renderSparkline(points) {
    var sample = points.slice(-30);
    if (sample.length < 2) return '';
    var geometry = chartGeometry(sample, 240, 48, { left: 2, right: 2, top: 3, bottom: 3 });
    return '<svg class="market-sparkline" viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true"><path d="' + geometry.area + '" fill="currentColor" opacity=".06"></path><path d="' + geometry.line + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"></path></svg>';
  }

  function displayedMarketPoints() {
    var points = marketPoints(state.marketOpen);
    if (!points.length) return points;
    var days = { '1M': 30, '3M': 90, '6M': 180, '1Y': 366 }[state.marketRange] || 180;
    var cutoff = new Date(points[points.length - 1].date + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    var date = cutoff.toISOString().slice(0, 10);
    return points.filter(function (p) { return p.date >= date; });
  }

  function renderMarketDialog() {
    if (!state.marketOpen) return '';
    var market = MARKETS.find(function (m) { return m.id === state.marketOpen; });
    var points = displayedMarketPoints();
    var allPoints = marketPoints(market.id);
    var chart = '';
    if (points.length > 1) {
      var geometry = chartGeometry(points, 1000, 380, { left: 110, right: 24, top: 20, bottom: 40 });
      var grid = [0, 1, 2, 3, 4].map(function (n) {
        var y = 20 + n * 80;
        var value = geometry.max - n / 4 * (geometry.max - geometry.min);
        return '<line x1="110" x2="976" y1="' + y + '" y2="' + y + '" class="market-gridline"></line><text x="98" y="' + (y + 5) + '" text-anchor="end" class="market-axis">' + marketNumber(value) + '</text>';
      }).join('');
      var axis = [0, Math.floor((points.length - 1) / 2), points.length - 1].map(function (i, n) {
        return '<text x="' + geometry.coords[i].x + '" y="372" text-anchor="' + (n === 0 ? 'start' : n === 2 ? 'end' : 'middle') + '" class="market-axis">' + marketDate(points[i].date) + '</text>';
      }).join('');
      var hovered = state.marketHover === null ? points.length - 1 : Math.max(0, Math.min(points.length - 1, state.marketHover));
      var selected = points[hovered], pos = geometry.coords[hovered];
      chart = '<div class="market-readout" id="market-readout" aria-live="polite">' + marketDate(selected.date, true) + ' · ' + marketNumber(selected.close) + ' points</div>' +
        '<div class="market-plot" tabindex="0" role="group" aria-label="Interactive ' + esc(market.index) + ' chart. Use left and right arrow keys to explore daily values."><svg viewBox="0 0 1000 380" preserveAspectRatio="none" role="img" aria-label="Daily ' + esc(market.index) + ' values from ' + marketDate(points[0].date, true) + ' to ' + marketDate(points[points.length - 1].date, true) + '">' +
        '<defs><linearGradient id="market-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#7961C8" stop-opacity=".22"></stop><stop offset="100%" stop-color="#7961C8" stop-opacity="0"></stop></linearGradient></defs>' + grid +
        '<path d="' + geometry.area + '" fill="url(#market-area)"></path><path d="' + geometry.line + '" fill="none" stroke="#7961C8" stroke-width="2.5" vector-effect="non-scaling-stroke"></path>' +
        '<line id="market-crosshair" x1="' + pos.x + '" x2="' + pos.x + '" y1="20" y2="340" class="market-crosshair"></line><circle id="market-point" cx="' + pos.x + '" cy="' + pos.y + '" r="5" fill="#7961C8" stroke="white" stroke-width="2"></circle>' + axis + '</svg></div><div class="market-mobile-dates"><span>' + marketDate(points[0].date) + '</span><span>' + marketDate(points[points.length - 1].date) + '</span></div>' +
        '<p class="market-chart-hint">Move across the chart, or focus it and use the arrow keys, to explore daily values.</p>';
    } else {
      chart = '<div class="market-chart-empty">' + (marketLoadFailed ? 'Market data is temporarily unavailable.' : 'Loading daily market data…') + '<button class="outline-sm" data-act="retrymarkets">Retry</button></div>';
    }
    return '<div class="market-backdrop" data-act="closemarket"></div><section class="market-dialog" role="dialog" aria-modal="true" aria-labelledby="market-dialog-title" id="market-dialog" tabindex="-1"><header class="market-dialog-head"><div><p>' + market.city + '</p><h2 id="market-dialog-title">' + esc(market.index) + '</h2></div><button class="search-toggle" data-act="closemarket" aria-label="Close market chart">' + ICON.close + '</button></header>' +
      '<div class="market-dialog-body"><div class="market-dialog-summary">' + (allPoints.length ? '<strong>' + marketNumber(allPoints[allPoints.length - 1].close) + '<small> points</small></strong>' + marketChange(allPoints) + '<span>Latest daily close · ' + marketDate(allPoints[allPoints.length - 1].date, true) + '</span>' : '') + '</div><div class="market-range" role="group" aria-label="Chart date range">' +
      ['1M', '3M', '6M', '1Y'].map(function (range) { return '<button id="market-range-' + range + '" data-act="marketrange" data-id="' + range + '" aria-pressed="' + (state.marketRange === range) + '">' + range + '</button>'; }).join('') + '</div>' + chart +
      '<p class="market-source">Completed daily sessions · Source: <a href="' + market.url + '" target="_blank" rel="noopener noreferrer">Yahoo Finance</a>. Daily change compares the latest two closes. Refreshed automatically; this is not a live feed.</p></div></section>';
  }

  function setMarketHover(index) {
    var points = displayedMarketPoints();
    if (points.length < 2) return;
    index = Math.max(0, Math.min(points.length - 1, index));
    if (state.marketHover === index) return;
    state.marketHover = index;
    var geometry = chartGeometry(points, 1000, 380, { left: 110, right: 24, top: 20, bottom: 40 });
    var pos = geometry.coords[index];
    var line = document.getElementById('market-crosshair'), dot = document.getElementById('market-point');
    if (line) { line.setAttribute('x1', pos.x); line.setAttribute('x2', pos.x); }
    if (dot) { dot.setAttribute('cx', pos.x); dot.setAttribute('cy', pos.y); }
    var readout = document.getElementById('market-readout');
    if (readout) readout.textContent = marketDate(points[index].date, true) + ' · ' + marketNumber(points[index].close) + ' points';
  }

  function loadMarketData() {
    marketLoadFailed = false;
    var buildMeta = document.querySelector('meta[name="daybreak-build"]');
    var buildId = buildMeta && buildMeta.getAttribute('content');
    var url = 'assets/markets.json' + (buildId && buildId !== 'dev' ? '?v=' + encodeURIComponent(buildId) : '');
    fetch(url, { cache: 'no-cache' }).then(function (response) {
      if (!response.ok) throw new Error('Market data request failed');
      return response.json();
    }).then(function (data) {
      if (!data || !data.markets) throw new Error('Invalid market data');
      ['london', 'newyork', 'shanghai'].forEach(function (id) {
        var series = data.markets[id] && data.markets[id].points;
        if (!Array.isArray(series) || series.length < 2 || !series.every(function (p, i) {
          return /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.close) && p.close > 0 && (!i || p.date > series[i - 1].date);
        })) throw new Error('Invalid market series');
      });
      if (data.markets.india && (!Array.isArray(data.markets.india.points) ||
          data.markets.india.points.length < 2 ||
          !data.markets.india.points.every(function (p, i, a) {
            return /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.close) && p.close > 0 &&
              (!i || p.date > a[i - 1].date);
          }))) throw new Error('Invalid NIFTY 50 series');
      marketData = data;
      render();
    }).catch(function () { marketLoadFailed = true; render(); });
  }

  function renderMarkets() {
    var selected = MARKETS.filter(function (m) { return state.headerPrefs.markets.indexOf(m.id) !== -1; });
    if (!selected.length) return '<section class="market-strip market-empty" aria-label="Stock market widgets"><p class="notice">No exchanges selected. <button data-act="settings">Choose exchanges in Settings</button></p></section>';
    var key = selected.map(function (m) { return m.id; }).join(',') + ':' + state.headerPrefs.showClock + ':' + (marketData ? marketData.updatedAt : marketLoadFailed ? 'unavailable' : 'loading');
    var existing = document.getElementById('market-widgets');
    if (existing && existing.getAttribute('data-markets') === key) return '<div id="market-widgets" data-markets="' + key + '"></div>';
    return '<section id="market-widgets" class="market-strip" aria-label="Stock market widgets" data-markets="' + key + '">' +
      '<div class="market-grid">' + selected.map(function (m) {
        var points = marketPoints(m.id);
        var last = points[points.length - 1];
        return '<button id="market-card-' + m.id + '" class="market-widget native-market" data-act="openmarket" data-id="' + m.id + '" aria-label="Open ' + esc(m.index) + ' interactive chart"><span class="market-heading"><span class="market-city">' + m.city + '<span>' + esc(m.index) + '</span></span>' +
          (state.headerPrefs.showClock ? renderClock(m.zone, m.city + ' time') : '') + '</span>' +
          (last ? '<span class="market-quote"><strong>' + marketNumber(last.close) + '</strong>' + marketChange(points) + '</span>' + renderSparkline(points) + '<span class="market-card-foot">' + marketDate(last.date) + ' · Daily close <span>Explore chart</span></span>' : '<span class="market-pending">' + (marketLoadFailed ? 'Data unavailable · Click to retry' : 'Loading market data…') + '</span>') + '</button>';
      }).join('') + '</div><p class="market-note">Daily index closes · Select a market to explore its chart. <button data-act="settings">Customise widgets</button></p></section>';
  }

  function renderHeaderMenu(id, label) {
    var open = state.utilityOpen === id;
    return '<div class="header-menu"><button id="menu-toggle-' + id + '" class="tab tab-subtle menu-toggle' + (open ? ' on' : '') + '" data-act="headermenu" data-id="' + id + '" aria-expanded="' + open + '" aria-controls="menu-' + id + '">' + label + '<span aria-hidden="true">⌄</span></button>' +
      (open ? '<section id="menu-' + id + '" class="header-dropdown" role="dialog" aria-labelledby="menu-title-' + id + '" tabindex="-1">' + renderHeaderMenuContent(id) + '</section>' : '') + '</div>';
  }

  function navIcon(path) {
    return '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"></path></svg>';
  }

  function renderSidebar() {
    var home = state.view === 'briefing' && state.topic === 'all';
    var savedCount = STORIES.filter(function (s) { return state.saved[s.id]; }).length;
    var topicFilters = [{ id: 'all', label: 'All' }].concat(D.TOPICS).map(function (topic) {
      var count = topic.id === 'all' ? CURRENT.length : CURRENT.filter(function (story) { return story.topic === topic.id; }).length;
      var on = state.view === 'briefing' && state.topic === topic.id;
      return '<button class="sidebar-topic' + (on ? ' active' : '') + '" data-act="topic" data-id="' + esc(topic.id) + '" aria-pressed="' + on + '"><span>' + esc(topic.label) + '</span><span class="sidebar-topic-count">' + count + '</span></button>';
    }).join('');
    return '<aside class="dashboard-sidebar" aria-label="Main navigation"><button class="sidebar-brand" data-act="home" aria-label="Pheme home"><img src="assets/images/pheme-logo.png" width="56" height="56" alt=""></button>' +
      '<nav class="sidebar-nav" aria-label="Main"><button class="sidebar-link' + (home ? ' active' : '') + '" data-act="home"' + (home ? ' aria-current="page"' : '') + '>' + navIcon('M3 10 12 3l9 7v11h-6v-7H9v7H3z') + 'Home</button>' +
      '<button class="sidebar-link' + (state.view === 'papers' ? ' active' : '') + '" data-act="view" data-view="papers">' + navIcon('M4 3h16v18H4zM8 7h8M8 11h8M8 15h3m3 0h2') + 'Newspapers</button>' +
      '<button class="sidebar-link' + (state.view === 'saved' ? ' active' : '') + '" data-act="view" data-view="saved">' + ICON.bookmarkLg + 'Saved stories' + (savedCount ? '<span class="sidebar-count">' + savedCount + '</span>' : '') + '</button>' +
      '<button class="sidebar-link' + (state.view === 'trading' ? ' active' : '') + '" data-act="view" data-view="trading"' + (state.view === 'trading' ? ' aria-current="page"' : '') + '>' + navIcon('M3 18h3l4-7 4 4 6-10m-1 0h1v1') + 'Trading</button></nav>' +
      '<nav class="sidebar-topic-nav" aria-label="Filter stories by topic"><span class="sidebar-topic-heading">Topics</span>' + topicFilters + '</nav></aside>';
  }

  function dashboardImage(s, cls) {
    var src = safeAsset(s.image);
    return src ? '<button class="dashboard-image ' + (cls || '') + '" data-act="open" data-id="' + esc(s.id) + '" aria-label="Open ' + esc(s.headline) + '"><img src="' + esc(src) + '" alt="' + esc(s.imageAlt || s.headline) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>' : '';
  }

  function renderChannels() {
    var names = ['BBC News', 'The Guardian', 'Sky News', 'Al Jazeera English', 'Financial Times', 'The Economist'];
    var available = followed();
    var marks = { 'BBC News': 'BBC', 'The Guardian': 'The Guardian', 'Sky News': 'sky news', 'Al Jazeera English': 'AJ', 'Financial Times': 'FT', 'The Economist': 'The Economist' };
    return '<section class="channel-section" aria-labelledby="channels-title"><div class="dashboard-section-head"><h1 id="channels-title">Explore newspapers</h1><button class="section-action" data-act="view" data-view="papers">View all</button></div><div class="channel-grid">' +
      names.filter(function (name) { return available.some(function (p) { return p.name === name; }); }).map(function (name, i) {
        return '<button class="channel-tile channel-' + i + '" data-act="paper" data-name="' + esc(name) + '"><span class="channel-mark" aria-hidden="true">' + marks[name] + '</span><span>' + esc(name) + '</span></button>';
      }).join('') + '</div></section>';
  }

  function renderQuickStory(s) {
    return '<article class="quick-story">' + dashboardImage(s, 'quick-image') + '<div class="quick-story-copy"><h3><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h3><div class="quick-meta"><span class="publisher-tag">' + esc(s.source) + '</span><span>' + esc(s.time) + '</span></div><div class="quick-story-tools"><span>' + esc(s.cov.count) + '</span>' + storyTools(s, true) + '</div></div></article>';
  }

  function renderDashboardCard(s) {
    return '<article class="news-card">' + dashboardImage(s) + '<div class="news-card-copy"><div class="news-card-meta"><span class="publisher-tag">' + esc(s.source) + '</span><span>' + esc(s.time) + '</span></div><h3><button class="storybtn" data-act="open" data-id="' + esc(s.id) + '">' + esc(s.headline) + '</button></h3><p>' + esc(s.summary) + '</p><div class="card-coverage">' + covBar(s.cov) + '<span>' + esc(s.cov.count) + '</span></div><div class="card-actions">' + compareLink(s, 'textlink', 'Compare coverage') + storyTools(s, true) + '</div></div></article>';
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
      '<div class="masthead-status"><div class="topbar-date">' + esc(displayDate()) + '</div>' + renderWorldClocks() + '</div>' +
      '<div class="topbar-actions">' +
      '<button class="search-toggle search-launch' + (state.searchOpen ? ' on' : '') + '" data-act="togglesearch" aria-label="Search stories" aria-expanded="' + state.searchOpen + '">' + ICON.search + '<span>Search anything…</span></button>' +
      '<span class="vsep" aria-hidden="true"></span>' +
      '<button class="nav-link' + (isSaved ? ' on' : '') + '" data-act="view" data-view="saved" aria-pressed="' + isSaved + '">Saved' +
      (savedCount ? '<span class="badge-count">' + savedCount + '</span>' : '') + '</button>' +
      '<button id="settings-toggle" class="nav-link settings-toggle" data-act="settings" aria-expanded="' + state.settingsOpen + '">Settings</button>' +
      '</div></header></div>' +
      '<nav class="topicbar" aria-label="Pheme navigation"><div class="wrap topicbar-inner">' +
      '<div class="topic-tabs">' + topicTabs + '</div>' +
      '<div class="topic-utility">' +
      renderHeaderMenu('digest', 'Digest') + renderHeaderMenu('coverage', 'Coverage') + renderHeaderMenu('newspapers', 'Newspapers') +
      '</div></div></nav>' + searchDrawer + '</div>';
  }

  /* ---------- Broadsheet Front Page / Topic / Saved ---------- */
  function renderLead(s) {
    var src = safeAsset(s.image);
    var alt = s.imageAlt || s.headline;
    var figure = src
      ? '<figure class="hero-figure"><button class="hero-figure-btn" data-act="open" data-id="' + esc(s.id) + '" aria-label="Open ' + esc(s.headline) + '">' +
        '<img src="' + esc(src) + '" alt="' + esc(alt) + '" loading="eager" decoding="async" referrerpolicy="no-referrer"></button></figure>'
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
      '<button class="map-region-btn" type="button" data-act="publishermapview">Explore publisher RSS map</button>' +
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

    var mapHtml = !isSaved && state.topic === 'world' ? renderWorldMap() : '';
    var overview = !isSaved && state.topic === 'all' && !state.query.trim();
    if (!overview) {
      if (!headerHtml) headerHtml = '<div class="page-head"><h1>' + esc(labelOf[state.topic] || 'Your briefing') + '</h1><p>' + esc(plural(list.length, 'story', 'stories')) + ' in this edition</p></div>';
      return headerHtml + mapHtml + '<section class="news-card-grid" aria-label="Stories">' + list.map(renderDashboardCard).join('') + '</section>';
    }
    var quick = list.slice(0, 6);
    var featured = [];
    list.slice(6).forEach(function (s) {
      if (featured.length < 3 && !featured.some(function (f) { return f.topic === s.topic; })) featured.push(s);
    });
    var displayed = quick.concat(featured).map(function (s) { return s.id; });
    var remaining = list.filter(function (s) { return displayed.indexOf(s.id) === -1; });
    return renderChannels() + '<section class="headline-section" aria-labelledby="headlines-title"><div class="dashboard-section-head"><h2 id="headlines-title">Latest edition headlines</h2><span>' + list.length + ' stories · ' + esc(D.META.range) + '</span></div><div class="quick-grid">' + quick.map(renderQuickStory).join('') + '</div></section>' +
      '<section class="featured-section" aria-labelledby="featured-title"><div class="dashboard-section-head"><h2 id="featured-title">Featured stories</h2><span>A view across the topics</span></div><div class="news-card-grid">' + featured.map(renderDashboardCard).join('') + '</div></section>' +
      (remaining.length ? '<section class="more-section" aria-labelledby="more-title"><div class="dashboard-section-head"><h2 id="more-title">More in your briefing</h2><span>' + remaining.length + ' more stories</span></div><div class="news-card-grid">' + remaining.map(renderDashboardCard).join('') + '</div></section>' : '');
  }

  var EXCHANGE_PLACES = [
    { name: 'London Stock Exchange', city: 'London', region: 'Europe', lat: 51.515, lng: -0.099, id: 'london' },
    { name: 'New York Stock Exchange', city: 'New York', region: 'North America', lat: 40.7069, lng: -74.0113, id: 'newyork' },
    { name: 'Nasdaq', city: 'New York', region: 'North America', lat: 40.756, lng: -73.986, id: 'newyork' },
    { name: 'Shanghai Stock Exchange', city: 'Shanghai', region: 'Asia', lat: 31.23, lng: 121.474, id: 'shanghai' },
    { name: 'Tokyo Stock Exchange', city: 'Tokyo', region: 'Asia', lat: 35.681, lng: 139.774 },
    { name: 'Hong Kong Exchanges', city: 'Hong Kong', region: 'Asia', lat: 22.285, lng: 114.158 },
    { name: 'Deutsche Börse', city: 'Frankfurt', region: 'Europe', lat: 50.1155, lng: 8.677 },
    { name: 'Euronext Paris', city: 'Paris', region: 'Europe', lat: 48.872, lng: 2.341 },
    { name: 'National Stock Exchange of India', city: 'Mumbai', region: 'Asia', lat: 19.06, lng: 72.859, id: 'india' },
    { name: 'Australian Securities Exchange', city: 'Sydney', region: 'Oceania', lat: -33.868, lng: 151.209 },
    { name: 'B3', city: 'São Paulo', region: 'South America', lat: -23.546, lng: -46.634 },
    { name: 'Johannesburg Stock Exchange', city: 'Johannesburg', region: 'Africa', lat: -26.107, lng: 28.055 }
  ];
  var MARKET_COMPANIES = [
    { name: 'Apple', keys: ['apple','aapl','iphone','ipad'] },
    { name: 'Microsoft', keys: ['microsoft','msft','azure'] },
    { name: 'Nvidia', keys: ['nvidia','nvda'] },
    { name: 'Tesla', keys: ['tesla','tsla'] },
    { name: 'Alphabet', keys: ['alphabet','google','googl'] },
    { name: 'Amazon', keys: ['amazon','amzn','aws'] }
  ];

  function terminalPoints(marketId) {
    var points = marketPoints(marketId);
    if (!points.length) return points;
    var days = { '1M': 30, '3M': 90, '6M': 180, '1Y': 366 }[state.marketRange] || 180;
    var cutoff = new Date(points[points.length - 1].date + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    return points.filter(function (p) { return p.date >= cutoff.toISOString().slice(0, 10); });
  }

  function terminalChart() {
    var market = MARKETS.find(function (m) { return m.id === state.tradingMarket; }) || MARKETS[0];
    var series = terminalPoints(market.id);
    if (series.length < 2) return '<div class="terminal-chart-empty">Daily prices unavailable. No live quote is being displayed.</div>';
    var g = chartGeometry(series, 960, 360, { left: 82, right: 22, top: 20, bottom: 40 });
    var lines = [0,1,2,3,4].map(function (i) {
      var y = 20 + i * 75;
      return '<line x1="82" x2="938" y1="' + y + '" y2="' + y + '" class="terminal-gridline"></line>' +
        '<text x="72" y="' + (y + 4) + '" text-anchor="end" class="terminal-chart-label">' +
        marketNumber(g.max - i / 4 * (g.max - g.min)) + '</text>';
    }).join('');
    var last = series[series.length - 1];
    return '<div class="terminal-chart-head"><div><span class="terminal-eyebrow">' + esc(market.city) + ' · Latest completed close</span>' +
      '<strong>' + marketNumber(last.close) + '</strong>' + marketChange(marketPoints(market.id)) + '</div>' +
      '<span>As of ' + marketDate(last.date, true) + '</span></div>' +
      '<div class="terminal-chart-scroll"><svg viewBox="0 0 960 360" role="img" aria-label="' + esc(market.index) +
      ' daily closing prices between ' + esc(marketDate(series[0].date)) + ' and ' + esc(marketDate(last.date)) + '">' +
      lines + '<path d="' + g.area + '" class="terminal-chart-fill"></path>' +
      '<path d="' + g.line + '" class="terminal-chart-stroke"></path>' +
      '<text class="terminal-chart-label" x="82" y="348" text-anchor="start">' + esc(marketDate(series[0].date)) + '</text>' +
      '<text class="terminal-chart-label" x="938" y="348" text-anchor="end">' + esc(marketDate(last.date)) + '</text></svg></div>' +
      '<div class="terminal-chart-summary">Range high <strong>' + marketNumber(Math.max.apply(null, series.map(function (p) { return p.close; }))) +
      '</strong> · Range low <strong>' + marketNumber(Math.min.apply(null, series.map(function (p) { return p.close; }))) + '</strong></div>';
  }

  function marketNewsItems() {
    var result = [], seen = Object.create(null);
    var chosen = MARKET_COMPANIES.find(function (c) { return c.name === state.marketNewsFocus; });
    var watchKeys = state.marketNewsFocus === 'watchlist'
      ? MARKET_COMPANIES.filter(function (c) { return state.marketWatch.indexOf(c.name) !== -1; })
        .reduce(function (acc, c) { return acc.concat(c.keys); }, [])
      : null;
    if (publisherFeed && publisherFeed.publishers) {
      Object.keys(publisherFeed.publishers).forEach(function (publisher) {
        var data = publisherFeed.publishers[publisher];
        (data && data.articles || []).forEach(function (article) {
          if (!article || !safeExternalUrl(article.url)) return;
          var text = (article.title || '') + ' ' + (article.summary || '');
          if (chosen ? !chosen.keys.some(function (k) { return new RegExp('\\b' + k + '\\b','i').test(text); }) :
            watchKeys ? !watchKeys.some(function (k) { return new RegExp('\\b' + k + '\\b','i').test(text); }) :
            article.topic !== 'finance' && article.topic !== 'business' && !/stock|equities|earnings|inflation|central bank|interest rate|shares|economy|markets/i.test(article.title || '')) return;
          var key = article.url.split('?')[0];
          if (seen[key]) return;
          seen[key] = true;
          result.push({ publisher: publisher, article: article });
        });
      });
    }
    return result.sort(function (a, b) { return String(b.article.published || '').localeCompare(String(a.article.published || '')); }).slice(0, 24);
  }

  function marketNewsHtml() {
    var news = marketNewsItems();
    if (!publisherFeed) return '<p class="notice">' + (publisherFeedError ? 'Publisher news temporarily unavailable.' : 'Loading publisher market headlines…') + '</p>';
    if (!news.length) return '<p class="notice">No recent matching original headlines in the available publisher feeds.</p>';
    return '<div class="market-news-list">' + news.map(function (item) {
      var a = item.article, url = safeExternalUrl(a.url), img = safeAsset(a.image);
      return '<article class="market-news-item">' +
        (img ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="market-news-image"><img src="' + esc(img) + '" loading="lazy" decoding="async" alt=""></a>' : '') +
        '<div class="market-news-copy"><span>' + esc(item.publisher) + ' · ' + esc(articlePublishedLabel(a.published)) + '</span>' +
        '<h3><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a></h3>' +
        (a.summary ? '<p>' + esc(a.summary) + '</p>' : '') + '</div></article>';
    }).join('') + '</div>';
  }


  var companyMarketData = null;
  var companyMarketLoadError = false;

  function renderCompanyQuotes() {
    if (!companyMarketData) return '<p class="terminal-provider-notice">' +
      (companyMarketLoadError ? 'Company data unavailable.' : 'Checking company data connection…') + '</p>';
    var data = companyMarketData;
    var licensed = data.status === 'available';
    var tickerMap = { Apple: 'AAPL', Microsoft: 'MSFT', Nvidia: 'NVDA', Tesla: 'TSLA', Alphabet: 'GOOGL', Amazon: 'AMZN' };
    var cards = MARKET_COMPANIES.map(function (company) {
      var ticker = tickerMap[company.name], quote = licensed && data.quotes[ticker];
      var profile = licensed && data.profiles && data.profiles[ticker];
      var valid = quote && Number.isFinite(quote.price) && quote.price > 0;
      var age = valid && quote.collectedAt ? Date.now() - Date.parse(quote.collectedAt) : NaN;
      var freshness = !Number.isFinite(age) || age < 0 ? 'Time unknown' :
        age > 30 * 60 * 1000 ? 'Stale snapshot' : 'Recent snapshot';
      return '<article class="company-quote-card"><div class="company-quote-heading"><strong>' +
        esc(ticker) + '</strong><span>' + esc(company.name) + '</span></div>' +
        (valid ? '<div class="company-quote-price">' + (quote.currency === 'USD' ? 'USD ' : '') +
          marketNumber(quote.price) + (quote.currency !== 'USD' ? ' ' + esc(quote.currency || '') : '') +
          '</div><div class="company-quote-meta">' + esc(freshness) + ' · ' +
          esc(quote.quoteTime || 'Quote time unknown') + '</div>' +
          (Number.isFinite(quote.changePercent) ? '<div class="company-quote-change">' +
            (quote.changePercent >= 0 ? '+' : '') + quote.changePercent.toFixed(2) + '% reported change</div>' : '') :
          '<div class="company-quote-empty">No public quote</div>') +
        (profile && profile.sector ? '<span class="company-quote-sector">' + esc(profile.sector) + '</span>' : '') +
        '</article>';
    }).join('');
    return '<p class="terminal-provider-notice">' +
      (licensed ? 'Licensed vendor snapshots. These are not streaming live prices.' :
        'Company quotes not enabled. Credentials and public-display rights must be configured.') +
      '</p><div class="company-quote-grid">' + cards + '</div>' +
      '<p class="terminal-disclaimer">Quotes: Twelve Data; optional profiles: Financial Modeling Prep. Snapshots may be delayed.</p>';
  }

  function loadCompanyMarketData() {
    fetch('assets/company-market-data.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Company market data request failed');
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.status || !data.quotes) throw new Error('Invalid company market data');
        companyMarketData = data;
        companyMarketLoadError = false;
      })
      .catch(function () { companyMarketLoadError = true; })
      .finally(function () {
        var el = app.querySelector('#company-market-panel-content');
        if (el) el.innerHTML = renderCompanyQuotes();
      });
  }

  /* Market workspace: self-contained panels, no endless vertical document. */
  var MARKET_DIRECTORY = [
    ['AAPL','Apple','NASDAQ','Technology','apple iphone ipad'],
    ['MSFT','Microsoft','NASDAQ','Technology','microsoft azure windows'],
    ['NVDA','Nvidia','NASDAQ','Semiconductors','nvidia ai chips'],
    ['TSLA','Tesla','NASDAQ','Automotive','tesla electric vehicles'],
    ['GOOGL','Alphabet','NASDAQ','Communication services','google alphabet youtube'],
    ['AMZN','Amazon','NASDAQ','Consumer & cloud','amazon aws'],
    ['META','Meta Platforms','NASDAQ','Communication services','meta facebook instagram'],
    ['AMD','Advanced Micro Devices','NASDAQ','Semiconductors','amd'],
    ['INTC','Intel','NASDAQ','Semiconductors','intel'],
    ['AVGO','Broadcom','NASDAQ','Semiconductors','broadcom'],
    ['NFLX','Netflix','NASDAQ','Entertainment','netflix'],
    ['ORCL','Oracle','NYSE','Enterprise software','oracle'],
    ['IBM','IBM','NYSE','Technology','ibm'],
    ['CRM','Salesforce','NYSE','Enterprise software','salesforce'],
    ['PLTR','Palantir','NASDAQ','Software','palantir'],
    ['JPM','JPMorgan Chase','NYSE','Banking','jpmorgan chase'],
    ['BAC','Bank of America','NYSE','Banking','bank of america'],
    ['GS','Goldman Sachs','NYSE','Banking','goldman sachs'],
    ['V','Visa','NYSE','Payments','visa'],
    ['MA','Mastercard','NYSE','Payments','mastercard'],
    ['BRK.B','Berkshire Hathaway','NYSE','Conglomerate','berkshire buffett'],
    ['WMT','Walmart','NYSE','Retail','walmart'],
    ['COST','Costco','NASDAQ','Retail','costco'],
    ['DIS','Walt Disney','NYSE','Entertainment','disney'],
    ['KO','Coca-Cola','NYSE','Consumer goods','coca cola'],
    ['PEP','PepsiCo','NASDAQ','Consumer goods','pepsico pepsi'],
    ['XOM','Exxon Mobil','NYSE','Energy','exxon'],
    ['CVX','Chevron','NYSE','Energy','chevron'],
    ['BA','Boeing','NYSE','Aerospace','boeing'],
    ['GE','GE Aerospace','NYSE','Aerospace','ge aerospace'],
    ['NKE','Nike','NYSE','Consumer goods','nike'],
    ['UBER','Uber','NYSE','Transport','uber'],
    ['SHOP','Shopify','NASDAQ','E-commerce','shopify'],
    ['PFE','Pfizer','NYSE','Pharmaceuticals','pfizer'],
    ['LLY','Eli Lilly','NYSE','Pharmaceuticals','eli lilly'],
    ['JNJ','Johnson & Johnson','NYSE','Healthcare','johnson johnson'],
    ['NVO','Novo Nordisk','NYSE','Pharmaceuticals','novo nordisk'],
    ['TSM','Taiwan Semiconductor','NYSE','Semiconductors','tsmc taiwan semiconductor'],
    ['BABA','Alibaba','NYSE','E-commerce','alibaba'],
    ['PDD','PDD Holdings','NASDAQ','E-commerce','pinduoduo temu'],
    ['BIDU','Baidu','NASDAQ','Technology','baidu'],
    ['ASML','ASML Holding','NASDAQ','Semiconductor equipment','asml'],
    ['SAP','SAP','NYSE','Enterprise software','sap'],
    ['ARM','Arm Holdings','NASDAQ','Semiconductors','arm holdings'],
    ['COIN','Coinbase','NASDAQ','Financial technology','coinbase'],
    ['HOOD','Robinhood','NASDAQ','Financial technology','robinhood'],
    ['PYPL','PayPal','NASDAQ','Payments','paypal']
  ].map(function (v) {
    return { ticker:v[0], name:v[1], exchange:v[2], sector:v[3],
      search:(v[0] + ' ' + v[1] + ' ' + v[4]).toLowerCase(), tv:v[2] + ':' + v[0] };
  });

  var companyDirectoryState = 'idle';

  function loadCompanyDirectory() {
    if (companyDirectoryState !== 'idle') return;
    companyDirectoryState = 'loading';
    fetch('assets/companies.json' + buildCacheSuffix(), { cache: 'default' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('Company directory unavailable');
        return resp.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.companies)) throw new Error('Invalid company directory');
        var seen = Object.create(null);
        MARKET_DIRECTORY.forEach(function (c) { seen[c.tv] = true; });
        data.companies.forEach(function (v) {
          if (!Array.isArray(v) || v.length < 5) return;
          var tv = String(v[4]);
          if (seen[tv]) return;
          seen[tv] = true;
          MARKET_DIRECTORY.push({
            ticker: String(v[0]),
            name: String(v[1]),
            exchange: String(v[2]),
            sector: String(v[3]),
            search: (v[0] + ' ' + v[1] + ' ' + v[2] + ' ' + v[3]).toLowerCase(),
            tv: tv
          });
        });
        companyDirectoryState = 'ready';
        if (state.view === 'trading') {
          var drop = app.querySelector('#ws-search-results');
          if (drop && !drop.hidden) drop.innerHTML = marketSearchResultsHtml();
          var wl = app.querySelector('#ws-watchlist-content');
          if (wl) wl.innerHTML = marketWorkspaceWatchlist();
        }
      })
      .catch(function () { companyDirectoryState = 'error'; });
  }

  function findMarketCompany(id) {
    if (!id) return null;
    return MARKET_DIRECTORY.find(function (c) { return c.tv === id || c.ticker === id; }) || null;
  }

  function ensureCustomCompany(rawQuery) {
    var clean = String(rawQuery || '').trim().toUpperCase();
    if (!clean || clean.length > 24 || !/^[A-Z0-9._:-]+$/.test(clean)) return null;
    var existing = findMarketCompany(clean);
    if (existing) return existing;
    var parts = clean.indexOf(':') !== -1 ? clean.split(':') : ['', clean];
    var exchange = parts[0] || 'NASDAQ';
    var ticker = parts[1] || clean;
    if (!ticker || !/^[A-Z0-9.-]+$/.test(ticker)) return null;
    var tv = parts[0] ? (exchange + ':' + ticker) : ticker;
    var entry = {
      ticker: ticker,
      name: ticker,
      exchange: parts[0] || 'Global',
      sector: 'Custom symbol',
      search: (ticker + ' ' + exchange + ' ' + tv).toLowerCase(),
      tv: tv
    };
    MARKET_DIRECTORY.push(entry);
    return entry;
  }

  function selectedMarketCompany() {
    return findMarketCompany(state.marketSelectedCompany) || ensureCustomCompany(state.marketSelectedCompany) || MARKET_DIRECTORY[0];
  }

  function searchMarketCompanies(query, limit) {
    var raw = (query || '').trim().toLowerCase();
    if (!raw) return MARKET_DIRECTORY.slice(0, limit || 10);
    var tokens = raw.split(/\s+/).filter(Boolean);
    var rawSym = raw.replace(/\s+/g, '');
    var scored = [];
    for (var i = 0; i < MARKET_DIRECTORY.length; i++) {
      var c = MARKET_DIRECTORY[i];
      var ok = true;
      for (var t = 0; t < tokens.length; t++) {
        if (c.search.indexOf(tokens[t]) === -1) { ok = false; break; }
      }
      if (!ok) continue;
      var tl = c.ticker.toLowerCase();
      var nl = c.name.toLowerCase();
      var tvl = c.tv.toLowerCase();
      var score = 10;
      if (tl === rawSym || tvl === rawSym) score = 100;
      else if (nl === raw) score = 95;
      else if (tl.indexOf(rawSym) === 0) score = 80;
      else if (nl.indexOf(raw) === 0) score = 70;
      else if (nl.indexOf(' ' + raw) !== -1) score = 50;
      // Slightly boost curated global companies (first 200 entries) on ties
      if (i < 200) score += 5;
      scored.push({ c: c, score: score, idx: i });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
    return scored.slice(0, limit || 12).map(function (item) { return item.c; });
  }

  function marketSearchResultsHtml() {
    var q = state.marketSearch.trim();
    if (!q) return '<div class="ws-suggestions-title">Popular companies · ' + MARKET_DIRECTORY.length.toLocaleString('en-GB') + ' global stocks searchable</div>' +
      MARKET_DIRECTORY.slice(0,8).map(marketSearchResult).join('');
    var found = searchMarketCompanies(q, 12);
    var rawUpper = q.toUpperCase();
    var looksLikeSymbol = /^[A-Z0-9._:-]{1,18}$/.test(rawUpper);
    var hasExact = found.some(function (c) { return c.ticker.toUpperCase() === rawUpper || c.tv.toUpperCase() === rawUpper; });
    var customRow = looksLikeSymbol && !hasExact
      ? '<button type="button" class="ws-search-hit ws-discover-link" data-act="wscompanycustom" data-id="' + esc(rawUpper) + '">' +
        '<span class="ws-ticker">' + esc(rawUpper) + '</span><span>Open symbol directly on TradingView<small>Chart, technicals, financials &amp; news</small></span></button>'
      : '';
    var loadingNote = companyDirectoryState === 'loading'
      ? '<div class="ws-search-empty">Loading full global directory (7,800+ companies)…</div>'
      : '';
    return loadingNote +
      (found.length ? found.map(marketSearchResult).join('') :
        (customRow ? '' : '<div class="ws-search-empty">No matching company name found. Try a ticker symbol (e.g. SHEL, LSE:RR., NSE:RELIANCE, CRWD) or open the screener.</div>')) +
      customRow +
      '<button class="ws-search-hit ws-discover-link" type="button" data-act="wstab" data-id="discover">' +
      'Browse the stock screener ↗</button>';
  }

  function marketSearchResult(company) {
    return '<button type="button" class="ws-search-hit" data-act="wscompany" data-id="' + esc(company.tv) + '">' +
      '<span class="ws-ticker">' + esc(company.ticker) + '</span><span>' + esc(company.name) +
      '<small>' + esc(company.exchange) + ' · ' + esc(company.sector) + '</small></span></button>';
  }

  function marketRelatedNews(company, generalSearch) {
    var matches = [], seen = Object.create(null);
    if (!publisherFeed || !publisherFeed.publishers) return matches;
    var keys = company ? [company.name.toLowerCase(), company.ticker.toLowerCase()].concat(
      company.search.split(' ').filter(function (k) { return k.length > 3; }).slice(0,3)
    ) : [];
    var q = (generalSearch || '').trim().toLowerCase();
    Object.keys(publisherFeed.publishers).forEach(function (publisher) {
      var feed = publisherFeed.publishers[publisher];
      (feed && feed.articles || []).forEach(function (a) {
        if (!a || !safeExternalUrl(a.url) || !a.title) return;
        var text = ((a.title || '') + ' ' + (a.summary || '')).toLowerCase();
        var hit = company ? keys.some(function (key) {
          return key.length > 2 && (text.indexOf(key) !== -1);
        }) : q ? text.indexOf(q) !== -1 :
          a.topic === 'finance' || a.topic === 'business' ||
          /stocks|earnings|shares|markets|inflation|economy|central bank|interest rate/i.test(a.title);
        if (!hit) return;
        var k = a.url.split('?')[0];
        if (seen[k]) return;
        seen[k] = true;
        matches.push({ publisher:publisher, article:a });
      });
    });
    return matches.sort(function (a,b) {
      return String(b.article.published||'').localeCompare(String(a.article.published||''));
    }).slice(0,50);
  }

  function marketWorkspaceNewsHtml(items, limit) {
    if (!publisherFeed) return '<p class="ws-empty">Loading original publisher feeds…</p>';
    if (!items.length) return '<p class="ws-empty">No matching recent articles in the collected publisher feeds. Try another company or keyword.</p>';
    return items.slice(0,limit||20).map(function (item) {
      var a = item.article;
      return '<article class="ws-news-row">' +
        '<div class="ws-news-byline">' + esc(item.publisher) + ' · ' + esc(articlePublishedLabel(a.published)) + '</div>' +
        '<a href="' + esc(safeExternalUrl(a.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>' +
        '</article>';
    }).join('');
  }

  function marketWorkspaceWatchlist() {
    var saved = state.marketWatch.map(function (name) {
      return MARKET_DIRECTORY.find(function (company) { return company.tv === name || company.name === name || company.ticker === name; });
    }).filter(Boolean);
    return saved.length ? saved.map(function (company) {
      return '<div class="ws-watch-entry"><button type="button" class="ws-watch-row" data-act="wscompany" data-id="' + esc(company.tv) +
        '" aria-label="Open ' + esc(company.name) + ' company details"><strong>' + esc(company.ticker) + '</strong><span>' + esc(company.name) +
        '</span><span class="ws-watch-arrow" aria-hidden="true">↗</span></button>' +
        '<button type="button" class="ws-watch-remove" data-act="wsremove" data-id="' + esc(company.tv) +
        '" aria-label="Remove ' + esc(company.name) + ' from watchlist" title="Remove from watchlist">×</button></div>';
    }).join('') : '<p class="ws-empty">Your watchlist is empty. Search for a company to add it.</p>';
  }

  function updateMarketWatchlistInPlace() {
    var list = app.querySelector('#ws-watchlist-content');
    if (list) list.innerHTML = marketWorkspaceWatchlist();
    var count = app.querySelector('#ws-watch-count');
    if (count) count.textContent = state.marketWatch.length + ' saved';
    var chosen = selectedMarketCompany();
    var star = app.querySelector('[data-act="wswatch"]');
    if (star && chosen) {
      var active = state.marketWatch.some(function (name) { return name === chosen.tv || name === chosen.name; });
      star.setAttribute('aria-pressed', String(active));
      star.textContent = active ? '★ In watchlist' : '☆ Add to watchlist';
    }
    refreshWorkspaceNews();
  }

  var EXCHANGE_SESSIONS = [
    { id: 'london', name: 'London', code: 'LSE', zone: 'Europe/London', open: 480, close: 990, hours: '08:00–16:30' },
    { id: 'newyork', name: 'New York', code: 'NYSE', zone: 'America/New_York', open: 570, close: 960, hours: '09:30–16:00' },
    { id: 'mumbai', name: 'Mumbai', code: 'NSE', zone: 'Asia/Kolkata', open: 555, close: 930, hours: '09:15–15:30' },
    { id: 'tokyo', name: 'Tokyo', code: 'TSE', zone: 'Asia/Tokyo', open: 540, close: 930, hours: '09:00–15:30' },
    { id: 'shanghai', name: 'Shanghai', code: 'SSE', zone: 'Asia/Shanghai', open: 570, close: 900, hours: '09:30–15:00' }
  ];

  function exchangeSessionState(ex) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: ex.zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date());
      var map = {};
      parts.forEach(function (p) { map[p.type] = p.value; });
      var day = map.weekday || '';
      var mins = Number(map.hour || 0) * 60 + Number(map.minute || 0);
      var weekday = day !== 'Sat' && day !== 'Sun';
      var open = weekday && mins >= ex.open && mins < ex.close;
      return { open: open, time: (map.hour || '00') + ':' + (map.minute || '00'), label: open ? 'Open' : 'Closed' };
    } catch (e) {
      return { open: false, time: '--:--', label: 'Closed' };
    }
  }

  function renderExchangeSessions() {
    return '<section class="ws-session-strip" aria-label="Global exchange session status">' + EXCHANGE_SESSIONS.map(function (ex) {
      var st = exchangeSessionState(ex);
      return '<div class="ws-session-card' + (st.open ? ' is-open' : '') + '" data-session-id="' + esc(ex.id) + '">' +
        '<div class="ws-session-top"><strong>' + esc(ex.name) + ' <span>' + esc(ex.code) + '</span></strong>' +
        '<span class="ws-session-badge">' + esc(st.label) + '</span></div>' +
        '<div class="ws-session-foot"><time>' + esc(st.time) + '</time><small>' + esc(ex.hours) + '</small></div></div>';
    }).join('') + '</section>';
  }

  function updateSessionCards() {
    app.querySelectorAll('[data-session-id]').forEach(function (card) {
      var id = card.getAttribute('data-session-id');
      var ex = EXCHANGE_SESSIONS.find(function (x) { return x.id === id; });
      if (!ex) return;
      var st = exchangeSessionState(ex);
      card.classList.toggle('is-open', st.open);
      var badge = card.querySelector('.ws-session-badge');
      if (badge) badge.textContent = st.label;
      var timeEl = card.querySelector('time');
      if (timeEl) timeEl.textContent = st.time;
    });
  }

  function marketWorkspaceOverview() {
    var mini = MARKETS.map(function (m) {
      var series = marketPoints(m.id), last = series[series.length-1];
      return '<button type="button" class="ws-index-cell" data-act="wsmarket" data-id="' + esc(m.id) + '">' +
        '<span>' + esc(m.index) + '</span>' +
        (last ? '<strong>' + marketNumber(last.close) + '</strong><small>' + esc(marketDate(last.date)) + ' · daily close</small>' :
          '<strong>—</strong><small>Data pending</small>') + '</button>';
    }).join('');
    return '<p class="ws-data-disclosure">Index cards: completed daily closes · Market sessions: indicative weekday schedules, excluding holidays · Embedded prices: exchange-dependent delays</p>' +
      renderExchangeSessions() +
      '<section class="ws-market-strip" aria-label="Major world indices">' + mini + '</section>' +
      '<div class="ws-dashboard-grid"><section class="ws-widget ws-widget-chart">' +
      '<div class="ws-widget-head"><h2>Market monitor</h2><span>TradingView · prices may be delayed</span></div>' +
      '<div id="tv-market-overview" class="tv-market-overview ws-tv-overview" aria-label="Embedded TradingView markets overview">' +
      '<p class="ws-empty">Connecting to TradingView…</p></div></section>' +
      '<div class="ws-sidebar-stack"><section class="ws-widget ws-widget-watch">' +
      '<div class="ws-widget-head"><h2>Watchlist</h2><span id="ws-watch-count">' + state.marketWatch.length + ' saved</span></div>' +
      '<div class="ws-widget-scroll" id="ws-watchlist-content">' + marketWorkspaceWatchlist() + '</div></section>' +
      '<section class="ws-widget ws-widget-headlines"><div class="ws-widget-head"><h2>Market headlines</h2>' +
      '<button data-act="wstab" data-id="news">All news ↗</button></div>' +
      '<div class="ws-widget-scroll" id="ws-market-headlines">' +
      marketWorkspaceNewsHtml(marketRelatedNews(null,''),12) + '</div></section></div></div>';
  }

  function marketWorkspaceCompany() {
    var company = selectedMarketCompany();
    var watched = state.marketWatch.indexOf(company.tv) !== -1 || state.marketWatch.indexOf(company.name) !== -1;
    var profile = companyMarketData && companyMarketData.status === 'available' &&
      companyMarketData.profiles && companyMarketData.profiles[company.ticker];
    return '<div class="ws-company-header"><div><span class="ws-kicker">' + esc(company.tv) + '</span><h2>' + esc(company.name) + '</h2>' +
      '<p>' + esc(profile && profile.sector || company.sector) + ' · ' + esc(company.exchange) +
      ' · Company information is indicative; check the source for financial fundamentals.</p></div>' +
      '<button class="ws-star-button" data-act="wswatch" data-id="' + esc(company.tv) + '" aria-pressed="' +
      watched + '">' + (watched ? '★ In watchlist' : '☆ Add to watchlist') + '</button></div>' +
      '<div class="ws-company-layout"><section class="ws-widget ws-widget-company-chart">' +
      '<div class="ws-widget-head ws-company-widget-head"><h3>Company intelligence</h3><span>TradingView · may be delayed</span></div>' +
      '<div class="ws-company-switch" role="group" aria-label="Company data views">' +
      [{id:'chart',name:'Chart'},{id:'advanced',name:'Advanced'},{id:'technicals',name:'Technicals'},{id:'financials',name:'Financials'},{id:'profile',name:'Profile'}].map(function (option) {
        var active = state.marketCompanyPanel === option.id;
        return '<button type="button" data-act="wscompanypanel" data-id="' + option.id +
          '" aria-pressed="' + active + '">' + option.name + '</button>';
      }).join('') + '</div>' +
      '<div class="ws-company-chart" id="ws-company-chart" aria-label="Company TradingView information"><p class="ws-empty">Loading provider information…</p></div>' +
      '<div class="ws-widget-foot"><a href="https://www.tradingview.com/symbols/' +
      encodeURIComponent(company.exchange) + '-' + encodeURIComponent(company.ticker.replace('.','')) +
      '/" target="_blank" rel="noopener noreferrer">Open instrument on TradingView ↗</a></div></section>' +
      '<section class="ws-widget ws-widget-company-news"><div class="ws-widget-head"><h3>Related company news</h3>' +
      '<span>Original publisher RSS</span></div><div class="ws-widget-scroll" id="ws-company-news">' +
      marketWorkspaceNewsHtml(marketRelatedNews(company,''),24) + '</div></section></div>';
  }

  function marketWorkspaceNews() {
    return '<section class="ws-widget ws-news-workspace"><div class="ws-widget-head"><h2>Company & market news</h2>' +
      '<span>Last available RSS articles · link to original</span></div>' +
      '<div class="ws-news-filter"><button data-act="wsnewsfilter" data-id="all" aria-pressed="' +
      (state.marketNewsFocus === 'all') + '">All financial news</button>' +
      '<button data-act="wsnewsfilter" data-id="watchlist" aria-pressed="' +
      (state.marketNewsFocus === 'watchlist') + '">My watchlist</button></div>' +
      '<div class="ws-widget-scroll" id="ws-news-results">' +
      marketWorkspaceNewsHtml(state.marketNewsFocus === 'watchlist' ?
        marketRelatedNewsForWatchlist() : marketRelatedNews(null,state.marketSearch),45) +
      '</div></section>';
  }

  function marketRelatedNewsForWatchlist() {
    var results=[], seen=Object.create(null);
    state.marketWatch.forEach(function (name) {
      var company=MARKET_DIRECTORY.find(function (c) { return c.tv === name || c.name === name || c.ticker === name; });
      if (!company) return;
      marketRelatedNews(company,'').forEach(function (item) {
        if (!seen[item.article.url]) { seen[item.article.url]=true; results.push(item); }
      });
    });
    return results.sort(function (a,b) { return String(b.article.published||'').localeCompare(String(a.article.published||'')); });
  }

  function renderTrading() {
    var tabs = [
      {id:'overview',label:'Overview'}, {id:'company',label:'Company'},
      {id:'heatmap',label:'Heatmap'}, {id:'movers',label:'Movers & FX'}, {id:'calendar',label:'Calendar'},
      {id:'news',label:'News'}, {id:'map',label:'World map'}, {id:'discover',label:'Discover'}
    ];
    var tab = tabs.some(function (t) { return t.id === state.marketWorkspaceTab; }) ? state.marketWorkspaceTab : 'overview';
    var results = marketSearchResultsHtml();
    return '<div class="ws-shell"><header class="ws-header"><div class="ws-heading">' +
      '<div><span class="ws-kicker">PHEME / MARKET INTELLIGENCE</span><h1>Markets workspace</h1></div>' +
      '<span class="ws-provider-pill">Data from publisher RSS &amp; TradingView</span></div>' +
      '<div id="ws-ticker-tape" class="ws-ticker-tape" aria-label="Live market ticker tape"><p class="ws-empty">Loading ticker tape…</p></div>' +
      '<div class="ws-search-area"><label class="sr-only" for="ws-company-search">Search any company, ticker or news</label>' +
      '<span aria-hidden="true" class="ws-search-icon">⌕</span>' +
      '<input id="ws-company-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search any company or ticker (e.g. Shell, Rolls-Royce, LSE:RR., NVDA, Reliance)…" value="' +
      esc(state.marketSearch) + '" aria-controls="ws-search-results" aria-expanded="false">' +
      '<button type="button" data-act="wssearchnews">Search news</button>' +
      '<div id="ws-search-results" class="ws-search-dropdown" hidden>' + results + '</div></div>' +
      '<div class="ws-mobile-toolbar"><label for="ws-mobile-section">Workspace</label><select id="ws-mobile-section" aria-label="Choose market workspace">' +
      tabs.map(function (t) { return '<option value="' + t.id + '"' + (t.id === tab ? ' selected' : '') + '>' + t.label + '</option>'; }).join('') +
      '</select><span class="ws-mobile-hint">Swipe charts horizontally to inspect data</span></div>' +
      '<nav class="ws-tabs" aria-label="Market workspace sections">' +
      tabs.map(function (t) { return '<button type="button" data-act="wstab" data-id="' + t.id +
        '" aria-current="' + (t.id === tab ? 'page' : 'false') + '" class="' + (t.id === tab ? 'active' : '') +
        '">' + t.label + '</button>'; }).join('') + '</nav></header>' +
      '<div class="ws-panel" id="ws-active-panel">' +
      (tab === 'overview' ? marketWorkspaceOverview() :
       tab === 'company' ? marketWorkspaceCompany() :
       tab === 'heatmap' ? '<section class="ws-widget ws-full-widget"><div class="ws-widget-head"><h2>S&amp;P 500 sector heatmap</h2><span>Sized by market cap · coloured by daily move</span></div>' +
         '<div id="ws-stock-heatmap" class="ws-widget-embed"><p class="ws-empty">Loading sector heatmap…</p></div></section>' :
       tab === 'movers' ? '<div class="ws-two-col">' +
         '<section class="ws-widget ws-half-widget"><div class="ws-widget-head"><h2>Market movers</h2><span>Gainers, losers &amp; most active</span></div>' +
         '<div id="ws-hotlists" class="ws-widget-embed"><p class="ws-empty">Loading market movers…</p></div></section>' +
         '<section class="ws-widget ws-half-widget"><div class="ws-widget-head"><h2>Forex cross rates</h2><span>GBP · USD · EUR · JPY · CHF · CAD · AUD · INR</span></div>' +
         '<div id="ws-forex-cross" class="ws-widget-embed"><p class="ws-empty">Loading forex cross rates…</p></div></section></div>' :
       tab === 'calendar' ? '<section class="ws-widget ws-full-widget"><div class="ws-widget-head"><h2>Economic calendar</h2><span>Central banks, CPI, GDP &amp; jobs (UK, US, EU, JP, IN, CN)</span></div>' +
         '<div id="ws-economic-calendar" class="ws-widget-embed"><p class="ws-empty">Loading economic calendar…</p></div></section>' :
       tab === 'news' ? marketWorkspaceNews() :
       tab === 'map' ? '<section class="ws-widget ws-map-panel"><div class="ws-widget-head"><h2>World exchanges</h2><span>Location pins; historical index data where available</span></div>' +
         '<div id="exchange-world-map" class="exchange-world-map ws-exchange-map" role="region" aria-label="Global stock exchanges"></div>' +
         '<p class="ws-widget-foot">Exchange pins do not imply real-time market data. Indices show completed daily closes.</p></section>' :
       '<section class="ws-widget ws-discover-panel"><div class="ws-widget-head"><h2>Discover US-listed stocks</h2><span>TradingView stock screener · independent provider</span></div>' +
         '<div id="ws-stock-screener" class="ws-stock-screener"><p class="ws-empty">Loading stock screener…</p></div>' +
         '<p class="ws-widget-foot">Use the screener to explore more stocks. Pheme’s integrated company news currently searches its built-in directory.</p></section>') +
      '</div></div>';
  }

  function mountTradingViewBox(box, scriptFile, config, creditLabel, fallbackUrl) {
    if (!box || box.getAttribute('data-tv-loaded') === 'yes') return;
    box.setAttribute('data-tv-loaded', 'yes');
    var widget = document.createElement('div');
    widget.className = 'tradingview-widget-container';
    widget.style.width = '100%';
    widget.style.height = '100%';
    var canvas = document.createElement('div');
    canvas.className = 'tradingview-widget-container__widget';
    canvas.style.width = '100%';
    canvas.style.height = creditLabel ? 'calc(100% - 28px)' : '100%';
    widget.appendChild(canvas);
    if (creditLabel) {
      var credit = document.createElement('div');
      credit.className = 'tradingview-widget-copyright';
      credit.innerHTML = '<a href="' + esc(fallbackUrl || 'https://www.tradingview.com/markets/') + '" target="_blank" rel="noopener nofollow noreferrer">' + esc(creditLabel) + '</a>';
      widget.appendChild(credit);
    }
    box.replaceChildren(widget);
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = 'https://s3.tradingview.com/external-embedding/' + scriptFile;
    script.textContent = JSON.stringify(config);
    script.onerror = function () {
      box.removeAttribute('data-tv-loaded');
      box.innerHTML = '<p class="ws-empty">Widget unavailable right now. <a href="' + esc(fallbackUrl || 'https://www.tradingview.com/markets/') + '" target="_blank" rel="noopener noreferrer">Open on TradingView ↗</a></p>';
    };
    widget.appendChild(script);
  }

  function isCompactTradingViewport() {
    return window.matchMedia && window.matchMedia('(max-width: 680px)').matches;
  }

  function mountTradingViewMarkets() {
    var compact = isCompactTradingViewport();
    mountTradingViewBox(app.querySelector('#ws-ticker-tape'), 'embed-widget-ticker-tape.js', {
      symbols: [
        { proName: 'TVC:UKX', title: 'FTSE 100' },
        { proName: 'SP:SPX', title: 'S&P 500' },
        { proName: 'NASDAQ:NDX', title: 'NASDAQ 100' },
        { proName: 'NSE:NIFTY', title: 'NIFTY 50' },
        { proName: 'TVC:GOLD', title: 'Gold' },
        { proName: 'TVC:UKOIL', title: 'Brent Oil' },
        { proName: 'FX:GBPUSD', title: 'GBP/USD' },
        { proName: 'FX:EURUSD', title: 'EUR/USD' },
        { proName: 'BITSTAMP:BTCUSD', title: 'Bitcoin' },
        { proName: 'NASDAQ:AAPL', title: 'Apple' },
        { proName: 'NASDAQ:NVDA', title: 'Nvidia' },
        { proName: 'NASDAQ:MSFT', title: 'Microsoft' }
      ],
      showSymbolLogo: true,
      isTransparent: false,
      displayMode: 'adaptive',
      colorTheme: 'light',
      locale: 'en'
    }, '', 'https://www.tradingview.com/markets/');

    mountTradingViewBox(app.querySelector('#tv-market-overview'), 'embed-widget-market-overview.js', {
      colorTheme: 'light',
      dateRange: '3M',
      locale: 'en',
      isTransparent: false,
      showFloatingTooltip: true,
      width: '100%',
      height: '100%',
      showSymbolLogo: true,
      showChart: !compact,
      tabs: [
        { title: 'Companies', originalTitle: 'Companies', symbols: [
          { s: 'NASDAQ:AAPL', d: 'Apple' },
          { s: 'NASDAQ:MSFT', d: 'Microsoft' },
          { s: 'NASDAQ:NVDA', d: 'Nvidia' },
          { s: 'NASDAQ:TSLA', d: 'Tesla' },
          { s: 'NASDAQ:GOOGL', d: 'Alphabet' },
          { s: 'NASDAQ:AMZN', d: 'Amazon' }
        ] },
        { title: 'Global indices', originalTitle: 'Global indices', symbols: [
          { s: 'TVC:UKX', d: 'FTSE 100 · UK' },
          { s: 'SP:SPX', d: 'S&P 500 · US' },
          { s: 'NASDAQ:NDX', d: 'NASDAQ 100 · US' },
          { s: 'NSE:NIFTY', d: 'NIFTY 50 · India' },
          { s: 'SSE:000001', d: 'Shanghai Composite · China' },
          { s: 'TVC:NI225', d: 'Nikkei 225 · Japan' }
        ] },
        { title: 'Commodities', originalTitle: 'Commodities', symbols: [
          { s: 'TVC:GOLD', d: 'Gold Spot' },
          { s: 'TVC:SILVER', d: 'Silver Spot' },
          { s: 'TVC:UKOIL', d: 'Brent Crude Oil' },
          { s: 'TVC:USOIL', d: 'WTI Crude Oil' },
          { s: 'NYMEX:NG1!', d: 'Natural Gas' }
        ] },
        { title: 'Forex', originalTitle: 'Forex', symbols: [
          { s: 'FX:GBPUSD', d: 'GBP / USD' },
          { s: 'FX:EURUSD', d: 'EUR / USD' },
          { s: 'FX:EURGBP', d: 'EUR / GBP' },
          { s: 'FX:USDJPY', d: 'USD / JPY' },
          { s: 'FX_IDC:USDINR', d: 'USD / INR' }
        ] }
      ]
    }, 'Market data by TradingView', 'https://www.tradingview.com/markets/');

    mountTradingViewBox(app.querySelector('#ws-stock-heatmap'), 'embed-widget-stock-heatmap.js', {
      exchanges: [],
      dataSource: 'SPX500',
      grouping: 'sector',
      blockSize: 'market_cap_basic',
      blockColor: 'change',
      locale: 'en',
      symbolUrl: '',
      colorTheme: 'light',
      hasTopBar: true,
      isDataSetEnabled: true,
      isZoomEnabled: true,
      hasSymbolTooltip: !compact,
      isMonoSize: compact,
      width: '100%',
      height: '100%'
    }, 'Stock heatmap by TradingView', 'https://www.tradingview.com/heatmap/stock/');

    mountTradingViewBox(app.querySelector('#ws-hotlists'), 'embed-widget-hotlists.js', {
      colorTheme: 'light',
      dateRange: '12M',
      exchange: 'US',
      showChart: !compact,
      locale: 'en',
      width: '100%',
      height: '100%',
      isTransparent: false,
      showSymbolLogo: true,
      showFloatingTooltip: true
    }, 'Market movers by TradingView', 'https://www.tradingview.com/markets/stocks-usa/market-movers-gainers/');

    mountTradingViewBox(app.querySelector('#ws-forex-cross'), 'embed-widget-forex-cross-rates.js', {
      width: '100%',
      height: '100%',
      currencies: compact ? ['GBP', 'USD', 'EUR', 'JPY'] : ['GBP', 'USD', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'INR'],
      isTransparent: false,
      colorTheme: 'light',
      locale: 'en'
    }, 'Forex rates by TradingView', 'https://www.tradingview.com/markets/currencies/');

    mountTradingViewBox(app.querySelector('#ws-economic-calendar'), 'embed-widget-events.js', {
      colorTheme: 'light',
      isTransparent: false,
      width: '100%',
      height: '100%',
      locale: 'en',
      importanceFilter: compact ? '1' : '-1,0,1',
      countryFilter: compact ? 'gb,us,eu' : 'gb,us,eu,jp,in,cn'
    }, 'Economic calendar by TradingView', 'https://www.tradingview.com/economic-calendar/');
  }

  function mountWorkspaceCompanyChart() {
    var target = app.querySelector('#ws-company-chart');
    if (!target || target.dataset.loaded === 'yes') return;
    target.dataset.loaded = 'yes';
    var company = selectedMarketCompany();
    var mode = state.marketCompanyPanel;
    var compact = isCompactTradingViewport();
    var container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '100%';
    container.style.width = '100%';
    var chart = document.createElement('div');
    chart.className = 'tradingview-widget-container__widget';
    chart.style.height = 'calc(100% - 28px)';
    chart.style.width = '100%';
    var attribution = document.createElement('div');
    attribution.className = 'tradingview-widget-copyright';
    attribution.innerHTML = '<a href="https://www.tradingview.com/" rel="noopener nofollow noreferrer" target="_blank">Company data by TradingView</a>';
    container.appendChild(chart);
    container.appendChild(attribution);
    target.replaceChildren(container);
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    var base = 'https://s3.tradingview.com/external-embedding/';
    var options = { colorTheme:'light', isTransparent:false, locale:'en', width:'100%', height:'100%' };
    if (mode === 'advanced') {
      script.src = base + 'embed-widget-advanced-chart.js';
      options = {
        autosize: true,
        symbol: company.tv,
        interval: 'D',
        timezone: 'Europe/London',
        theme: 'light',
        style: '1',
        locale: 'en',
        allow_symbol_change: true,
        hide_side_toolbar: compact,
        withdateranges: !compact,
        details: !compact,
        calendar: false,
        support_host: 'https://www.tradingview.com'
      };
    } else if (mode === 'technicals') {
      script.src = base + 'embed-widget-technical-analysis.js';
      options.symbol = company.tv;
      options.interval = '1D';
      options.showIntervalTabs = !compact;
      options.displayMode = 'single';
    } else if (mode === 'financials') {
      script.src = base + 'embed-widget-financials.js';
      options.symbol = company.tv;
      options.displayMode = compact ? 'compact' : 'regular';
    } else if (mode === 'profile') {
      script.src = base + 'embed-widget-symbol-profile.js';
      options.symbol = company.tv;
    } else {
      script.src = base + 'embed-widget-symbol-overview.js';
      options.symbols = [[company.name + '|' + company.tv]];
      options.chartOnly = false;
      options.autosize = true;
      options.showVolume = !compact;
      options.showMA = false;
      options.hideDateRanges = false;
      options.hideMarketStatus = false;
      options.hideSymbolLogo = false;
      options.scalePosition = 'right';
      options.scaleMode = 'Normal';
      options.chartType = 'area';
      options.lineWidth = 2;
      options.dateRanges = compact ? ['1d|1','1m|30','3m|60','12m|1D'] : ['1d|1','1m|30','3m|60','12m|1D','all|1M'];
    }
    script.textContent = JSON.stringify(options);
    script.onerror = function () {
      target.innerHTML = '<p class="ws-empty">This TradingView view is unavailable. Try another tab or open the company on TradingView.</p>';
    };
    container.appendChild(script);
  }

  function mountWorkspaceScreener() {
    var target = app.querySelector('#ws-stock-screener');
    if (!target || target.dataset.loaded === 'yes') return;
    target.dataset.loaded = 'yes';
    var container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '100%';
    container.style.width = '100%';
    var content = document.createElement('div');
    content.className = 'tradingview-widget-container__widget';
    content.style.height = 'calc(100% - 28px)';
    var brand = document.createElement('div');
    brand.className = 'tradingview-widget-copyright';
    brand.innerHTML = '<a href="https://www.tradingview.com/markets/stocks-usa/market-movers-all-stocks/" rel="noopener nofollow noreferrer" target="_blank">Stock screener by TradingView</a>';
    container.appendChild(content);
    container.appendChild(brand);
    target.replaceChildren(container);
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-screener.js';
    script.textContent = JSON.stringify({
      market:'america', showToolbar:true, defaultColumn:'overview',
      defaultScreen:'general', isTransparent:false, locale:'en',
      colorTheme:'light', width:'100%', height:'100%'
    });
    script.onerror = function () {
      target.innerHTML = '<p class="ws-empty">The screener could not load. <a href="https://www.tradingview.com/markets/stocks-usa/" target="_blank" rel="noopener noreferrer">Explore markets on TradingView</a>.</p>';
    };
    container.appendChild(script);
  }

  function refreshWorkspaceNews() {
    if (state.view !== 'trading') return;
    var overview = app.querySelector('#ws-market-headlines');
    if (overview) overview.innerHTML = marketWorkspaceNewsHtml(marketRelatedNews(null,''),12);
    var company = app.querySelector('#ws-company-news');
    if (company) company.innerHTML = marketWorkspaceNewsHtml(marketRelatedNews(selectedMarketCompany(),''),24);
    var full = app.querySelector('#ws-news-results');
    if (full) full.innerHTML = marketWorkspaceNewsHtml(
      state.marketNewsFocus === 'watchlist' ? marketRelatedNewsForWatchlist() :
        marketRelatedNews(null,state.marketSearch),45);
  }

  function showWorkspaceSearchResults() {
    var dropdown = app.querySelector('#ws-search-results');
    var input = app.querySelector('#ws-company-search');
    if (!dropdown || !input) return;
    dropdown.innerHTML = marketSearchResultsHtml();
    dropdown.hidden = false;
    input.setAttribute('aria-expanded','true');
  }

  function hideWorkspaceSearchResults() {
    var dropdown = app.querySelector('#ws-search-results');
    var input = app.querySelector('#ws-company-search');
    if (dropdown) dropdown.hidden = true;
    if (input) input.setAttribute('aria-expanded','false');
  }

  function mountExchangeMap() {
    var canvas = app.querySelector('#exchange-world-map');
    if (!canvas || !window.L || exchangeMap) return;
    var L = window.L;
    exchangeMap = L.map(canvas, { scrollWheelZoom: false, minZoom: 2, maxZoom: 12, worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 17
    }).addTo(exchangeMap);
    exchangeMapLayer = L.layerGroup().addTo(exchangeMap);
    EXCHANGE_PLACES.forEach(function (place) {
      var market = MARKETS.find(function (m) { return m.id === place.id; });
      var points = market ? marketPoints(market.id) : [];
      var last = points[points.length - 1];
      var content = '<div class="exchange-popup"><strong>' + esc(place.name) + '</strong><span>' +
        esc(place.city) + ' · ' + esc(place.region) + '</span>' +
        (market ? '<p>' + esc(market.index) + (last ? ' · ' + marketNumber(last.close) + ' (' + marketDate(last.date) + ')' : ' · data unavailable') + '</p>' +
          '<button type="button" data-act="exchangefocus" data-id="' + market.id + '">' +
          (last ? 'View daily chart' : 'View index · data pending') + '</button>' :
          '<p>Location marker · no index series connected</p>') + '</div>';
      L.circleMarker([place.lat, place.lng], {
        radius: market ? 9 : 6, weight: 2, color: '#204D3D', fillColor: market ? '#2F5D50' : '#C2A77A', fillOpacity: .9
      }).addTo(exchangeMapLayer).bindPopup(content, { maxWidth: 290 });
    });
    exchangeMap.fitBounds(L.latLngBounds(EXCHANGE_PLACES.map(function (p) { return [p.lat,p.lng]; })), { padding: [20,20], maxZoom: 2 });
  }

  /* ---------- Newspapers View ---------- */
  var publisherFeed = null;
  var publisherFeedLoading = false;
  var publisherFeedError = false;
  var publisherReaderCache = Object.create(null);

  function allPublisherChoices() {
    var choices = followed().slice();
    if (publisherFeed && publisherFeed.publishers) {
      Object.keys(publisherFeed.publishers).forEach(function (name) {
        if (!choices.some(function (p) { return p.name === name; })) choices.push({ name: name, topic: 'world' });
      });
    }
    return choices;
  }

  function publisherLocationGroups() {
    if (!publisherFeed || !publisherFeed.publishers) return [];
    var groups = Object.create(null);
    Object.keys(publisherFeed.publishers).forEach(function (name) {
      var entry = publisherFeed.publishers[name];
      var loc = entry && entry.location;
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
      var key = loc.city + '|' + loc.country;
      if (!groups[key]) groups[key] = { location: loc, names: [] };
      groups[key].names.push(name);
    });
    return Object.keys(groups).map(function (key) { return groups[key]; });
  }

  function updatePublisherMapStatus() {
    var label = app.querySelector('#publisher-map-status');
    if (!label) return;
    if (!publisherFeed) {
      label.textContent = publisherFeedError ? 'Publisher map temporarily unavailable' : 'Loading publisher locations…';
      return;
    }
    var groups = publisherLocationGroups();
    var counts = Object.keys(publisherFeed.publishers).length;
    label.textContent = counts + ' publishers · ' + groups.length + ' editorial cities · locations show publisher bases, not story locations';
  }

  function mountPublisherMap() {
    var canvas = app.querySelector('#publisher-world-map');
    if (!canvas || !window.L) return;
    if (publisherMap) return;
    var L = window.L;
    publisherMap = L.map(canvas, { scrollWheelZoom: false, minZoom: 2, maxZoom: 12, worldCopyJump: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 17
    }).addTo(publisherMap);
    publisherMapLayer = L.layerGroup().addTo(publisherMap);
    publisherMap.fitBounds(MAP_REGIONS.global.bounds, { maxZoom: 2 });
    refreshPublisherMap();
  }

  function refreshPublisherMap() {
    updatePublisherMapStatus();
    if (!publisherMap || !publisherMapLayer || !window.L) return;
    var L = window.L;
    publisherMapLayer.clearLayers();
    var groups = publisherLocationGroups();
    groups.forEach(function (group) {
      var location = group.location;
      var html = '<div class="publisher-map-popup">' +
        '<strong>' + esc(location.city) + ', ' + esc(location.country) + '</strong>' +
        '<p>Publisher editorial bases · ' + group.names.length + '</p>' +
        '<div class="publisher-map-links">' +
        group.names.map(function (name) {
          var entry = publisherDetails(name);
          var count = entry && Array.isArray(entry.articles) ? entry.articles.length : 0;
          return '<button type="button" data-act="paper" data-name="' + esc(name) + '">' +
            esc(name) + ' <span>' + count + ' articles</span></button>';
        }).join('') + '</div></div>';
      L.circleMarker([location.lat, location.lng], {
        radius: Math.min(20, 6 + Math.sqrt(group.names.length) * 3),
        color: '#234c40', weight: 2, fillColor: '#417b69', fillOpacity: 0.8
      }).addTo(publisherMapLayer).bindPopup(html, { maxWidth: 310 });
    });
    if (groups.length > 1) {
      publisherMap.fitBounds(L.latLngBounds(groups.map(function (group) {
        return [group.location.lat, group.location.lng];
      })), { padding: [22, 22], maxZoom: 3 });
    }
    setTimeout(function () { if (publisherMap) publisherMap.invalidateSize(); }, 0);
  }

  function loadPublisherFeeds() {
    if (publisherFeedLoading) return;
    publisherFeedLoading = true;
    fetch('assets/publisher-feeds.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Publisher feed unavailable');
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.publishers || typeof data.publishers !== 'object') throw new Error('Invalid publisher feed');
        publisherFeed = data;
        publisherFeedError = false;
      })
      .catch(function () { publisherFeedError = true; })
      .finally(function () {
        publisherFeedLoading = false;
        if (state.view === 'papers' && !state.reading) {
          var track = app.querySelector('#paper-provider-track');
          if (track && app.querySelector('#paper-article-content')) {
            // Rebuild the provider rail once when newly available world outlets appear.
            // Subsequent publisher selections only replace the article feed in place.
            var visible = Array.from(track.querySelectorAll('[data-act="paper"]')).map(function (tab) {
              return tab.getAttribute('data-name');
            });
            var added = allPublisherChoices().some(function (p) { return visible.indexOf(p.name) === -1; });
            if (added) {
              var railOffset = track.scrollLeft;
              render();
              var newTrack = app.querySelector('#paper-provider-track');
              if (newTrack) newTrack.scrollLeft = railOffset;
              return;
            }
            track.querySelectorAll('[data-act="paper"]').forEach(function (tab) {
              var p = tab.getAttribute('data-name');
              var count = storiesForPaper(p).length;
              var indicator = tab.querySelector('.paper-provider-count');
              if (indicator) indicator.textContent = count + ' ' + (count === 1 ? 'article' : 'articles');
            });
            selectPaperInPlace(state.paper || followed()[0].name);
          } else render();
        }
        if (state.publisherArticle && !state.reading) {
          // Deep-linked publisher articles initially have only query-string metadata.
          // Redraw once RSS arrives so the headline, summary and image become available.
          render();
        }
        if (state.view === 'trading' && !state.reading) {
          refreshWorkspaceNews();
        }
        refreshPublisherMap();
      });
  }

  function publisherDetails(name) {
    return publisherFeed && publisherFeed.publishers && publisherFeed.publishers[name] || null;
  }

  function storiesForPaper(name) {
    var details = publisherDetails(name);
    if (!details || !Array.isArray(details.articles)) return [];
    return details.articles.filter(function (a) {
      return a && typeof a.title === 'string' && safeExternalUrl(a.url);
    });
  }

  function normalizedPublisherArticleUrl(raw) {
    var safe = safeExternalUrl(raw);
    if (!safe) return '';
    try {
      var parsed = new URL(safe);
      parsed.search = '';
      parsed.hash = '';
      return parsed.href.replace(/\/+$/, '').toLowerCase();
    } catch (e) { return ''; }
  }

  var serverReaderCache = null;
  var serverReaderLoading = false;
  function loadServerReaderCache() {
    if (serverReaderCache || serverReaderLoading) return;
    serverReaderLoading = true;
    fetch('assets/reader-cache/index.json' + buildCacheSuffix(), { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('Server reader index unavailable');
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.items || typeof data.items !== 'object') throw new Error('Invalid reader cache');
        // A Railway result may already have arrived for this article.
        serverReaderCache = Object.assign(Object.create(null), data.items, serverReaderCache || {});
        if (state.publisherArticle && !state.reading) render();
      })
      .catch(function () { serverReaderCache = Object.create(null); })
      .finally(function () { serverReaderLoading = false; });
  }
  // Prefer the independent Railway API for deep links and articles that
  // have rolled out of the static deployment snapshot. A failed request
  // leaves the existing first-party RSS cache as the fallback.
  var remoteReaderAttempts = Object.create(null);
  function loadRemoteReaderArticle(entry) {
    var url = safeExternalUrl(entry && entry.url);
    var canonical = normalizedPublisherArticleUrl(url);
    if (!url || !canonical || remoteReaderAttempts[canonical]) return;
    remoteReaderAttempts[canonical] = true;
    var endpoint = 'https://pheme-reader-api-production.up.railway.app/v1/article?url=' + encodeURIComponent(url);
    fetch(endpoint, { mode: 'cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
      .then(function (response) {
        if (!response.ok) throw new Error('Independent reader unavailable');
        return response.json();
      })
      .then(function (data) {
        if (!data || data.publisher !== entry.name || normalizedPublisherArticleUrl(data.url) !== canonical ||
            typeof data.title !== 'string' || typeof data.status !== 'string') return;
        if (!serverReaderCache) serverReaderCache = Object.create(null);
        // Do not overwrite a fully licensed extraction with a metadata-only record.
        var existing = serverReaderCache[canonical];
        if (!existing || existing.status !== 'licensed-full-text' || data.status === 'licensed-full-text') {
          serverReaderCache[canonical] = data;
        }
        if (state.publisherArticle && normalizedPublisherArticleUrl(state.publisherArticle.url) === canonical && !state.reading) render();
      })
      .catch(function () { /* The static cache remains the fallback. */ });
  }
  function serverArticleFor(url) {
    return serverReaderCache && serverReaderCache[normalizedPublisherArticleUrl(url)] || null;
  }

  function publisherArticleFor(name, url) {
    var articles = storiesForPaper(name);
    var exact = articles.find(function (article) { return safeExternalUrl(article.url) === safeExternalUrl(url); });
    if (exact) return exact;
    var normalized = normalizedPublisherArticleUrl(url);
    return normalized ? articles.find(function (article) { return normalizedPublisherArticleUrl(article.url) === normalized; }) || null : null;
  }

  function publisherPreview(name, url, title, published) {
    return publisherArticleFor(name, url) || { url: url, title: title || '', published: published || '' };
  }

  function isKnownPublisherArticle(name, url) {
    var normalized = normalizedPublisherArticleUrl(url);
    if (!normalized) return false;
    if (publisherArticleFor(name, url)) return true;
    return STORIES.some(function (story) {
      return story.cov.rows.some(function (row) {
        return row.name === name && normalizedPublisherArticleUrl(row.url) === normalized;
      });
    });
  }

  function publisherRequiresSubscription(name) {
    var choice = CATALOGUE.find(function (item) { return item.name === name; }) || followed().find(function (item) { return item.name === name; });
    return !!(choice && choice.paywall);
  }

  function fetchPublisherPage(entry, url) {
    if (entry.name === 'Indian Express') {
      var parsedUrl;
      try { parsedUrl = new URL(url); } catch (e) { return Promise.reject(new Error('Publisher page unavailable')); }
      var articleId = /([0-9]+)\/?$/.exec(parsedUrl.pathname);
      if (parsedUrl.hostname !== 'indianexpress.com' || !articleId) return Promise.reject(new Error('Publisher page unavailable'));
      var api = '/assets/indian-express/' + articleId[1] + '.json';
      return fetch(api, { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('Publisher reader backend unavailable');
          return response.json();
        })
        .then(function (data) {
          var finalUrl = safeExternalUrl(data && data.url);
          if (!finalUrl || normalizedPublisherArticleUrl(finalUrl) !== normalizedPublisherArticleUrl(url) || typeof data.html !== 'string') throw new Error('Publisher page unavailable');
          return { markup: data.html, url: finalUrl };
        });
    }
    return fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' })
      .then(function (response) {
        if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('Publisher page unavailable');
        var finalUrl = safeExternalUrl(response.url);
        if (!finalUrl) throw new Error('Publisher page unavailable');
        return response.text().then(function (markup) { return { markup: markup, url: finalUrl }; });
      });
  }

  function sanitizedReaderContent(html, sourceUrl) {
    var parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    var allowed = { p: 1, h2: 1, h3: 1, h4: 1, blockquote: 1, ul: 1, ol: 1, li: 1, pre: 1, figure: 1, figcaption: 1, br: 1, strong: 1, em: 1, b: 1, i: 1, code: 1, hr: 1 };
    var blocked = { script: 1, style: 1, noscript: 1, iframe: 1, object: 1, embed: 1, form: 1, button: 1, svg: 1, math: 1 };
    function resolved(raw) {
      try { return safeExternalUrl(new URL(raw, sourceUrl).href); } catch (e) { return ''; }
    }
    function serialize(node) {
      if (node.nodeType === 3) return esc(node.nodeValue);
      if (node.nodeType !== 1) return '';
      var tag = node.tagName.toLowerCase();
      if (blocked[tag]) return '';
      if (tag === 'img') {
        var image = resolved(node.getAttribute('src') || node.getAttribute('data-src') || '');
        return image ? '<img src="' + esc(image) + '" alt="' + esc(node.getAttribute('alt') || '') + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
      }
      var children = Array.prototype.map.call(node.childNodes, serialize).join('');
      if (tag === 'a') {
        var href = resolved(node.getAttribute('href') || '');
        return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + children + '</a>' : children;
      }
      if (!allowed[tag]) return children;
      if (tag === 'br' || tag === 'hr') return '<' + tag + '>';
      return '<' + tag + '>' + children + '</' + tag + '>';
    }
    return Array.prototype.map.call(parsed.body.childNodes, serialize).join('');
  }

  function loadPublisherArticleContent(entry) {
    var url = safeExternalUrl(entry && entry.url);
    if (!url) return;
    loadRemoteReaderArticle(entry);
    if (publisherReaderCache[url]) return;
    loadServerReaderCache();
    // The server-generated licensed cache is preferred to direct client HTML.
    if (serverArticleFor(url) && serverArticleFor(url).status === 'licensed-full-text') {
      publisherReaderCache[url] = { status: 'server' };
      return;
    }
    // A BBC deep link can arrive before the RSS feed or after it has rolled off.
    // Render a clearly labelled external preview either way.
    if (entry.name === 'BBC News' && /^https:\/\/(?:www\.)?bbc\.(?:co\.uk|com)\/news\//i.test(url)) {
      publisherReaderCache[url] = { status: 'external' };
      return;
    }
    // The server cache supplies a stable source reference even when publisher
    // HTML is blocked by CORS or the item has vanished from the rolling RSS.
    // Do not retry arbitrary external HTML in the user's browser.
    if (entry.name !== 'Indian Express') {
      publisherReaderCache[url] = { status: 'external' };
      return;
    }
    if (!publisherFeed && !isKnownPublisherArticle(entry.name, url)) return;
    if (!isKnownPublisherArticle(entry.name, url)) {
      publisherReaderCache[url] = { status: 'unavailable' };
      return;
    }
    var result = publisherReaderCache[url] = { status: 'loading' };
    fetchPublisherPage(entry, url)
      .then(function (page) {
        if (page.markup.length > 8000000 || !window.Readability || !window.isProbablyReaderable) throw new Error('Reader extraction unavailable');
        var sourceDocument = new DOMParser().parseFromString(page.markup, 'text/html');
        var base = sourceDocument.createElement('base');
        base.href = page.url;
        sourceDocument.head.insertBefore(base, sourceDocument.head.firstChild);
        if (!window.isProbablyReaderable(sourceDocument)) throw new Error('No readable article content');
        var article = new window.Readability(sourceDocument.cloneNode(true), { charThreshold: 400 }).parse();
        if (!article || !article.content || (article.length || 0) < 400) throw new Error('No readable article content');
        result.status = 'ready';
        result.title = article.title || '';
        result.byline = article.byline || '';
        result.published = article.publishedTime || '';
        result.content = sanitizedReaderContent(article.content, page.url);
      })
      .catch(function () { result.status = 'unavailable'; })
      .finally(function () {
        if (state.publisherArticle && safeExternalUrl(state.publisherArticle.url) === url) render();
      });
  }

  function articlePublishedLabel(raw) {
    var date = new Date(raw);
    if (!raw || !Number.isFinite(date.getTime())) return 'Date unavailable';
    return date.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
    });
  }

  function renderPaperArticle(a, publisher) {
    var image = safeAsset(a.image);
    return '<article class="paper-source-article' + (image ? ' has-image' : '') + '">' +
      (image ? nativePublisherImageLink(a, publisher, image) : '') +
      '<div class="paper-source-copy">' +
      '<div class="news-card-meta"><span class="publisher-tag">' + esc(publisher) + '</span><time>' + esc(articlePublishedLabel(a.published)) + '</time></div>' +
      '<h3>' + nativePublisherArticleLink(a, publisher, a.title) + '</h3>' +
      (a.summary ? '<p class="paper-source-summary">' + esc(a.summary) + '</p>' : '') +
      '<div class="paper-source-actions">' +
      nativePublisherArticleLink(a, publisher, 'Read in Pheme →', 'paper-source-primary') +
      (a.topic ? '<span class="paper-source-topic">' + esc(labelOf[a.topic] || a.topic) + '</span>' : '') +
      '</div></div></article>';
  }

  function renderPublisherArticle(entry) {
    var candidate = serverArticleFor(entry.url);
    var serverItem = candidate && candidate.publisher === entry.name ? candidate : null;
    var item = publisherArticleFor(entry.name, entry.url) || serverItem || entry;
    var extraction = publisherReaderCache[safeExternalUrl(entry.url)];
    var serverFullText = serverItem && serverItem.status === 'licensed-full-text' &&
      Array.isArray(serverItem.paragraphs) && serverItem.paragraphs.length > 0;
    var extracted = (extraction && extraction.status === 'ready') || serverFullText;
    var title = (extraction && extraction.status === 'ready' && extraction.title) || item.title || entry.title || ('Latest reporting from ' + entry.name);
    var summary = item.summary || entry.summary || '';
    var published = (extraction && extraction.status === 'ready' && extraction.published) || item.published || entry.published;
    var image = safeAsset(item.image || entry.image);
    var safe = safeExternalUrl(entry.url);
    var isReference = serverItem && serverItem.status === 'edition-reference' && !publisherArticleFor(entry.name, entry.url);
    var isMetadata = serverItem && serverItem.status === 'publisher-metadata' && !publisherArticleFor(entry.name, entry.url);
    var hasContext = isReference && serverItem.context;
    return '<article class="source-reader" aria-labelledby="source-reader-title">' +
      '<div class="source-reader-top"><button type="button" class="textlink" data-act="closesourcearticle" data-name="' + esc(entry.name) + '">← Back to ' + esc(entry.name) + '</button><span class="source-reader-label">' + (extracted ? 'Article in Pheme' : isReference ? 'Source reference' : isMetadata ? 'Publisher metadata preview' : 'Publisher RSS preview') + '</span></div>' +
      '<header class="source-reader-head"><p class="kicker">' + esc(entry.name) + ' · ' + (extracted ? 'Publisher article' : isReference ? 'Source referenced in Pheme edition' : isMetadata ? 'Publisher page metadata' : 'Publisher RSS') + '</p>' +
      (published ? '<time>' + esc(articlePublishedLabel(published)) + '</time>' : '') +
      (extraction && extraction.byline ? '<p class="source-reader-byline">' + esc(extraction.byline) + '</p>' : '') +
      '<h1 id="source-reader-title">' + esc(title) + '</h1></header>' +
      (image ? '<figure class="source-reader-photo"><img src="' + esc(image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></figure>' : '') +
      '<div class="source-reader-body">' +
      (serverFullText ? '<div class="source-reader-content">' +
        serverItem.paragraphs.map(function (paragraph) { return '<p>' + esc(paragraph) + '</p>'; }).join('') +
        '</div>' : extraction && extraction.status === 'ready'
        ? '<div class="source-reader-content">' + extraction.content + '</div>'
        : (summary ? '<p class="source-reader-summary">' + esc(summary) + '</p>'
        : hasContext
        ? '<div class="source-reader-context"><strong>Pheme editorial context — not publisher text</strong><p>' + esc(serverItem.context) + '</p></div>'
        : '<p class="notice">No publisher RSS excerpt was supplied. Continue to the original article for full reporting.</p>')) +
      (serverFullText ? '<p class="source-reader-note">Article text supplied through an approved publisher integration, cached on Pheme’s server. Attribution and original link retained.</p>' :
        extracted ? '<p class="source-reader-note">Readability cleaned the publicly available article page. Restricted or paywalled text is not retrieved.</p>' :
        '<p class="source-reader-note">' +
        (extraction && extraction.status === 'external'
          ? (isReference
              ? 'The publisher article is no longer in the available RSS feed. Pheme retained its source link and any original headline from the editorial edition; the full publisher text has not been retrieved.'
              : isMetadata
              ? 'Pheme recovered limited public title/description metadata from the publisher page, where permitted. This is not the full article; use the original publisher link.'
              : 'Publisher-hosted article text is not available for authorised in-site reading. The latest available RSS preview appears above; open the original link for the full story.')
          : extraction && extraction.status === 'unavailable'
          ? 'Pheme could not retrieve this publisher’s full article. The publisher may restrict automated access. ' + (summary ? 'The available RSS excerpt is shown above.' : 'No RSS excerpt is available.')
          : 'Pheme is checking whether the publisher allows a readable version.' + (summary ? ' The RSS excerpt is shown while it loads.' : '')) +
        '</p>') +
      (publisherRequiresSubscription(entry.name) ? '<p class="source-reader-access">The publisher may require a subscription for the full article.</p>' : '') +
      '</div>' +
      '<div class="source-reader-actions">' + (safe ? originalArticleLink(safe, entry.name, 'Continue to ' + entry.name + ' ↗', 'darkbtn') : '') +
      '<button type="button" class="outline-sm" data-act="closesourcearticle" data-name="' + esc(entry.name) + '">Back to publisher feed</button></div></article>';
  }

  function paperArticleBody(name, meta, stories) {
    var details = publisherDetails(name);
    if (!publisherFeed) return '<div class="notice" role="status">' +
      (publisherFeedError ? 'Publisher feeds are temporarily unavailable. Try again later.' : 'Loading recent articles from publisher feeds…') + '</div>';
    if (!details || details.status === 'unavailable') return '<div class="notice">No verified, working RSS feed is currently available for ' + esc(name) + '. We will not attribute unrelated articles to this publisher.' +
      (name === 'ITV News' ? ' <a href="https://www.itv.com/news" target="_blank" rel="noopener noreferrer">Read ITV News directly</a> while a reliable syndication source is verified.' : '') + '</div>';
    var stamp = details.updatedAt ? articlePublishedLabel(details.updatedAt) : 'Unavailable';
    var status = '<p class="paper-feed-updated">' +
      (details.status === 'stale' ? 'Cached articles · live refresh unavailable' : 'Publisher RSS · last collected ' + esc(stamp)) + '</p>';
    return status + (stories.length
      ? '<div class="paper-story-feed" aria-label="Latest publisher articles from ' + esc(name) + '">' +
        stories.map(function (a) { return renderPaperArticle(a, name); }).join('') + '</div>'
      : '<div class="notice">No recent published articles were returned by the available feeds for ' + esc(name) + '.</div>');
  }

  function selectPaperInPlace(name) {
    var papers = allPublisherChoices();
    if (!papers.some(function (p) { return p.name === name; })) return;
    var section = app.querySelector('.paper-sheet');
    var feed = app.querySelector('#paper-article-content');
    var title = app.querySelector('#paper-name');
    var dateline = app.querySelector('#paper-article-total');
    var rail = app.querySelector('#paper-provider-track');
    if (!section || !feed || !title || !dateline || !rail) {
      state.paper = name;
      render();
      return;
    }
    state.paper = name;
    var meta = papers.find(function (p) { return p.name === name; }) || {};
    var stories = storiesForPaper(name);
    title.textContent = name;
    dateline.textContent = plural(stories.length, 'article', 'articles');
    feed.innerHTML = paperArticleBody(name, meta, stories);
    rail.querySelectorAll('[data-act="paper"]').forEach(function (tab) {
      var selected = tab.getAttribute('data-name') === name;
      tab.classList.toggle('on', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    section.setAttribute('aria-label', 'Articles from ' + name);
    updateSiteScrollTone();
  }

  var paperScrollQueued = false;
  function updateSiteScrollTone() {
    // Reach the deepest stone shade at 60% of the available vertical scroll.
    // This applies to briefing, newspapers and article-reader views alike.
    var root = document.documentElement;
    var maxScroll = Math.max(0, root.scrollHeight - window.innerHeight);
    var scrolled = Math.max(0, window.scrollY || root.scrollTop || 0);
    var progress = maxScroll > 0 ? Math.min(1, scrolled / (maxScroll * 0.6)) : 0;
    function channel(start, finish) { return Math.round(start + (finish - start) * progress); }
    var paperColor = 'rgb(' + channel(233, 145) + ', ' + channel(226, 128) + ', ' + channel(211, 109) + ')';
    var outerColor = 'rgb(' + channel(227, 125) + ', ' + channel(216, 109) + ', ' + channel(198, 92) + ')';
    root.style.setProperty('--paper-scroll-background', paperColor);
    root.style.setProperty('--paper-scroll-outer', outerColor);
  }
  window.addEventListener('scroll', function () {
    if (paperScrollQueued) return;
    paperScrollQueued = true;
    requestAnimationFrame(function () {
      paperScrollQueued = false;
      updateSiteScrollTone();
    });
  }, { passive: true });
  window.addEventListener('resize', updateSiteScrollTone, { passive: true });

  // Render newspaper marks locally so they remain visible when publisher icon services are blocked.
  var PUBLISHER_WORDMARKS = {
    'BBC News': { type: 'bbc', html: '<span>B</span><span>B</span><span>C</span>' },
    'The Guardian': { type: 'guardian', html: '<span>The</span><span>Guardian</span>' },
    'Sky News': { type: 'sky', html: '<span>sky</span><span>news</span>' },
    'Al Jazeera English': { type: 'aj', html: 'AJ' },
    'Financial Times': { type: 'ft', html: 'FT' },
    'The Economist': { type: 'economist', html: '<span>The</span><span>Economist</span>' }
  };
  var PUBLISHER_DOMAINS = {
    'ABC News Australia': 'abc.net.au',
    'Al Jazeera English': 'aljazeera.com',
    'Al-Monitor': 'al-monitor.com',
    'Ars Technica': 'arstechnica.com',
    'Associated Press': 'apnews.com',
    'BBC News': 'bbc.co.uk',
    'Bangkok Post': 'bangkokpost.com',
    'Bloomberg': 'bloomberg.com',
    'CNA': 'channelnewsasia.com',
    'CNBC': 'cnbc.com',
    'City AM': 'cityam.com',
    'DW News': 'dw.com',
    'Daily Mail': 'dailymail.com',
    'Daily Maverick': 'dailymaverick.co.za',
    'Dawn': 'dawn.com',
    'Euronews': 'euronews.com',
    'Financial Times': 'ft.com',
    'Fox News': 'foxnews.com',
    'France 24': 'france24.com',
    'Global News': 'globalnews.ca',
    'Haaretz': 'haaretz.com',
    'ITV News': 'itv.com',
    'Independent Online': 'iol.co.za',
    'Indian Express': 'indianexpress.com',
    'Japan Times': 'japantimes.co.jp',
    'MercoPress': 'mercopress.com',
    'Mexico News Daily': 'mexiconewsdaily.com',
    'Middle East Eye': 'middleeasteye.net',
    'NDTV': 'ndtv.com',
    'NPR': 'npr.org',
    'NZ Herald': 'nzherald.co.nz',
    'Nation (Kenya)': 'nation.africa',
    'Nature News': 'nature.com',
    'New Scientist': 'newscientist.com',
    'Philippine Daily Inquirer': 'inquirer.net',
    'Politico Europe': 'politico.eu',
    'Premium Times': 'premiumtimesng.com',
    'RNZ': 'rnz.co.nz',
    'RTÉ News': 'rte.ie',
    'Rappler': 'rappler.com',
    'Reuters': 'reuters.com',
    'ScienceDaily': 'sciencedaily.com',
    'Sky News': 'news.sky.com',
    'South China Morning Post': 'scmp.com',
    'Sydney Morning Herald': 'smh.com.au',
    'Taipei Times': 'taipeitimes.com',
    'TechCrunch': 'techcrunch.com',
    'The Age': 'theage.com.au',
    'The Conversation': 'theconversation.com',
    'The Conversation UK': 'theconversation.com',
    'The Economist': 'economist.com',
    'The Globe and Mail': 'theglobeandmail.com',
    'The Guardian': 'theguardian.com',
    'The Hindu': 'thehindu.com',
    'The Independent': 'independent.co.uk',
    'The Jerusalem Post': 'jpost.com',
    'The Korea Times': 'koreatimes.co.kr',
    'The New York Times': 'nytimes.com',
    'The Rio Times': 'riotimesonline.com',
    'The Straits Times': 'straitstimes.com',
    'The Sun - Nigeria': 'thesun.ng',
    'The Telegraph': 'telegraph.co.uk',
    'The Times': 'thetimes.com',
    'The Verge': 'theverge.com',
    'The Wall Street Journal': 'wsj.com',
    'VnExpress International': 'vnexpress.net',
    'Wired': 'wired.com',
    'Ukrainska Pravda': 'pravda.com.ua',
    'Yonhap': 'yna.co.kr',
    'STAT': 'statnews.com'
  };
  var PUBLISHER_MARK_PALETTE = [
    ['#17395F', '#E8EFF7'], ['#8E2A34', '#F8E8E2'], ['#24584B', '#E5EEE7'],
    ['#5A3C7D', '#EEE8F5'], ['#7A4A18', '#F5EBDD'], ['#263746', '#E7EDF0'],
    ['#A33A23', '#FAE9E3'], ['#3F536F', '#E8EDF4']
  ];

  function newspaperWordmark(name) {
    var wordmark = PUBLISHER_WORDMARKS[name];
    if (wordmark) return '<span class="paper-logo paper-logo-' + wordmark.type + '" aria-hidden="true">' + wordmark.html + '</span>';
    var words = name.replace(/^The\s+/i, '').split(/\s+/).filter(function (part) { return !/^(of|and|news|english)$/i.test(part); });
    var initials = words.slice(0, 3).map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || name.slice(0, 2).toUpperCase();
    var hash = name.split('').reduce(function (value, character) { return (value * 31 + character.charCodeAt(0)) >>> 0; }, 7);
    var colors = PUBLISHER_MARK_PALETTE[hash % PUBLISHER_MARK_PALETTE.length];
    var fallback = '<span class="paper-logo paper-logo-generic" aria-hidden="true" style="--publisher-mark-ink:' + colors[0] + ';--publisher-mark-bg:' + colors[1] + '"><span class="paper-logo-initials">' + esc(initials) + '</span><span class="paper-logo-name">' + esc(name) + '</span></span>';
    var domain = PUBLISHER_DOMAINS[name];
    if (!domain) return fallback;
    var icon = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(domain) + '&sz=128';
    return '<span class="paper-logo-asset"><img class="paper-logo-image" src="' + esc(icon) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' + fallback + '</span>';
  }

  function renderPapers() {
    var featuredOrder = ['BBC News', 'The Guardian', 'Sky News', 'Al Jazeera English', 'Financial Times', 'The Economist'];
    var papers = allPublisherChoices().sort(function (a, b) {
      var ai = featuredOrder.indexOf(a.name), bi = featuredOrder.indexOf(b.name);
      return (ai === -1 ? featuredOrder.length : ai) - (bi === -1 ? featuredOrder.length : bi);
    });
    if (!papers.length) {
      return '<div class="page-head"><h1>Newspapers</h1><p>Follow publishers to build your newspaper feed.</p></div>' +
        '<button class="chip" data-act="settings">+ Add newspaper</button>';
    }
    var name = state.paper && papers.some(function (p) { return p.name === state.paper; }) ? state.paper : papers[0].name;
    var meta = papers.filter(function (p) { return p.name === name; })[0] || {};
    var stories = storiesForPaper(name);
    var tabs = papers.map(function (p) {
      var on = p.name === name;
      var count = storiesForPaper(p.name).length;
      return '<button class="paper-provider' + (on ? ' on' : '') + '" data-act="paper" data-name="' + esc(p.name) +
        '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '">' +
        '<span class="paper-provider-logo-wrap">' + newspaperWordmark(p.name) + '</span>' +
        '<span class="paper-provider-name">' + esc(p.name) + '</span>' +
        '<span class="paper-provider-count">' + count + ' ' + (count === 1 ? 'article' : 'articles') + '</span></button>';
    }).join('') + '<button class="paper-provider paper-provider-add" data-act="settings">+ Add newspaper</button>';

    var body = paperArticleBody(name, meta, stories);

    return '<div class="page-head"><h1>Newspapers</h1><p>Browse publishers sideways. Scroll down for their latest coverage.</p></div>' +
      '<section class="paper-providers" aria-label="Newspaper providers">' +
      '<div class="paper-providers-head"><h2>Publishers <span>' + papers.length + '</span></h2>' +
      '<div class="paper-carousel-controls">' +
      '<button type="button" class="paper-carousel-arrow" data-act="paperscroll" data-dir="-1" aria-label="Scroll publishers left">‹</button>' +
      '<button type="button" class="paper-carousel-arrow" data-act="paperscroll" data-dir="1" aria-label="Scroll publishers right">›</button>' +
      '</div></div>' +
      '<div class="paper-provider-track" id="paper-provider-track" role="tablist" aria-label="Choose newspaper">' + tabs + '</div></section>' +
      '<section class="publisher-map-section" aria-labelledby="publisher-map-heading">' +
      '<div class="publisher-map-heading"><div><h2 id="publisher-map-heading">Publishers around the world</h2>' +
      '<p>Markers show where news organisations are based. They do not geolocate article events.</p></div>' +
      '<button class="map-region-btn" type="button" data-act="publishermapreset">Global view</button></div>' +
      '<div id="publisher-world-map" class="publisher-world-map" role="region" aria-label="Interactive map of global news publisher editorial bases"></div>' +
      '<p id="publisher-map-status" class="publisher-map-status" role="status">Loading publisher locations…</p></section>' +
      '<section class="paper-sheet" aria-labelledby="paper-name">' +
      '<header class="paper-masthead"><div class="paper-masthead-text"><h2 id="paper-name">' + esc(name) + '</h2>' +
      '<span class="paper-dateline">Edition coverage · ' + esc(D.META.rangeLong) + '</span></div>' +
      '<span class="paper-article-total">' + esc(plural(stories.length, 'article', 'articles')) + '</span></header>' +
      '<div id="paper-article-content" role="tabpanel" aria-labelledby="paper-name" aria-live="polite" aria-atomic="false">' + body + '</div></section>';
  }

  /* ---------- Native Story Reader & Coverage Comparison ---------- */
  var ARTICLE_BOILERPLATE = /Across Pheme[’']s|Use the leaning filter|Pheme is tracking|Reported by \d+ outlets|First reported by|Coverage: \d|select an outlet to read|open any original article/i;
  function getArticleParagraphs(s) {
    var paragraphs = Array.isArray(s.article) ? s.article : [];
    if (paragraphs.length < 2 || !paragraphs.every(function (p) { return typeof p === 'string' && p.trim() && !ARTICLE_BOILERPLATE.test(p); })) return [];
    if (paragraphs.join(' ').trim().split(/\s+/).length < 80) return [];
    return paragraphs;
  }

  function estimateReadTime(s) {
    var parts = [s.headline, s.summary].concat(getArticleParagraphs(s));
    var words = parts.join(' ').trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 210)) + ' min read';
  }

  function syncSpeakingDom() {
    var btn = app.querySelector('[data-act="togglelisten"]');
    if (btn) {
      btn.classList.toggle('on', state.audioOpen || state.speaking);
      btn.innerHTML = (state.speaking ? ICON.pause + 'Pause' : ICON.listen + 'Listen');
    }
    var player = app.querySelector('.voice-player');
    if (player) {
      player.classList.toggle('is-playing', state.speaking);
      player.classList.toggle('is-loading', state.audioLoading);
      var playBtn = player.querySelector('[data-act="voiceplay"]');
      if (playBtn) {
        playBtn.innerHTML = state.speaking ? ICON.pause : ICON.play;
        playBtn.setAttribute('aria-label', state.speaking ? 'Pause narration' : 'Play narration');
      }
      var scrub = document.getElementById('voice-scrub');
      var dur = state.audioDuration || 0;
      if (scrub && dur > 0) {
        scrub.max = String(dur.toFixed(2));
        if (document.activeElement !== scrub) scrub.value = String(Math.min(dur, state.audioTime).toFixed(2));
        scrub.style.setProperty('--progress', (Math.min(100, (state.audioTime / dur) * 100)).toFixed(2) + '%');
      }
      var curEl = document.getElementById('voice-cur');
      if (curEl) curEl.textContent = formatAudioTime(state.audioTime);
      var durEl = document.getElementById('voice-dur');
      if (durEl && dur > 0) durEl.textContent = formatAudioTime(dur);
      var rateBtn = player.querySelector('[data-act="speechrate"]');
      if (rateBtn) rateBtn.textContent = state.speechRate + '×';
    }
    app.querySelectorAll('.reader-para').forEach(function (el) {
      var idx = Number(el.getAttribute('data-pidx'));
      el.classList.toggle('speaking', (state.speaking || state.audioOpen) && idx === state.speakingIndex && state.speakingIndex >= 0);
    });
  }

  function renderVoicePlayer(s) {
    if (!state.audioOpen) return '';
    var track = audioTrackFor(s.id, state.readerPrefs.voice || 'ava');
    if (!track || state.audioError) {
      return '<section class="voice-player voice-player-note" aria-label="Article narration">' +
        '<span class="voice-orb" aria-hidden="true"></span>' +
        '<p class="voice-status">' + esc(state.audioError || 'Natural voice narration isn’t available for this archived story yet.') + '</p>' +
        '<button type="button" class="voice-close" data-act="closeaudio" aria-label="Close audio player">' + ICON.close + '</button>' +
        '</section>';
    }
    var allVoices = audioVoices();
    var storyVoicesMap = (audioManifest && audioManifest.stories && audioManifest.stories[s.id] && audioManifest.stories[s.id].voices) || {};
    var voices = allVoices.filter(function (v) { return !!storyVoicesMap[v.id]; });
    if (!voices.length) voices = allVoices;
    var activeVoiceId = track.voiceId;
    var activeMeta = voices.find(function (v) { return v.id === activeVoiceId; }) || voices[0];
    var dur = state.audioStoryId === s.id && state.audioDuration ? state.audioDuration : (track.duration || 0);
    var cur = state.audioStoryId === s.id ? state.audioTime : 0;
    var pct = dur > 0 ? Math.min(100, (cur / dur) * 100).toFixed(2) : '0';
    var voicePills = voices.length > 1
      ? '<div class="voice-row" role="group" aria-label="Choose narrator"><span class="voice-row-label">Voice</span><div class="voice-switcher">' + voices.map(function (v) {
          var on = v.id === activeVoiceId;
          return '<button type="button" class="voice-pill' + (on ? ' on' : '') + '" data-act="voicepick" data-id="' + esc(v.id) + '" aria-pressed="' + on + '" title="' + esc(v.label + ' — ' + (v.tagline || 'Natural voice')) + '">' +
            esc(v.label) + (v.accent ? '<span class="voice-accent">' + esc(v.accent) + '</span>' : '') + '</button>';
        }).join('') + '</div></div>'
      : '';
    return '<section class="voice-player' + (state.speaking ? ' is-playing' : '') + (state.audioLoading ? ' is-loading' : '') + '" aria-label="Natural voice narration">' +
      '<div class="voice-main">' +
      '<button type="button" class="voice-play-btn" data-act="voiceplay" aria-label="' + (state.speaking ? 'Pause narration' : 'Play narration') + '">' +
      (state.speaking ? ICON.pause : ICON.play) + '</button>' +
      '<div class="voice-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>' +
      '<div class="voice-track">' +
      '<div class="voice-head">' +
      '<span class="voice-name">' + esc(activeMeta.label) + '<small>' + esc(activeMeta.tagline || 'Natural voice') + '</small></span>' +
      '<span class="voice-time"><span id="voice-cur">' + formatAudioTime(cur) + '</span> / <span id="voice-dur">' + formatAudioTime(dur) + '</span></span>' +
      '</div>' +
      '<input id="voice-scrub" class="voice-scrub" type="range" min="0" max="' + esc(String((dur || 1).toFixed(2))) + '" step="0.1" value="' + esc(String(cur.toFixed(2))) + '" style="--progress:' + pct + '%" aria-label="Seek narration position">' +
      '</div></div>' +
      '<div class="voice-controls">' +
      '<div class="voice-skip-group">' +
      '<button type="button" class="voice-chip" data-act="voiceseek" data-id="-15" aria-label="Rewind 15 seconds">−15s</button>' +
      '<button type="button" class="voice-chip" data-act="voiceseek" data-id="15" aria-label="Skip forward 15 seconds">+15s</button>' +
      '<button type="button" class="voice-chip" data-act="speechrate" aria-label="Playback speed">' + state.speechRate + '×</button>' +
      '</div>' +
      '<button type="button" class="voice-close" data-act="closeaudio" aria-label="Close audio player">' + ICON.close + '</button>' +
      '</div>' + voicePills + '</section>';
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
            return row ? nativePublisherArticleLink(publisherPreview(name, row.url, row.title || s.headline, row.date), name, name + ' ↗', 'source-inline-link') : '';
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
    var back = state.readingSource ? 'Back to story' : (state.view === 'papers' ? 'Back to ' + (state.paper || followed()[0].name) : (state.view === 'saved' ? 'Back to saved' : (state.view === 'trading' ? 'Back to Trading' : 'Back to Pheme')));
    var more = STORIES.filter(function (o) { return o.source === s.source && o.id !== s.id; }).slice(0, 3);
    var cov = s.cov;
    var selectedSource = cov.rows.find(function (r) { return r.name === state.readingSource; });
    var primarySource = selectedSource || cov.rows.find(function (r) { return r.url === s.url; }) || { name: s.source, url: s.url };
    var selectedSourceArticle = selectedSource && publisherArticleFor(selectedSource.name, selectedSource.url);
    var selectedSourcePreview = selectedSource && publisherPreview(selectedSource.name, selectedSource.url, selectedSource.title, selectedSource.date);
    var primarySourcePreview = publisherPreview(primarySource.name, primarySource.url, primarySource.title || s.headline, s.publishedLabel || s.time);
    var sourceContext = selectedSource ? '<aside class="source-context" aria-label="Selected publisher coverage"><p class="kicker">' + esc(selectedSource.name) + ' · ' + esc(selectedSource.date) + '</p>' +
      (selectedSource.title ? '<h2>' + esc(selectedSource.title) + '</h2>' : '') +
      (selectedSourceArticle && selectedSourceArticle.summary ? '<p class="source-context-summary">' + esc(selectedSourceArticle.summary) + '</p><p class="source-context-note">Publisher-provided RSS excerpt</p>' : '<p class="source-context-note">' + (publisherFeed ? 'The available publisher feed has no excerpt for this article.' : (publisherFeedError ? 'Publisher excerpts are temporarily unavailable.' : 'Checking the publisher feed for an excerpt.')) + '</p>') +
      '<div class="source-context-foot"><p class="small">Pheme’s multi-source briefing continues below.</p>' +
      nativePublisherArticleLink(selectedSourcePreview, selectedSource.name, 'Read source in Pheme →', 'outline-sm') +
      '</div></aside>' : '';
    var img = safeAsset(s.image);
    var paras = getArticleParagraphs(s);
    var takeaways = (s.points || []).filter(function (point) { return typeof point === 'string' && !ARTICLE_BOILERPLATE.test(point); });
    var articleDate = s.articleUpdatedAt ? new Date(s.articleUpdatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : (s.publishedLabel || s.time);
    var storyHighlights = state.highlights[s.id] || {};
    var hlCount = Object.keys(storyHighlights).filter(function (k) { return storyHighlights[k]; }).length;
    var p = state.readerPrefs;
    var canSpeak = paras.length && !!audioTrackFor(s.id, p.voice || 'ava');

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
        ? '<button type="button" class="rtool' + (state.audioOpen || state.speaking ? ' on' : '') + '" data-act="togglelisten">' +
          (state.speaking ? ICON.pause + 'Pause' : ICON.listen + 'Listen') + '</button>'
        : '') +
      '<button type="button" class="rtool' + (state.aaOpen ? ' on' : '') + '" data-act="toggleaa" aria-expanded="' + state.aaOpen + '">Aa</button>' +
      '<button type="button" class="rtool' + (state.readerFocus ? ' on' : '') + '" data-act="togglefocus" title="Distraction-free Focus mode (F)">' + ICON.focus + (state.readerFocus ? 'Exit focus' : 'Focus') + '</button>' +
      '<button type="button" class="rtool" data-act="copylink" data-id="' + esc(s.id) + '">' + ICON.link + (state.copiedId === s.id ? 'Copied' : 'Share') + '</button>' +
      saveBtn(s) +
      renderAaPopover() +
      '</div></div>' +
      '<p class="kicker">' + esc(labelOf[s.topic]) +
      '<span class="kicker-meta">Pheme · ' + esc(articleDate) +
      (s.location ? ' · <button type="button" class="loc-chip" data-act="openonmap" data-id="' + esc(s.id) + '">' + esc(s.location.label) + '</button>' : '') +
      (safeExternalUrl(primarySource.url) ? ' · ' + nativePublisherArticleLink(primarySourcePreview, primarySource.name, 'Lead article: ' + primarySource.name + ' →', 'loc-chip') : '') +
      '</span></p>' +
      '<h1 id="reader-title">' + esc(s.headline) + '</h1>' +
      '<p class="standfirst">' + esc(s.summary) + '</p>' +
      renderVoicePlayer(s) +
      sourceContext +
      (img ? (function () {
        var capParts = [];
        if (s.imageAlt && s.imageAlt !== s.headline) capParts.push(esc(s.imageAlt));
        if (s.imageCredit) capParts.push('Photo: ' + esc(s.imageCredit));
        return '<figure class="reader-photo"><img src="' + esc(img) + '" alt="' + esc(s.imageAlt || s.headline) + '" referrerpolicy="no-referrer">' +
          (capParts.length ? '<figcaption class="reader-caption">' + capParts.join(' · ') + '</figcaption>' : '') + '</figure>';
      })() : '') +
      '<div class="reader-body">' +
      (paras.length ? paras.map(function (para, idx) {
        var hl = !!storyHighlights[idx];
        var sp = state.speaking && state.speakingIndex === idx;
        return '<p class="reader-para' + (hl ? ' hl-on' : '') + (sp ? ' speaking' : '') + '" data-act="highlight" data-id="' + esc(s.id) + '" data-pidx="' + idx + '" title="Click to highlight passage">' + esc(para) + '</p>';
      }).join('') : '<section class="article-unavailable"><h2>Article not available</h2><p>A full Pheme article has not been written for this story. Its original summary and source list are available here.</p></section>') +
      '</div>' +
      (paras.length ? '<p class="reader-hint">Tip: click any paragraph to highlight' + (hlCount ? ' · ' + plural(hlCount, 'highlight', 'highlights') + ' saved' : '') + ' · press F for Focus mode · ← / → for previous &amp; next story.</p>' : '') +
      (takeaways.length
        ? '<section class="takeaways-box"><h2>Key takeaways</h2><ul class="points">' +
          takeaways.map(function (pt) { return '<li>' + esc(pt) + '</li>'; }).join('') +
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
        var safeUrl = safeExternalUrl(r.url);
        return '<li>' + leanBadge(r.name) +
          '<div class="cov-outlet-col"><span class="name">' + esc(r.name) + '</span>' +
          (r.title ? (safeUrl ? nativePublisherArticleLink(publisherPreview(r.name, r.url, r.title, r.date), r.name, r.title, 'cov-outlet-hl cov-outlet-hl-link') : '<span class="cov-outlet-hl">' + esc(r.title) + '</span>') : '') +
          '</div>' +
          '<span class="small">' + esc(r.date) + '</span>' +
          nativePublisherArticleLink(publisherPreview(r.name, r.url, r.title || s.headline, r.date), r.name, 'Read in Pheme →') + '</li>';
      }).join('') + '</ul></section>' +
      '<div class="rfoot"><p class="small" style="max-width:60ch">' + (paras.length ? 'Written for Pheme from published reporting' + (s.articleSources && s.articleSources.length ? ' by ' + s.articleSources.map(function (source) { return nativePublisherArticleLink(publisherPreview(source.name, source.url, s.headline, s.publishedLabel || s.time), source.name, source.name, 'source-inline-link') || esc(source.name); }).join(', ') : '') + '.' : 'Source coverage for this archived story.') + '</p>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' + saveBtn(s) +
      nativePublisherArticleLink(primarySourcePreview, primarySource.name, 'Open source in Pheme →', 'darkbtn') + '</div></div>' +
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
      '<fieldset class="widget-settings"><legend>Trading and clocks</legend><label class="widget-choice"><input id="show-clock" type="checkbox"' + (state.headerPrefs.showClock ? ' checked' : '') + '><span>Show clocks<small>Analog clocks for London, New York and Shanghai</small></span></label></fieldset>' +
      '<fieldset class="widget-settings"><legend>Stock exchanges</legend><p class="small">Choose the markets shown in your toolbar. Your choices are saved in this browser.</p>' + marketChoices + '</fieldset>' +
      '<h3 class="settings-section-title">Newspapers</h3>' +
      '<p class="small">Pin newspapers for quick access to any stories featured in Pheme.</p>' +
      '<div class="settings-search">' + ICON.search + '<label for="src-q" class="sr-only">Search newspapers</label>' +
      '<input id="src-q" type="search" placeholder="Search newspapers, e.g. Telegraph" value="' + esc(state.srcQuery) + '" autocomplete="off"></div>' +
      '<div id="src-list">' + sourceListHtml() + '</div>' +
      '</div><div class="settings-foot"><button class="darkbtn" data-act="close">Done</button></div></div>';
  }

  /* Workspace widget controls: enlarge dense third-party embeds without a page reload. */
  function enhanceMarketWidgets() {
    if (state.view !== 'trading' || state.reading) return;
    app.querySelectorAll('.ws-panel .ws-widget').forEach(function (widget, idx) {
      var head = widget.querySelector(':scope > .ws-widget-head');
      if (!head || head.querySelector('[data-act="wsexpand"]')) return;
      var heading = head.querySelector('h2,h3');
      if (!heading) return;
      if (!widget.id) widget.id = 'ws-panel-' + idx;
      var controls = document.createElement('span');
      controls.className = 'ws-widget-actions';
      var control = document.createElement('button');
      control.type = 'button';
      control.className = 'ws-expand-button';
      control.setAttribute('data-act', 'wsexpand');
      control.setAttribute('data-id', widget.id);
      control.setAttribute('aria-label', 'Expand ' + heading.textContent);
      control.setAttribute('aria-expanded','false');
      control.title = 'Expand widget';
      control.textContent = '⤢';
      controls.appendChild(control);
      head.appendChild(controls);
    });
  }

  function closeExpandedMarketWidget() {
    var widget = app.querySelector('.ws-widget.ws-expanded');
    if (!widget) return false;
    widget.classList.remove('ws-expanded');
    document.body.classList.remove('ws-expanded-active');
    var button = widget.querySelector('[data-act="wsexpand"]');
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', button.getAttribute('aria-label').replace(/^Collapse /,'Expand '));
      button.textContent = '⤢';
      button.title = 'Expand widget';
      button.focus();
    }
    if (exchangeMap && widget.querySelector('#exchange-world-map')) {
      setTimeout(function () { if (exchangeMap) exchangeMap.invalidateSize(); }, 0);
    }
    return true;
  }

  function render(opts) {
    document.body.classList.toggle('market-chart-open', !!state.marketOpen);
    var previousMarkets = document.getElementById('market-widgets');
    var previousTicker = document.getElementById('ws-ticker-tape');
    var settingsScroll = app.querySelector('.settings-body');
    var previousSettingsScroll = settingsScroll ? settingsScroll.scrollTop : 0;
    if (worldMap) { worldMap.remove(); worldMap = null; worldMarkerLayer = null; mapPinById = Object.create(null); }
    if (publisherMap) { publisherMap.remove(); publisherMap = null; publisherMapLayer = null; }
    if (exchangeMap) { exchangeMap.remove(); exchangeMap = null; exchangeMapLayer = null; }
    var reading = state.reading ? byId[state.reading] : null;
    syncBodyReaderClasses();
    var main;
    if (state.publisherArticle) main = renderPublisherArticle(state.publisherArticle);
    else if (reading) main = renderReader(reading);
    else if (state.view === 'papers') main = renderPapers();
    else if (state.view === 'trading') main = renderTrading();
    else main = renderBriefing();

    app.innerHTML = '<div class="dashboard-shell">' + renderSidebar() + '<div class="dashboard-body">' + renderHeader() +
      '<main class="wrap page-main" id="main">' + main + '</main></div></div>' +
      renderSettings() + renderMarketDialog();

    if (state.publisherArticle) loadPublisherArticleContent(state.publisherArticle);

    var nextMarkets = document.getElementById('market-widgets');
    if (previousMarkets && nextMarkets && previousMarkets.getAttribute('data-markets') === nextMarkets.getAttribute('data-markets')) {
      nextMarkets.replaceWith(previousMarkets);
    }
    var nextTicker = document.getElementById('ws-ticker-tape');
    if (previousTicker && nextTicker && previousTicker.getAttribute('data-tv-loaded') === 'yes') {
      nextTicker.replaceWith(previousTicker);
    }
    settingsScroll = app.querySelector('.settings-body');
    if (settingsScroll) settingsScroll.scrollTop = previousSettingsScroll;
    updateClocks();
    updateSessionCards();

    if (state.view === 'trading' && !state.publisherArticle && !state.reading) {
      var selectedTab = app.querySelector('.ws-tabs button.active');
      if (selectedTab && selectedTab.parentElement) {
        var rail = selectedTab.parentElement;
        var desiredLeft = selectedTab.offsetLeft - rail.offsetLeft - (rail.clientWidth - selectedTab.offsetWidth) / 2;
        rail.scrollLeft = Math.max(0, desiredLeft);
      }
    }
    if (state.view === 'trading') loadCompanyDirectory();
    mountWorldMap();
    mountPublisherMap();
    mountExchangeMap();
    mountTradingViewMarkets();
    mountWorkspaceCompanyChart();
    mountWorkspaceScreener();
    enhanceMarketWidgets();
    updateReadProgress();
    updateSiteScrollTone();
    if (opts && opts.focus) {
      var el = document.getElementById(opts.focus);
      if (el) { el.focus(); if (el.setSelectionRange && el.value) el.setSelectionRange(el.value.length, el.value.length); }
    }
    if (opts && opts.scrollReader) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /* ---------- events ---------- */
  app.addEventListener('change', function (event) {
    if (!event.target || event.target.id !== 'ws-mobile-section') return;
    var next = event.target.value;
    if (['overview','company','heatmap','movers','calendar','news','map','discover'].indexOf(next) === -1 ||
        next === state.marketWorkspaceTab) return;
    closeExpandedMarketWidget();
    state.marketWorkspaceTab = next;
    hideWorkspaceSearchResults();
    render();
  });

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
      case 'wsexpand':
        var expanding = app.querySelector('#' + id);
        if (!expanding || !expanding.classList.contains('ws-widget')) break;
        if (expanding.classList.contains('ws-expanded')) {
          closeExpandedMarketWidget();
        } else {
          closeExpandedMarketWidget();
          expanding.classList.add('ws-expanded');
          document.body.classList.add('ws-expanded-active');
          var expandButton = expanding.querySelector('[data-act="wsexpand"]');
          if (expandButton) {
            var expandedName = (expanding.querySelector('.ws-widget-head h2,.ws-widget-head h3') || {}).textContent || 'widget';
            expandButton.setAttribute('aria-expanded','true');
            expandButton.setAttribute('aria-label','Collapse ' + expandedName);
            expandButton.textContent = '×';
            expandButton.title = 'Close expanded widget';
            expandButton.focus();
          }
          if (exchangeMap && expanding.querySelector('#exchange-world-map')) {
            setTimeout(function () { if (exchangeMap) exchangeMap.invalidateSize(); }, 0);
          }
        }
        break;
      case 'wstab':
        if (['overview','company','heatmap','movers','calendar','news','map','discover'].indexOf(id) < 0) break;
        closeExpandedMarketWidget();
        state.marketWorkspaceTab = id;
        hideWorkspaceSearchResults();
        render();
        break;
      case 'wscompanypanel':
        if (['chart','advanced','technicals','financials','profile'].indexOf(id) < 0) break;
        state.marketCompanyPanel = id;
        var companyWidget = app.querySelector('#ws-company-chart');
        if (companyWidget) {
          companyWidget.dataset.loaded = '';
          companyWidget.innerHTML = '<p class="ws-empty">Loading company information…</p>';
        }
        app.querySelectorAll('[data-act="wscompanypanel"]').forEach(function (button) {
          button.setAttribute('aria-pressed', String(button.getAttribute('data-id') === id));
        });
        mountWorkspaceCompanyChart();
        break;
      case 'wscompany':
        var selectedCompany = findMarketCompany(id);
        if (!selectedCompany) break;
        state.marketSelectedCompany = selectedCompany.tv;
        state.marketWorkspaceTab = 'company';
        state.marketSearch = '';
        render();
        break;
      case 'wscompanycustom':
        var customCompany = ensureCustomCompany(id);
        if (!customCompany) break;
        state.marketSelectedCompany = customCompany.tv;
        state.marketWorkspaceTab = 'company';
        state.marketSearch = '';
        render();
        break;
      case 'wsmarket':
        if (MARKETS.some(function (m) { return m.id === id; })) {
          state.tradingMarket = id;
          state.marketOpen = id;
          render({ focus: 'market-dialog' });
        }
        break;
      case 'wswatch':
      case 'wsremove':
        var watchCompany = findMarketCompany(id) || ensureCustomCompany(id);
        if (!watchCompany) break;
        var watchByTv = state.marketWatch.indexOf(watchCompany.tv);
        var watchByName = state.marketWatch.indexOf(watchCompany.name);
        if (watchByTv >= 0) state.marketWatch.splice(watchByTv, 1);
        else if (watchByName >= 0) state.marketWatch.splice(watchByName, 1);
        else if (act === 'wswatch') state.marketWatch.push(watchCompany.tv);
        state.marketWatch = state.marketWatch.slice(0,32);
        persist();
        updateMarketWatchlistInPlace();
        break;
      case 'wssearchnews':
        state.marketWorkspaceTab = 'news';
        state.marketNewsFocus = 'all';
        hideWorkspaceSearchResults();
        render();
        break;
      case 'wsnewsfilter':
        if (id !== 'all' && id !== 'watchlist') break;
        state.marketNewsFocus = id;
        app.querySelectorAll('[data-act="wsnewsfilter"]').forEach(function (button) {
          button.setAttribute('aria-pressed', String(button.getAttribute('data-id') === id));
        });
        refreshWorkspaceNews();
        break;
      case 'terminalmarket':
      case 'exchangefocus':
        if (MARKETS.some(function (m) { return m.id === id; })) {
          state.tradingMarket = id;
          state.marketOpen = id;
          state.marketHover = null;
          render({ focus: 'market-dialog' });
        }
        break;
      case 'terminalrange':
        if (['1M','3M','6M','1Y'].indexOf(id) >= 0) { state.marketRange = id; render(); }
        break;
      case 'exchangereset':
        if (exchangeMap) exchangeMap.fitBounds(window.L.latLngBounds(EXCHANGE_PLACES.map(function (p) { return [p.lat,p.lng]; })), { padding: [20,20], maxZoom: 2 });
        break;
      case 'togglemarketwatch':
        var watchName = t.getAttribute('data-name');
        if (!MARKET_COMPANIES.some(function (c) { return c.name === watchName; })) break;
        var watchIndex = state.marketWatch.indexOf(watchName);
        if (watchIndex === -1) state.marketWatch.push(watchName);
        else state.marketWatch.splice(watchIndex, 1);
        persist();
        var watchArea = app.querySelector('.market-watch-options');
        if (watchArea) watchArea.querySelectorAll('[data-act="togglemarketwatch"]').forEach(function (btn) {
          var enabled = state.marketWatch.indexOf(btn.getAttribute('data-name')) !== -1;
          btn.classList.toggle('on', enabled);
          btn.setAttribute('aria-pressed', String(enabled));
          btn.querySelector('span').textContent = enabled ? '★' : '☆';
          btn.setAttribute('aria-label', (enabled ? 'Remove ' : 'Add ') + btn.getAttribute('data-name') + (enabled ? ' from' : ' to') + ' watchlist');
        });
        if (state.marketNewsFocus === 'watchlist') {
          var watchNews = app.querySelector('#market-news-content');
          if (watchNews) watchNews.innerHTML = marketNewsHtml();
        }
        break;
      case 'marketnews':
        state.marketNewsFocus = t.getAttribute('data-name') || 'all';
        var newsContent = app.querySelector('#market-news-content');
        if (newsContent) {
          newsContent.innerHTML = marketNewsHtml();
          app.querySelectorAll('[data-act="marketnews"]').forEach(function (btn) {
            var active = btn.getAttribute('data-name') === state.marketNewsFocus;
            btn.classList.toggle('on', active);
            btn.setAttribute('aria-pressed', String(active));
          });
        }
        break;
      case 'openmarket':
        if (!MARKETS.some(function (m) { return m.id === id; })) break;
        state.marketOpen = id; state.marketHover = null; state.utilityOpen = null;
        render({ focus: 'market-dialog' }); break;
      case 'closemarket':
        var returnMarket = state.marketOpen;
        state.marketOpen = null; state.marketHover = null;
        render({ focus: 'market-card-' + returnMarket }); break;
      case 'marketrange':
        if (['1M', '3M', '6M', '1Y'].indexOf(id) === -1) break;
        state.marketRange = id; state.marketHover = null;
        render({ focus: 'market-range-' + id }); break;
      case 'retrymarkets':
        loadMarketData(); break;
      case 'headermenu':
        state.utilityOpen = state.utilityOpen === id ? null : id;
        render({ focus: state.utilityOpen ? 'menu-' + id : 'menu-toggle-' + id }); break;
      case 'home':
        leavePublisherArticle(location.pathname);
        state.view = 'briefing'; state.topic = 'all'; state.query = ''; state.searchOpen = false;
        if (state.reading) changeStory(null);
        render(); break;
      case 'topic':
        leavePublisherArticle(location.pathname);
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
        leavePublisherArticle(location.pathname);
        state.view = t.getAttribute('data-view');
        if (state.reading) changeStory(null);
        if (state.view === 'briefing') state.topic = state.topic || 'all';
        render(); break;
      case 'publishermapreset':
        if (publisherMap) publisherMap.fitBounds(MAP_REGIONS.global.bounds, { padding: [20, 20], maxZoom: 2, animate: true });
        break;
      case 'publishermapview':
        state.view = 'papers'; state.paper = null; changeStory(null); render();
        var publisherMapEl = app.querySelector('#publisher-map-heading');
        if (publisherMapEl) publisherMapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      case 'paperscroll':
        var providerTrack = app.querySelector('#paper-provider-track');
        if (providerTrack) providerTrack.scrollBy({ left: (Number(t.getAttribute('data-dir')) || 1) * Math.max(240, providerTrack.clientWidth * 0.72), behavior: 'smooth' });
        break;
      case 'paper':
        if (state.publisherArticle) leavePublisherArticle('?publisher=' + encodeURIComponent(t.getAttribute('data-name') || ''));
        if (state.view === 'papers' && !state.reading && !state.publisherArticle) {
          selectPaperInPlace(t.getAttribute('data-name'));
        } else {
          state.view = 'papers';
          state.paper = t.getAttribute('data-name');
          if (state.reading) changeStory(null);
          state.settingsOpen = false;
          render();
        }
        break;
      case 'open':
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); changeStory(id); state.settingsOpen = false;
        render({ scrollReader: true }); break;
      case 'opensource':
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); changeStory(id, t.getAttribute('data-source')); state.settingsOpen = false;
        render({ scrollReader: true }); break;
      case 'publisherarticle':
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var publisherArticleUrl = safeExternalUrl(t.getAttribute('data-url'));
        if (!publisherArticleUrl) break;
        state.publisherArticle = {
          name: t.getAttribute('data-name') || '', url: publisherArticleUrl,
          title: t.getAttribute('data-title') || '', summary: (publisherArticleFor(t.getAttribute('data-name') || '', publisherArticleUrl) || {}).summary || '',
          published: t.getAttribute('data-published') || ''
        };
        state.view = 'papers'; state.paper = state.publisherArticle.name;
        state.reading = null; state.readingSource = null; state.settingsOpen = false;
        history.pushState(null, '', publisherArticleHref(state.publisherArticle, state.publisherArticle.name));
        render({ scrollReader: true }); break;
      case 'closesourcearticle':
        state.publisherArticle = null; state.view = 'papers'; state.paper = t.getAttribute('data-name') || state.paper;
        history.pushState(null, '', '?publisher=' + encodeURIComponent(state.paper || ''));
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
      case 'voiceplay':
        if (state.speaking) {
          pauseStoryAudio();
        } else if (state.reading && byId[state.reading]) {
          startSpeech(byId[state.reading]);
        }
        break;
      case 'closeaudio':
        stopSpeech();
        render();
        break;
      case 'voiceseek':
        if (voiceAudio && state.audioStoryId === state.reading) {
          var delta = Number(id) || 0;
          var durLimit = state.audioDuration || voiceAudio.duration || 0;
          var nextPos = Math.max(0, Math.min(durLimit, (voiceAudio.currentTime || 0) + delta));
          try { voiceAudio.currentTime = nextPos; } catch (e) { /* ignore */ }
          state.audioTime = nextPos;
          syncSpeakingDom();
        }
        break;
      case 'voicepick':
        if (id && state.reading && byId[state.reading]) {
          state.readerPrefs.voice = id;
          persist();
          var resumeAt = state.audioStoryId === state.reading ? state.audioTime : 0;
          var keepPlaying = state.speaking;
          startSpeech(byId[state.reading], { voice: id, seekTo: resumeAt, autoplay: keepPlaying });
        }
        break;
      case 'speechrate':
        var rates = [1, 1.15, 1.25, 1.5, 0.9];
        state.speechRate = rates[(rates.indexOf(state.speechRate) + 1) % rates.length];
        state.readerPrefs.rate = state.speechRate;
        persist();
        applyPlaybackRate(state.speechRate);
        syncSpeakingDom();
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
        var fullUrl = state.readingSource
          ? location.origin + location.pathname + sourceHref(id, state.readingSource)
          : location.origin + '/stories/' + encodeURIComponent(id) + '/';
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

  function exploreMarketPointer(e) {
    var plot = e.target.closest('.market-plot');
    if (!plot || !state.marketOpen) return;
    var rect = plot.querySelector('svg').getBoundingClientRect();
    var count = displayedMarketPoints().length;
    var position = ((e.clientX - rect.left) / rect.width * 1000 - 110) / 866;
    setMarketHover(Math.round(position * (count - 1)));
  }
  app.addEventListener('pointermove', exploreMarketPointer);
  app.addEventListener('pointerdown', exploreMarketPointer);

  app.addEventListener('input', function (e) {
    if (e.target.id === 'ws-company-search') {
      state.marketSearch = e.target.value.slice(0,120);
      showWorkspaceSearchResults();
      if (state.marketWorkspaceTab === 'news' && state.marketNewsFocus === 'all') refreshWorkspaceNews();
      return;
    }
    if (e.target.id === 'src-q') {
      state.srcQuery = e.target.value;
      var box = document.getElementById('src-list');
      if (box) box.innerHTML = sourceListHtml();
    } else if (e.target.id === 'q') {
      leavePublisherArticle(location.pathname);
      state.query = e.target.value;
      if (state.reading) changeStory(null);
      if (state.view === 'papers') state.view = 'briefing';
      render({ focus: 'q' });
    } else if (e.target.id === 'voice-scrub' && voiceAudio) {
      var seekVal = parseFloat(e.target.value);
      if (Number.isFinite(seekVal)) {
        try { voiceAudio.currentTime = seekVal; } catch (err) { /* ignore */ }
        state.audioTime = seekVal;
        syncSpeakingDom();
      }
    }
  });

  app.addEventListener('keydown', function (e) {
    if (e.target.id !== 'ws-company-search') return;
    if (e.key === 'Escape') { hideWorkspaceSearchResults(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var found = searchMarketCompanies(state.marketSearch, 5);
      if (found.length) {
        state.marketSelectedCompany = found[0].tv;
        state.marketWorkspaceTab = 'company';
        state.marketSearch = '';
      } else {
        var customHit = ensureCustomCompany(state.marketSearch);
        if (customHit) {
          state.marketSelectedCompany = customHit.tv;
          state.marketWorkspaceTab = 'company';
          state.marketSearch = '';
        } else {
          state.marketWorkspaceTab = 'news';
          state.marketNewsFocus = 'all';
        }
      }
      render();
    }
  });
  app.addEventListener('focusin', function (e) {
    if (e.target.id === 'ws-company-search') {
      loadCompanyDirectory();
      showWorkspaceSearchResults();
    }
  });
  app.addEventListener('click', function (e) {
    if (!e.target.closest('.ws-search-area')) hideWorkspaceSearchResults();
  });
  app.addEventListener('submit', function (e) { e.preventDefault(); });
  app.addEventListener('error', function (e) {
    var target = e.target;
    if (target && target.tagName === 'IMG') {
      if (target.classList.contains('paper-logo-image')) {
        target.hidden = true;
        return;
      }
      var box = target.closest('.dashboard-image, .hero-figure, .reader-photo, .market-news-image, .paper-source-image');
      if (box && !box.querySelector('.broken-media-fallback')) {
        var fallback = document.createElement('span');
        fallback.className = 'broken-media-fallback';
        fallback.textContent = 'Image unavailable';
        box.classList.add('image-unavailable');
        target.hidden = true;
        box.appendChild(fallback);
      }
    }
  }, true);
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Tab' && (state.settingsOpen || state.marketOpen)) {
      var controls = state.marketOpen
        ? app.querySelectorAll('.market-dialog button, .market-dialog a[href], .market-dialog [tabindex="0"]')
        : app.querySelectorAll('.settings button, .settings input');
      var first = controls[0], last = controls[controls.length - 1];
      if (e.target.id === 'market-dialog') { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && e.target === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
    }
    if (state.marketOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target.closest('.market-plot')) {
      e.preventDefault();
      var hoverIndex = state.marketHover === null ? displayedMarketPoints().length - 1 : state.marketHover;
      setMarketHover(hoverIndex + (e.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (e.key === 'Escape') {
      if (closeExpandedMarketWidget()) return;
      if (state.marketOpen) { var marketId = state.marketOpen; state.marketOpen = null; render({ focus: 'market-card-' + marketId }); }
      else if (state.settingsOpen) { state.settingsOpen = false; render({ focus: 'settings-toggle' }); }
      else if (state.utilityOpen) { var menuId = state.utilityOpen; state.utilityOpen = null; render({ focus: 'menu-toggle-' + menuId }); }
      else if (state.aaOpen) { state.aaOpen = false; render(); }
      else if (state.readerFocus) { state.readerFocus = false; render(); }
      else if (state.searchOpen) { state.searchOpen = false; state.query = ''; render(); }
      else if (state.publisherArticle) { leavePublisherArticle('?publisher=' + encodeURIComponent(state.publisherArticle.name || '')); state.view = 'papers'; render(); }
      else if (state.reading) { changeStory(null); render(); }
    } else if (!typing && state.reading && !state.settingsOpen && !state.marketOpen) {
      if (e.key === ' ' && state.audioOpen && tag !== 'BUTTON' && tag !== 'A') {
        e.preventDefault();
        if (state.speaking) pauseStoryAudio();
        else if (byId[state.reading]) startSpeech(byId[state.reading]);
      } else if (e.key === 'f' || e.key === 'F') {
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

  document.getElementById('world-map-library')?.addEventListener('load', function () {
    if (state.view === 'trading') loadCompanyDirectory();
    mountWorldMap();
    mountPublisherMap();
    mountExchangeMap();
  });
  render();
  loadMarketData();
  loadServerReaderCache();
  loadPublisherFeeds();
  setInterval(loadPublisherFeeds, 5 * 60 * 1000);
  loadAudioManifest();
  setInterval(function () { updateClocks(); updateSessionCards(); }, 1000);
})();
