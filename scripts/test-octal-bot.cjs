const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('assets/octal-bot.js', 'utf8');
const report = {publisher: 'Daily & Local', headline: '<img src=x> Natural gas prices rise',
  url: 'https://publisher.example/gas', published: '2026-11-25T08:00:00Z', direction: 'up'};
const feed = {generatedAt: report.published, resources: {
  gas: {node: 'gas', status: 'cross-source-candidate', direction: 'up', octalCorroboration: 5, publisherCount: 3, articles: [report]},
  labour: {node: 'labour', status: 'contested', direction: null, octalCorroboration: null, publisherCount: 2,
    opposingPublisherCount: 1, articles: [{...report, url: 'javascript:alert(1)'}]}
}};
const tick = () => new Promise(resolve => setImmediate(resolve));

function boot() {
  const elements = {};
  const handlers = {};
  const requests = [];
  const responses = {
    'resource-evidence': feed,
    'resource-graph': {graph: {nodes: [{id: 'gas', type: 'primary'}, {id: 'dc', type: 'company'}]}},
    'resource-scenario': {shock: 'gas', shockPercent: 20, results: [
      {node: 'dc', label: 'AI data centre', status: 'scenario-only', changePercent: 1.12,
        paths: [{assumptions: [{from: 'power', passThrough: 0.2}]}]}
    ]},
    infer: {inference: {status: 'supported', octalResult: 0, reason: 'Example',
      inputs: [], trace: {outputFloor: 0, multiplication: {value: 0, exact: {numerator: 0, denominator: 7}}}}}
  };
  const element = id => elements[id] ??= {id, innerHTML: '', value: '', dataset: {},
    focus() {}, checkValidity() { return true; }, setAttribute() {}};
  const root = element('octal-bot');
  root.querySelector = selector => selector.startsWith('#') ? element(selector.slice(1)) : null;
  root.addEventListener = (type, handler) => { handlers[type] = handler; };
  root.contains = () => false;
  const window = {matchMedia: () => ({matches: false})};
  vm.runInNewContext(source, {window, document: {getElementById: element}, URL, URLSearchParams, AbortSignal,
    async fetch(path, options) {
      const url = new URL(path);
      requests.push([url, options]);
      const response = responses[url.pathname.split('/').at(-1)];
      if (response instanceof Error) throw response;
      return {ok: true, json: () => response};
    }});
  window.PhemeOctalBot.mount();
  const click = (id, dataset = {}) => handlers.click({target: {closest: () => ({
    id, dataset, hasAttribute: attribute => Object.hasOwn(dataset, attribute === 'data-octal-check' ? 'octalCheck' : 'octalSignal')
  })}});
  return {element, handlers, requests, responses, click};
}

test('keeps contested evidence unscored, filters signals, and checks only HTTPS publisher URLs', async () => {
  const {element, handlers, requests, responses, click} = boot();
  await tick();
  assert.match(element('octal-evidence').innerHTML, /Mixed reports/);
  assert.match(element('octal-evidence').innerHTML, /— <small>\/ 7/);
  assert.doesNotMatch(element('octal-evidence').innerHTML, /javascript:|<img/);
  click('', {octalCheck: 0});
  assert.equal(requests.length, 2);

  handlers.change({target: {id: 'octal-filter', value: 'cross-source-candidate'}});
  assert.match(element('octal-evidence').innerHTML, /Natural gas/);
  assert.doesNotMatch(element('octal-queue').innerHTML, /Skilled labour/);
  click('', {octalCheck: 0});
  await tick();
  assert.match(element('octal-inference').innerHTML, /0 \/ 7/);
  assert.match(element('octal-inference').innerHTML, /0 ÷ 7/);
  assert.equal(requests.at(-1)[0].searchParams.get('url'), report.url);
  assert.equal(requests.at(-1)[1].credentials, 'omit');

  responses['resource-evidence'] = new Error('Offline');
  click('octal-refresh');
  await tick();
  assert.match(element('octal-feed-status').textContent, /Refresh failed/);
  assert.match(element('octal-evidence').innerHTML, /Natural gas/);
});

test('passes explicit scenario inputs through and shows modelled pass-through', async () => {
  const {element, handlers, requests} = boot();
  await tick();
  element('octal-shock').value = 'gas';
  element('octal-percent').value = '20';
  handlers.submit({target: {id: 'octal-scenario-form'}, preventDefault() {}});
  await tick();
  const url = requests.at(-1)[0];
  assert.equal(url.pathname, '/v1/resource-scenario');
  assert.equal(url.searchParams.get('shock'), 'gas');
  assert.equal(url.searchParams.get('percent'), '20');
  assert.match(element('octal-scenario-result').innerHTML, /AI data centre \+1\.12%/);
  assert.match(element('octal-scenario-result').innerHTML, /0\.2× pass-through/);
});
