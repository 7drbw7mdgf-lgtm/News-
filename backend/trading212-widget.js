(function () {
  'use strict';
  var get = function (id) { return document.getElementById(id); };
  var form = get('unlock'), input = get('access'), account = get('account'), status = get('status');
  var token = '', request = null;

  function lock(message) {
    if (request) request.abort();
    request = null;
    token = '';
    input.value = '';
    account.hidden = true;
    form.hidden = false;
    get('token-help').hidden = false;
    ['value', 'cash', 'account-mode', 'rows'].forEach(function (id) { get(id).textContent = ''; });
    status.textContent = message || '';
  }

  function render(data) {
    var money = new Intl.NumberFormat('en-GB', {style: 'currency', currency: data.currency});
    var value = function (amount) { return typeof amount === 'number' ? money.format(amount) : 'Unavailable'; };
    get('value').textContent = value(data.totalValue);
    get('cash').textContent = value(data.availableCash);
    get('account-mode').textContent = data.mode === 'live' ? 'Live account · Read-only' : 'Demo account · Read-only';
    get('positions').hidden = !data.positions.length;
    get('empty').hidden = Boolean(data.positions.length);
    var rows = get('rows');
    rows.replaceChildren();
    data.positions.forEach(function (position) {
      var row = rows.insertRow();
      row.insertCell().textContent = position.name === position.ticker ?
        position.ticker : position.name + ' · ' + position.ticker;
      row.insertCell().textContent = position.quantity == null ? 'Unavailable' : String(position.quantity);
    });
    form.hidden = true;
    get('token-help').hidden = true;
    account.hidden = false;
    status.textContent = 'Updated ' + new Date(data.asOf).toLocaleString('en-GB');
  }

  async function refresh() {
    if (!token || request) return;
    var controller = new AbortController();
    request = controller;
    status.textContent = 'Loading Trading 212 account…';
    try {
      var response = await fetch('/v1/trading212/account', {
        headers: {Authorization: 'Bearer ' + token},
        cache: 'no-store', credentials: 'omit', signal: controller.signal
      });
      var data = await response.json();
      if (request !== controller) return;
      if (response.status === 401) return lock('The widget access token was rejected.');
      if (response.status === 503) return lock('Trading 212 is awaiting server configuration.');
      if (!response.ok) {
        if (data.error === 'broker_rate_limited') throw Error('Trading 212 is limiting requests. Try again in a minute.');
        if (data.error === 'broker_access') throw Error('Trading 212 rejected the server credentials or account permissions.');
        throw Error('Trading 212 is unavailable. Try again.');
      }
      render(data);
    } catch (error) {
      if (request === controller) status.textContent = error instanceof TypeError ?
        'The account service could not be reached. Try again.' : error.message;
    } finally {
      if (request === controller) request = null;
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (request) return;
    token = input.value;
    input.value = '';
    refresh();
  });
  get('refresh').addEventListener('click', refresh);
  get('lock').addEventListener('click', function () { lock(); input.focus(); });
  window.addEventListener('pagehide', function () { lock(); });
})();
