/* One shared module powers all market charts; quotes come from TradingView. */
import('https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js').catch(function () {
  document.documentElement.classList.add('market-data-unavailable');
});
