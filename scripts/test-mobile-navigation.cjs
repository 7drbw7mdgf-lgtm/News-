const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function boot(width, search = '') {
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
    setInterval() {}, fetch: () => new Promise(() => {})
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
  assert.match(ui.html(), /Markets workspace/);
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

test('Trading embeds request the same datasets and controls on phone and desktop', () => {
  const layouts = [boot(360), boot(1440)];
  for (const ui of layouts) ui.click({'data-act': 'view', 'data-view': 'trading'});
  const select = (workspace, embed) => {
    layouts[0].select(workspace);
    layouts[1].click({'data-act': 'wstab', 'data-id': workspace});
    const [phone, desktop] = layouts.map(ui => ui.config(embed));
    assert.deepEqual(phone, desktop);
    return phone;
  };
  assert.equal(select('overview', '#tv-market-overview').showChart, true);
  assert.equal(select('movers', '#ws-forex-cross').currencies.length, 8);
  assert.equal(layouts[0].config('#ws-hotlists').showChart, true);
  const calendar = select('calendar', '#ws-economic-calendar');
  assert.equal(calendar.countryFilter, 'gb,us,eu,jp,in,cn');
  assert.equal(calendar.importanceFilter, '-1,0,1');
  assert.ok(select('company', '#ws-company-chart').dateRanges.includes('all|1M'));
  for (const ui of layouts) ui.click({'data-act': 'wscompanypanel', 'data-id': 'advanced'});
  const [phone, desktop] = layouts.map(ui => ui.config('#ws-company-chart'));
  assert.deepEqual(phone, desktop);
  assert.equal(phone.hide_side_toolbar, false);
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
