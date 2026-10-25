(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function appState() { try { return state; } catch (e) { return null; } }
  function httpsUrl(u) {
    u = String(u || '').trim();
    try { if (typeof safeUrl === 'function') return safeUrl(u) || ''; } catch (e) {}
    return /^https:\/\//i.test(u) ? u : '';
  }
  function driveId(u) {
    var m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(u);
    return m ? m[1] : '';
  }

  /* =====================================================================
     PART 1  In-app file viewer
     Two modes: 'pending' (Editor tab: Approve / Reject) and 'file' (Browse: any approved note).
     Both get Download and Full screen. Going back: "Exit full screen", ✕, Esc, or the phone/browser Back button
     (Back closes the viewer and returns to what was underneath).
     ===================================================================== */
  var pv = null, curId = null, curMode = 'pending', lastTrigger = null, slowT = null;
  // Back button: opening the viewer adds ONE history entry ({ pvViewer: 1 }) during the tap itself, so the phone/browser
  // Back button closes the viewer (and its full screen) and returns to the page underneath instead of leaving the app.
  // Entries are only ever added during a tap: Chrome skips entries added any other way, which would make Back leave the app.
  // (On Android in real full screen, the system Back first leaves full screen by itself; fullscreenchange keeps us in step.)
  // backPending: we called history.back() ourselves (✕ / Esc / Approve) and its popstate hasn't arrived yet.
  var backPending = false;

  function build() {
    if (pv) return pv;
    var scrim = document.createElement('div'); scrim.id = 'pvScrim';
    var box = document.createElement('div'); box.id = 'pvModal';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'pvTitle');
    box.innerHTML =
      '<div class="pv-head">' +
        '<div style="min-width:0"><span class="pv-eyebrow" id="pvEyebrow">◈ Pending Review · File Check</span>' +
        '<h3 class="pv-title" id="pvTitle"></h3><p class="pv-path" id="pvPath"></p></div>' +
        '<button type="button" class="pv-x" aria-label="Close viewer">✕</button>' +
      '</div>' +
      '<div class="pv-stage" id="pvStage">' +
        '<iframe class="pv-frame" id="pvFrame" title="File preview" allow="autoplay; fullscreen" referrerpolicy="no-referrer" ' +
          'sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"></iframe>' +
        '<div class="pv-state" id="pvLoading"><span class="pv-needle" aria-hidden="true"></span><span>⬡ Loading file…</span></div>' +
        '<div class="pv-state pv-msg" id="pvMsg"></div>' +
      '</div>' +
      '<div class="pv-meta" id="pvMeta"></div>' +
      '<div class="pv-actions">' +
        '<a class="pv-btn pv-open" id="pvOpen" target="_blank" rel="noopener noreferrer">🔗 Open in Drive</a>' +
        '<a class="pv-btn" id="pvDownload" target="_blank" rel="noopener noreferrer">⬇️ Download</a>' +
        '<button type="button" class="pv-btn" id="pvFull">⛶ Full screen</button>' +
        '<button type="button" class="pv-btn pv-no" id="pvReject">✕ Reject</button>' +
        '<button type="button" class="pv-btn pv-ok" id="pvApprove">✅ Approve</button>' +
      '</div>';
    document.body.appendChild(scrim); document.body.appendChild(box);
    pv = { scrim: scrim, box: box, frame: $('pvFrame'), stage: $('pvStage'), loading: $('pvLoading'), msg: $('pvMsg') };

    scrim.addEventListener('click', function () { closeViewer(); });
    box.querySelector('.pv-x').addEventListener('click', function () { closeViewer(); });
    $('pvApprove').addEventListener('click', function () { act('approve'); });
    $('pvReject').addEventListener('click', function () { act('reject'); });
    $('pvFull').addEventListener('click', function () { setFull(!isFull()); });
    pv.frame.addEventListener('load', function () { if (pv.frame.getAttribute('src')) setLoading(false); });
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        // The browser left real full screen (its own Esc / gesture): drop back to the normal viewer too.
        if (!fullscreenEl() && pv.box.classList.contains('pv-max') && pv.realFull) setFull(false);
      });
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();   // don't let the page's Esc also close the note details behind
        if (isFull()) setFull(false); else closeViewer();
        return;
      }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(box.querySelectorAll('button, a[href]'), function (n) { return n.getAttribute('aria-disabled') !== 'true' && !n.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return pv;
  }

  function setLoading(on) { if (pv) pv.loading.classList.toggle('on', !!on); if (!on) clearTimeout(slowT); }
  function showMsg(html) { pv.msg.innerHTML = html; pv.msg.classList.add('on'); }

  function setLink(el, href) {
    if (href) { el.setAttribute('href', href); el.removeAttribute('aria-disabled'); }
    else { el.removeAttribute('href'); el.setAttribute('aria-disabled', 'true'); }
  }

  // ---- full screen ----
  function fullscreenEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function isFull() { return !!pv && pv.box.classList.contains('pv-max'); }
  function updateFullBtn() {
    var on = isFull();
    $('pvFull').textContent = on ? '⤡ Exit full screen' : '⛶ Full screen';
    $('pvFull').setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function setFull(on) {
    if (!pv || on === isFull()) return;
    if (on) {
      pv.box.classList.add('pv-max');   // works everywhere, even where the browser refuses real full screen (iPhone)
      pv.realFull = false;
      var req = pv.box.requestFullscreen || pv.box.webkitRequestFullscreen;
      if (req) {
        try {
          var r = req.call(pv.box);
          if (r && r.then) r.then(function () { pv.realFull = true; }, function () {});
          else pv.realFull = true;
        } catch (e) {}
      }
    } else {
      pv.box.classList.remove('pv-max');
      pv.realFull = false;
      if (fullscreenEl()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
    }
    updateFullBtn();
  }

  // ---- Back button ----
  function viewerOpen() { return !!pv && pv.box.classList.contains('on'); }
  function ownsEntry() { return !!(history.state && history.state.pvViewer); }
  window.addEventListener('popstate', function () {
    if (backPending) { backPending = false; return; }   // the history.back() we asked for has landed
    if (viewerOpen() && !ownsEntry()) closeViewer(true);
  });

  function findItem(id, mode) {
    var s = appState();
    var list = s ? (mode === 'file' ? s.files : s.pending) : null;
    return list ? list.filter(function (x) { return x.id === id; })[0] || null : null;
  }

  function openViewer(id, trigger, mode) {
    mode = mode === 'file' ? 'file' : 'pending';
    var p = findItem(id, mode);
    if (!p) return;
    build();
    curId = id; curMode = mode; lastTrigger = trigger || null;
    var isFile = mode === 'file';

    var path = '';
    try { if (typeof buildDrivePath === 'function') path = buildDrivePath(p); } catch (e) {}
    $('pvEyebrow').textContent = isFile ? '◈ Archive · View File' : '◈ Pending Review · File Check';
    $('pvTitle').textContent = p.displayName || '';
    $('pvPath').textContent = path ? (isFile ? 'Folder: ' : 'Target Path: ') + path : '';
    $('pvApprove').hidden = isFile;
    $('pvReject').hidden = isFile;

    var chips = '<div class="pv-chips">' +
      '<span class="pv-chip pv-type">' + esc(p.contentType) + '</span>' +
      (isFile ? '' : '<span class="pv-chip">' + esc(p.scope) + '</span>') +
      '<span class="pv-chip">' + esc(p.sem) + ' · ' + esc(p.subject) + (p.course && p.course !== 'NONE' ? ' · ' + esc(p.course) : '') + '</span>' +
      '<span class="pv-chip">' + esc(p.module) + '</span>' +
      (p.size ? '<span class="pv-chip">' + esc(p.size) + '</span>' : '') +
      (isFile ? '<span class="pv-chip">👍 ' + esc(p.likes) + '</span>' : '') +
      '<span class="pv-chip">by ' + esc(p.name) + '</span></div>';
    $('pvMeta').innerHTML = chips +
      '<p class="pv-topics"><b>Topics</b>' + esc(p.topics) + '</p>' +
      (p.note ? '<p class="pv-note">⚠ ' + esc(p.note) + '</p>' : '') +
      '<p class="pv-hint">◈ Preview blank or blocked? Some in-app browsers refuse embedded Drive — use “Open in Drive” or “Download”.</p>';

    var url = httpsUrl(p.fileUrl), did = driveId(url);
    setLink($('pvOpen'), url);
    setLink($('pvDownload'), did ? 'https://drive.google.com/uc?export=download&id=' + did : '');
    pv.box.classList.remove('pv-max'); pv.realFull = false; updateFullBtn();

    pv.msg.classList.remove('on'); pv.msg.innerHTML = '';
    pv.frame.removeAttribute('src');
    if (url && did) {
      pv.stage.classList.remove('pv-empty');
      setLoading(true);
      pv.frame.setAttribute('src', 'https://drive.google.com/file/d/' + did + '/preview');
      clearTimeout(slowT);
      slowT = setTimeout(function () { setLoading(false); }, 9000);
    } else {
      pv.stage.classList.add('pv-empty'); setLoading(false);
      showMsg(url
        ? 'This link can’t be embedded here.<br>Use <b>Open in Drive</b> to look at the file.'
        : 'No file link came back for this upload yet.<br>Sync again, then reopen it.');
    }

    pv.scrim.classList.add('on'); pv.box.classList.add('on');
    document.documentElement.classList.add('pv-lock');
    if (!backPending && !ownsEntry()) { try { history.pushState({ pvViewer: 1 }, ''); } catch (e) {} }
    try { pv.box.querySelector('.pv-x').focus({ preventScroll: true }); } catch (e) {}
  }

  // fromBack: closed by the Back button (its history entry is already gone).
  function closeViewer(fromBack) {
    if (!pv || !pv.box.classList.contains('on')) return;
    if (isFull()) {
      pv.box.classList.remove('pv-max'); pv.realFull = false;
      if (fullscreenEl()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
    }
    if (fromBack !== true && ownsEntry() && !backPending) { backPending = true; history.back(); }
    pv.scrim.classList.remove('on'); pv.box.classList.remove('on');
    document.documentElement.classList.remove('pv-lock');
    pv.frame.removeAttribute('src');            // stops any video / audio immediately
    setLoading(false);
    var t = lastTrigger; lastTrigger = null; curId = null;
    if (t && document.contains(t)) { try { t.focus({ preventScroll: true }); } catch (e) {} }
  }

  // Approve / Reject reuse the editor row's own buttons, so the app's existing handlers do the real work.
  function act(kind) {
    var id = curId; if (!id) return;
    var attr = kind === 'approve' ? 'data-approve-id' : 'data-reject-id';
    var cls = kind === 'approve' ? '.btn-approve-item' : '.btn-reject-item';
    var list = $('pendingQueueList'), btn = null;
    if (list) Array.prototype.forEach.call(list.querySelectorAll(cls), function (b) { if (b.getAttribute(attr) === id) btn = b; });
    lastTrigger = null;
    closeViewer();
    if (btn) btn.click();
  }

  function decoratePending() {
    var list = $('pendingQueueList'); if (!list) return;
    Array.prototype.forEach.call(list.querySelectorAll('.btn-approve-item'), function (a) {
      var wrap = a.parentNode;
      if (!wrap || wrap.querySelector('.pv-view-btn')) return;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'pv-view-btn';
      b.setAttribute('data-view-id', a.getAttribute('data-approve-id') || '');
      b.innerHTML = '<span aria-hidden="true">◈</span>View file';
      wrap.insertBefore(b, a);
    });
  }

  /* =====================================================================
     PART 2  Daily-merger: only the same Subject + Course can be combined
     ===================================================================== */
  var mg = { subj: '', course: '', sig: '' };

  function dailyFiles() {
    var s = appState();
    return s && s.files ? s.files.filter(function (f) { return f.approved && f.scope === 'DAILY'; }) : [];
  }
  function ranked(map) {
    return Object.keys(map).sort(function (a, b) { return (map[b] - map[a]) || (a < b ? -1 : 1); });
  }
  function fillSelect(sel, items, want) {
    if (!sel) return;
    while (sel.options.length) sel.remove(0);
    items.forEach(function (it) { var o = document.createElement('option'); o.value = it.v; o.textContent = it.t; sel.appendChild(o); });
    sel.value = want;
  }

  function syncMerge() {
    var bar = $('mergeFilterBar'), note = $('mergeGroupNote'), list = $('dailyMergeList');
    var sSel = $('mergeSubject'), cSel = $('mergeCourse');
    if (!bar || !note || !list || !sSel || !cSel) return;

    var fs = dailyFiles();
    bar.classList.toggle('mg-hide', !fs.length);
    note.classList.toggle('mg-hide', !fs.length);
    if (!fs.length) return;

    var subjCount = {}, courseCount = {};
    fs.forEach(function (f) {
      subjCount[f.subject] = (subjCount[f.subject] || 0) + 1;
      if (f.subject === (mg.subj || '')) courseCount[f.course] = (courseCount[f.course] || 0) + 1;
    });
    var subjects = ranked(subjCount);
    if (subjects.indexOf(mg.subj) < 0) mg.subj = subjects[0];
    courseCount = {};
    fs.forEach(function (f) { if (f.subject === mg.subj) courseCount[f.course] = (courseCount[f.course] || 0) + 1; });
    var courses = ranked(courseCount);
    if (courses.indexOf(mg.course) < 0) mg.course = courses[0];

    var sig = JSON.stringify([subjects, courses]);
    if (sig !== mg.sig) {
      mg.sig = sig;
      fillSelect(sSel, subjects.map(function (c) { return { v: c, t: c }; }), mg.subj);
      fillSelect(cSel, courses.map(function (c) { return { v: c, t: c === 'NONE' ? 'NONE (No Course Layer)' : c }; }), mg.course);
    } else {
      if (sSel.value !== mg.subj) sSel.value = mg.subj;
      if (cSel.value !== mg.course) cSel.value = mg.course;
    }

    var byId = {};
    fs.forEach(function (f) { byId[f.id] = f; });
    var shown = 0;
    Array.prototype.forEach.call(list.querySelectorAll('label'), function (row) {
      var cb = row.querySelector('.daily-merge-check');
      if (!cb) return;
      var f = byId[cb.value];
      var ok = !!f && f.subject === mg.subj && f.course === mg.course;
      row.classList.toggle('mg-hide', !ok);
      cb.checked = ok;                 // rows outside the chosen subject + course can never be combined
      if (ok) shown++;
    });
    note.innerHTML = '◈ <b>' + shown + '</b> of ' + fs.length + ' daily notes · <b>' + esc(mg.subj) + ' · ' + esc(mg.course) +
      '</b> — only notes from the same subject + course can be combined';
  }

  // Browse → note details → "View here" opens an approved note in this same viewer.
  window.DeptViewer = { open: function (id, trigger) { openViewer(id, trigger, 'file'); } };

  /* ---- wiring ---- */
  function init() {
    var pl = $('pendingQueueList');
    if (pl) {
      pl.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.pv-view-btn') : null;
        if (b) openViewer(b.getAttribute('data-view-id'), b);
      });
      new MutationObserver(decoratePending).observe(pl, { childList: true });
      decoratePending();
    }

    var dl = $('dailyMergeList');
    if (dl) {
      var q = 0;
      new MutationObserver(function () { if (q) return; q = requestAnimationFrame(function () { q = 0; syncMerge(); }); })
        .observe(dl, { childList: true });
    }
    var sSel = $('mergeSubject'), cSel = $('mergeCourse');
    if (sSel) sSel.addEventListener('change', function () { mg.subj = sSel.value; mg.course = ''; syncMerge(); });
    if (cSel) cSel.addEventListener('change', function () { mg.course = cSel.value; syncMerge(); });
    syncMerge();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
