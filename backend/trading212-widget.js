(function () {
  'use strict';
  var get = function (id) { return document.getElementById(id); };
  var form = get('unlock'), input = get('access'), account = get('account'), status = get('status');
  var token = '', request = null, orderRequest = null, ticket = null;
  var orderStatus = get('order-status'), orderForm = get('order-form'), confirm = get('order-confirm');
  var review = get('order-review'), details = get('order-details'), pendingRows = get('pending-rows');

  function closeReview() {
    ticket = null;
    review.hidden = true;
    details.textContent = '';
  }

  function lock(message) {
    if (request) request.abort();
    request = null;
    if (orderRequest) orderRequest.abort();
    orderRequest = null;
    get('order-controls').disabled = false;
    get('lock').disabled = false;
    closeReview();
    orderForm.reset();
    pendingRows.replaceChildren();
    get('pending-orders').hidden = true;
    get('demo-orders').hidden = true;
    orderStatus.textContent = '';
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
    var demoOrders = data.mode === 'demo' && data.demoOrdersEnabled === true;
    get('demo-orders').hidden = !demoOrders;
    get('account-mode').textContent = data.mode === 'demo' ?
      (demoOrders ? 'Demo account · Orders enabled' : 'Demo account · Read-only') : 'Live account · Read-only';
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

  var orderErrors = {
    invalid_order: 'Enter a Trading 212 ticker and a positive number of shares.',
    preview_expired_or_used: 'This review expired or was already used. Check pending orders before opening another review.',
    demo_orders_disabled: 'Demo ordering is disabled on the server.',
    broker_rejected: 'Trading 212 rejected the request. Check the instrument, quantity and key permissions.',
    broker_access: 'Trading 212 rejected the server credentials or pending-order permission.',
    broker_rate_limited: 'Trading 212 is limiting requests. Try again in a minute.',
    too_many_previews: 'Wait for previous reviews to expire before opening another.',
    auth_required: 'The widget access token was rejected. Lock and unlock the widget again.'
  };

  async function orderCall(path, body, onSuccess, submitting) {
    if (!token || orderRequest || get('demo-orders').hidden) return;
    var controller = new AbortController();
    orderRequest = controller;
    get('order-controls').disabled = true;
    if (submitting) get('lock').disabled = true;
    var headers = {Authorization: 'Bearer ' + token};
    if (body) headers['Content-Type'] = 'application/json';
    var fallback = submitting ?
      'Outcome uncertain. Check Trading 212 before trying again.' : 'The demo order service could not complete the request.';
    orderStatus.textContent = submitting ? 'Sending request to Trading 212 demo…' : 'Loading…';
    try {
      var response = await fetch('/v1/trading212/orders' + path, {
        method: body ? 'POST' : 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store', credentials: 'omit', signal: controller.signal
      });
      var data = await response.json();
      if (orderRequest !== controller) return;
      if (!response.ok) {
        orderStatus.textContent = Object.hasOwn(orderErrors, data.error) ? orderErrors[data.error] : fallback;
        return;
      }
      orderStatus.textContent = '';
      onSuccess(data);
    } catch (error) {
      if (orderRequest === controller) orderStatus.textContent = fallback;
    } finally {
      if (orderRequest === controller) {
        orderRequest = null;
        get('order-controls').disabled = false;
        get('lock').disabled = false;
      }
    }
  }

  function previewOrder(intent, cancellationLabel) {
    closeReview();
    orderCall('/preview', intent, function (data) {
      var order = data.order;
      var cancelling = order.action === 'cancel';
      details.textContent = cancelling ?
        'Request cancellation of demo order ' + order.orderId + ' (' + cancellationLabel +
          '). The order could fill before cancellation.' :
        (order.side === 'buy' ? 'Buy ' : 'Sell ') + order.quantity + ' shares of ' + order.ticker +
          ' at the next available market price in the demo account. The execution price can change.';
      ticket = data.ticket;
      confirm.textContent = cancelling ? 'Confirm cancellation' : 'Confirm demo market order';
      review.hidden = false;
      details.focus();
    });
  }

  orderForm.addEventListener('submit', function (event) {
    event.preventDefault();
    previewOrder({
      action: 'market', ticker: get('order-ticker').value.trim(),
      side: get('order-side').value, quantity: get('order-quantity').valueAsNumber
    });
  });
  get('order-back').addEventListener('click', closeReview);
  confirm.addEventListener('click', function () {
    if (!ticket || orderRequest) return;
    var approved = ticket;
    closeReview();
    orderCall('/confirm', {ticket: approved}, function (data) {
      pendingRows.replaceChildren();
      get('pending-orders').hidden = true;
      if (data.outcome === 'cancellation_requested') {
        orderStatus.textContent = 'Cancellation requested for demo order ' + data.orderId + '. Check its status in Trading 212.';
      } else if (data.outcome === 'submitted') {
        orderStatus.textContent = 'Demo order ' + data.orderId + ' submitted' + (data.status ? ' · ' + data.status : '') + '.';
      } else {
        throw Error('Unrecognised order result');
      }
    }, true);
  });
  get('order-pending').addEventListener('click', function () {
    closeReview();
    orderCall('', null, function (data) {
      pendingRows.replaceChildren();
      get('pending-orders').hidden = !data.orders.length;
      if (!data.orders.length) orderStatus.textContent = 'No pending demo orders.';
      data.orders.forEach(function (order) {
        var row = pendingRows.insertRow();
        var label = [order.ticker, order.quantity == null ? null : order.quantity + ' shares', order.status]
          .filter(Boolean).join(' · ');
        row.insertCell().textContent = '#' + order.orderId + ' · ' + label;
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Review cancellation';
        button.addEventListener('click', function () {
          previewOrder({action: 'cancel', orderId: order.orderId}, label);
        });
        row.insertCell().appendChild(button);
      });
    });
  });

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
