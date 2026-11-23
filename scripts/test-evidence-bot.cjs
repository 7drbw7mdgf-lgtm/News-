const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync('assets/evidence-bot.js', 'utf8');
const records = JSON.parse(fs.readFileSync('feeds/phemica-plan-events.json', 'utf8'));

function fixture(response) {
  const root = { innerHTML: '', contains: () => false };
  const window = {};
  vm.runInNewContext(script, {
    window,
    document: { getElementById: key => key === 'evidence-bot' ? root : null },
    URL,
    fetch: async path => {
      assert.equal(path, 'api/phemica/v1/input.json');
      return response();
    }
  });
  window.PhemeEvidenceBot.mount();
  return root;
}

const settled = () => new Promise(setImmediate);

test('shows the latest revision and replays earlier evidence without look-ahead', async () => {
  const root = fixture(() => ({ ok: true, json: () => ({ schemaVersion: 1, planEvents: records }) }));
  await settled();
  assert.match(root.innerHTML, /data-status="postponed"/);
  root.onchange({ target: { id: 'evidence-bot-cutoff', value: '2022-09-02' } });
  assert.match(root.innerHTML, /data-status="announced"/);
  assert.doesNotMatch(root.innerHTML, /postponed taking one furnace/);
  assert.match(root.innerHTML, /Reported deadline 30 Sept? 2022/);
});

test('preserves prior evidence when refresh fails and blocks unsafe source links', async () => {
  let available = true;
  const injected = { ...records[1], sourceUrl: 'javascript:alert(1)', evidence: '<img src=x>' };
  const root = fixture(() => ({
    ok: available, json: () => ({ schemaVersion: 1, planEvents: [records[0], injected] })
  }));
  await settled();
  assert.doesNotMatch(root.innerHTML, /href="javascript:/);
  assert.match(root.innerHTML, /&lt;img src=x&gt;/);
  available = false;
  root.onclick({ target: { id: 'evidence-bot-refresh' } });
  await settled();
  assert.match(root.innerHTML, /Refresh failed/);
  assert.match(root.innerHTML, /data-status="postponed"/);
});
