const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync('backend/trading212-widget.js', 'utf8');
const settled = () => new Promise(setImmediate);

test('review performs no write and confirmation sends its ticket only once', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener(name, handler) { this[name] = handler; },
        focus() {}, reset() {}, replaceChildren() {}
      });
    }
    return elements.get(id);
  };
  const token = 'a'.repeat(64);
  const calls = [];
  vm.runInNewContext(script, {
    document: {getElementById: element},
    window: {addEventListener() {}},
    AbortController,
    fetch: async (path, options) => {
      calls.push([path, options.body && JSON.parse(options.body)]);
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      const data = {
        '/v1/trading212/account': {mode: 'demo', currency: 'GBP', demoOrdersEnabled: true, positions: []},
        '/v1/trading212/orders/preview': {
          ticket: 'ticket', order: {action: 'market', ticker: 'EXAMPLE_EQ', quantity: 2, side: 'sell'}
        },
        '/v1/trading212/orders/confirm': {outcome: 'submitted', orderId: '123', status: 'NEW'}
      };
      return {ok: true, json: async () => data[path]};
    }
  });
  const event = {preventDefault() {}};
  element('access').value = token;
  element('unlock').submit(event);
  await settled();
  assert.equal(element('demo-orders').hidden, false);

  element('order-ticker').value = 'EXAMPLE_EQ';
  element('order-side').value = 'sell';
  element('order-quantity').valueAsNumber = 2;
  element('order-form').submit(event);
  await settled();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['/v1/trading212/orders/preview',
    {action: 'market', ticker: 'EXAMPLE_EQ', quantity: 2, side: 'sell'}]);
  assert.match(element('order-details').textContent, /Sell 2 shares of EXAMPLE_EQ/);

  element('order-quantity').valueAsNumber = 5;
  element('order-confirm').click();
  element('order-confirm').click();
  await settled();
  assert.deepEqual(calls.slice(2), [['/v1/trading212/orders/confirm', {ticket: 'ticket'}]]);
  assert.match(element('order-status').textContent, /Demo order 123 submitted/);
});
