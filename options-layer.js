(function () {
  'use strict';

  /* ============================================================================================
     PART A  Sheet-controlled options
     The Apps Script sends `options` with every listing (subjects, courses, modules, months...).
     Missing / old script => the built-in lists already in the page keep working untouched.
     ============================================================================================ */
  var CACHE_KEY = 'deptnotes_options_v1';
  var DEFAULT_LABELS = { CS: 'Computer Science', ECO: 'Economics', STATI: 'Statistics' };
  // Modules and months are constants (no longer read from the Sheet).
  var FIXED_MODULES = ['1', '2', '3', '4', '5', '6'];
  var FIXED_MONTHS = ['JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR', 'APR'];
  var cur = null;
  var lastSig = '';
  var liveSeen = false;

  function $(id) { return document.getElementById(id); }
  function list(x) { return Array.isArray(x) ? x : []; }
  function strs(x, upper) {
    var out = [];
    list(x).forEach(function (v) {
      v = String(v == null ? '' : v).trim();
      if (upper) v = v.toUpperCase();
      if (v && out.indexOf(v) < 0) out.push(v);
    });
    return out;
  }
  function normalise(o) {
    if (!o || typeof o !== 'object') return null;
    var n = {
      subjects: strs(o.subjects, true),
      courses: strs(o.courses, true),
      ecoCourses: strs(o.ecoCourses, true),
      ecoOnlyCourses: strs(o.ecoOnlyCourses, true),
      noCourseSubjects: strs(o.noCourseSubjects, true),
      modules: FIXED_MODULES.slice(),
      months: FIXED_MONTHS.slice(),
      labels: {}
    };
    if (o.subjectLabels && typeof o.subjectLabels === 'object') {
      Object.keys(o.subjectLabels).forEach(function (k) { n.labels[String(k).toUpperCase()] = String(o.subjectLabels[k]); });
    }
    n.batches = Array.isArray(o.batches) ? o.batches.map(function (b) {
      return { code: String(b.code || '').toUpperCase(), label: String(b.label || b.code || ''), startYear: (b.startYear == null ? null : Number(b.startYear)) };
    }).filter(function (b) { return b.code; }) : [];
    n.structure = (o.structure && typeof o.structure === 'object' && !Array.isArray(o.structure)) ? o.structure : {};
    if (!n.subjects.length || !n.courses.length) return null;
    return n;
  }

  // The lists the page ships with (same as the Apps Script defaults), used until the Sheet's options arrive.
  function builtinOptions() {
    var subs = $('filterSubject') ? Array.prototype.map.call($('filterSubject').options, function (o) { return o.value; })
      .filter(function (v) { return v && v !== 'ALL'; }) : [];
    return {
      subjects: subs,
      courses: ['DSC-A', 'DSC-B', 'DSC-C', 'MDC'],
      ecoCourses: ['DSC-A', 'DSC-B'],
      ecoOnlyCourses: ['DSC-A'],
      noCourseSubjects: typeof SUBJECTS_NO_COURSE !== 'undefined' ? SUBJECTS_NO_COURSE.slice() : ['ENG', 'FRENCH']
    };
  }

  function digitsOf(s) {
    var out = '';
    String(s == null ? '' : s).split('').forEach(function (ch) { if (ch >= '0' && ch <= '9') out += ch; });
    return out;
  }

  /* ---- The rules for "which subjects and courses does a semester have" ----
     If the Editor set up that semester in Course Structure, its list is the truth: only those subjects,
     only those courses, and a subject with no courses has no course layer.
     If not (or for "All" sems), the shared SUBJECTS / COURSES lists from the Sheet are used, like before. */
  function upAll(list) { return (Array.isArray(list) ? list : []).map(function (c) { return String(c).toUpperCase(); }); }
  function semCfgOf(sem) {
    if (!cur || !sem || sem === 'ALL' || !cur.structure) return null;
    var c = cur.structure[digitsOf(sem)];
    return c && Array.isArray(c.subjects) && c.subjects.length ? c : null;
  }
  function coursesIn(c, subject) { return upAll(c.courses && c.courses[subject]); }
  function union(lists) {
    var out = [];
    lists.forEach(function (l) { l.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); });
    return out;
  }
  function globalCourses(subject) {
    var a = subject === 'ECO'
      ? (cur.ecoCourses.length ? cur.ecoCourses : cur.courses)
      : cur.courses.filter(function (c) { return cur.ecoOnlyCourses.indexOf(c) < 0; });
    return a.length ? a : cur.courses;
  }
  function structureSems() {
    return cur && cur.structure ? Object.keys(cur.structure).map(function (k) { return semCfgOf('SEM' + k); }).filter(Boolean) : [];
  }

  // An unset sem uses the shared lists only if it's in SHARED_LIST_SEMS (1–3); any other unset sem is empty.
  function usesSharedLists(sem) {
    if (!sem || sem === 'ALL') return true;
    var shared = typeof SHARED_LIST_SEMS !== 'undefined' ? SHARED_LIST_SEMS : ['1', '2', '3'];
    return shared.indexOf(digitsOf(sem)) > -1;
  }

  function subjectsForSem(sem) {
    var c = semCfgOf(sem);
    if (!c && !usesSharedLists(sem)) return { codes: [], noCourse: [] };
    if (!c) return { codes: cur ? cur.subjects : [], noCourse: cur ? cur.noCourseSubjects : [] };
    var codes = upAll(c.subjects);
    return { codes: codes, noCourse: codes.filter(function (s) { return !coursesIn(c, s).length; }) };
  }

  // Courses a subject has in a semester. Can be [] — that means "no course layer" for that subject there.
  function allowedCourses(subject, sem) {
    if (!cur) return subject === 'ECO' ? ['DSC-A', 'DSC-B'] : ['DSC-B', 'DSC-C', 'MDC'];
    var c = semCfgOf(sem);
    if (c && upAll(c.subjects).indexOf(subject) > -1) return coursesIn(c, subject);
    if (!c && !usesSharedLists(sem)) return [];
    return globalCourses(subject);
  }

  function isNoCourse(subject, sem) {
    var c = semCfgOf(sem);
    if (c && upAll(c.subjects).indexOf(subject) > -1) return !coursesIn(c, subject).length;
    var list = cur ? cur.noCourseSubjects : (typeof SUBJECTS_NO_COURSE !== 'undefined' ? SUBJECTS_NO_COURSE : []);
    return list.indexOf(subject) > -1;
  }

  // What the Browse "Course" filter should offer for this subject + sem (it also has to cover "All").
  function coursesForBrowse(subject, sem) {
    if (!cur) return [];
    var c = semCfgOf(sem);
    if (subject === 'ALL') {
      if (c) return union(upAll(c.subjects).map(function (s) { return coursesIn(c, s); }));
      if (sem === 'ALL') return union([cur.courses].concat(structureSems().map(function (x) {
        return union(upAll(x.subjects).map(function (s) { return coursesIn(x, s); }));
      })));
      return usesSharedLists(sem) ? cur.courses.slice() : [];
    }
    if (sem === 'ALL') {
      return union([isNoCourse(subject, 'ALL') ? [] : globalCourses(subject)].concat(structureSems().map(function (x) { return coursesIn(x, subject); })));
    }
    return allowedCourses(subject, sem);
  }

  function fill(id, items, fallback) {
    var sel = $(id);
    if (!sel) return;
    var prev = sel.value;
    while (sel.options.length) sel.remove(0);
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.v; o.textContent = it.t;
      sel.appendChild(o);
    });
    var has = function (v) { return items.some(function (i) { return i.v === v; }); };
    var want = has(prev) ? prev : fallback;
    if (want == null || !has(want)) want = items.length ? items[0].v : '';
    sel.value = want;
  }

  function rebuild(n) {
    var structs = Object.keys(n.structure || {}).map(function (k) { return n.structure[k]; })
      .filter(function (c) { return c && Array.isArray(c.subjects); });
    var allSubjects = union([n.subjects].concat(structs.map(function (c) { return upAll(c.subjects); })));
    var allCourses = union([n.courses].concat(structs.map(function (c) {
      return union(Object.keys(c.courses || {}).map(function (k) { return upAll(c.courses[k]); }));
    })));
    var labelFor = function (c) { return n.labels[c] || DEFAULT_LABELS[c] || ''; };
    var noC = function (c) { return n.noCourseSubjects.indexOf(c) > -1; };
    var ecoOnly = function (c) { return n.ecoOnlyCourses.indexOf(c) > -1; };

    var subjText = function (c) { return c + (labelFor(c) ? ' (' + labelFor(c) + ')' : ''); };
    fill('filterSubject', [{ v: 'ALL', t: 'All Subjects' }].concat(allSubjects.map(function (c) { return { v: c, t: subjText(c) }; })), 'ALL');
    fill('upSubject', allSubjects.map(function (c) { return { v: c, t: subjText(c) }; }));
    fill('editModalSubject', allSubjects.map(function (c) { return { v: c, t: subjText(c) }; }));

    fill('filterCourse', [{ v: 'ALL', t: 'All Courses' }].concat(allCourses.map(function (c) { return { v: c, t: c }; })), 'ALL');
    fill('upCourse', allCourses.map(function (c) { return { v: c, t: c }; }));
    fill('editModalCourse', allCourses.map(function (c) { return { v: c, t: c }; }).concat([{ v: 'NONE', t: 'No course (files go by month)' }]));

    var mods = n.modules;
    fill('filterModule', [{ v: 'ALL', t: 'All Modules' }].concat(mods.map(function (m) { return { v: 'MODULE ' + m, t: 'Module ' + m }; }),
      [{ v: 'MODULE', t: 'Module (Unsorted / Time-Based)' }]), 'ALL');
    fill('upModule', mods.map(function (m) { return { v: m, t: 'Module ' + m }; }).concat([{ v: '', t: "Not Sure -> Use Unnumbered 'MODULE' Folder" }]));
    fill('editModalModule', mods.map(function (m) { return { v: 'MODULE ' + m, t: 'Module ' + m }; }).concat([{ v: 'MODULE', t: 'Module (Unsorted)' }]));

    fill('filterMonth', [{ v: 'ALL', t: 'All Months' }].concat(n.months.map(function (m) { return { v: m, t: '.' + m }; })), 'ALL');
    fill('upMonth', n.months.map(function (m) { return { v: m, t: m + ' (.' + m + ')' }; }));
    fill('editModalMonth', n.months.map(function (m) { return { v: m, t: m }; }));
  }

  function readout(live, cached) {
    var el = $('optionsLiveReadout');
    if (!el) return;
    if (!live || !cur) {
      el.textContent = '◈ Using the built-in lists — paste the new code below, run setup(), then deploy a new version to switch on Sheet-controlled options.';
      return;
    }
    el.textContent = '◈ ' + (cached && !liveSeen ? 'LAST KNOWN' : 'LIVE FROM SHEET') + ' · ' + cur.subjects.length + ' subjects · ' + cur.courses.length +
      ' courses · modules 1–6 · months JUL–APR (fixed)';
  }

  function apply(raw, fromCache) {
    var n = normalise(raw);
    if (!n) { if (!fromCache && !liveSeen) readout(false); return; }
    if (!fromCache) liveSeen = true;
    var sig = JSON.stringify(n);
    if (sig === lastSig) { readout(true, fromCache); return; }
    lastSig = sig; cur = n;
    // the app keeps its own "no course layer" list; it is a const array, so update it in place
    try {
      if (typeof SUBJECTS_NO_COURSE !== 'undefined') {
        SUBJECTS_NO_COURSE.length = 0;
        n.noCourseSubjects.forEach(function (x) { SUBJECTS_NO_COURSE.push(x); });
      }
    } catch (e) {}
    rebuild(n);
    try { cascadeAll(); } catch (e) {}
    if (!fromCache) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(raw)); } catch (e) {} }
    readout(true, fromCache);
    refreshAll();
    try { if (typeof updateUploadPreview === 'function') updateUploadPreview(); } catch (e) {}
    try { if (typeof renderBrowse === 'function') renderBrowse(); } catch (e) {}
  }

  // Narrows a subject <select> (filterSubject / upSubject) down to the subjects set up for one semester,
  // leaving every option in place (just disabled/hidden) so nothing about the select's id, value or
  // listeners changes — the same trick the Upload form already uses to restrict Course by Subject.
  function applySemFilter(selId, sem) {
    var sel = $(selId);
    if (!sel || !cur) return;
    // "All sems" shows every subject that exists anywhere; one sem shows only that sem's subjects.
    var allowed = (!sem || sem === 'ALL')
      ? union([cur.subjects].concat(structureSems().map(function (c) { return upAll(c.subjects); })))
      : subjectsForSem(sem).codes;
    Array.prototype.forEach.call(sel.options, function (o) {
      if (o.value === 'ALL') return;
      var ok = allowed.indexOf(o.value) > -1;
      o.disabled = !ok; o.hidden = !ok;
    });
    if (sel.value !== 'ALL' && allowed.indexOf(sel.value) === -1) {
      var hasAll = Array.prototype.some.call(sel.options, function (o) { return o.value === 'ALL'; });
      if (!allowed.length && !hasAll) { sel.value = ''; return; } // sem not set up: show nothing selected
      sel.value = allowed[0] || 'ALL';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Same idea for a Course <select>: only the courses that apply stay visible.
  // hasAll: the select has an "All" option to fall back to. keep: a value to leave selected even if it no longer
  // applies (so opening an old note never silently changes its course).
  function applyCourseFilter(selId, allowed, hasAll, keep) {
    var sel = $(selId);
    if (!sel || !cur) return;
    Array.prototype.forEach.call(sel.options, function (o) {
      if (o.value === 'ALL' || o.value === 'NONE') { o.disabled = false; o.hidden = false; return; }
      var ok = allowed.indexOf(o.value) > -1 || o.value === keep;
      o.disabled = !ok; o.hidden = !ok;
    });
    var v = sel.value;
    if (v === keep || v === 'ALL' || v === 'NONE' || allowed.indexOf(v) > -1) return;
    sel.value = hasAll ? 'ALL' : (allowed[0] || 'NONE');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Browse filters: Sem → Subject → Course.
  function cascadeBrowse() {
    var sem = $('filterSem') ? $('filterSem').value : 'ALL';
    applySemFilter('filterSubject', sem);
    var subj = $('filterSubject') ? $('filterSubject').value : 'ALL';
    applyCourseFilter('filterCourse', coursesForBrowse(subj, sem), true);
  }
  // Note details popup (Editor): Sem → Subject → Course, keeping the note's current course visible.
  function cascadeEditModal(keepCourse) {
    var sem = $('editModalSem') ? $('editModalSem').value : '';
    applySemFilter('editModalSubject', sem);
    var subj = $('editModalSubject') ? $('editModalSubject').value : '';
    var sel = $('editModalCourse');
    if (sel && isNoCourse(subj, sem) && keepCourse === undefined) { sel.value = 'NONE'; }
    applyCourseFilter('editModalCourse', allowedCourses(subj, sem), false, keepCourse);
  }
  function cascadeAll() {
    cascadeBrowse();
    if ($('upSem')) applySemFilter('upSubject', $('upSem').value);
  }

  window.DeptOptions = {
    apply: function (o) { try { apply(o, false); } catch (e) {} },
    allowedCourses: allowedCourses,
    isNoCourse: isNoCourse,
    subjectsForSem: subjectsForSem,
    applySemFilter: function (selId, sem) { try { applySemFilter(selId, sem); } catch (e) {} },
    cascadeBrowse: function () { try { cascadeBrowse(); } catch (e) {} },
    cascadeEditModal: function (keep) { try { cascadeEditModal(keep); } catch (e) {} },
    get: function () { return cur; }
  };

  /* ============================================================================================
     PART B  Themed selectors
     Each native <select> stays in the page (hidden) as the source of truth, so every existing
     id, .value read and change/input listener keeps working. We only draw a nicer control on top.
     ============================================================================================ */
  var DROPDOWNS = ['filterSem', 'filterSubject', 'filterCourse', 'filterModule', 'filterMonth', 'filterBatch', 'upSem', 'upSubject', 'upCourse', 'editModalCourse', 'editModalModule', 'editModalMonth', 'editModalSem', 'editModalSubject', 'mergeSubject', 'mergeCourse', 'structSemSelect', 'structCopyFromSelect'];
  var CHIPS = ['filterType', 'upType', 'upScope', 'upMonth', 'upModule'];
  var COMPACT = ['filterType', 'upMonth', 'upModule'];
  var TITLES = { filterMonth: 'Month Filter' };
  var controls = {};
  var panel = null, scrim = null, openCtl = null;
  var vdesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function visibleOptions(sel) { return Array.prototype.filter.call(sel.options, function (o) { return !o.disabled && !o.hidden; }); }
  function selectedOption(sel) { return sel.options[sel.selectedIndex] || null; }
  function splitLabel(text, value, id) {
    text = String(text || '');
    if (id === 'upModule' && value === '') return { m: 'Not sure', s: "Unnumbered 'MODULE' folder" };
    if (id === 'upModule' && /^[0-9]+$/.test(String(value))) return { m: String(value), s: '' };
    var i = text.indexOf(' (');
    if (i > 0 && text.charAt(text.length - 1) === ')') return { m: text.slice(0, i), s: text.slice(i + 2, -1) };
    return { m: text, s: '' };
  }
  function titleOf(sel) {
    if (TITLES[sel.id]) return TITLES[sel.id];
    var l = document.querySelector('label[for="' + sel.id + '"]');
    if (!l && sel.parentNode) l = sel.parentNode.querySelector('label');
    return l ? l.textContent.replace(/\s+/g, ' ').replace(/:$/, '').trim() : sel.id;
  }
  function fire(sel) {
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function choose(ctl, opt) {
    var changed = ctl.sel.value !== opt.value;
    ctl.sel.value = opt.value;
    if (changed) fire(ctl.sel);
    ctl.render();
  }

  /* ---- shared panel: desktop dropdown / phone bottom sheet ---- */
  function ensurePanel() {
    if (panel) return;
    scrim = document.createElement('div'); scrim.id = 'tselScrim';
    panel = document.createElement('div'); panel.id = 'tselPanel'; panel.setAttribute('role', 'dialog');
    document.body.appendChild(scrim); document.body.appendChild(panel);
    scrim.addEventListener('click', function () { closePanel(); });
    panel.addEventListener('click', function (e) {
      var x = e.target.closest ? e.target.closest('.tsel-x') : null;
      if (x) { closePanel(); return; }
      var it = e.target.closest ? e.target.closest('.tsel-item') : null;
      if (it && openCtl) { var ctl = openCtl; closePanel(true); choose(ctl, it.__opt); try { ctl.btn.focus({ preventScroll: true }); } catch (er) {} }
    });
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
      var items = Array.prototype.slice.call(panel.querySelectorAll('.tsel-item'));
      var i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[Math.min(i + 1, items.length - 1)] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[Math.max(i - 1, 0)] || items[0]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); if (items[0]) items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); if (items.length) items[items.length - 1].focus(); }
      else if (e.key === 'Tab') { closePanel(true); }
    });
    window.addEventListener('resize', function () { if (openCtl) closePanel(true); });
    document.addEventListener('scroll', function (e) {
      if (openCtl && window.innerWidth >= 640 && !(panel && panel.contains(e.target))) closePanel(true);
    }, true);
  }

  function place(ctl) {
    var listEl = panel.querySelector('.tsel-list');
    if (window.innerWidth < 640) {
      panel.style.left = panel.style.top = panel.style.width = '';
      listEl.style.maxHeight = '';
      return;
    }
    var r = ctl.btn.getBoundingClientRect();
    var w = Math.max(r.width, 250);
    var below = window.innerHeight - r.bottom - 14;
    var above = r.top - 14;
    var useBelow = below >= 230 || below >= above;
    listEl.style.maxHeight = Math.max(150, Math.min(340, (useBelow ? below : above) - 52)) + 'px';
    panel.style.width = w + 'px';
    panel.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
    var ph = panel.offsetHeight;
    panel.style.top = (useBelow ? r.bottom + 6 : Math.max(8, r.top - ph - 6)) + 'px';
  }

  function openPanel(ctl) {
    ensurePanel();
    closePanel(true);
    openCtl = ctl;
    var cursor = selectedOption(ctl.sel);
    panel.setAttribute('aria-label', ctl.title);
    panel.innerHTML = '<div class="tsel-head"><span>◈ ' + esc(ctl.title) + '</span><button type="button" class="tsel-x" aria-label="Close">✕</button></div><div class="tsel-list" role="listbox"></div>';
    var listEl = panel.querySelector('.tsel-list');
    var focusEl = null;
    visibleOptions(ctl.sel).forEach(function (o) {
      var on = o === cursor;
      var p = splitLabel(o.text, o.value, ctl.sel.id);
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'tsel-item'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.innerHTML = '<span class="tsel-g" aria-hidden="true">' + (on ? '◈' : '⬡') + '</span><span class="tsel-t">' + esc(p.m) + (p.s ? '<span class="tsel-s">' + esc(p.s) + '</span>' : '') + '</span>';
      b.__opt = o;
      listEl.appendChild(b);
      if (on) focusEl = b;
    });
    panel.classList.add('on'); scrim.classList.add('on');
    ctl.btn.setAttribute('aria-expanded', 'true');
    place(ctl);
    focusEl = focusEl || listEl.querySelector('.tsel-item');
    if (focusEl) { try { focusEl.focus({ preventScroll: true }); focusEl.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  function closePanel(skipFocus) {
    if (!panel) return;
    var ctl = openCtl;
    openCtl = null;
    panel.classList.remove('on'); scrim.classList.remove('on');
    if (ctl) {
      ctl.btn.setAttribute('aria-expanded', 'false');
      if (skipFocus !== true) { try { ctl.btn.focus({ preventScroll: true }); } catch (e) {} }
    }
  }

  /* ---- control factories ---- */
  function hook(ctl) {
    var sel = ctl.sel;
    // programmatic `.value = x` (the app does this a lot) keeps the drawn control in sync
    Object.defineProperty(sel, 'value', {
      configurable: true, enumerable: true,
      get: function () { return vdesc.get.call(sel); },
      set: function (v) {
        vdesc.set.call(sel, v);
        if (v != null && String(v) !== '' && vdesc.get.call(sel) !== String(v)) {
          // a value that is no longer in the list (e.g. an old month) is kept visible instead of silently changing
          var o = document.createElement('option'); o.value = String(v); o.textContent = String(v);
          sel.appendChild(o); vdesc.set.call(sel, v);
        }
        ctl.render();
      }
    });
    sel.addEventListener('change', function () { ctl.render(); });
    var q = 0;
    new MutationObserver(function () {
      if (q) return;
      q = requestAnimationFrame(function () { q = 0; ctl.render(); });
    }).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'label'] });
  }

  function make(id, kind) {
    var sel = $(id);
    if (!sel || controls[id]) return;
    var host = document.createElement('div');
    host.className = 'tsel';
    sel.parentNode.insertBefore(host, sel.nextSibling);
    sel.classList.add('tsel-native');
    sel.setAttribute('tabindex', '-1'); sel.setAttribute('aria-hidden', 'true');
    var ctl = { sel: sel, host: host, title: titleOf(sel) };
    controls[id] = ctl;

    if (kind === 'dd') {
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'tsel-btn';
      btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<span class="tsel-glyph" aria-hidden="true">⬡</span><span class="tsel-val"></span><span class="tsel-caret" aria-hidden="true">▾</span>';
      host.appendChild(btn);
      if (id === 'filterMonth') host.style.minWidth = '150px';
      if (id === 'filterBatch') host.style.minWidth = '170px';
      if (id === 'structSemSelect') host.style.minWidth = '130px';
      if (id === 'structCopyFromSelect') host.style.minWidth = '190px';
      ctl.btn = btn;
      ctl.render = function () {
        var o = selectedOption(sel);
        btn.querySelector('.tsel-val').textContent = o ? o.text : 'Select…';
        btn.disabled = !!sel.disabled;
        btn.setAttribute('aria-label', ctl.title + ': ' + (o ? o.text : 'none selected'));
      };
      btn.addEventListener('click', function () { if (openCtl === ctl) closePanel(); else openPanel(ctl); });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPanel(ctl); }
      });
    } else {
      host.classList.add('tchips');
      if (id === 'upMonth' || id === 'upModule') host.classList.add('tchips--grid');
      if (COMPACT.indexOf(id) > -1) host.classList.add('tchips--compact');
      host.setAttribute('role', 'radiogroup'); host.setAttribute('aria-label', ctl.title);
      ctl.btn = host;
      ctl.render = function () {
        var kids = Array.prototype.slice.call(host.children);
        var ai = kids.indexOf(document.activeElement);
        var on = selectedOption(sel);
        host.innerHTML = '';
        visibleOptions(sel).forEach(function (o) {
          var p = splitLabel(o.text, o.value, id);
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'tchip'; b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', o === on ? 'true' : 'false');
          b.innerHTML = esc(p.m) + (p.s ? '<span class="tchip-sub">' + esc(p.s) + '</span>' : '');
          b.__opt = o;
          if (id === 'upModule' && o.value === '') b.style.gridColumn = '1 / -1';
          host.appendChild(b);
        });
        if (ai > -1 && host.children[ai]) { try { host.children[ai].focus({ preventScroll: true }); } catch (e) {} }
      };
      host.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.tchip') : null;
        if (b) choose(ctl, b.__opt);
      });
      host.addEventListener('keydown', function (e) {
        var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0);
        if (!step) return;
        var kids = Array.prototype.slice.call(host.children);
        var i = kids.indexOf(document.activeElement);
        if (i < 0) return;
        e.preventDefault();
        var nx = kids[(i + step + kids.length) % kids.length];
        if (nx) { choose(ctl, nx.__opt); }
      });
    }

    hook(ctl);
    // labels: HUD eyebrow style, and a click on the label opens / focuses the drawn control
    var lab = document.querySelector('label[for="' + id + '"]') || (id === 'filterMonth' ? sel.parentNode.querySelector('label') : null);
    if (lab) {
      lab.classList.add('tsel-label');
      lab.addEventListener('click', function (e) {
        e.preventDefault();
        var t = kind === 'dd' ? ctl.btn : (host.querySelector('[aria-checked="true"]') || host.querySelector('.tchip'));
        if (t) t.focus();
      });
    }
    ctl.render();
  }

  function refreshAll() { Object.keys(controls).forEach(function (k) { controls[k].render(); }); }

  function init() {
    DROPDOWNS.forEach(function (id) { make(id, 'dd'); });
    CHIPS.forEach(function (id) { make(id, 'chips'); });
    readout(false);
    var el = $('optionsLiveReadout');
    if (el) el.textContent = '◈ Waiting for the first sync…';
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) apply(JSON.parse(raw), true);
    } catch (e) {}
    // No sync yet (offline, old script, first visit): run the per-sem rules on the built-in lists, so
    // SEM 4–10 stay empty instead of showing SEM 1–3's subjects. The first real sync replaces this.
    if (!cur) {
      cur = normalise(builtinOptions());
      try { cascadeAll(); } catch (e) {}
      try { if (typeof updateUploadPreview === 'function') updateUploadPreview(); } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

