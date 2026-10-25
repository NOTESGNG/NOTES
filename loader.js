    (function () {
      var el, fill, thanks, count, timer = null, pct = 0, base = 0, slot = 100, hideT = null;
      function grab() {
        el = document.getElementById('upLoader');
        fill = document.getElementById('ulBarFill');
        thanks = document.getElementById('ulThanks');
        count = document.getElementById('ulFileCount');
        return !!(el && fill);
      }
      function paint() { fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, pct / 100)) + ')'; }
      function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      function nice(n) {
        n = String(n || '').trim();
        if (!n || n.toUpperCase() === 'ANON') return 'friend';
        return n.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
      }
      function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

      window.upLoader = {
        nice: nice,
        show: function (total) {
          if (!grab()) return;
          clearTimeout(hideT); clearInterval(timer);
          pct = 0; base = 0; slot = 100 / Math.max(1, total || 1);
          fill.style.transition = 'none'; paint(); void fill.offsetWidth; fill.style.transition = '';
          thanks.innerHTML = '';
          el.classList.remove('ul-done');
          if (count) count.textContent = (total || 1) + ' FILE' + ((total || 1) > 1 ? 'S' : '') + ' // SENDING';
          document.documentElement.classList.add('ul-lock');
          el.classList.add('ul-on');
          // The server gives no byte-level progress, so ease toward the end of the current file's slice.
          timer = setInterval(function () {
            var ceil = base + slot * 0.92;
            if (pct < ceil) { pct += (ceil - pct) * 0.05 + 0.05; paint(); }
          }, 120);
        },
        step: function (i, total) {
          if (!el) return;
          slot = 100 / Math.max(1, total || 1);
          base = i * slot;
          if (pct < base) { pct = base; paint(); }
        },
        finish: async function (ok, name, n) {
          if (!el) return;
          clearInterval(timer);
          if (!ok) {
            el.classList.remove('ul-on');
            document.documentElement.classList.remove('ul-lock');
            await wait(340);
            return;
          }
          pct = 100; paint();
          if (count) count.textContent = 'DONE // PENDING REVIEW';
          await wait(420);
          thanks.innerHTML = 'Thank you, <b>' + esc(nice(name)) + '</b>, for uploading ' + (n > 1 ? 'your ' + n + ' files' : 'your file') + '!';
          el.classList.add('ul-done');
          await wait(1900);
          el.classList.remove('ul-on');
          document.documentElement.classList.remove('ul-lock');
          await wait(340);
          el.classList.remove('ul-done');
        }
      };
    })();
