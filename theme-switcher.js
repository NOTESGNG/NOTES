    (function () {
      var KEY = 'deptnotes-theme';
      function sync(value) {
        var btns = document.querySelectorAll('#themeSwitcher .theme-opt');
        for (var i = 0; i < btns.length; i++) {
          btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-theme-value') === value ? 'true' : 'false');
        }
      }
      function setTheme(value) {
        if (value !== 'midnight' && value !== 'matinee') value = 'midnight';
        document.documentElement.setAttribute('data-theme', value);
        sync(value);
        try { localStorage.setItem(KEY, value); } catch (e) {}
      }
      function init() {
        var sw = document.getElementById('themeSwitcher');
        if (!sw) return;
        sync(document.documentElement.getAttribute('data-theme') || 'midnight');
        sw.addEventListener('click', function (ev) {
          var b = ev.target.closest ? ev.target.closest('.theme-opt') : null;
          if (b) setTheme(b.getAttribute('data-theme-value'));
        });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    })();
