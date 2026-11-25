/* Trading workspace for PHEME's evidence and resource models. */
(function () {
  'use strict';

  const api = 'https://pheme-reader-api-production.up.railway.app/v1/';
  const resourceNames = {
    gas: 'Natural gas', labour: 'Skilled labour', power: 'Electricity', chips: 'GPUs & accelerators',
    copper: 'Copper', silicon: 'Silicon', powerplant: 'Power generation', semifab: 'Semiconductor fabrication',
    equipment: 'Electrical equipment', build: 'Data-centre construction', dc: 'AI data centres', margin: 'Operating margin'
  };
  const labels = {
    'cross-source-candidate': 'Cross-source candidate', contested: 'Mixed reports',
    unverified: 'Unverified', 'no-evidence': 'No recent reports'
  };
  const inferenceLabels = {
    supported: 'Evidence passed', filtered: 'Below threshold', contested: 'Contested',
    unknown: 'Unknown', blocked: 'Blocked'
  };
  const directions = {
    up: 'Increase reported', down: 'Decrease reported', qualified: 'Qualified claim', unspecified: 'Direction unclear'
  };
  const dates = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London'
  });
  const number = new Intl.NumberFormat('en-GB', {maximumFractionDigits: 4, signDisplay: 'exceptZero'});
  let feed, graph, selected, inference, scenario;
  let filter = 'all';
  let loading = false;
  let feedError = false;
  let shock = 'gas';
  let percent = '20';
  let inferenceRequest = 0;
  let scenarioRequest = 0;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function resourceName(id) {
    return Object.hasOwn(resourceNames, id) ? resourceNames[id] :
      (graph?.nodes.find(node => node.id === id)?.label || id);
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* A malformed source cannot be opened or assessed. */ }
    return '';
  }

  function sourceLink(url, label) {
    const href = safeUrl(url);
    return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
      esc(label) + '</a>' : esc(label);
  }

  function dateLabel(value) {
    const stamp = Date.parse(value);
    return Number.isFinite(stamp) ? dates.format(stamp) : 'Date unavailable';
  }

  function displayScore(score) {
    return Number.isInteger(score) && score >= 0 && score <= 7 ? String(score) : '—';
  }

  function pct(value) {
    return Number.isFinite(value) ? number.format(value) + '%' : 'Unavailable';
  }

  async function read(path, query) {
    const url = new URL(path, api);
    if (query) url.search = new URLSearchParams(query);
    const response = await fetch(url.href, {
      credentials: 'omit', signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  function signals() {
    if (!feed) return [];
    const priority = row => row.status === 'contested' ? 0 : row.status === 'cross-source-candidate' ? 1 : 2;
    return Object.values(feed.resources)
      .filter(row => row && Object.hasOwn(labels, row.status) && typeof row.node === 'string' &&
        Array.isArray(row.articles) && row.articles.length)
      .sort((a, b) => priority(a) - priority(b) ||
        (b.octalCorroboration ?? -1) - (a.octalCorroboration ?? -1) ||
        (Date.parse(b.articles[0].published) || 0) - (Date.parse(a.articles[0].published) || 0));
  }

  function visibleSignals(rows) {
    return filter === 'all' ? rows : rows.filter(row => row.status === filter);
  }

  function syncSelection() {
    const visible = visibleSignals(signals());
    if (visible.some(row => row.node === selected)) return;
    selected = visible[0]?.node;
    inference = null;
    inferenceRequest++;
  }

  function badge(status, name) {
    return '<span class="octal-badge tone-' + esc(status) + '">' + esc(name) + '</span>';
  }

  function renderQueue(rows) {
    return '<div class="octal-card-head"><div><h3>Signal queue</h3><p>Resource reports from the last 96 hours</p></div></div>' +
      '<div class="octal-filter"><label for="octal-filter">Evidence status</label>' +
      '<select id="octal-filter"><option value="all">All with reports</option>' +
      Object.entries(labels).filter(([value]) => value !== 'no-evidence').map(([value, label]) =>
        '<option value="' + value + '"' + (filter === value ? ' selected' : '') + '>' + label + '</option>'
      ).join('') + '</select></div>' +
      (rows.length ? '<ul class="octal-queue-list" aria-label="Resource signals">' + rows.map(row =>
        '<li><button type="button" id="octal-signal-' + esc(row.node) + '" data-octal-signal="' + esc(row.node) +
        '" aria-pressed="' + (selected === row.node) + '"><span class="octal-queue-text"><strong>' +
        esc(resourceName(row.node)) + '</strong><small>' + esc(labels[row.status]) +
        '</small></span><span class="octal-queue-score" aria-label="' +
        (displayScore(row.octalCorroboration) === '—' ? 'No score' : 'Score ' + displayScore(row.octalCorroboration) + ' of 7') +
        '">' + displayScore(row.octalCorroboration) + '</span></button></li>'
      ).join('') + '</ul>' : '<p class="octal-message">' + (loading && !feed ? 'Loading resource reports…' :
        feedError && !feed ? 'The evidence feed could not be reached. Try refreshing.' : 'No reports match this filter.') + '</p>');
  }

  function reportRows(articles, offset) {
    return articles.map((article, index) => '<li><div class="octal-report"><div><div class="octal-report-meta"><strong>' +
      esc(article.publisher) + '</strong> <time datetime="' + esc(article.published) + '">' +
      esc(dateLabel(article.published)) + '</time></div><div class="octal-headline">' +
      sourceLink(article.url, article.headline || 'Publisher report') +
      '</div><span class="octal-report-direction">' + esc(directions[article.direction] || 'Direction unclear') + '</span></div>' +
      (safeUrl(article.url) ? '<button class="octal-control" id="octal-check-' + (offset + index) +
        '" type="button" aria-label="Check article from ' + esc(article.publisher) +
        '" data-octal-check="' + (offset + index) + '">Check article</button>' : '') +
      '</div></li>').join('');
  }

  function evidenceLinks(title, rows) {
    if (!Array.isArray(rows) || !rows.length) return '';
    return '<div class="octal-citations"><strong>' + title + '</strong><ul>' + rows.map(row =>
      '<li>' + sourceLink(row.url, row.publisher || 'Publisher') + ' <small>' + esc(dateLabel(row.published)) +
      '</small></li>'
    ).join('') + '</ul></div>';
  }

  function renderInference() {
    if (!inference) return '';
    const head = '<h4 id="octal-inference-title" tabindex="-1">Article inference</h4><p class="octal-inference-article">' +
      esc(inference.title) + '</p>';
    if (!inference.result) return head + '<p role="status">' + esc(inference.message) + '</p>';
    const detail = inference.result;
    const filters = detail.trace?.filters || [];
    const product = detail.trace?.multiplication;
    const inputs = Array.isArray(detail.inputs) ? detail.inputs : [];
    const descriptions = {
      passed: 'Passed input filter', contradicted: 'Contradicted',
      'unknown-or-unverified': 'Insufficient source support', 'below-input-floor': 'Below input threshold'
    };
    return head + '<div class="octal-inference-state">' + badge(detail.status, inferenceLabels[detail.status] || 'Unavailable') +
      '<strong>' + displayScore(detail.octalResult) + ' / 7</strong></div><p>' + esc(detail.reason) + '</p>' +
      (inputs.length ? '<ol class="octal-premises">' + inputs.map(input => {
        const verdict = filters.find(item => item.symbol === input.symbol);
        const name = String(input.proposition || '').replace(/[:_-]+/g, ' ');
        return '<li><strong>' + esc(name || input.symbol) + '</strong> <span>' +
          displayScore(input.octalValue) + ' / 7 · ' + esc(descriptions[verdict?.reason] || 'No filter result') + '</span>' +
          evidenceLinks('Supporting sources', input.supportingEvidence) +
          evidenceLinks('Contradicting sources', input.contradictingEvidence) + '</li>';
      }).join('') + '</ol>' : '') +
      (product?.exact ? '<p class="octal-trace">Normalized product ' + esc(product.exact.numerator) +
        ' ÷ ' + esc(product.exact.denominator) + ' → ' + displayScore(product.value) +
        ' / 7. Output threshold ' + esc(detail.trace.outputFloor) + ' / 7.</p>' : '') +
      '<p class="octal-muted">The article engine checks recognized economic propositions. Its score measures corroboration.</p>';
  }

  function renderEvidence(row) {
    if (!row) return '<div class="octal-card-head"><div><h3>Signal evidence</h3>' +
      '<p>Select a resource to inspect its reports.</p></div></div>';
    const score = displayScore(row.octalCorroboration);
    const bars = Array.from({length: 8}, (_, n) => '<span class="' +
      (score !== '—' && n <= Number(score) ? 'filled' : '') + '">' + n + '</span>').join('');
    const note = row.status === 'contested' ? 'Reports describe moves in both directions. Review the headlines for location and timing.' :
      row.status === 'cross-source-candidate' ? 'Several publishers reported a similar direction. Check that they describe the same event.' :
      'The matched headlines give the engine too little support for a resource score.';
    const supporting = row.status === 'cross-source-candidate' ? 'Same direction' :
      (row.status === 'contested' ? 'Larger side' : 'Directional reports');
    return '<div class="octal-card-head octal-evidence-head"><div><span class="octal-kicker">Signal evidence</span>' +
      '<h3 id="octal-detail-title" tabindex="-1">' + esc(resourceName(row.node)) + '</h3><p>' +
      esc(directions[row.direction] || 'Direction unresolved') + '</p></div>' + badge(row.status, labels[row.status]) + '</div>' +
      '<div class="octal-metrics"><div><span>Corroboration</span><strong>' + score +
      ' <small>/ 7</small></strong></div><div><span>' + supporting + '</span><strong>' + esc(row.publisherCount ?? 0) +
      '</strong></div><div><span>Opposite direction</span><strong>' + esc(row.opposingPublisherCount ?? 0) +
      '</strong></div></div><div class="octal-scale" aria-hidden="true">' + bars + '</div>' +
      '<p class="octal-note">' + esc(note) + ' Publisher counts are based on RSS matches. Shared reporting can still affect the count.</p>' +
      '<div class="octal-reports"><h4>Source reports</h4><ul>' + reportRows(row.articles.slice(0, 4), 0) + '</ul>' +
      (row.articles.length > 4 ? '<details><summary>Show ' + (row.articles.length - 4) +
      ' more reports</summary><ul>' + reportRows(row.articles.slice(4), 4) + '</ul></details>' : '') + '</div>' +
      '<div id="octal-inference" class="octal-inference"' + (inference ? '' : ' hidden') + '>' + renderInference() + '</div>';
  }

  function renderScenarioResult() {
    if (!scenario) return '';
    if (!scenario.result) return '<p role="status">' + esc(scenario.message) + '</p>';
    const data = scenario.result;
    const reached = data.results.filter(row => row.node !== data.shock && row.status !== 'unreached');
    const company = reached.find(row => graph?.nodes.find(node => node.id === row.node)?.type === 'company');
    return '<div class="octal-scenario-summary"><strong>' + esc(resourceName(data.shock)) + ' ' + pct(data.shockPercent) +
      '</strong><span>' + (company ? 'Company model · ' + esc(company.label) + ' ' +
        (company.changePercent == null ? 'needs path review' : pct(company.changePercent)) :
        'No modelled path reaches a company with the available coefficients.') + '</span></div>' +
      (reached.length ? '<ol class="octal-path">' + reached.map(row => {
        const edge = row.paths?.[0]?.assumptions?.at(-1);
        return '<li><div><strong>' + esc(row.label) + '</strong>' + (edge && row.changePercent != null ?
          '<small>From ' + esc(resourceName(edge.from)) + ' · ' + esc(edge.passThrough) + '× pass-through</small>' : '') +
          '</div><span>' + (row.changePercent == null ? 'Review overlap' : pct(row.changePercent)) + '</span></li>';
      }).join('') + '</ol>' : '');
  }

  function renderScenarioForm() {
    const nodes = graph?.nodes.filter(node => ['primary', 'secondary'].includes(node.type)) || [];
    return '<div class="octal-card-head"><div><h3>Cost scenario</h3>' +
      '<p>Change one resource cost to inspect the modelled path.</p></div></div>' +
      '<form id="octal-scenario-form" class="octal-scenario-form">' +
      '<label for="octal-shock">Resource<select id="octal-shock"' + (!nodes.length ? ' disabled' : '') + '>' +
      (nodes.length ? nodes.map(node => '<option value="' + esc(node.id) + '"' + (node.id === shock ? ' selected' : '') +
      '>' + esc(resourceName(node.id)) + '</option>').join('') : '<option>Model unavailable</option>') +
      '</select></label><label for="octal-percent">Change (%)<input type="number" id="octal-percent" min="-100" max="100" step="any" required value="' +
      esc(percent) + '"></label><button class="octal-control octal-primary" type="submit"' + (!nodes.length ? ' disabled' : '') +
      '>Run scenario</button></form>' +
      '<p class="octal-note">Illustrative coefficients for the AI data-centre model. A missing coefficient stops the path.</p>' +
      '<div id="octal-scenario-result" class="octal-scenario-result" role="region" aria-label="Scenario result">' + renderScenarioResult() + '</div>';
  }

  function paint() {
    const root = document.getElementById('octal-bot');
    if (!root) return;
    const active = document.activeElement;
    const focusId = active && root.contains(active) ? active.id : '';
    const queue = root.querySelector('.octal-queue-list');
    const scrollTop = queue?.scrollTop;
    const expandedReports = root.querySelector('.octal-reports details')?.open;
    const rows = signals();
    const available = rows.filter(row => row.status === 'cross-source-candidate').length;
    const mixed = rows.filter(row => row.status === 'contested').length;
    root.querySelector('#octal-feed-stats').innerHTML = [
      [feed ? rows.length : '—', 'Tracked signals'],
      [feed ? available : '—', 'Cross-source candidates'],
      [feed ? mixed : '—', 'Mixed reports']
    ].map(([value, label]) => '<div><strong>' + value + '</strong><span>' + label + '</span></div>').join('');
    root.querySelector('#octal-feed-status').textContent = loading ? 'Refreshing evidence…' :
      feedError ? (feed ? 'Refresh failed · showing ' + dateLabel(feed.generatedAt) + ' UK' : 'Evidence feed unavailable') :
      feed ? 'Checked ' + dateLabel(feed.generatedAt) + ' UK' : 'Connecting to evidence feed';
    root.querySelector('#octal-refresh').setAttribute('aria-disabled', String(loading));
    root.querySelector('#octal-queue').innerHTML = renderQueue(visibleSignals(rows));
    root.querySelector('#octal-evidence').innerHTML = renderEvidence(rows.find(row => row.node === selected));
    const nextQueue = root.querySelector('.octal-queue-list');
    if (nextQueue && scrollTop) nextQueue.scrollTop = scrollTop;
    const details = root.querySelector('.octal-reports details');
    if (details && expandedReports) details.open = true;
    if (focusId) document.getElementById(focusId)?.focus({preventScroll: true});
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    paint();
    const results = await Promise.allSettled([read('resource-evidence'), read('resource-graph')]);
    const [nextFeed, nextGraph] = results;
    if (nextFeed.status === 'fulfilled' && nextFeed.value?.resources) {
      feed = nextFeed.value;
      feedError = false;
      syncSelection();
    } else feedError = true;
    if (nextGraph.status === 'fulfilled' && Array.isArray(nextGraph.value?.graph?.nodes)) {
      const firstGraph = !graph;
      graph = nextGraph.value.graph;
      const panel = document.getElementById('octal-scenario');
      if (firstGraph && panel) panel.innerHTML = renderScenarioForm();
    }
    loading = false;
    paint();
  }

  function paintInference() {
    const panel = document.getElementById('octal-inference');
    if (!panel) return;
    const keepFocus = document.activeElement?.id === 'octal-inference-title';
    panel.hidden = !inference;
    panel.innerHTML = renderInference();
    if (keepFocus) document.getElementById('octal-inference-title')?.focus({preventScroll: true});
  }

  async function checkArticle(row) {
    const url = safeUrl(row?.url);
    if (!url) return;
    const request = ++inferenceRequest;
    inference = {title: row.headline, message: 'Checking article propositions…'};
    paintInference();
    document.getElementById('octal-inference-title')?.focus();
    try {
      const data = await read('infer', {url});
      if (!data?.inference) throw new Error('Invalid response');
      if (request === inferenceRequest) inference.result = data.inference;
    } catch (error) {
      if (request === inferenceRequest) inference.message = error.message === '404' ?
        'This article is outside the current inference cache.' : 'The article check is unavailable. Try again.';
    }
    if (request === inferenceRequest) paintInference();
  }

  async function runScenario() {
    const value = document.getElementById('octal-percent');
    if (!value?.checkValidity()) return;
    shock = document.getElementById('octal-shock').value;
    percent = value.value;
    const request = ++scenarioRequest;
    scenario = {message: 'Running the cost scenario…'};
    const show = () => {
      const result = document.getElementById('octal-scenario-result');
      if (result) result.innerHTML = renderScenarioResult();
    };
    show();
    try {
      const data = await read('resource-scenario', {shock, percent});
      if (!Array.isArray(data?.results)) throw new Error('Invalid response');
      if (request === scenarioRequest) scenario.result = data;
    } catch {
      if (request === scenarioRequest) scenario.message = 'The scenario could not be calculated. Try again.';
    }
    if (request === scenarioRequest) show();
  }

  function mount() {
    const root = document.getElementById('octal-bot');
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    root.querySelector('#octal-scenario').innerHTML = renderScenarioForm();
    root.addEventListener('input', event => {
      if (event.target.id === 'octal-percent') percent = event.target.value;
    });
    root.addEventListener('change', event => {
      if (event.target.id === 'octal-shock') shock = event.target.value;
      if (event.target.id !== 'octal-filter') return;
      filter = event.target.value;
      syncSelection();
      paint();
    });
    root.addEventListener('submit', event => {
      if (event.target.id !== 'octal-scenario-form') return;
      event.preventDefault();
      runScenario();
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.id === 'octal-refresh') refresh();
      if (button.hasAttribute('data-octal-signal')) {
        if (selected === button.dataset.octalSignal) return;
        selected = button.dataset.octalSignal;
        inference = null;
        inferenceRequest++;
        const currentDetails = root.querySelector('.octal-reports details');
        if (currentDetails) currentDetails.open = false;
        paint();
        if (window.matchMedia('(max-width: 900px)').matches) {
          document.getElementById('octal-detail-title')?.focus();
        }
      }
      if (button.hasAttribute('data-octal-check')) {
        const rows = signals().find(row => row.node === selected)?.articles;
        checkArticle(rows?.[Number(button.dataset.octalCheck)]);
      }
    });
    paint();
    if (!feed && !feedError) refresh();
  }

  window.PhemeOctalBot = {
    mount,
    html: broker => '<section id="octal-bot" aria-labelledby="octal-title">' +
      '<header class="octal-hero"><div class="octal-hero-top"><div><h2 id="octal-title">Octal Bot</h2>' +
      '<p>Inspect resource signals, source claims and cost scenarios.</p></div>' +
      '<button class="octal-control" id="octal-refresh" type="button">Refresh evidence</button></div>' +
      '<p id="octal-feed-status" role="status"></p><div id="octal-feed-stats" class="octal-feed-stats"></div></header>' +
      '<div class="octal-grid"><section id="octal-queue" class="octal-card" aria-label="Signal queue"></section>' +
      '<section id="octal-evidence" class="octal-card" aria-label="Signal evidence"></section></div>' +
      '<div class="octal-grid octal-tools"><section id="octal-scenario" class="octal-card" aria-label="Cost scenario"></section>' +
      broker + '</div></section>'
  };
})();
