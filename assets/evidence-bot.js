/* PHEME Trading evidence bot. Reads reviewed plans and their source history. */
(function () {
  'use strict';

  var endpoint = 'api/phemica/v1/input.json';
  var labels = {
    announced: 'Announced plan', amended: 'Plan amended', postponed: 'Postponed',
    withdrawn: 'Withdrawn', confirmed: 'Confirmed', restarted: 'Restarted'
  };
  var feed = null, company = '', cutoff = '', loading = false, failed = false;

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char];
    });
  }

  function sourceLink(item) {
    try {
      var url = new URL(item.sourceUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        return '<a href="' + escape(url.href) + '" target="_blank" rel="noopener noreferrer">' +
          escape(item.sourceLabel || 'Open source') + '</a>';
      }
    } catch (error) { /* The plan can still display without a valid source link. */ }
    return escape(item.sourceLabel || 'Source unavailable');
  }

  function options(values, selected) {
    return values.map(function (value) {
      return '<option value="' + escape(value[0]) + '"' + (value[0] === selected ? ' selected' : '') +
        '>' + escape(value[1]) + '</option>';
    }).join('');
  }

  function eventDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return 'Date unavailable';
    return new Date(value + 'T00:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
  }

  function relevantEvents(events) {
    return events.filter(function (event) {
      return event && event.planId && event.company && event.site && event.process &&
        Object.hasOwn(labels, event.status) && /^\d{4}-\d{2}-\d{2}$/.test(event.publicAvailableOn);
    }).sort(function (a, b) {
      return b.publicAvailableOn.localeCompare(a.publicAvailableOn);
    });
  }

  function planCards(events) {
    var byPlan = new Map();
    events.forEach(function (event) {
      if (cutoff && event.publicAvailableOn > cutoff) return;
      if (!byPlan.has(event.planId)) byPlan.set(event.planId, []);
      byPlan.get(event.planId).push(event);
    });

    return Array.from(byPlan.values(), function (timeline) {
      var latest = timeline[0];
      var schedule = latest.effectiveOn ? 'Reported effective date ' + eventDate(latest.effectiveOn) :
        latest.effectiveBy ? 'Reported deadline ' + eventDate(latest.effectiveBy) : '';
      return '<article class="evidence-bot-plan"><header><div><h3>' + escape(latest.company) + ' · ' +
        escape(latest.site) + '</h3><p>' + escape(latest.process) + '</p></div>' +
        '<span class="evidence-bot-status" data-status="' + escape(latest.status) + '">' +
        labels[latest.status] + '</span></header>' +
        (schedule ? '<p class="evidence-bot-meta">' + escape(schedule) + '</p>' : '') +
        '<ol aria-label="Evidence history">' + timeline.map(function (event) {
          return '<li><div class="evidence-bot-meta">' + escape(eventDate(event.publicAvailableOn)) +
            ' · ' + labels[event.status] + '</div><p>' + escape(event.evidence) + '</p>' +
            sourceLink(event) + '</li>';
        }).join('') + '</ol></article>';
    }).join('');
  }

  function content() {
    if (!feed) {
      return '<p class="ws-empty" role="status">' + (failed ?
        'The evidence feed could not be loaded. Use Refresh to retry.' : 'Loading verified evidence…') + '</p>';
    }
    var events = relevantEvents(feed.planEvents);
    var companies = Array.from(new Set(events.map(function (event) { return event.company; }))).sort();
    var selected = company ? events.filter(function (event) { return event.company === company; }) : events;
    var dates = Array.from(new Set(selected.map(function (event) { return event.publicAvailableOn; })));
    var cards = planCards(selected);
    return '<div class="evidence-bot-filters">' +
      '<label>Company<select id="evidence-bot-company">' +
      options([['','All tracked companies']].concat(companies.map(function (name) { return [name, name]; })), company) +
      '</select></label><label>Evidence as of<select id="evidence-bot-cutoff">' +
      options([['','Latest available']].concat(dates.map(function (day) { return [day, eventDate(day)]; })), cutoff) +
      '</select></label></div>' +
      (failed ? '<p class="ws-empty" role="status">Refresh failed. Showing the last available evidence.</p>' : '') +
      (cards || '<p class="ws-empty">No verified plan records for this selection.</p>');
  }

  function paint() {
    var root = document.getElementById('evidence-bot');
    if (!root) return;
    var focused = document.activeElement;
    var retainFocus = focused && root.contains(focused) && focused.id;
    root.innerHTML = '<div class="ws-widget-head"><div><h2>Evidence Bot</h2>' +
      '<p class="evidence-bot-meta">Reviewed company plans and source updates</p></div>' +
      '<button id="evidence-bot-refresh" type="button" aria-disabled="' + loading + '">' +
      (loading ? 'Refreshing…' : 'Refresh') + '</button></div>' +
      '<div class="evidence-bot-body" aria-busy="' + loading + '">' + content() + '</div>';
    if (retainFocus) {
      var replacement = document.getElementById(retainFocus);
      if (replacement) replacement.focus();
    }
  }

  function refresh() {
    if (loading) return;
    loading = true;
    failed = false;
    paint();
    fetch(endpoint, {cache: 'no-cache'})
      .then(function (response) {
        if (!response.ok) throw Error('Evidence feed unavailable');
        return response.json();
      })
      .then(function (data) {
        if (!data || data.schemaVersion !== 1 || !Array.isArray(data.planEvents)) {
          throw Error('Evidence feed schema mismatch');
        }
        feed = data;
        var events = relevantEvents(feed.planEvents);
        if (company && !events.some(function (event) { return event.company === company; })) company = '';
        if (cutoff && !events.some(function (event) {
          return event.publicAvailableOn === cutoff && (!company || event.company === company);
        })) cutoff = '';
      })
      .catch(function () { failed = true; })
      .finally(function () { loading = false; paint(); });
  }

  function mount() {
    var root = document.getElementById('evidence-bot');
    if (!root) return;
    root.onchange = function (event) {
      if (event.target.id === 'evidence-bot-company') {
        company = event.target.value;
        cutoff = '';
      } else if (event.target.id === 'evidence-bot-cutoff') {
        cutoff = event.target.value;
      } else {
        return;
      }
      paint();
    };
    root.onclick = function (event) {
      if (event.target.id === 'evidence-bot-refresh') refresh();
    };
    paint();
    if (!feed && !failed) refresh();
  }

  window.PhemeEvidenceBot = {
    html: function () { return '<section id="evidence-bot" class="ws-widget" aria-label="Evidence Bot"></section>'; },
    mount: mount
  };
})();
