const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function boot(width, search = '', files = {}) {
  const events = {};
  const embeds = {};
  const classList = { add() {}, remove() {}, toggle() {} };
  const app = {
    innerHTML: '',
    addEventListener(name, listener) { (events[name] ||= []).push(listener); },
    querySelector(selector) {
      if (!/^#[a-z][a-z0-9-]+$/.test(selector) || !this.innerHTML.includes('id="' + selector.slice(1) + '"')) return null;
      return {
        style: {}, dataset: {},
        getAttribute() { return null; },
        setAttribute() {},
        replaceChildren(widget) {
          embeds[selector] = widget;
        }
      };
    },
    querySelectorAll() { return []; }
  };
  const window = {
    innerWidth: width, innerHeight: 800,
    matchMedia: () => ({matches: width < 681}),
    addEventListener(name, listener) { if (name === 'popstate') events.popstate = listener; }
  };
  const document = {
    title: '',
    documentElement: {scrollHeight: 2000, style: {setProperty() {}}},
    body: {classList},
    addEventListener() {},
    getElementById(id) { return id === 'app' ? app : null; },
    querySelector() { return null; },
    createElement(tag) {
      return {
        tag, style: {}, children: [],
        appendChild(child) { this.children.push(child); }
      };
    }
  };
  const location = {search, pathname: '/', hash: ''};
  const entries = [];
  const go = url => { location.search = new URL(url, 'https://pheme24.online').search; };
  const history = {
    replaceState(_state, _title, url) { go(url); },
    pushState(_state, _title, url) { go(url); entries.push(location.search); }
  };
  const context = vm.createContext({
    window, document, location, history, URL, URLSearchParams,
    setInterval() {}, setTimeout, fetch: url => {
      const path = String(url).split('?')[0];
      if (!(path in files)) return new Promise(() => {});
      return Promise.resolve({ ok: true, json: () => Promise.resolve(files[path]) });
    }
  });
  for (const file of ['assets/data.js', 'assets/app.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, {filename: file});
  }
  return {
    location, entries, document,
    back(url) { go(url); events.popstate(); },
    html: () => app.innerHTML,
    click(attributes) {
      const target = {closest: () => ({getAttribute: key => attributes[key] || null})};
      for (const listener of events.click) listener({target});
    },
    select(value) {
      const target = {id: 'ws-mobile-section', value, getAttribute() { return null; }};
      for (const listener of events.change) listener({target});
    },
    config(id) {
      const embed = embeds[id];
      return JSON.parse(embed.children.find(child => child.tag === 'script').textContent);
    }
  };
}

test('phone navigation exposes the same destinations as the desktop sidebar', () => {
  const ui = boot(360);
  const main = ui.html().match(/<nav class="sidebar-nav"[^>]*>(.*?)<\/nav>/s)[1];
  const phone = ui.html().match(/<nav class="phone-nav wrap"[^>]*>(.*?)<\/nav>/s)[1];
  assert.equal(phone, main);
  assert.match(phone, /Home.*Newspapers.*Saved stories.*Trading/s);
  ui.click({'data-act': 'view', 'data-view': 'trading'});
  assert.match(ui.html(), /<h1>Markets<\/h1>/);
  const picker = ui.html().match(/<select id="ws-mobile-section"[^>]*>(.*?)<\/select>/s)[1];
  const options = [...picker.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options, ['overview', 'company', 'heatmap', 'movers', 'calendar', 'news', 'octal', 'evidence', 'resources', 'map', 'discover']);
  for (const workspace of options) {
    ui.select(workspace);
    assert.ok(ui.html().includes('<option value="' + workspace + '" selected>'), workspace);
  }
  ui.select('evidence');
  assert.match(ui.html(), /title="Private Trading 212 account"/);
});

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const DATA = {
  'assets/markets.json': read('assets/markets.json'),
  'assets/economic-calendar.json': read('assets/economic-calendar.json'),
  'assets/company-market-data.json': read('assets/company-market-data.json')
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

test('every Trading section renders natively with no third-party embeds', async () => {
  const ui = boot(1440, '?view=trading', DATA);
  await settle();
  for (const section of ['overview', 'company', 'heatmap', 'movers', 'calendar', 'news', 'octal', 'evidence', 'resources', 'map', 'discover']) {
    ui.click({'data-act': 'wstab', 'data-id': section});
    const html = ui.html();
    assert.doesNotMatch(html, /tradingview/i, section);
    assert.match(html, new RegExp('ws-panel-' + section), section);
  }
});

test('Overview draws the index monitor and upcoming official events', async () => {
  const ui = boot(1440, '?view=trading', DATA);
  await settle();
  const html = ui.html();
  assert.match(html, /Market monitor/);
  assert.match(html, /<svg class="ws-chart"[^>]*aria-label="Index performance over 3M/);
  assert.match(html, /FTSE 100/);
  assert.match(html, /Coming up/);
  ui.click({'data-act': 'wsmonitorrange', 'data-id': '1Y'});
  assert.match(ui.html(), /aria-label="Index performance over 1Y/);
});

test('Company price panels wait for licensed data instead of embedding a provider', async () => {
  const ui = boot(1440, '?view=trading&workspace=company&company=AAPL', DATA);
  await settle();
  assert.match(ui.html(), /data-act="wscompanypanel" data-id="profile" aria-pressed="true"/);
  // The harness DOM does not reflect in-place panel swaps, so force a full render after switching.
  const rerender = view => view.click({'data-act': 'wsmonitorrange', 'data-id': '3M'});
  ui.click({'data-act': 'wscompanypanel', 'data-id': 'chart'});
  rerender(ui);
  assert.match(ui.html(), /Share prices aren’t shown yet/);
  const licensed = boot(1440, '?view=trading&workspace=company&company=AAPL', Object.assign({}, DATA, {
    'assets/company-market-data.json': { status: 'available', quotes: { AAPL: { symbol: 'AAPL', name: 'Apple', price: 200, changePercent: 1.2, currency: 'USD', source: 'Twelve Data' } },
      history: { AAPL: Array.from({length: 60}, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), close: 150 + i })) }, profiles: {} }
  }));
  await settle();
  licensed.click({'data-act': 'wscompanypanel', 'data-id': 'chart'});
  rerender(licensed);
  assert.match(licensed.html(), /<svg class="ws-chart"[^>]*aria-label="Apple daily closes"/);
  licensed.click({'data-act': 'wscompanypanel', 'data-id': 'technicals'});
  rerender(licensed);
  assert.match(licensed.html(), /20-day average/);
});

test('Calendar lists only official sources and filters by region and type', async () => {
  const ui = boot(1440, '?view=trading&workspace=calendar', DATA);
  await settle();
  const links = [...ui.html().matchAll(/<a href="(https:[^"]+)" target="_blank"/g)].map(m => new URL(m[1]).hostname);
  assert.ok(links.length > 5);
  for (const host of links) assert.match(host, /federalreserve\.gov|bankofengland\.co\.uk|ecb\.europa\.eu|boj\.or\.jp|rbi\.org\.in|bls\.gov|ons\.gov\.uk/);
  ui.click({'data-act': 'wscalregion', 'data-id': 'UK'});
  assert.doesNotMatch(ui.html(), /Federal Reserve rate decision/);
  assert.match(ui.html(), /Bank of England rate decision/);
  ui.click({'data-act': 'wscaltype', 'data-id': 'data'});
  assert.doesNotMatch(ui.html(), /Bank of England rate decision/);
});

test('each view has its own address', () => {
  const ui = boot(1440);
  assert.equal(ui.location.search, '');
  ui.click({'data-act': 'view', 'data-view': 'papers'});
  assert.equal(ui.location.search, '?view=newspapers');
  assert.equal(ui.document.title, 'Newspapers — Pheme');
  ui.click({'data-act': 'view', 'data-view': 'saved'});
  assert.equal(ui.location.search, '?view=saved');
  ui.click({'data-act': 'view', 'data-view': 'trading'});
  assert.equal(ui.location.search, '?view=trading');
  ui.click({'data-act': 'wstab', 'data-id': 'news'});
  assert.equal(ui.location.search, '?view=trading&workspace=news');
  assert.equal(ui.document.title, 'Trading: News — Pheme');
  ui.click({'data-act': 'topic', 'data-id': 'uk'});
  assert.equal(ui.location.search, '?topic=uk');
  ui.click({'data-act': 'home'});
  assert.equal(ui.location.search, '');
  assert.deepEqual(ui.entries, ['?view=newspapers', '?view=saved', '?view=trading', '?view=trading&workspace=news', '?topic=uk', '']);
});

test('addresses open the matching view and back/forward restores it', () => {
  assert.match(boot(1440, '?view=trading&workspace=calendar').html(), /<option value="calendar" selected>/);
  assert.match(boot(1440, '?workspace=octal').html(), /<option value="octal" selected>/);
  assert.match(boot(1440, '?view=saved').html(), /aria-current="page"><svg[^]*?<span>Saved stories<\/span>/);
  const ui = boot(1440, '?topic=uk');
  assert.match(ui.html(), /class="sidebar-topic active" href="\?topic=uk"/);
  ui.click({'data-act': 'view', 'data-view': 'trading'});
  ui.back('?topic=uk');
  assert.equal(ui.location.search, '?topic=uk');
  assert.match(ui.html(), /class="sidebar-topic active" href="\?topic=uk"/);
  assert.equal(ui.entries.length, 1, 'restoring an address must not add a history entry');
  assert.equal(boot(1440, '?topic=nonsense').location.search, '', 'unknown topics fall back to home');
});

test('navigation items are links to their views', () => {
  const html = boot(1440).html();
  const nav = html.match(/<nav class="sidebar-nav"[^>]*>(.*?)<\/nav>/s)[1];
  assert.match(nav, /href="\?view=newspapers"/);
  assert.match(nav, /href="\?view=saved"/);
  assert.match(nav, /href="\?view=trading"/);
  assert.match(html, /<a class="sidebar-topic[^"]*" href="\?topic=world"/);
});
