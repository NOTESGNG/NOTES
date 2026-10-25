(function () {
  'use strict';
  var phone = window.matchMedia('(max-width: 639.98px)');
  var FILTERS = ['filterSem', 'filterSubject', 'filterCourse', 'filterType', 'filterModule', 'filterMonth', 'filterBatch'];
  // Long hints are kept for big screens; phones get ones that fit.
  var PLACEHOLDERS = {
    searchInput: 'Search topics, months, names…',
    upName: 'e.g. Devaki'
  };
  var longHints = {};
  var card = null, btn = null;

  function $(id) { return document.getElementById(id); }

  function updateToggle() {
    if (!btn) return;
    var on = FILTERS.filter(function (id) { var s = $(id); return s && s.value && s.value !== 'ALL'; }).length;
    var open = card.classList.contains('fx-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.innerHTML = '<span>◈ Filters</span><span class="fx-count">' + (on ? on + ' on' : '') + '</span><span aria-hidden="true">' + (open ? '▴' : '▾') + '</span>';
  }

  function applyPlaceholders() {
    Object.keys(PLACEHOLDERS).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (!(id in longHints)) longHints[id] = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', phone.matches ? PLACEHOLDERS[id] : longHints[id]);
    });
  }

  function measureHeader() {
    var h = document.querySelector('header');
    if (h) document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px');
  }

  function init() {
    card = document.querySelector('#viewBrowse > .bg-white.rounded-2xl');
    if (card) {
      card.id = 'filterCard';
      var holder = card.firstElementChild && card.firstElementChild.firstElementChild;
      btn = document.createElement('button');
      btn.type = 'button'; btn.id = 'btnFiltersToggle'; btn.setAttribute('aria-controls', 'filterCard');
      if (holder) holder.appendChild(btn);
      btn.addEventListener('click', function () { card.classList.toggle('fx-open'); updateToggle(); });
      card.addEventListener('change', updateToggle);
      // renderBrowse() rewrites the folder line after every filter change (including Reset / joining a batch).
      var path = $('liveDrivePath');
      if (path) new MutationObserver(updateToggle).observe(path, { childList: true, characterData: true, subtree: true });
      updateToggle();
    }
    applyPlaceholders();
    measureHeader();
    if (phone.addEventListener) phone.addEventListener('change', applyPlaceholders); else phone.addListener(applyPlaceholders);
    window.addEventListener('resize', measureHeader);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
