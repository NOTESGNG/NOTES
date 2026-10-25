    // Bump this by 1 whenever the generated Apps Script code changes. The Setup tab writes it into the
    // script, the script reports it back on ?action=health, and the Editor tab warns if they don't match.
    const EXPECTED_SCRIPT_VERSION = 7;   // 7: Editor-only pending links, rejected files deleted, shield from NEW_FILE_GRACE_DAYS, saveBatches
    // Sems that use the shared SUBJECTS / COURSES lists until the Editor sets them up. Every other sem
    // (4 to 10) has NO subjects until it's set up in Course Structure. Change this list to change that.
    const SHARED_LIST_SEMS = ['1', '2', '3'];
    const POINTS_MAP = {
      'NOTES': 1,
      'Q.PAPERS': 2,
      'SYLLABUS BREAKDOWN': 1,
      'CLASS VIDEOS': 2
    };

    function isValidWebAppUrl(u) {
      const s = String(u || '').trim();
      return s.indexOf('https://script.google.com/') === 0 && s.slice(-5) === '/exec';
    }

    // ---- Auto-CAPS layer: everything except Topics is normalised so typing style never matters ----
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function safeUrl(u) { return String(u || '').toLowerCase().indexOf('https://') === 0 ? String(u) : ''; }
    // Direct-download link for a Google Drive file link ('' if it isn't one).
    function driveDownloadUrl(u) {
      const s = safeUrl(u);
      const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
      return m ? 'https://drive.google.com/uc?export=download&id=' + m[1] : '';
    }
    function UP(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase(); }
    function extractDigits(s) {
      let out = '';
      const str = String(s == null ? '' : s);
      for (let i = 0; i < str.length; i++) {
        const ch = str.charAt(i);
        if (ch >= '0' && ch <= '9') out += ch;
      }
      return out;
    }

    // "Does this subject have no course layer in this sem?" Uses the Editor's Course Structure when it's loaded,
    // otherwise the shared no-course list (ENG, FRENCH…).
    function noCourseFor(subject, sem) {
      if (window.DeptOptions && window.DeptOptions.isNoCourse) return window.DeptOptions.isNoCourse(subject, sem);
      return SUBJECTS_NO_COURSE.includes(subject);
    }

    function canonItem(it) {
      const o = Object.assign({}, it);
      o.name = UP(o.name) || 'ANON';
      o.month = UP(o.month);
      o.subject = UP(o.subject);
      o.course = UP(o.course) || (SUBJECTS_NO_COURSE.includes(o.subject) ? 'NONE' : 'DSC-B');
      o.contentType = UP(o.contentType) || 'NOTES';
      o.module = UP(o.module) || 'MODULE';
      o.scope = UP(o.scope) === 'DAILY' ? 'DAILY' : 'COMPLETE';
      o.sem = 'SEM' + (extractDigits(o.sem) || '1');
      o.displayName = UP(o.displayName || (o.name + '.' + o.month));
      o.topics = String(o.topics == null ? '' : o.topics);
      o.size = o.size || '';
      o.fileUrl = o.fileUrl || '';
      o.batch = UP(o.batch || '');
      return o;
    }

    const state = {
      activeTab: 'viewBrowse',
      liveWebAppUrl: '',
      testFolderId: cleanFolderIdOrPlaceholder(DEFAULT_ROOT_FOLDER_ID),
      activeModalFileId: null,
      editorUnlocked: false,
      editorPin: '',
      bootstrapSession: false,
      likedIds: {},
      files: [],
      pending: [],
      announcements: [],
      batch: null            // { code, label, startYear } — set by "Join Class"; stays null until the student does that once. Never a hard gate: null just means uploads go untagged and every file stays visible.
    };

    // Which Web App a device starts from: #hub= join link > last one used on this device > DEFAULT_WEBAPP_URL.
    // If DEFAULT_WEBAPP_URL was edited since this device last loaded the page, the new default wins instead, so editing that
    // one line still moves everyone. From the starting point the app follows any "forward" the Editor applied, and the
    // other of saved/default is kept as a backup, so deleting an old deployment never strands a device.
    let savedWebAppUrl = '';
    let fallbackWebAppUrl = '';
    try {
      const savedLikes = localStorage.getItem('deptnotes_liked_ids');
      if (savedLikes) state.likedIds = JSON.parse(savedLikes);
      const savedUrl = localStorage.getItem('deptnotes_live_url');
      if (savedUrl && isValidWebAppUrl(savedUrl)) savedWebAppUrl = savedUrl;
      const savedBatch = localStorage.getItem('deptnotes_batch');
      if (savedBatch) {
        const b = JSON.parse(savedBatch);
        if (b && b.code) state.batch = { code: String(b.code).toUpperCase(), label: String(b.label || b.code), startYear: Number.isFinite(b.startYear) ? b.startYear : null };
      }
    } catch (e) {}

    try {
      let startUrl = '';
      const hashStr = String(location.hash || '');
      const hubIdx = hashStr.indexOf('hub=');
      if (hubIdx > -1) {
        const hu = decodeURIComponent(hashStr.slice(hubIdx + 4).split('&')[0]);
        if (isValidWebAppUrl(hu)) startUrl = hu;
      }
      const defaultOk = isValidWebAppUrl(DEFAULT_WEBAPP_URL);
      let seenDefault = '';
      try { seenDefault = localStorage.getItem('deptnotes_default_url') || ''; } catch (e) {}
      const defaultChanged = defaultOk && seenDefault !== DEFAULT_WEBAPP_URL;
      if (!startUrl && savedWebAppUrl && !defaultChanged) startUrl = savedWebAppUrl;
      if (!startUrl && defaultOk) startUrl = DEFAULT_WEBAPP_URL;
      if (!startUrl) startUrl = savedWebAppUrl;
      state.liveWebAppUrl = startUrl;
      if (savedWebAppUrl && savedWebAppUrl !== startUrl) fallbackWebAppUrl = savedWebAppUrl;
      else if (defaultOk && DEFAULT_WEBAPP_URL !== startUrl) fallbackWebAppUrl = DEFAULT_WEBAPP_URL;
      try { if (defaultOk) localStorage.setItem('deptnotes_default_url', DEFAULT_WEBAPP_URL); } catch (e) {}
    } catch (e) {}

    // ==================== HELPER FUNCTIONS ====================
    function showToast(msg, type = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const colors = {
        info: 'bg-slate-900 text-white border-slate-700',
        success: 'bg-emerald-700 text-white border-emerald-600',
        warn: 'bg-amber-600 text-white border-amber-500'
      };
      const el = document.createElement('div');
      el.className = `pointer-events-auto px-4 py-3 rounded-xl border shadow-lg text-xs font-medium transition-all ${colors[type] || colors.info}`;
      el.textContent = msg;
      container.appendChild(el);
      setTimeout(() => el.remove(), 3600);
    }

    function semToYearFolder(sem) {
      const num = parseInt(extractDigits(sem), 10) || 1;
      const yearNum = Math.ceil(num / 2);
      return `YEAR ${Math.min(Math.max(yearNum, 1), 5)}`;
    }

    // Days of Top-5 protection a note has left. The script works this out from the Sheet's NEW_FILE_GRACE_DAYS,
    // so the badge always matches what the pruning really does. A script from before that falls back to 7 days.
    function shieldDaysLeft(f) {
      if (typeof f.shieldDaysLeft === 'number') return f.shieldDaysLeft;
      return Math.max(0, 7 - f.daysOld);
    }

    function buildDrivePath(item) {
      const yr = semToYearFolder(item.sem);
      const semLabel = item.sem.toUpperCase().replace('SEM', 'SEM ');
      const noCourse = !item.course || item.course === 'NONE';
      let parts = [yr, semLabel, item.subject];
      if (!noCourse && item.course && item.course !== 'NONE') {
        parts.push(item.course);
      }
      parts.push(item.contentType);
      if (item.contentType === 'NOTES' || item.contentType === 'CLASS VIDEOS') {
        parts.push(noCourse ? item.month : (item.module || 'MODULE'));
      }
      return parts.join(' / ');
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const base64 = result.includes(',') ? result.split(',')[1] : result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // ==================== MY UPLOADS RECEIPT + HEALTH CHECK ====================
    function loadMyUploads() {
      try { return JSON.parse(localStorage.getItem('deptnotes_my_uploads') || '[]'); } catch (e) { return []; }
    }
    function saveMyUploads(list) {
      try { localStorage.setItem('deptnotes_my_uploads', JSON.stringify(list.slice(0, 12))); } catch (e) {}
    }
    function addMyUpload(item) {
      const list = loadMyUploads();
      list.unshift(item);
      saveMyUploads(list);
    }
    function renderMyUploads() {
      const box = document.getElementById('myUploadsBox');
      const listEl = document.getElementById('myUploadsList');
      if (!box || !listEl) return;
      const list = loadMyUploads();
      box.classList.toggle('hidden', list.length === 0);
      const synced = state.liveWebAppUrl && (state.files.length + state.pending.length) > 0;
      listEl.innerHTML = list.map(u => {
        let status = '⏳ Saved — waiting for Editor approval';
        let cls = 'bg-amber-50 text-amber-800 border-amber-200';
        const rid = u.recordId || '';
        if (!rid) { status = 'ℹ️ Uploaded before the ID update — look for it in Browse'; cls = 'bg-slate-100 text-slate-700 border-slate-200'; }
        else if (state.files.some(f => f.id === rid)) { status = '✅ Approved — live in Browse'; cls = 'bg-emerald-50 text-emerald-800 border-emerald-200'; }
        else if (synced && !state.pending.some(p => p.id === rid)) { status = '🗑️ No longer pending (rejected or removed by the Editor)'; cls = 'bg-slate-100 text-slate-700 border-slate-200'; }
        return '<div class="rounded-xl border px-3 py-2 text-xs ' + cls + '"><div class="font-semibold">' + escapeHtmlSafe(u.label) + '</div><div>' + status + '</div><div class="opacity-70">Saved in: ' + escapeHtmlSafe(u.savedIn || '') + '</div></div>';
      }).join('');
    }
    function escapeHtmlSafe(t) {
      return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Asks the Web App if uploads can really work, and tells the person plainly if not (instead of files vanishing).
    // Shows the Editor-tab warning when the deployed script is older than this page expects.
    // A script from before versioning reports no scriptVersion at all, which counts as out of date.
    function updateScriptVersionBanner(h) {
      const banner = document.getElementById('scriptVersionBanner');
      if (!banner) return;
      const have = h && Number(h.scriptVersion);
      if (!h || have >= EXPECTED_SCRIPT_VERSION) { banner.classList.add('hidden'); return false; }
      document.getElementById('scriptVersionDetail').textContent = (have
        ? 'The deployed script is version ' + have + '; this app needs version ' + EXPECTED_SCRIPT_VERSION + '.'
        : 'The deployed script is from before batches and per-semester course structure.') +
        (have
          ? ' Until you redeploy, adding batches won\'t work, rejected files aren\'t deleted from Drive, and pending files\' links stay public. Everything else keeps working.'
          : ' Until you redeploy, Save Structure, batch tags on uploads and moving notes between sems won\'t work. Everything else keeps working.');
      banner.classList.remove('hidden');
      return true;
    }

    async function checkUploadHealth() {
      const banner = document.getElementById('uploadHealthBanner');
      if (!banner) return;
      if (!state.liveWebAppUrl) { banner.classList.add('hidden'); return; }
      try {
        const res = await fetch(state.liveWebAppUrl + '?action=health', { redirect: 'follow' });
        const h = await res.json();
        updateScriptVersionBanner(h);
        if (h && h.problems && h.recordIds === true) {
          if (h.ok) { banner.classList.add('hidden'); return; }
          banner.innerHTML = '⚠️ Uploads may not work yet: ' + h.problems.map(escapeHtmlSafe).join(' • ');
          banner.classList.remove('hidden');
        } else {
          banner.innerHTML = '⚠️ This Web App is running an old script (before stable Record IDs). The Editor must paste the latest code and deploy a <strong>New version</strong> (Deploy → Manage deployments → pencil → New version).';
          banner.classList.remove('hidden');
        }
      } catch (err) {
        banner.innerHTML = '⚠️ Cannot reach the Drive script. The Editor must deploy it as <strong>Execute as: Me</strong> and <strong>Who has access: Anyone</strong>.';
        banner.classList.remove('hidden');
      }
    }

    // ==================== LIVE GOOGLE DRIVE API SYNC (doGet / doPost) ====================
    let lastSyncSig = '';
    let hubHops = 0;
    async function syncFromLiveDrive(quiet) {
      if (!state.liveWebAppUrl) return;
      try {
        if (!quiet) showToast('Syncing with your Google Drive & Sheet...', 'info');
        // Drive links of files still waiting for approval only come back for the Editor, so the PIN goes along once unlocked.
        const pinPart = state.editorUnlocked && state.editorPin ? '&pin=' + encodeURIComponent(state.editorPin) : '';
        const res = await fetch(state.liveWebAppUrl + '?action=listAll' + pinPart, { redirect: 'follow' });
        const data = await res.json();
        if (data && data.ok) {
          if (data.forwardUrl && data.forwardUrl !== state.liveWebAppUrl && isValidWebAppUrl(data.forwardUrl) && hubHops < 8) {
            hubHops++;
            applyLiveUrl(data.forwardUrl);
            lastSyncSig = '';
            showToast('The Editor connected a new Drive — reconnected automatically.', 'info');
            return syncFromLiveDrive(true);
          }
          hubHops = 0;
          fallbackWebAppUrl = '';
          const sig = JSON.stringify([data.files, data.pending, data.announcements, data.options]);
          if (quiet && sig === lastSyncSig) return;
          lastSyncSig = sig;
          state.files = (data.files || []).map(canonItem);
          state.pending = (data.pending || []).map(canonItem);
          state.announcements = data.announcements || [];
          if (window.DeptOptions) window.DeptOptions.apply(data.options);
          renderBrowse();
          renderEditor();
          renderFeedAndLeaderboard();
          renderMyUploads();
          if (!quiet) showToast(`Synced! ${state.files.length} approved file(s), ${state.pending.length} pending in Drive.`, 'success');
        }
      } catch (err) {
        if (fallbackWebAppUrl && fallbackWebAppUrl !== state.liveWebAppUrl) {
          const f = fallbackWebAppUrl;
          fallbackWebAppUrl = '';
          applyLiveUrl(f);
          lastSyncSig = '';
          return syncFromLiveDrive(quiet);
        }
        if (!quiet) showToast('Could not reach Web App URL — check that deployment access is set to "Anyone".', 'warn');
      }
    }

    function canSeeSetup() {
      // The Setup tab is only for the Editor — or for whoever is connecting this app for the very first time.
      return state.editorUnlocked || !state.liveWebAppUrl || state.bootstrapSession;
    }

    function applyLiveUrl(url) {
      state.liveWebAppUrl = url || '';
      try { if (url) localStorage.setItem('deptnotes_live_url', url); else localStorage.removeItem('deptnotes_live_url'); } catch (e) {}
      const badge = document.getElementById('connectionBadge');
      document.getElementById('btnSyncNow').classList.toggle('hidden', !url);
      const quickDisc = document.getElementById('btnDisconnectLiveQuick');
      if (quickDisc) quickDisc.classList.toggle('hidden', !url);
      const banner = document.getElementById('notConnectedBanner');
      if (banner) banner.classList.toggle('hidden', !!url);
      badge.textContent = url ? 'Live Drive Connected' : 'Not connected';
      badge.className = 'text-xs font-medium px-2 py-0.5 rounded-full border ' + (url
        ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : 'bg-amber-100 text-amber-800 border-amber-200');
      document.getElementById('inputWebAppUrl').value = url || DEFAULT_WEBAPP_URL;
      const sl = document.getElementById('inputShareLink');
      if (sl) sl.value = url ? SITE_URL + '#hub=' + encodeURIComponent(url) : 'Connect a Web App URL first';
      const pl = document.getElementById('inputPermanentLine');
      if (pl) pl.value = url ? "const DEFAULT_WEBAPP_URL = '" + url + "';" : 'Connect a Web App URL first';
      if (!url) {
        state.files = [];
        state.pending = [];
        state.announcements = [];
        lastSyncSig = '';
        lockEditor();
        renderBrowse();
        renderEditor();
        renderFeedAndLeaderboard();
      }
      applySetupGate();
      if (state.activeTab === 'viewSetup' && !canSeeSetup()) switchTab('viewBrowse');
    }

    function cleanFolderId(raw) {
      const s = String(raw || '').trim();
      const idx = s.indexOf('folders/');
      if (idx > -1) {
        return s.slice(idx + 8).split('?')[0].split('/')[0].trim();
      }
      return s;
    }

    function cleanFolderIdOrPlaceholder(raw) {
      return cleanFolderId(raw) || FOLDER_ID_PLACEHOLDER;
    }

    let setupGateShown = false;
    function applySetupGate() {
      const on = canSeeSetup();
      document.getElementById('tabBtnSetup').classList.toggle('hidden', !on);
      if (on !== setupGateShown) {
        setupGateShown = on;
        document.getElementById('appsScriptCodeBlock').textContent = on ? generateAppsScriptCode(state.testFolderId) : '';
      }
    }

    let liveRootFolderId = ''; // the folder ID the deployed script reports, used to warn before copying a mismatched script
    async function refreshLiveConfig() {
      const el = document.getElementById('liveConfigStatus');
      if (!state.liveWebAppUrl) { el.textContent = 'Not connected to a live Web App yet — refresh the page to reconnect.'; return; }
      const res = await postToLiveDrive({ action: 'getConfig' }, true);
      if (res && res.ok) {
        liveRootFolderId = String(res.rootFolderId || '');
        el.textContent = 'The connected script uses Root Folder: ' + (res.rootFolderName || '(unknown)') + ' — ID ' + res.rootFolderId + (res.forwardUrl ? ' • it forwards everyone to a newer Web App' : '');
        const box = document.getElementById('inputTestFolderId');
        if (res.rootFolderId && !String(res.rootFolderId).startsWith('PASTE_') && (!box.value.trim() || box.value.startsWith('PASTE_'))) {
          state.testFolderId = res.rootFolderId;
          box.value = res.rootFolderId;
          document.getElementById('appsScriptCodeBlock').textContent = generateAppsScriptCode(state.testFolderId);
        }
      } else {
        el.textContent = 'Connected URL did not respond to getConfig — in Apps Script, click Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy.';
      }
    }

    // Actions that need the Editor PIN. This ONE list is used by the app (to attach the PIN) AND written into the
    // generated Apps Script (to check it), so the two can never disagree. Add new editor actions here only.
    const EDITOR_ACTIONS = ['approve', 'reject', 'editProps', 'delete', 'verifyPin', 'getConfig', 'setForwardUrl', 'setRootFolder', 'postNotice', 'deleteNotice', 'saveStructure', 'getFileData', 'saveBatches'];

    function lockEditor() {
      state.editorUnlocked = false;
      state.editorPin = '';
      state.pending.forEach(p => { p.fileUrl = ''; }); // pending Drive links are Editor-only
      lastSyncSig = '';
      document.getElementById('editorMainContent').classList.add('hidden');
      document.getElementById('modalEditorBlock').classList.add('hidden');
      document.getElementById('editorPinInput').value = '';
      document.getElementById('btnUnlockEditor').textContent = 'Unlock Console';
      applySetupGate();
      renderFeedAndLeaderboard();
      if (state.activeTab === 'viewSetup' && !canSeeSetup()) switchTab('viewBrowse');
    }

    async function postToLiveDrive(payload, silentError) {
      if (!state.liveWebAppUrl) return null;
      if (EDITOR_ACTIONS.includes(payload.action)) {
        payload = Object.assign({}, payload, { pin: payload.pin || state.editorPin });
      }
      try {
        const res = await fetch(state.liveWebAppUrl, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });
        const out = await res.json();
        if (out && out.ok === false && out.error === 'Wrong editor PIN' && payload.action !== 'verifyPin') {
          lockEditor();
          showToast('Wrong Editor PIN — console locked again.', 'warn');
        }
        // An older Apps Script doesn't know newer actions. Say what to do instead of a bare "Unknown action".
        if (out && out.ok === false && out.error === 'Unknown action') {
          out.error = 'your Apps Script is out of date. Copy the new code from ⚙️ Setup, paste it into Apps Script, run setup, then Deploy → New version.';
        }
        return out;
      } catch (err) {
        if (!silentError) {
          showToast('Live Drive request failed — verify Web App deployment URL.', 'warn');
        }
        return null;
      }
    }

    // ==================== RENDER: STUDENT ARCHIVE BROWSER ====================
    function renderBrowse() {
      const sem = document.getElementById('filterSem').value;
      const subject = document.getElementById('filterSubject').value;
      const course = document.getElementById('filterCourse').value;
      const type = document.getElementById('filterType').value;
      const mod = document.getElementById('filterModule').value;
      const month = document.getElementById('filterMonth').value;
      const query = document.getElementById('searchInput').value.trim().toLowerCase();

      const noCourse = subject !== 'ALL' && noCourseFor(subject, sem);
      document.getElementById('courseFilterWrapper').style.opacity = noCourse ? '0.45' : '1';

      const yr = sem === 'ALL' ? 'Years 1–5' : semToYearFolder(sem);
      const semText = sem === 'ALL' ? 'All Sems' : sem.toUpperCase().replace('SEM', 'SEM ');
      const subText = subject === 'ALL' ? 'All Subjects' : subject;
      const courseText = noCourse ? '(No Course Layer)' : (course === 'ALL' ? 'All Courses' : course);
      document.getElementById('liveDrivePath').textContent = `${yr} / ${semText} / ${subText} / ${courseText}`;

      let filtered = state.files.filter(f => f.approved);
      if (sem !== 'ALL') filtered = filtered.filter(f => f.sem === sem);
      if (subject !== 'ALL') filtered = filtered.filter(f => f.subject === subject);
      if (!noCourse && course !== 'ALL') filtered = filtered.filter(f => f.course === course);
      if (type !== 'ALL') filtered = filtered.filter(f => f.contentType === type);
      if (mod !== 'ALL') filtered = filtered.filter(f => f.module === mod);
      if (month !== 'ALL') filtered = filtered.filter(f => f.month === month);
      filtered = filtered.filter(matchesBatchFilter);

      if (query) {
        filtered = filtered.filter(f =>
          f.displayName.toLowerCase().includes(query) ||
          f.topics.toLowerCase().includes(query) ||
          f.name.toLowerCase().includes(query) ||
          f.month.toLowerCase().includes(query) ||
          f.course.toLowerCase().includes(query)
        );
      }

      filtered.sort((a, b) => (b.likes - a.likes) || (a.daysOld - b.daysOld));

      document.getElementById('resultsSummaryText').textContent =
        `Showing ${filtered.length} approved item${filtered.length === 1 ? '' : 's'} (Sorted by 👍 Likes)`;

      const grid = document.getElementById('filesGrid');
      grid.innerHTML = '';

      if (filtered.length === 0) {
        grid.innerHTML = `
          <div class="col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-3">
            <div class="text-2xl">📂</div>
            <p class="text-base font-bold text-slate-800">0 files in this folder right now</p>
            <p class="text-xs text-slate-500 max-w-md mx-auto">
              ${state.liveWebAppUrl
                ? 'Try switching "Year & Semester" or "Course Stream" to "All", or upload the first note for this module to earn contributor points!'
                : 'This app is not connected to the department Drive yet. Ask your Editor for the join link.'}
            </p>
          </div>
        `;
        return;
      }

      filtered.forEach((f, idx) => {
        const shieldDays = shieldDaysLeft(f);
        const isShielded = shieldDays > 0;
        const isLiked = !!state.likedIds[f.id];
        const isVideo = f.contentType === 'CLASS VIDEOS';
        const isPYQ = f.contentType === 'Q.PAPERS';

        const badgeColor = isVideo
          ? 'bg-purple-100 text-purple-800 border-purple-200'
          : isPYQ
          ? 'bg-amber-100 text-amber-800 border-amber-200'
          : 'bg-indigo-50 text-indigo-700 border-indigo-200';

        const card = document.createElement('div');
        card.className = 'bg-white rounded-2xl border border-slate-200 p-4 shadow-xs hover:shadow-md hover:border-indigo-200 transition flex flex-col justify-between gap-3';
        card.innerHTML = `
          <div class="space-y-2.5">
            <div class="flex items-start justify-between gap-2">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-xs font-bold px-2 py-0.5 rounded-md border ${badgeColor}">
                  ${isVideo ? '🎬 VIDEO' : esc(f.contentType)}
                </span>
                <span class="text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                  ${esc(f.sem.toUpperCase())} • ${esc(f.subject)}${f.course !== 'NONE' ? ' (' + esc(f.course) + ')' : ''}
                </span>
                ${f.scope === 'DAILY' ? '<span class="text-xs font-semibold px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200">📅 Daily Note</span>' : ''}
                ${f.batch ? '<span class="text-xs font-semibold px-2 py-0.5 rounded-md bg-purple-100 text-purple-800 border border-purple-200">🎓 ' + esc(f.batch) + '</span>' : ''}
              </div>
              <span class="text-xs font-mono text-slate-400">#${idx + 1}</span>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="font-bold text-base text-slate-900 font-mono min-w-0" style="overflow-wrap:anywhere">${esc(f.displayName)}</h3>
              ${isShielded
                ? `<span class="shrink-0 whitespace-nowrap text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200" title="Uploaded ${f.daysOld}d ago — protected from Top-5 pruning for ${shieldDays} more day${shieldDays === 1 ? '' : 's'}">🛡️ 🆕 ${shieldDays}d Shield</span>`
                : `<span class="text-xs text-slate-400">${f.daysOld}d ago</span>`
              }
            </div>

            <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-100 text-xs space-y-1">
              <div class="text-xs font-semibold uppercase tracking-wider text-slate-400">Topics covered:</div>
              <p class="text-slate-700 font-medium line-clamp-2">${esc(f.topics)}</p>
            </div>

            <div class="text-xs text-slate-500 font-mono truncate" title="${esc(buildDrivePath(f))}">
              📁 ${esc(buildDrivePath(f))}
            </div>
          </div>

          <div class="pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
            <button type="button" data-like-id="${esc(f.id)}" class="btn-like flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
              isLiked
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-300'
            }">
              <span>👍</span>
              <span>${f.likes}</span>
            </button>

            <div class="flex items-center gap-1.5">
              <button type="button" data-open-id="${esc(f.id)}" class="btn-open-modal px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition">
                ${isVideo ? '▶️ Watch / Properties' : '📄 Open / Properties'}
              </button>
            </div>
          </div>
        `;
        grid.appendChild(card);
      });

      grid.querySelectorAll('.btn-like').forEach(btn => {
        btn.addEventListener('click', () => toggleLike(btn.getAttribute('data-like-id')));
      });
      grid.querySelectorAll('.btn-open-modal').forEach(btn => {
        btn.addEventListener('click', () => openFileModal(btn.getAttribute('data-open-id')));
      });
    }

    // ==================== LIKE SYSTEM + TOP-5 PRUNING WITH 7-DAY SHIELD ====================
    async function toggleLike(fileId) {
      const file = state.files.find(f => f.id === fileId);
      if (!file) return;

      let delta = 1;
      if (state.likedIds[fileId]) {
        file.likes = Math.max(0, file.likes - 1);
        delete state.likedIds[fileId];
        delta = -1;
        showToast(`Removed like from ${file.displayName}`, 'info');
      } else {
        file.likes += 1;
        state.likedIds[fileId] = true;
        delta = 1;
        showToast(`👍 Liked ${file.displayName}! Higher likes keep notes in the Top 5.`, 'success');
      }

      try {
        localStorage.setItem('deptnotes_liked_ids', JSON.stringify(state.likedIds));
      } catch (e) {}

      renderBrowse();
      renderFeedAndLeaderboard();

      if (state.liveWebAppUrl) {
        await postToLiveDrive({ action: 'like', recordId: file.id, delta });
      }
    }

    // ==================== UPLOAD FORM LOGIC ====================
    // True when the chosen sem has no subjects yet (not set up in Course Structure).
    function semHasNoSubjects(sem) {
      return !!(window.DeptOptions && window.DeptOptions.get && window.DeptOptions.get() &&
        !window.DeptOptions.subjectsForSem(sem).codes.length);
    }

    function updateUploadPreview() {
      const semEmpty = semHasNoSubjects(document.getElementById('upSem').value);
      const note = document.getElementById('upSemNotSetUp');
      if (note) {
        note.textContent = semEmpty ? document.getElementById('upSem').value.replace('SEM', 'SEM ') + ' isn\'t set up yet. Ask your Editor to add its subjects in Course Structure.' : '';
        note.classList.toggle('hidden', !semEmpty);
      }
      if (semEmpty) { const cs = document.getElementById('upCourse'); if (cs.value !== '') cs.value = ''; }
      const submit = document.getElementById('btnSubmitUpload');
      if (submit && !submit.textContent.includes('Uploading')) submit.disabled = semEmpty;
      const rawName = UP(document.getElementById('upName').value) || 'ANON';
      const month = document.getElementById('upMonth').value;
      const sem = document.getElementById('upSem').value;
      const subject = document.getElementById('upSubject').value;
      const noCourse = noCourseFor(subject, sem);
      document.getElementById('upCourseWrapper').style.opacity = noCourse ? '0.4' : '1';

      const allowedCourses = (window.DeptOptions && window.DeptOptions.allowedCourses) ? window.DeptOptions.allowedCourses(subject, sem) : (subject === 'ECO' ? ['DSC-A', 'DSC-B'] : ['DSC-B', 'DSC-C', 'MDC']);
      const courseSel = document.getElementById('upCourse');
      Array.from(courseSel.options).forEach(o => { o.disabled = !allowedCourses.includes(o.value); o.hidden = o.disabled; });
      if (allowedCourses.length && !allowedCourses.includes(courseSel.value)) courseSel.value = allowedCourses[0];

      const course = noCourse ? 'NONE' : document.getElementById('upCourse').value;
      const contentType = document.getElementById('upType').value;
      const modRaw = document.getElementById('upModule').value;
      const modFolder = modRaw ? `MODULE ${modRaw}` : 'MODULE';

      document.getElementById('previewFileName').textContent = `${rawName}.${month}`;
      document.getElementById('previewDestPath').textContent = buildDrivePath({
        sem, subject, course, contentType, module: modFolder, month
      });
    }

    // ==================== RENDER: ANNOUNCEMENTS & POINTS LEADERBOARD ====================
    function buildFeed() {
      // Editor notices (stored in the Sheet's script, same for every device) + recently approved files (derived from the synced archive)
      const notices = (state.announcements || []).slice();
      const recent = state.files
        .filter(f => f.approved && f.daysOld <= 14)
        .sort((a, b) => a.daysOld - b.daysOld)
        .slice(0, 30)
        .map(f => {
          const pts = POINTS_MAP[f.contentType] || 1;
          return {
            id: 'ap_' + f.id,
            title: `✅ Approved: ${f.displayName} (${f.sem} ${f.subject}${f.course !== 'NONE' ? ' ' + f.course : ''})`,
            body: `Topics: ${f.topics} (+${pts} Contributor Point${pts > 1 ? 's' : ''} awarded to ${f.name}).`,
            time: (f.daysOld === 0 ? 'Today' : f.daysOld + 'd ago') + ' • New Upload'
          };
        });
      return notices.concat(recent);
    }

    function renderFeedAndLeaderboard() {
      const feed = buildFeed();
      document.getElementById('feedCountBadge').textContent = feed.length;
      const annList = document.getElementById('announcementsList');
      annList.innerHTML = '';

      if (feed.length === 0) {
        annList.innerHTML = `<p class="text-xs text-slate-400 italic p-3">No announcements yet. Approved files and Editor notices appear here.</p>`;
      } else {
        feed.forEach(a => {
          const canDelete = state.editorUnlocked && /^n\d+$/.test(String(a.id));
          const item = document.createElement('div');
          item.className = 'p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1';
          item.innerHTML = `
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-bold text-sm text-slate-900">${esc(a.title)}</h4>
              <span class="flex items-center gap-2">
                <span class="text-xs text-slate-400 whitespace-nowrap">${esc(a.time)}</span>
                ${canDelete ? `<button type="button" data-del-notice="${esc(a.id)}" class="btn-del-notice text-xs font-semibold text-rose-600 hover:text-rose-800">✕ Remove</button>` : ''}
              </span>
            </div>
            <p class="text-xs text-slate-600 leading-relaxed">${esc(a.body)}</p>
          `;
          annList.appendChild(item);
        });
        annList.querySelectorAll('.btn-del-notice').forEach(btn => {
          btn.addEventListener('click', async () => {
            const res = await postToLiveDrive({ action: 'deleteNotice', id: btn.getAttribute('data-del-notice') });
            if (res && res.ok) {
              await syncFromLiveDrive(true);
              showToast('Notice removed', 'info');
            }
          });
        });
      }

      const scores = {};
      state.files.filter(f => f.approved).forEach(f => {
        const pts = POINTS_MAP[f.contentType] || 1;
        if (!scores[f.name]) {
          scores[f.name] = { name: f.name, points: 0, uploads: 0, likes: 0 };
        }
        scores[f.name].points += pts;
        scores[f.name].uploads += 1;
        scores[f.name].likes += f.likes;
      });

      const sortedContributors = Object.values(scores).sort((a, b) => (b.points - a.points) || (b.likes - a.likes));
      const lbList = document.getElementById('leaderboardList');
      lbList.innerHTML = '';

      if (sortedContributors.length === 0) {
        lbList.innerHTML = `<p class="text-xs text-slate-400 italic p-2">0 contributors yet — points appear automatically as files are approved!</p>`;
        return;
      }

      sortedContributors.forEach((c, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-xs';
        row.innerHTML = `
          <div class="flex items-center gap-2.5">
            <span class="font-bold text-sm w-6 text-center">${medal}</span>
            <div>
              <div class="font-bold text-slate-900">${esc(c.name)}</div>
              <div class="text-xs text-slate-500">${c.uploads} file(s) • 👍 ${c.likes} likes</div>
            </div>
          </div>
          <span class="px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 font-bold border border-indigo-200">
            ${c.points} pts
          </span>
        `;
        lbList.appendChild(row);
      });
    }

    // ==================== RENDER: EDITOR CONSOLE (PENDING + DAILY MERGER) ====================
    function renderEditor() {
      document.getElementById('pendingCountBadge').textContent = state.pending.length;
      const pList = document.getElementById('pendingQueueList');
      pList.innerHTML = '';

      if (state.pending.length === 0) {
        pList.innerHTML = `
          <div class="p-6 rounded-xl bg-slate-50 border border-slate-200 text-center text-xs text-slate-500">
            🎉 Nothing waiting for approval.
          </div>
        `;
      } else {
        state.pending.forEach(p => {
          const destPath = buildDrivePath(p);
          const row = document.createElement('div');
          row.className = 'p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-3';
          row.innerHTML = `
            <div class="space-y-1 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono font-bold text-sm text-indigo-700">${esc(p.displayName)}</span>
                <span class="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-800">${esc(p.contentType)}</span>
                <span class="text-xs font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-700">${esc(p.scope)}</span>
                <span class="text-xs text-slate-400">${esc(p.size || '2.1 MB')}</span>
              </div>
              <p class="text-xs text-slate-700 font-medium">Topics: ${esc(p.topics)}</p>
              ${p.note ? `<p class="text-xs text-rose-600 font-medium">⚠ ${esc(p.note)}</p>` : ''}
              <p class="text-xs font-mono text-slate-500">Target Path: ${esc(destPath)}</p>
            </div>
            <div class="flex items-center gap-2 self-end md:self-center">
              <button type="button" data-approve-id="${esc(p.id)}" class="btn-approve-item px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition">
                ✅ 1-Tap Approve
              </button>
              <button type="button" data-reject-id="${esc(p.id)}" class="btn-reject-item px-3 py-1.5 rounded-xl bg-rose-100 hover:bg-rose-200 text-rose-700 text-xs font-semibold transition">
                ✕ Reject
              </button>
            </div>
          `;
          pList.appendChild(row);
        });

        pList.querySelectorAll('.btn-approve-item').forEach(btn => {
          btn.addEventListener('click', () => approvePendingItem(btn.getAttribute('data-approve-id')));
        });
        pList.querySelectorAll('.btn-reject-item').forEach(btn => {
          btn.addEventListener('click', () => rejectPendingItem(btn.getAttribute('data-reject-id')));
        });
      }

      renderBatchAdmin();

      const dailyFiles = state.files.filter(f => f.approved && f.scope === 'DAILY');
      const dList = document.getElementById('dailyMergeList');
      dList.innerHTML = '';

      if (dailyFiles.length === 0) {
        dList.innerHTML = `<p class="text-xs text-slate-400 italic p-2">No daily notes to merge yet.</p>`;
      } else {
        dailyFiles.forEach(df => {
          const item = document.createElement('label');
          item.className = 'flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer hover:border-indigo-300 text-xs';
          item.innerHTML = `
            <div class="flex items-center gap-2.5">
              <input type="checkbox" value="${esc(df.id)}" checked class="daily-merge-check rounded text-indigo-600" />
              <div>
                <span class="font-mono font-bold text-slate-800">${esc(df.displayName)}</span>
                <span class="text-slate-500 ml-1">(${esc(df.subject)} ${esc(df.course)} • ${esc(df.module)})</span>
                <div class="text-xs text-slate-500">${esc(df.topics)}</div>
              </div>
            </div>
            <span class="text-xs font-mono text-slate-400">${esc(df.size)}</span>
          `;
          dList.appendChild(item);
        });
      }
    }

    async function approvePendingItem(pendId, skipSync) {
      const idx = state.pending.findIndex(p => p.id === pendId);
      if (idx === -1) return;
      if (!state.liveWebAppUrl) { showToast('Not connected to a Drive.', 'warn'); return; }

      const pItem = state.pending[idx];
      const res = await postToLiveDrive({ action: 'approve', recordId: pItem.id });
      if (!res || !res.ok) {
        if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Approval failed: ' + res.error, 'warn');
        return;
      }
      showToast(`Approved "${pItem.displayName}" — moved in Drive`, 'success');
      if (!skipSync) await syncFromLiveDrive(true);
    }

    async function rejectPendingItem(pendId) {
      const idx = state.pending.findIndex(p => p.id === pendId);
      if (idx === -1) return;
      if (!state.liveWebAppUrl) { showToast('Not connected to a Drive.', 'warn'); return; }

      const target = state.pending[idx];
      const res = await postToLiveDrive({ action: 'reject', recordId: target.id });
      if (!res || !res.ok) {
        if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Reject failed: ' + res.error, 'warn');
        return;
      }
      state.pending.splice(idx, 1);
      showToast(`Rejected & deleted ${target.displayName} — its file no longer takes Drive space`, 'warn');
      renderEditor();
    }

    // ==================== MODAL: PREVIEW & QUICK REORGANIZE ====================
    function openFileModal(fileId) {
      const f = state.files.find(x => x.id === fileId);
      if (!f) return;
      state.activeModalFileId = fileId;
      resetDeleteButton();

      document.getElementById('modalFileTypeBadge').textContent = f.contentType;
      document.getElementById('modalFileName').textContent = f.displayName;
      document.getElementById('modalFilePath').textContent = buildDrivePath(f);
      document.getElementById('modalContributor').textContent = `${f.name} (+${POINTS_MAP[f.contentType] || 1} pts)`;
      document.getElementById('modalMonth').textContent = `.${f.month} (${f.sem.toUpperCase()})`;
      document.getElementById('modalLikes').textContent = `👍 ${f.likes} Likes`;
      const shieldDays = shieldDaysLeft(f);
      document.getElementById('modalShield').textContent = shieldDays > 0
        ? `🛡️ Active (${shieldDays} day${shieldDays === 1 ? '' : 's'} remaining)`
        : `Standard Pool (${f.daysOld} days old)`;
      document.getElementById('modalTopics').textContent = f.topics;

      const previewBox = document.getElementById('modalPreviewBox');
      if (safeUrl(f.fileUrl)) {
        const dl = driveDownloadUrl(f.fileUrl);
        previewBox.innerHTML = `
          <p class="font-bold text-sm mb-3">Live Google Drive File (${esc(f.displayName)})</p>
          <div class="flex flex-wrap items-center justify-center gap-2">
            <button type="button" data-view-file="${esc(f.id)}" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition">
              ${f.contentType === 'CLASS VIDEOS' ? '▶️ Watch here' : '👁 View here'}
            </button>
            ${dl ? `<a href="${esc(dl)}" target="_blank" rel="noopener noreferrer" class="px-4 py-2 rounded-xl bg-white text-slate-900 text-xs font-semibold transition">⬇️ Download</a>` : ''}
            <a href="${esc(safeUrl(f.fileUrl))}" target="_blank" rel="noopener noreferrer" class="px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold transition">
              🔗 Open in Drive
            </a>
          </div>
        `;
        const viewBtn = previewBox.querySelector('[data-view-file]');
        viewBtn.addEventListener('click', () => { if (window.DeptViewer) window.DeptViewer.open(f.id, viewBtn); });
      } else if (f.contentType === 'CLASS VIDEOS') {
        previewBox.innerHTML = `
          <div class="w-12 h-12 rounded-full bg-purple-600 flex items-center justify-center text-xl mb-2">▶️</div>
          <p class="font-bold text-sm">Google Drive Native Video Stream (${esc(f.displayName)})</p>
          <p class="text-xs text-slate-400 mt-1 max-w-md">Streams directly from <code class="text-purple-300">${esc(buildDrivePath(f))}</code> using Google Drive's built-in player without eating phone storage.</p>
        `;
      } else {
        previewBox.innerHTML = `
          <div class="w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center text-xl mb-2">📄</div>
          <p class="font-bold text-sm">Google Drive Embedded PDF Viewer (${esc(f.displayName)} • ${esc(f.size)})</p>
          <p class="text-xs text-slate-400 mt-1 max-w-md">In live Drive mode, this opens the exact Google Drive file from <code class="text-indigo-300">${esc(buildDrivePath(f))}</code>.</p>
        `;
      }

      document.getElementById('editModalSem').value = f.sem || 'SEM1';
      document.getElementById('editModalSubject').value = f.subject || 'CS';
      document.getElementById('editModalCourse').value = f.course || 'DSC-B';
      if (window.DeptOptions) window.DeptOptions.cascadeEditModal(f.course || 'DSC-B');
      document.getElementById('editModalModule').value = f.module || 'MODULE';
      document.getElementById('editModalMonth').value = f.month || 'SEP';
      document.getElementById('editModalTopics').value = f.topics || '';

      document.getElementById('modalEditorBlock').classList.toggle('hidden', !state.editorUnlocked);

      const modal = document.getElementById('fileModal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeFileModal() {
      const modal = document.getElementById('fileModal');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      state.activeModalFileId = null;
      resetDeleteButton();
    }

    let deleteConfirmTimer = 0;
    function resetDeleteButton() {
      clearTimeout(deleteConfirmTimer);
      const b = document.getElementById('btnDeleteFileModal');
      if (!b) return;
      delete b.dataset.confirm;
      b.textContent = '🗑️ Remove';
    }

    // ==================== UPGRADED GOOGLE APPS SCRIPT GENERATOR (ZERO REGEX ESCAPE HAZARDS) ====================
    function generateAppsScriptCode(rootFolderId) {
      const cleanId = (rootFolderId || FOLDER_ID_PLACEHOLDER).trim();
      const lines = [
        '// After pasting new code: Deploy > Manage deployments > pencil icon > Version: New version > Deploy (keeps the SAME URL).',
        'const ROOT_FOLDER_ID = "' + cleanId + '";',
        'const SCRIPT_VERSION = ' + EXPECTED_SCRIPT_VERSION + '; // the app compares this to warn the Editor when the deployed script is out of date',
        'const PENDING_FOLDER_NAME = "🕓 PENDING REVIEW";',
        'const OVERFLOW_FOLDER_NAME = "_OVERFLOW";',
        'const CONFIG_SHEET_NAME = "CONFIG";',
        '// Two SEPARATE tabs: (1) the upload/form-responses tab and (2) the CONFIG tab (PIN + settings).',
        '// Leave UPLOADS_SHEET_NAME empty to auto-detect the form tab. Only fill it if you have several form tabs, e.g. "Form Responses 1".',
        'const UPLOADS_SHEET_NAME = "";',
        'const CONFIG_KEYS = ["EDITOR_PIN", "MAX_FILES_PER_MODULE", "NEW_FILE_GRACE_DAYS", "SUBJECTS", "COURSES", "MODULES", "MONTHS", "NO_COURSE_SUBJECTS", "ECO_COURSES", "ECO_ONLY_COURSES", "BATCHES", "STRUCTURE"];',
        '',
        'const SUBJECTS_NO_COURSE_LAYER = ["ENG", "FRENCH"];',
        'const ECO_COURSES = ["DSC-A", "DSC-B"];',
        'const DEFAULT_COURSES = ["DSC-B", "DSC-C", "MDC"];',
        'const ALL_SUBJECTS = ["BIO", "CHEM", "CS", "ECO", "ENG", "EVS", "FRENCH", "MATHS", "PHYSICS", "STATI"];',
        'const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];',
        '',
        'const SUBJECT_ALIASES = {',
        '  "math": "MATHS", "maths": "MATHS", "mathematics": "MATHS",',
        '  "stat": "STATI", "stats": "STATI", "stati": "STATI", "statistics": "STATI",',
        '  "english": "ENG", "eng": "ENG",',
        '  "economics": "ECO", "eco": "ECO",',
        '  "cs": "CS", "computerscience": "CS",',
        '  "biology": "BIO", "bio": "BIO",',
        '  "chemistry": "CHEM", "chem": "CHEM",',
        '  "environmentalscience": "EVS", "evs": "EVS"',
        '};',
        '',
        'const CONTENT_ALIASES = {',
        '  "notes": "NOTES", "note": "NOTES",',
        '  "qpaper": "Q.PAPERS", "qpapers": "Q.PAPERS", "questionpaper": "Q.PAPERS", "questionpapers": "Q.PAPERS",',
        '  "pyq": "Q.PAPERS", "pyqs": "Q.PAPERS",',
        '  "syllabusbreakdown": "SYLLABUS BREAKDOWN", "syllabus": "SYLLABUS BREAKDOWN",',
        '  "classvideos": "CLASS VIDEOS", "classvideo": "CLASS VIDEOS", "videos": "CLASS VIDEOS", "video": "CLASS VIDEOS"',
        '};',
        '',
        'const POINTS_TABLE = {',
        '  "NOTES": 1,',
        '  "Q.PAPERS": 2,',
        '  "SYLLABUS BREAKDOWN": 1,',
        '  "CLASS VIDEOS": 2',
        '};',
        '',
        'const COL = {',
        '  TIMESTAMP: 0,',
        '  NAME: 1,',
        '  SEM: 2,',
        '  SUBJECT: 3,',
        '  COURSE: 4,',
        '  CONTENT_TYPE: 5,',
        '  MODULE: 6,',
        '  MONTH: 7,',
        '  FILE: 8',
        '};',
        '',
        'const FORM_COL_HEADERS = ["Timestamp", "Name", "Sem", "Subject", "Course", "Content Type", "Module", "Month", "File"];',
        'const EXTRA_COL_HEADERS = [',
        '  "Status",',
        '  "File Link",',
        '  "Approved",',
        '  "Processed",',
        '  "Points",',
        '  "Public Path",',
        '  "Likes",',
        '  "Topics",',
        '  "Approved Timestamp",',
        '  "Upload Scope",',
        '  "Record ID",',
        '  "Batch"',
        '];',
        '',
        '// Every data row carries a permanent Record ID in its own column. The app and the script find a file by this ID,',
        '// never by its row number, so sorting, filtering, inserting or deleting rows in the Sheet can no longer',
        '// make an approve / delete / like land on the wrong file.',
        'const RECORD_ID_HEADER = "Record ID";',
        'const ROW_ACTIONS = ["approve", "reject", "like", "editProps", "delete", "getFileData"];',
        '',
        'const EDITOR_ACTIONS = ' + JSON.stringify(EDITOR_ACTIONS) + '; // written from the app\'s own list so they always match',
        '',
        '// ================= SETUP =================',
        'function setup() {',
        '  ensureFolderStructure(getRootFolder());',
        '  const ss = SpreadsheetApp.getActiveSpreadsheet();',
        '  const sheet = getMainSheet();',
        '',
        '  // Lock Columns A-I (1-9) for the 9 base/form columns and Columns J-T (10-20) for the 11 helper columns (the last one is the permanent Record ID)',
        '  const currentLastCol = sheet.getLastColumn();',
        '  const currentHeaders = currentLastCol > 0 ? sheet.getRange(1, 1, 1, currentLastCol).getValues()[0] : [];',
        '  for (let i = 0; i < FORM_COL_HEADERS.length; i++) {',
        '    const cellVal = currentHeaders[i] || "";',
        '    if (!clean(cellVal) || findCol(EXTRA_COL_HEADERS, cellVal) > -1) {',
        '      sheet.getRange(1, i + 1).setValue(FORM_COL_HEADERS[i]);',
        '    }',
        '  }',
        '',
        '  const lastCol = Math.max(sheet.getLastColumn(), FORM_COL_HEADERS.length);',
        '  const headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];',
        '  const helperSlice = headerRow.slice(FORM_COL_HEADERS.length);',
        '',
        '  let nextCol = lastCol + 1;',
        '  EXTRA_COL_HEADERS.forEach(function(header) {',
        '    if (findCol(helperSlice, header) === -1) {',
        '      sheet.getRange(1, nextCol).setValue(header);',
        '      nextCol++;',
        '    }',
        '  });',
        '',
        '  const newLastCol = sheet.getLastColumn();',
        '  const newHeaderRow = sheet.getRange(1, 1, 1, newLastCol).getValues()[0];',
        '  const approvedColIndex = findCol(newHeaderRow, "Approved") + 1;',
        '',
        '  const rule = SpreadsheetApp.newDataValidation()',
        '    .requireValueInList(["YES", "NO"], true)',
        '    .setAllowInvalid(false)',
        '    .build();',
        '  const validationRows = Math.max(1, sheet.getMaxRows() - 1);',
        '  sheet.getRange(2, approvedColIndex, validationRows, 1).setDataValidation(rule);',
        '',
        '  ["Approved", "Processed"].forEach(function(h) {',
        '    const col = findCol(newHeaderRow, h) + 1;',
        '    if (col > 0 && sheet.getLastRow() > 1) {',
        '      const rng = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);',
        '      rng.setValues(rng.getValues().map(function(r) { return [up(r[0])]; }));',
        '    }',
        '  });',
        '',
        '  // CONFIG lives on its OWN tab. This also moves any stray config rows out of the upload tab.',
        '  ensureConfigSheet(sheet);',
        '  ss.setActiveSheet(sheet);',
        '  ensureRecordIds(sheet);',
        '  purgeRejectedRows(sheet);',
        '',
        '  const triggers = ScriptApp.getProjectTriggers();',
        '  if (!triggers.some(function(t) { return t.getHandlerFunction() === "onFormSubmit"; })) {',
        '    ScriptApp.newTrigger("onFormSubmit").forSpreadsheet(ss).onFormSubmit().create();',
        '  }',
        '  if (!triggers.some(function(t) { return t.getHandlerFunction() === "onSheetEdit"; })) {',
        '    ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();',
        '  }',
        '  if (!triggers.some(function(t) { return t.getHandlerFunction() === "onSheetChange"; })) {',
        '    ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();',
        '  }',
        '',
        '  const folderNote = PropertiesService.getScriptProperties().getProperty("ROOT_FOLDER_NOTE");',
        '  try { SpreadsheetApp.getUi().alert("Setup complete! Upload tab and CONFIG tab are separate, Year 1-5 folders are ready, and triggers are installed." + (folderNote ? "\\n\\n" + folderNote + "." : "")); } catch (e) {}',
        '}',
        '',
        'function onOpen() {',
        '  SpreadsheetApp.getUi()',
        '    .createMenu("Archive Tools")',
        '    .addItem("Process Approved Files", "processApprovedFilesMenu")',
        '    .addItem("Repair Sheets (separate CONFIG tab)", "repairSheets")',
        '    .addItem("Delete Rejected Uploads", "purgeRejectedMenu")',
        '    .addToUi();',
        '}',
        '',
        'function processApprovedFilesMenu() {',
        '  withLock(function() { processApprovedFiles(false); });',
        '}',
        '',
        'function onSheetEdit(e) {',
        '  if (!e || !e.range) return;',
        '  const sheet = e.range.getSheet();',
        '  if (sheet.getSheetId() !== getMainSheet().getSheetId() || e.range.getRow() < 2) return;',
        '  // A row typed or pasted in by hand gets its permanent Record ID right away.',
        '  try { withLock(function() { ensureRecordIds(sheet); }); } catch (idErr) {}',
        '  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];',
        '  const approvedCol = findCol(headerRow, "Approved") + 1;',
        '  if (approvedCol < 1) return;',
        '  const firstCol = e.range.getColumn();',
        '  const lastCol = firstCol + e.range.getNumColumns() - 1;',
        '  if (approvedCol >= firstCol && approvedCol <= lastCol) {',
        '    withLock(function() { processApprovedFiles(true); });',
        '  }',
        '}',
        '',
        '// Fires for inserted rows, imports, pasted blocks and other changes that onEdit does not see.',
        'function onSheetChange(e) {',
        '  try { withLock(function() { ensureRecordIds(getMainSheet()); }); } catch (err) {}',
        '}',
        '',
        'function onFormSubmit(e) {',
        '  if (!e || !e.range) return;',
        '  // Only the upload form\'s tab (the FIRST tab) is handled. Responses from any other form or tab are left untouched.',
        '  if (e.range.getSheet().getSheetId() !== getMainSheet().getSheetId()) return;',
        '  withLock(function() {',
        '    const sheet = e.range.getSheet();',
        '    const row = e.range.getRow();',
        '    // Every form response gets its permanent Record ID before anything else happens to it.',
        '    try { ensureRecordIds(sheet); } catch (idErr) {}',
        '    const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];',
        '    const col = function(name) { return findCol(headerRow, name) + 1; };',
        '    if (col("Status") < 1 || col("File Link") < 1 || col("Approved") < 1) return; // setup() has not been run on this tab',
        '    try {',
        '      const values = sheet.getRange(row, 1, 1, COL.FILE + 1).getValues()[0];',
        '      const fileUrlOrId = values[COL.FILE];',
        '      if (!fileUrlOrId) {',
        '        throw new Error("No file value received from the form — check that the File Upload question is question #8.");',
        '      }',
        '      const c = canonRow(values[COL.NAME], values[COL.SEM], values[COL.SUBJECT], values[COL.COURSE],',
        '        values[COL.CONTENT_TYPE], values[COL.MODULE], values[COL.MONTH]);',
        '      const root = getRootFolder();',
        '      const pendingFolder = getOrCreateFolder(root, PENDING_FOLDER_NAME);',
        '      const file = getFileFromFormUpload(fileUrlOrId);',
        '      file.setName(getUniqueFileName(pendingFolder, c.name + "." + c.month, file.getId()));',
        '      moveFileTo(file, pendingFolder);',
        '      writeCanonToRow(sheet, row, c);',
        '      sheet.getRange(row, col("Status")).setValue("Uploaded OK — pending approval");',
        '      sheet.getRange(row, col("File Link")).setValue(file.getUrl());',
        '      sheet.getRange(row, col("Approved")).setValue("NO");',
        '      sheet.getRange(row, col("Processed")).setValue("");',
        '      sheet.getRange(row, col("Points")).setValue(getPoints(c.contentType));',
        '      sheet.getRange(row, col("Public Path")).setValue("");',
        '      if (col("Likes") > 0) sheet.getRange(row, col("Likes")).setValue(0);',
        '      if (col("Upload Scope") > 0) sheet.getRange(row, col("Upload Scope")).setValue("COMPLETE");',
        '    } catch (err) {',
        '      sheet.getRange(row, col("Status")).setValue("ERROR: " + err.message);',
        '    }',
        '  });',
        '}',
        '',
        'function processApprovedFiles(silentMode) {',
        '  const sheet = getMainSheet();',
        '  const data = sheet.getDataRange().getValues();',
        '  if (data.length < 2) return 0;',
        '  const headerRow = data[0];',
        '',
        '  const statusCol = findCol(headerRow, "Status");',
        '  const fileLinkCol = findCol(headerRow, "File Link");',
        '  const approvedCol = findCol(headerRow, "Approved");',
        '  const processedCol = findCol(headerRow, "Processed");',
        '  const pointsCol = findCol(headerRow, "Points");',
        '  const publicPathCol = findCol(headerRow, "Public Path");',
        '  const likesCol = findCol(headerRow, "Likes");',
        '  const topicsCol = findCol(headerRow, "Topics");',
        '  const approvedTsCol = findCol(headerRow, "Approved Timestamp");',
        '',
        '  if (approvedCol === -1 || processedCol === -1 || statusCol === -1) {',
        '    if (!silentMode) {',
        '      try { SpreadsheetApp.getUi().alert("Run setup() first - the helper columns are missing."); } catch (x) {}',
        '    }',
        '    return 0;',
        '  }',
        '',
        '  const cfg = getConfig();',
        '  const root = getRootFolder();',
        '  const pendingFolder = getOrCreateFolder(root, PENDING_FOLDER_NAME);',
        '  let processedCount = 0;',
        '',
        '  for (let r = 1; r < data.length; r++) {',
        '    const rowData = data[r];',
        '    if (isConfigKeyRow(rowData)) continue;',
        '    const approved = up(rowData[approvedCol]);',
        '    const processedState = up(rowData[processedCol]);',
        '',
        '    if (approved !== "YES" || ["YES", "OVERFLOW", "REJECTED"].indexOf(processedState) > -1) continue;',
        '',
        '    try {',
        '      const c = canonRow(rowData[COL.NAME], rowData[COL.SEM], rowData[COL.SUBJECT], rowData[COL.COURSE],',
        '        rowData[COL.CONTENT_TYPE], rowData[COL.MODULE], rowData[COL.MONTH]);',
        '      const fileUrl = (fileLinkCol > -1 && rowData[fileLinkCol]) || rowData[COL.FILE];',
        '      const topics = topicsCol > -1 ? String(rowData[topicsCol] || "").trim() : "";',
        '',
        '      let file = null;',
        '      try {',
        '        file = getFileFromFormUpload(fileUrl);',
        '      } catch (err) {',
        '        file = findFileCaseInsensitive(pendingFolder, c.name + "." + c.month);',
        '      }',
        '      if (!file) {',
        '        sheet.getRange(r + 1, statusCol + 1).setValue("ERROR: file not found in Pending Review");',
        '        continue;',
        '      }',
        '',
        '      let baseFolder = root;',
        '      const rootNorm = normalizeText(root.getName());',
        '      if (rootNorm.indexOf("year") !== 0) {',
        '        baseFolder = getOrCreateFolder(root, c.year);',
        '      }',
        '',
        '      let destFolder = getOrCreateFolder(baseFolder, c.sem);',
        '      destFolder = getOrCreateFolder(destFolder, c.subject);',
        '      if (c.hasCourse) destFolder = getOrCreateFolder(destFolder, c.course);',
        '      destFolder = getOrCreateFolder(destFolder, c.contentType);',
        '',
        '      if (c.contentType === "NOTES" || c.contentType === "CLASS VIDEOS") {',
        '        destFolder = c.hasCourse',
        '          ? getOrCreateFolder(destFolder, c.moduleLabel)',
        '          : getOrCreateFolder(destFolder, c.month);',
        '      }',
        '',
        '      file.setName(getUniqueFileName(destFolder, c.name + "." + c.month, file.getId()));',
        '      if (topics) {',
        '        file.setDescription("Topics: " + topics + " | Sem: " + c.sem + " | Month: " + c.month);',
        '      }',
        '      moveFileTo(file, destFolder);',
        '',
        '      // A note that was approved before (and is only being re-filed after an edit) keeps its first approval date,',
        '      // so editing it never restarts its 7-day shield or shows it in the Feed as a new upload again.',
        '      const firstApprovedTs = approvedTsCol > -1 ? rowData[approvedTsCol] : "";',
        '      const nowIso = firstApprovedTs || new Date().toISOString();',
        '      const fullPath = getFullPath(destFolder);',
        '',
        '      writeCanonToRow(sheet, r + 1, c);',
        '      sheet.getRange(r + 1, processedCol + 1).setValue("YES");',
        '      sheet.getRange(r + 1, publicPathCol + 1).setValue(fullPath);',
        '      sheet.getRange(r + 1, statusCol + 1).setValue("Moved to Public");',
        '      if (pointsCol > -1) sheet.getRange(r + 1, pointsCol + 1).setValue(getPoints(c.contentType));',
        '      if (likesCol > -1 && rowData[likesCol] === "") sheet.getRange(r + 1, likesCol + 1).setValue(0);',
        '      if (approvedTsCol > -1 && !firstApprovedTs) sheet.getRange(r + 1, approvedTsCol + 1).setValue(nowIso);',
        '',
        '      data[r][processedCol] = "YES";',
        '      data[r][publicPathCol] = fullPath;',
        '      if (approvedTsCol > -1) data[r][approvedTsCol] = nowIso;',
        '      if (likesCol > -1 && data[r][likesCol] === "") data[r][likesCol] = 0;',
        '',
        '      enforceTopFiveInFolder(sheet, data, fullPath, destFolder, root, cfg);',
        '      processedCount++;',
        '    } catch (err) {',
        '      sheet.getRange(r + 1, statusCol + 1).setValue("ERROR: " + err.message);',
        '    }',
        '  }',
        '',
        '  if (!silentMode) {',
        '    try { SpreadsheetApp.getUi().alert(processedCount + " file(s) moved out of Pending Review."); } catch (e) {}',
        '  }',
        '  return processedCount;',
        '}',
        '',
        'function enforceTopFiveInFolder(sheet, data, targetPublicPath, destFolder, root, cfg) {',
        '  const headerRow = data[0];',
        '  const processedCol = findCol(headerRow, "Processed");',
        '  const publicPathCol = findCol(headerRow, "Public Path");',
        '  const likesCol = findCol(headerRow, "Likes");',
        '  const approvedTsCol = findCol(headerRow, "Approved Timestamp");',
        '  const fileLinkCol = findCol(headerRow, "File Link");',
        '  const statusCol = findCol(headerRow, "Status");',
        '',
        '  if (likesCol === -1 || approvedTsCol === -1) return;',
        '',
        '  const MAX_FILES = cfg ? cfg.MAX_FILES_PER_MODULE : 5;',
        '  const GRACE_MS = (cfg ? cfg.NEW_FILE_GRACE_DAYS : 7) * 24 * 60 * 60 * 1000;',
        '  const now = new Date().getTime();',
        '',
        '  const activeRows = [];',
        '  for (let r = 1; r < data.length; r++) {',
        '    if (up(data[r][processedCol]) === "YES" &&',
        '        up(data[r][publicPathCol]) === up(targetPublicPath)) {',
        '      const approvedTime = data[r][approvedTsCol] ? new Date(data[r][approvedTsCol]).getTime() : 0;',
        '      const isShielded = (now - approvedTime) <= GRACE_MS;',
        '      activeRows.push({',
        '        dataIndex: r,',
        '        rowIndex: r + 1,',
        '        likes: Number(data[r][likesCol] || 0),',
        '        isShielded: isShielded,',
        '        fileUrl: data[r][fileLinkCol]',
        '      });',
        '    }',
        '  }',
        '',
        '  if (activeRows.length <= MAX_FILES) return;',
        '',
        '  const eligible = activeRows.filter(function(item) { return !item.isShielded; }).sort(function(a, b) { return b.likes - a.likes; });',
        '  const shieldedCount = activeRows.length - eligible.length;',
        '  const allowedEligibleSlots = Math.max(0, MAX_FILES - shieldedCount);',
        '',
        '  if (eligible.length <= allowedEligibleSlots) return;',
        '',
        '  const cutoffLikes = allowedEligibleSlots > 0 ? eligible[allowedEligibleSlots - 1].likes : Infinity;',
        '  const overflowFolder = getOrCreateFolder(root, OVERFLOW_FOLDER_NAME);',
        '',
        '  eligible.forEach(function(item, idx) {',
        '    if (idx >= allowedEligibleSlots && item.likes < cutoffLikes) {',
        '      try {',
        '        const f = getFileFromFormUpload(item.fileUrl);',
        '        moveFileTo(f, overflowFolder);',
        '        sheet.getRange(item.rowIndex, processedCol + 1).setValue("OVERFLOW");',
        '        sheet.getRange(item.rowIndex, statusCol + 1).setValue("Popped off to _Overflow (Lowest Likes)");',
        '        data[item.dataIndex][processedCol] = "OVERFLOW";',
        '      } catch (err) {}',
        '    }',
        '  });',
        '}',
        '',
        'function doGet(e) {',
        '  if (e && e.parameter && e.parameter.action === "health") {',
        '    return jsonResponse(getHealth());',
        '  }',
        '  if (e && e.parameter && e.parameter.action === "verifyPin") {',
        '    const ok = clean(e.parameter.pin) === clean(getConfig().EDITOR_PIN);',
        '    return jsonResponse({ ok: ok, error: ok ? "" : "Wrong editor PIN" });',
        '  }',
        '',
        '  const sheet = getMainSheet();',
        '  let data = sheet.getDataRange().getValues();',
        '  if (data.length <= 1) {',
        '    return jsonResponse({ ok: true, files: [], pending: [], announcements: getNotices(), forwardUrl: getForwardUrl(), options: getOptions() });',
        '  }',
        '',
        '  // Rows added by any route (form, app, hand, import) get their Record ID here at the latest.',
        '  if (rowsNeedingIds(data, findCol(data[0], RECORD_ID_HEADER)).length) {',
        '    try {',
        '      const lock = LockService.getScriptLock();',
        '      if (lock.tryLock(8000)) {',
        '        try { ensureRecordIds(sheet); } finally { lock.releaseLock(); }',
        '      }',
        '    } catch (idErr) {}',
        '    data = sheet.getDataRange().getValues();',
        '  }',
        '',
        '  const h = data[0];',
        '  const idx = function(name) { return findCol(h, name); };',
        '  const idIdx = idx(RECORD_ID_HEADER);',
        '  const files = [];',
        '  const pending = [];',
        '  const nowMs = new Date().getTime();',
        '  const cfg = getConfig();',
        '  const graceMs = cfg.NEW_FILE_GRACE_DAYS * 86400000;',
        '  // Drive links of files still waiting for approval go only to the Editor (the app sends the PIN once unlocked).',
        '  const pinGiven = clean(e && e.parameter ? e.parameter.pin : "");',
        '  const showPendingLinks = pinGiven !== "" && pinGiven === clean(cfg.EDITOR_PIN);',
        '',
        '  for (let r = 1; r < data.length; r++) {',
        '    const row = data[r];',
        '    if (isConfigKeyRow(row)) continue;',
        '    if (!row[COL.NAME] && !row[COL.SUBJECT] && !row[COL.FILE]) continue;',
        '',
        '    const processed = up(row[idx("Processed")] || "");',
        '    if (processed === "OVERFLOW" || processed === "REJECTED") continue;',
        '',
        '    // Never list a row without its permanent ID (it gets one on the next sync).',
        '    const recordId = idIdx > -1 ? clean(row[idIdx]) : "";',
        '    if (!recordId) continue;',
        '',
        '    const c = canonRow(row[COL.NAME], row[COL.SEM], row[COL.SUBJECT], row[COL.COURSE],',
        '      row[COL.CONTENT_TYPE], row[COL.MODULE], row[COL.MONTH]);',
        '',
        '    const approvedRaw = idx("Approved Timestamp") > -1 ? row[idx("Approved Timestamp")] : "";',
        '    const approvedMs = approvedRaw ? new Date(approvedRaw).getTime() : nowMs;',
        '    const daysOld = Math.max(0, Math.floor((nowMs - approvedMs) / 86400000));',
        '    // Same rule as enforceTopFiveInFolder(), so the app\'s shield badge always matches what pruning really does.',
        '    const ageMs = nowMs - approvedMs;',
        '    const shieldDaysLeft = approvedRaw && ageMs <= graceMs ? Math.max(1, Math.ceil((graceMs - ageMs) / 86400000)) : 0;',
        '',
        '    const item = {',
        '      id: recordId,',
        '      recordId: recordId,',
        '      name: c.name,',
        '      month: c.month,',
        '      displayName: c.name + "." + c.month,',
        '      sem: "SEM" + c.semNum,',
        '      subject: c.subject,',
        '      course: c.course,',
        '      contentType: c.contentType,',
        '      module: c.moduleLabel,',
        '      scope: normalizeScope(idx("Upload Scope") > -1 ? row[idx("Upload Scope")] : ""),',
        '      batch: idx("Batch") > -1 ? clean(row[idx("Batch")]) : "",',
        '      topics: idx("Topics") > -1 ? (clean(row[idx("Topics")]) || "General Notes") : "General Notes",',
        '      likes: idx("Likes") > -1 ? Number(row[idx("Likes")] || 0) : 0,',
        '      daysOld: daysOld,',
        '      shieldDaysLeft: shieldDaysLeft,',
        '      points: Number(row[idx("Points")] || getPoints(c.contentType)),',
        '      publicPath: String(row[idx("Public Path")] || ""),',
        '      fileUrl: String(row[idx("File Link")] || row[COL.FILE] || "")',
        '    };',
        '',
        '    if (processed === "YES") {',
        '      item.approved = true;',
        '      files.push(item);',
        '    } else {',
        '      item.approved = false;',
        '      const statusText = idx("Status") > -1 ? clean(row[idx("Status")]) : "";',
        '      if (up(statusText).indexOf("ERROR") === 0) item.note = statusText;',
        '      if (!showPendingLinks) item.fileUrl = "";',
        '      pending.push(item);',
        '    }',
        '  }',
        '',
        '  return jsonResponse({ ok: true, files: files, pending: pending, announcements: getNotices(), forwardUrl: getForwardUrl(), options: getOptions() });',
        '}',
        '',
        'function doPost(e) {',
        '  const lock = LockService.getScriptLock();',
        '  try {',
        '    lock.waitLock(30000);',
        '    const body = JSON.parse(e.postData.contents);',
        '    const sheet = getMainSheet();',
        '    getIdColumn(sheet, true); // makes sure the Record ID column exists before the headers are read',
        '    const h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];',
        '    const idx = function(name) { return findCol(h, name) + 1; };',
        '    // The file is found by its permanent Record ID. (rowId / fileId are only older names for the same value.)',
        '    // A plain row number never matches anything, so a stale page can never hit the wrong row.',
        '    const targetRow = findRowByRecordId(sheet, body.recordId || body.rowId || body.fileId);',
        '',
        '    if (EDITOR_ACTIONS.indexOf(body.action) > -1) {',
        '      if (clean(body.pin) !== clean(getConfig().EDITOR_PIN)) {',
        '        return jsonResponse({ ok: false, error: "Wrong editor PIN" });',
        '      }',
        '    }',
        '',
        '    if (body.action === "verifyPin") {',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    if (body.action === "getConfig") {',
        '      let rootName = "";',
        '      try { rootName = getRootFolder().getName(); } catch (x) {}',
        '      return jsonResponse({ ok: true, rootFolderId: getRootFolderId(), rootFolderName: rootName, forwardUrl: getForwardUrl() });',
        '    }',
        '',
        '    if (body.action === "setForwardUrl") {',
        '      const fwd = clean(body.forwardUrl);',
        '      if (fwd && (fwd.indexOf("https://script.google.com/") !== 0 || fwd.slice(-5) !== "/exec")) {',
        '        return jsonResponse({ ok: false, error: "Not a valid Web App URL" });',
        '      }',
        '      PropertiesService.getScriptProperties().setProperty("FORWARD_URL", fwd);',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    // Points this same script (same Web App URL) at a different Drive folder, so every device sees it on its next sync.',
        '    if (body.action === "setRootFolder") {',
        '      const newId = clean(body.folderId);',
        '      let folder;',
        '      try {',
        '        folder = DriveApp.getFolderById(newId);',
        '        folder.getName();',
        '      } catch (x) {',
        '        return jsonResponse({ ok: false, error: "This script\'s Google account cannot open that folder" });',
        '      }',
        '      const props = PropertiesService.getScriptProperties();',
        '      props.setProperty("ROOT_FOLDER_ID", newId);',
        '      const fromCode = clean(ROOT_FOLDER_ID);',
        '      if (fromCode && fromCode.indexOf("PASTE_") !== 0) props.setProperty("ROOT_FOLDER_ID_IN_CODE", fromCode);',
        '      props.deleteProperty("ROOT_FOLDER_NOTE");',
        '      ensureFolderStructure(folder);',
        '      return jsonResponse({ ok: true, rootFolderId: newId, rootFolderName: folder.getName() });',
        '    }',
        '',
        '    if (body.action === "postNotice") {',
        '      const noticeTitle = clean(body.title).substring(0, 100);',
        '      const noticeBody = clean(body.body).substring(0, 300);',
        '      if (!noticeTitle || !noticeBody) {',
        '        return jsonResponse({ ok: false, error: "A notice needs a headline and details" });',
        '      }',
        '      const noticeList = readNotices();',
        '      noticeList.unshift({ id: "n" + new Date().getTime(), title: noticeTitle, body: noticeBody, ts: new Date().getTime() });',
        '      saveNotices(noticeList.slice(0, 12));',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    if (body.action === "deleteNotice") {',
        '      saveNotices(readNotices().filter(function(n) { return n.id !== String(body.id); }));',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    if (body.action === "saveStructure") {',
        '      let parsed;',
        '      try { parsed = JSON.parse(String(body.structure || "{}")); } catch (parseErr) {',
        '        return jsonResponse({ ok: false, error: "Structure must be valid JSON" });',
        '      }',
        '      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {',
        '        return jsonResponse({ ok: false, error: "Invalid structure" });',
        '      }',
        '      setConfigValue("STRUCTURE", JSON.stringify(parsed));',
        '      OPTIONS_CACHE = null;',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    // The Editor tab\'s Batches panel sends the whole list: [{ code, label, startYear }]. Written to CONFIG → BATCHES.',
        '    if (body.action === "saveBatches") {',
        '      const seen = {};',
        '      const entries = [];',
        '      (Array.isArray(body.batches) ? body.batches : []).forEach(function(b) {',
        '        const code = up(b && b.code).split("|").join("").split(";").join("");',
        '        if (!code || seen[code]) return;',
        '        seen[code] = true;',
        '        const label = clean(b.label).split("|").join("/").split(";").join(",") || code;',
        '        const year = parseInt(onlyDigits(b.startYear), 10);',
        '        entries.push(code + "|" + label + "|" + (year >= 1900 && year <= 2200 ? year : ""));',
        '      });',
        '      setConfigValue("BATCHES", entries.join("; "));',
        '      OPTIONS_CACHE = null;',
        '      return jsonResponse({ ok: true, batches: parseBatches(entries.join("; ")) });',
        '    }',
        '',
        '    if (ROW_ACTIONS.indexOf(body.action) > -1 && targetRow < 2) {',
        '      return jsonResponse({ ok: false, error: "That file was not found (it may have been removed, or this page is out of date) - refresh and try again" });',
        '    }',
        '',
        '    // Hands one note\'s bytes to the Editor\'s browser so the month-end merger can stitch daily notes into one PDF.',
        '    // (Google Docs/Slides come back already converted to PDF by getBlob.)',
        '    if (body.action === "getFileData" && targetRow >= 2) {',
        '      const link = (idx("File Link") > 0 ? sheet.getRange(targetRow, idx("File Link")).getValue() : "") || sheet.getRange(targetRow, COL.FILE + 1).getValue();',
        '      if (!clean(link)) return jsonResponse({ ok: false, error: "This note has no file attached" });',
        '      const srcFile = getFileFromFormUpload(link);',
        '      if (srcFile.getSize() > 20 * 1024 * 1024) return jsonResponse({ ok: false, error: "File is over 20 MB" });',
        '      const srcBlob = srcFile.getBlob();',
        '      return jsonResponse({ ok: true, name: srcFile.getName(), mimeType: srcBlob.getContentType(), base64Data: Utilities.base64Encode(srcBlob.getBytes()) });',
        '    }',
        '',
        '    if (body.action === "upload") {',
        '      if (!body.base64Data) {',
        '        return jsonResponse({ ok: false, error: "No file attached" });',
        '      }',
        '      if (idx("Approved") < 1 || idx("Status") < 1 || idx("File Link") < 1) {',
        '        return jsonResponse({ ok: false, error: "The Sheet is not set up yet - the Editor must run setup() once in Apps Script" });',
        '      }',
        '      const c = canonRow(body.name, body.sem, body.subject, body.course, body.contentType, body.module, body.month);',
        '      const root = getRootFolder();',
        '      const pendingFolder = getOrCreateFolder(root, PENDING_FOLDER_NAME);',
        '',
        '      const bytes = Utilities.base64Decode(body.base64Data);',
        '      const blob = Utilities.newBlob(bytes, body.mimeType || "application/pdf", body.fileName || "upload.pdf");',
        '      const driveFile = pendingFolder.createFile(blob);',
        '      driveFile.setName(getUniqueFileName(pendingFolder, c.name + "." + c.month, driveFile.getId()));',
        '',
        '      const newRow = new Array(h.length).fill("");',
        '      const recordId = newRecordId(getTakenIds(sheet));',
        '      if (idx(RECORD_ID_HEADER) > 0) newRow[idx(RECORD_ID_HEADER) - 1] = recordId;',
        '      newRow[COL.TIMESTAMP] = new Date();',
        '      newRow[COL.NAME] = c.name;',
        '      newRow[COL.SEM] = c.sem;',
        '      newRow[COL.SUBJECT] = c.subject;',
        '      newRow[COL.COURSE] = c.course;',
        '      newRow[COL.CONTENT_TYPE] = c.contentType;',
        '      newRow[COL.MODULE] = c.modNum ? c.moduleLabel : "";',
        '      newRow[COL.MONTH] = c.month;',
        '      newRow[COL.FILE] = driveFile.getUrl();',
        '      if (idx("Status") > 0) newRow[idx("Status") - 1] = "Uploaded via Web App — pending approval";',
        '      if (idx("File Link") > 0) newRow[idx("File Link") - 1] = driveFile.getUrl();',
        '      if (idx("Approved") > 0) newRow[idx("Approved") - 1] = "NO";',
        '      if (idx("Points") > 0) newRow[idx("Points") - 1] = getPoints(c.contentType);',
        '      if (idx("Likes") > 0) newRow[idx("Likes") - 1] = 0;',
        '      if (idx("Topics") > 0) newRow[idx("Topics") - 1] = clean(body.topics);',
        '      if (idx("Upload Scope") > 0) newRow[idx("Upload Scope") - 1] = normalizeScope(body.scope);',
        '      if (idx("Batch") > 0) newRow[idx("Batch") - 1] = up(body.batch);',
        '',
        '      sheet.appendRow(newRow);',
        '      SpreadsheetApp.flush();',
        '      let savedInPath = PENDING_FOLDER_NAME;',
        '      try { savedInPath = getFullPath(pendingFolder); } catch (pathErr) {}',
        '      return jsonResponse({ ok: true, recordId: recordId, fileUrl: driveFile.getUrl(), savedIn: savedInPath, sheetName: sheet.getName(), savedName: driveFile.getName() });',
        '    }',
        '',
        '    if (body.action === "approve" && targetRow >= 2) {',
        '      sheet.getRange(targetRow, idx("Approved")).setValue("YES");',
        '      processApprovedFiles(true);',
        '      if (up(sheet.getRange(targetRow, idx("Processed")).getValue()) !== "YES") {',
        '        const why = clean(sheet.getRange(targetRow, idx("Status")).getValue());',
        '        sheet.getRange(targetRow, idx("Approved")).setValue("NO");',
        '        return jsonResponse({ ok: false, error: why || "File could not be moved - see the Status column in the Sheet" });',
        '      }',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    // A rejected upload is removed for good: its file is deleted (so it stops using Drive space) and so is its row.',
        '    if (body.action === "reject" && targetRow >= 2) {',
        '      deleteDriveFileForGood((idx("File Link") > 0 ? sheet.getRange(targetRow, idx("File Link")).getValue() : "") || sheet.getRange(targetRow, COL.FILE + 1).getValue());',
        '      sheet.deleteRow(targetRow);',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    if (body.action === "like" && targetRow >= 2 && idx("Likes") > 0) {',
        '      const cell = sheet.getRange(targetRow, idx("Likes"));',
        '      const step = Number(body.delta) < 0 ? -1 : 1;',
        '      const nextLikes = Math.max(0, Number(cell.getValue() || 0) + step);',
        '      cell.setValue(nextLikes);',
        '      return jsonResponse({ ok: true, likes: nextLikes });',
        '    }',
        '',
        '    if (body.action === "editProps" && targetRow >= 2) {',
        '      // sem / subject let the Editor move a note into a different semester or subject entirely (e.g. a senior\'s note that fits a junior\'s current sem better) - Drive is re-filed to match on the next processApprovedFiles() below.',
        '      if (body.sem) sheet.getRange(targetRow, COL.SEM + 1).setValue(body.sem);',
        '      if (body.subject) sheet.getRange(targetRow, COL.SUBJECT + 1).setValue(body.subject);',
        '      if (body.course) sheet.getRange(targetRow, COL.COURSE + 1).setValue(body.course);',
        '      if (body.module) sheet.getRange(targetRow, COL.MODULE + 1).setValue(body.module);',
        '      if (body.month) sheet.getRange(targetRow, COL.MONTH + 1).setValue(body.month);',
        '      if (body.batch !== undefined && idx("Batch") > 0) {',
        '        sheet.getRange(targetRow, idx("Batch")).setValue(up(body.batch));',
        '      }',
        '      if (body.topics !== undefined && idx("Topics") > 0) {',
        '        sheet.getRange(targetRow, idx("Topics")).setValue(clean(body.topics));',
        '      }',
        '      sheet.getRange(targetRow, idx("Processed")).setValue("");',
        '      processApprovedFiles(true);',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    if (body.action === "delete" && targetRow >= 2) {',
        '      const link = sheet.getRange(targetRow, idx("File Link")).getValue();',
        '      if (link) {',
        '        const root = getRootFolder();',
        '        const overflow = getOrCreateFolder(root, OVERFLOW_FOLDER_NAME);',
        '        // A file that is already gone from Drive must not stop its row from being removed.',
        '        try { moveFileTo(getFileFromFormUpload(link), overflow); } catch (moveErr) {}',
        '      }',
        '      sheet.getRange(targetRow, idx("Processed")).setValue("OVERFLOW");',
        '      sheet.getRange(targetRow, idx("Status")).setValue("Moved to _Overflow (Deleted by Editor)");',
        '      return jsonResponse({ ok: true });',
        '    }',
        '',
        '    return jsonResponse({ ok: false, error: "Unknown action" });',
        '  } catch (err) {',
        '    return jsonResponse({ ok: false, error: err.message });',
        '  } finally {',
        '    try { lock.releaseLock(); } catch (x) {}',
        '  }',
        '}',
        '',
        '// Public, read-only self-check. Tells every device whether uploads can really work (no private data returned).',
        'function getHealth() {',
        '  const out = { ok: true, recordIds: true, folderOk: false, uploadsSheet: "", configSheet: false, setupDone: false, pendingFolder: PENDING_FOLDER_NAME, rootFolderName: "", problems: [] };',
        '  try {',
        '    const root = getRootFolder();',
        '    out.rootFolderName = root.getName();',
        '    getOrCreateFolder(root, PENDING_FOLDER_NAME);',
        '    out.folderOk = true;',
        '  } catch (err) {',
        '    out.problems.push("Script cannot open the Drive folder: " + err.message + " (redeploy as Execute as: Me, and check ROOT_FOLDER_ID)");',
        '  }',
        '  try {',
        '    const sh = getMainSheet();',
        '    out.uploadsSheet = sh.getName();',
        '    const lc = sh.getLastColumn();',
        '    const hdr = lc > 0 ? sh.getRange(1, 1, 1, lc).getValues()[0] : [];',
        '    out.setupDone = findCol(hdr, "Approved") > -1 && findCol(hdr, "Status") > -1 && findCol(hdr, "File Link") > -1;',
        '    if (!out.setupDone) out.problems.push("Run setup() once - the helper columns (Status, File Link, Approved...) are missing");',
        '  } catch (err) {',
        '    out.problems.push("Upload sheet problem: " + err.message);',
        '  }',
        '  out.configSheet = !!getConfigSheet();',
        '  if (!out.configSheet) out.problems.push("CONFIG tab missing - run setup()");',
        '  out.ok = out.problems.length === 0;',
        '  out.scriptVersion = SCRIPT_VERSION;',
        '  out.folderNote = PropertiesService.getScriptProperties().getProperty("ROOT_FOLDER_NOTE") || "";',
        '  return out;',
        '}',
        'function jsonResponse(obj) {',
        '  return ContentService.createTextOutput(JSON.stringify(obj))',
        '    .setMimeType(ContentService.MimeType.JSON);',
        '}',
        '',
        '// ================= CHARACTER-SAFE HELPERS (NO REGEX ESCAPE ISSUES) =================',
        'function clean(raw) {',
        '  const s = String(raw == null ? "" : raw).trim();',
        '  return s.split(" ").filter(Boolean).join(" ");',
        '}',
        '',
        'function up(raw) {',
        '  return clean(raw).toUpperCase();',
        '}',
        '',
        'function onlyDigits(raw) {',
        '  const s = String(raw == null ? "" : raw);',
        '  let out = "";',
        '  for (let i = 0; i < s.length; i++) {',
        '    const ch = s.charAt(i);',
        '    if (ch >= "0" && ch <= "9") out += ch;',
        '  }',
        '  return out;',
        '}',
        '',
        'function normalizeText(raw) {',
        '  const s = String(raw == null ? "" : raw).toLowerCase();',
        '  let out = "";',
        '  for (let i = 0; i < s.length; i++) {',
        '    const ch = s.charAt(i);',
        '    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) out += ch;',
        '  }',
        '  return out;',
        '}',
        '',
        'function normalizeName(raw) {',
        '  return up(raw) || "ANON";',
        '}',
        '',
        'function normalizeSubject(raw) {',
        '  return SUBJECT_ALIASES[normalizeText(raw)] || up(raw) || "CS";',
        '}',
        '',
        '// ================= DYNAMIC OPTIONS (edit them in the CONFIG tab of the Sheet - no code change needed) =================',
        '// Every key below is optional. If a row is missing or empty, the built-in default is used, so old sheets keep working.',
        'let OPTIONS_CACHE = null;',
        '',
        'function splitList(raw) {',
        '  const flat = String(raw == null ? "" : raw).split(String.fromCharCode(10)).join(",").split(";").join(",");',
        '  const out = [];',
        '  flat.split(",").forEach(function(part) {',
        '    const v = clean(part);',
        '    if (v) out.push(v);',
        '  });',
        '  return out;',
        '}',
        '',
        'function upList(raw) {',
        '  const seen = {};',
        '  const out = [];',
        '  splitList(raw).forEach(function(part) {',
        '    const v = up(part);',
        '    if (v && !seen[v]) { seen[v] = true; out.push(v); }',
        '  });',
        '  return out;',
        '}',
        '',
        '// "1, 2, 3" or a range like "1-6" (or both: "1-4, 6"). Result is sorted and de-duplicated.',
        'function moduleList(raw) {',
        '  const seen = {};',
        '  const nums = [];',
        '  function add(n) { if (!seen[n]) { seen[n] = true; nums.push(n); } }',
        '  splitList(raw).forEach(function(part) {',
        '    const dash = part.indexOf("-");',
        '    if (dash > 0) {',
        '      const a = parseInt(onlyDigits(part.substring(0, dash)), 10);',
        '      const b = parseInt(onlyDigits(part.substring(dash + 1)), 10);',
        '      if (a > 0 && b >= a) { for (let n = a; n <= b && n <= a + 40; n++) add(n); }',
        '      return;',
        '    }',
        '    const d = parseInt(onlyDigits(part), 10);',
        '    if (d > 0) add(d);',
        '  });',
        '  nums.sort(function(x, y) { return x - y; });',
        '  return nums.map(function(n) { return String(n); });',
        '}',
        '',
        'function getOptions() {',
        '  if (OPTIONS_CACHE) return OPTIONS_CACHE;',
        '  const opt = {',
        '    subjects: ALL_SUBJECTS.slice(),',
        '    subjectLabels: {},',
        '    courses: ["DSC-A", "DSC-B", "DSC-C", "MDC"],',
        '    ecoCourses: ECO_COURSES.slice(),',
        '    ecoOnlyCourses: ["DSC-A"],',
        '    noCourseSubjects: SUBJECTS_NO_COURSE_LAYER.slice(),',
        '    modules: ["1", "2", "3", "4"],',
        '    months: ["AUG", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR"],',
        '    batches: [],',
        '    structure: {}',
        '  };',
        '  try {',
        '    const s = getConfigSheet();',
        '    if (s && s.getLastRow() > 0) {',
        '      s.getRange(1, 1, s.getLastRow(), 2).getValues().forEach(function(r) {',
        '        const k = up(r[0]);',
        '        const v = r[1];',
        '        if (!clean(v)) return;',
        '        if (k === "SUBJECTS") {',
        '          // "CS=Computer Science, ECO=Economics, MATHS" - the part after = is an optional display name',
        '          const codes = [];',
        '          const labels = {};',
        '          splitList(v).forEach(function(part) {',
        '            const eq = part.indexOf("=");',
        '            const code = up(eq > -1 ? part.substring(0, eq) : part);',
        '            if (!code || codes.indexOf(code) > -1) return;',
        '            codes.push(code);',
        '            if (eq > -1 && clean(part.substring(eq + 1))) labels[code] = clean(part.substring(eq + 1));',
        '          });',
        '          if (codes.length) { opt.subjects = codes; opt.subjectLabels = labels; }',
        '        }',
        '        if (k === "COURSES") { const a = upList(v); if (a.length) opt.courses = a; }',
        '        if (k === "ECO_COURSES") { const b = upList(v); if (b.length) opt.ecoCourses = b; }',
        '        if (k === "ECO_ONLY_COURSES") { opt.ecoOnlyCourses = upList(v); }',
        '        if (k === "NO_COURSE_SUBJECTS") { opt.noCourseSubjects = upList(v); }',
        '        if (k === "MODULES") { const m = moduleList(v); if (m.length) opt.modules = m; }',
        '        if (k === "MONTHS") {',
        '          const mo = [];',
        '          upList(v).forEach(function(x) { const three = x.substring(0, 3); if (three.length === 3 && mo.indexOf(three) === -1) mo.push(three); });',
        '          if (mo.length) opt.months = mo;',
        '        }',
        '        if (k === "BATCHES") { opt.batches = parseBatches(v); }',
        '        if (k === "STRUCTURE") { opt.structure = parseStructure(v); }',
        '      });',
        '    }',
        '  } catch (err) {}',
        '  OPTIONS_CACHE = opt;',
        '  return opt;',
        '}',
        '',
        '// "CODE|Label|StartYear; CODE|Label|StartYear" -> [{code,label,startYear}]. Any malformed entry is skipped rather than breaking the whole list.',
        'function parseBatches(raw) {',
        '  const out = [];',
        '  String(raw == null ? "" : raw).split(";").forEach(function(chunk) {',
        '    const parts = chunk.split("|").map(function(p) { return clean(p); });',
        '    const code = up(parts[0]);',
        '    if (!code) return;',
        '    const label = parts[1] || code;',
        '    const startYear = parseInt(parts[2], 10);',
        '    out.push({ code: code, label: label, startYear: isNaN(startYear) ? null : startYear });',
        '  });',
        '  return out;',
        '}',
        '',
        '// The Editor\'s Course Structure panel writes this as JSON: { "<semNum>": { subjects: [...], labels: {...}, noCourseSubjects: [...], courses: { SUBJ: [...] } } }.',
        '// A missing or unparsable value just means every semester keeps using the flat SUBJECTS / COURSES lists above - nothing breaks.',
        'function parseStructure(raw) {',
        '  const s = String(raw == null ? "" : raw).trim();',
        '  if (!s) return {};',
        '  try {',
        '    const parsed = JSON.parse(s);',
        '    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};',
        '  } catch (err) {',
        '    return {};',
        '  }',
        '}',
        '',
        '// semNum is optional - pass it whenever it\'s known so a per-semester override from the Structure panel is honoured; omit it to fall back to the flat global lists.',
        '// Same rule as the app: if the Editor set this sem up and it lists this subject, the subject has a course',
        '// layer only if it has courses there. Otherwise the shared NO_COURSE_SUBJECTS list decides.',
        'function semSubjectCfg(subject, semNum) {',
        '  const semCfg = semNum != null ? getOptions().structure[String(semNum)] : null;',
        '  if (!semCfg || !Array.isArray(semCfg.subjects)) return null;',
        '  return upList(semCfg.subjects.join(",")).indexOf(subject) > -1 ? semCfg : null;',
        '}',
        '',
        'function hasCourseLayer(subject, semNum) {',
        '  const semCfg = semSubjectCfg(subject, semNum);',
        '  if (semCfg) return upList(((semCfg.courses || {})[subject] || []).join(",")).length > 0;',
        '  return getOptions().noCourseSubjects.indexOf(subject) === -1;',
        '}',
        '',
        'function resolveCourse(subject, courseRaw, semNum) {',
        '  if (!hasCourseLayer(subject, semNum)) return "NONE";',
        '  const opt = getOptions();',
        '  const semCfg = semSubjectCfg(subject, semNum);',
        '  let allowed;',
        '  if (semCfg) {',
        '    allowed = upList(((semCfg.courses || {})[subject] || []).join(","));',
        '  } else {',
        '    allowed = subject === "ECO" ? opt.ecoCourses : opt.courses.filter(function(c) { return opt.ecoOnlyCourses.indexOf(c) === -1; });',
        '  }',
        '  if (!allowed.length) allowed = opt.courses.length ? opt.courses : DEFAULT_COURSES;',
        '  const key = normalizeText(courseRaw);',
        '  for (let i = 0; i < allowed.length; i++) {',
        '    if (normalizeText(allowed[i]) === key) return allowed[i];',
        '  }',
        '  return allowed[0];',
        '}',
        '',
        'function normalizeContentType(raw) {',
        '  return CONTENT_ALIASES[normalizeText(raw)] || "NOTES";',
        '}',
        '',
        'function normalizeMonth(raw) {',
        '  const s = up(raw);',
        '  let letters = "";',
        '  for (let i = 0; i < s.length; i++) {',
        '    const ch = s.charAt(i);',
        '    if (ch >= "A" && ch <= "Z") letters += ch;',
        '  }',
        '  letters = letters.substring(0, 3);',
        '  if (MONTHS.indexOf(letters) > -1 || getOptions().months.indexOf(letters) > -1) return letters;',
        '  return s || "GEN";',
        '}',
        '',
        'function normalizeModuleNumber(raw) {',
        '  return onlyDigits(raw);',
        '}',
        '',
        'function normalizeSemesterNumber(raw) {',
        '  const d = onlyDigits(raw);',
        '  return d ? parseInt(d, 10) : 1;',
        '}',
        '',
        'function canonRow(name, sem, subject, course, contentType, module, month) {',
        '  const subj = normalizeSubject(subject);',
        '  const semNum = normalizeSemesterNumber(sem);',
        '  const yearNum = Math.min(5, Math.max(1, Math.ceil(semNum / 2)));',
        '  const modNum = normalizeModuleNumber(module);',
        '  return {',
        '    name: normalizeName(name),',
        '    semNum: semNum,',
        '    sem: "SEM " + semNum,',
        '    year: "YEAR " + yearNum,',
        '    subject: subj,',
        '    hasCourse: hasCourseLayer(subj, semNum),',
        '    course: resolveCourse(subj, course, semNum),',
        '    contentType: normalizeContentType(contentType),',
        '    modNum: modNum,',
        '    moduleLabel: modNum ? "MODULE " + modNum : "MODULE",',
        '    month: normalizeMonth(month)',
        '  };',
        '}',
        '',
        '// ================= STABLE RECORD IDS =================',
        'function newRecordId(taken) {',
        '  let id = "";',
        '  do {',
        '    id = "R" + Utilities.getUuid().split("-").join("").substring(0, 12).toUpperCase();',
        '  } while (taken[id]);',
        '  taken[id] = true;',
        '  return id;',
        '}',
        '',
        '// Returns the 1-based column number of the Record ID column (creating it at the far right if asked to).',
        'function getIdColumn(sheet, createIfMissing) {',
        '  const lc = sheet.getLastColumn();',
        '  const hdr = lc > 0 ? sheet.getRange(1, 1, 1, lc).getValues()[0] : [];',
        '  const found = findCol(hdr, RECORD_ID_HEADER);',
        '  if (found > -1) return found + 1;',
        '  if (!createIfMissing) return 0;',
        '  const col = Math.max(1, lc + 1);',
        '  sheet.getRange(1, col).setValue(RECORD_ID_HEADER);',
        '  return col;',
        '}',
        '',
        'function rowHasContent(row) {',
        '  return !!(clean(row[COL.NAME]) || clean(row[COL.SUBJECT]) || clean(row[COL.FILE]));',
        '}',
        '',
        '// Indexes (in the data array, header = 0) of data rows that still need an ID: blank, or a copy of an earlier row\'s ID.',
        'function rowsNeedingIds(data, idIdx) {',
        '  const needs = [];',
        '  const seen = {};',
        '  for (let r = 1; r < data.length; r++) {',
        '    const row = data[r];',
        '    if (isConfigKeyRow(row) || !rowHasContent(row)) continue;',
        '    const v = idIdx > -1 ? clean(row[idIdx]) : "";',
        '    if (!v || seen[v]) needs.push(r);',
        '    else seen[v] = true;',
        '  }',
        '  return needs;',
        '}',
        '',
        'function getTakenIds(sheet) {',
        '  const taken = {};',
        '  const idCol = getIdColumn(sheet, false);',
        '  const lastRow = sheet.getLastRow();',
        '  if (!idCol || lastRow < 2) return taken;',
        '  sheet.getRange(2, idCol, lastRow - 1, 1).getValues().forEach(function(r) {',
        '    const v = clean(r[0]);',
        '    if (v) taken[v] = true;',
        '  });',
        '  return taken;',
        '}',
        '',
        '// Gives every data row a unique Record ID, whatever route the row came in by. Only blank or duplicated cells are',
        '// written - an ID that already exists is never changed. Call it inside the script lock. Returns how many were created.',
        'function ensureRecordIds(sheet) {',
        '  sheet = sheet || getMainSheet();',
        '  if (sheet.getLastRow() < 2) return 0;',
        '  const idCol = getIdColumn(sheet, true);',
        '  const data = sheet.getDataRange().getValues();',
        '  const needs = rowsNeedingIds(data, idCol - 1);',
        '  if (!needs.length) return 0;',
        '',
        '  const taken = {};',
        '  for (let r = 1; r < data.length; r++) {',
        '    const v = clean(data[r][idCol - 1]);',
        '    if (v) taken[v] = true;',
        '  }',
        '',
        '  let created = 0;',
        '  let i = 0;',
        '  while (i < needs.length) {',
        '    let j = i;',
        '    while (j + 1 < needs.length && needs[j + 1] === needs[j] + 1) j++;',
        '    const block = [];',
        '    for (let k = i; k <= j; k++) block.push([newRecordId(taken)]);',
        '    sheet.getRange(needs[i] + 1, idCol, block.length, 1).setValues(block);',
        '    created += block.length;',
        '    i = j + 1;',
        '  }',
        '  SpreadsheetApp.flush();',
        '  return created;',
        '}',
        '',
        '// The sheet row that currently holds this Record ID, or 0 if there is none. Row numbers are never trusted.',
        'function findRowByRecordId(sheet, recordId) {',
        '  const id = clean(recordId);',
        '  if (!id) return 0;',
        '  const idCol = getIdColumn(sheet, false);',
        '  const lastRow = sheet.getLastRow();',
        '  if (!idCol || lastRow < 2) return 0;',
        '  const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();',
        '  for (let i = 0; i < ids.length; i++) {',
        '    if (clean(ids[i][0]) === id) return i + 2;',
        '  }',
        '  return 0;',
        '}',
        '',
        'function writeCanonToRow(sheet, rowNum, c) {',
        '  sheet.getRange(rowNum, COL.NAME + 1, 1, 7).setValues([[',
        '    c.name, c.sem, c.subject, c.course, c.contentType, c.modNum ? c.moduleLabel : "", c.month',
        '  ]]);',
        '}',
        '',
        'function getPoints(contentType) {',
        '  return POINTS_TABLE[normalizeContentType(contentType)] || 1;',
        '}',
        '',
        'function getMainSheet() {',
        '  const all = SpreadsheetApp.getActiveSpreadsheet().getSheets();',
        '  const cfgKey = up(CONFIG_SHEET_NAME);',
        '  const candidates = all.filter(function(s) { return up(s.getName()) !== cfgKey; });',
        '  if (!candidates.length) throw new Error("No upload tab found - the spreadsheet only has the CONFIG tab");',
        '  let i;',
        '  // 1) explicit name set at the top of the script',
        '  const wanted = up(UPLOADS_SHEET_NAME);',
        '  if (wanted) {',
        '    for (i = 0; i < candidates.length; i++) {',
        '      if (up(candidates[i].getName()) === wanted) return candidates[i];',
        '    }',
        '  }',
        '  // 2) the Google Form responses tab',
        '  for (i = 0; i < candidates.length; i++) {',
        '    if (normalizeText(candidates[i].getName()).indexOf("formresponses") === 0) return candidates[i];',
        '  }',
        '  // 3) any non-CONFIG tab whose header row looks like the upload form',
        '  for (i = 0; i < candidates.length; i++) {',
        '    const lc = candidates[i].getLastColumn();',
        '    if (lc < 1) continue;',
        '    const hdr = candidates[i].getRange(1, 1, 1, lc).getValues()[0];',
        '    if (findCol(hdr, "Timestamp") > -1 && findCol(hdr, "File") > -1) return candidates[i];',
        '  }',
        '  // 4) first tab that is not CONFIG',
        '  return candidates[0];',
        '}',
        '',
        'function isConfigKeyRow(row) {',
        '  return CONFIG_KEYS.indexOf(up(row[0])) > -1;',
        '}',
        '',
        '// Writes one CONFIG row by key - updates it in place if the key already has a row, appends a new row otherwise.',
        'function setConfigValue(key, value) {',
        '  const cfg = getConfigSheet() || ensureConfigSheet(getMainSheet());',
        '  const lastRow = cfg.getLastRow();',
        '  for (let r = 1; r <= lastRow; r++) {',
        '    if (up(String(cfg.getRange(r, 1).getValue())) === up(key)) {',
        '      cfg.getRange(r, 2).setValue(value);',
        '      return;',
        '    }',
        '  }',
        '  cfg.appendRow([key, value]);',
        '}',
        '',
        'function ensureConfigSheet(mainSheet) {',
        '  const ss = SpreadsheetApp.getActiveSpreadsheet();',
        '  let cfg = getConfigSheet();',
        '  if (!cfg) {',
        '    cfg = ss.insertSheet(CONFIG_SHEET_NAME);',
        '    cfg.getRange(1, 1, 1, 2).setValues([["Setting", "Value"]]);',
        '  }',
        '  const existing = {};',
        '  if (cfg.getLastRow() > 0) {',
        '    cfg.getRange(1, 1, cfg.getLastRow(), 2).getValues().forEach(function(r) {',
        '      const k = up(r[0]);',
        '      if (CONFIG_KEYS.indexOf(k) > -1) existing[k] = true;',
        '    });',
        '  }',
        '  // Move stray config rows out of the upload tab (bottom-up so row numbers stay valid)',
        '  if (mainSheet && mainSheet.getSheetId() !== cfg.getSheetId() && mainSheet.getLastRow() > 1) {',
        '    const rows = mainSheet.getRange(1, 1, mainSheet.getLastRow(), 2).getValues();',
        '    for (let r = rows.length - 1; r >= 1; r--) {',
        '      const k = up(rows[r][0]);',
        '      if (CONFIG_KEYS.indexOf(k) === -1) continue;',
        '      if (!existing[k]) {',
        '        cfg.appendRow([k, rows[r][1]]);',
        '        existing[k] = true;',
        '      }',
        '      mainSheet.deleteRow(r + 1);',
        '    }',
        '  }',
        '  // MODULES and MONTHS rows used to live here, but the app uses fixed lists (modules 1-6, months JUL-APR) and',
        '  // never read them, so they are removed instead of looking like settings that do something.',
        '  for (let r = cfg.getLastRow(); r >= 1; r--) {',
        '    const key = up(cfg.getRange(r, 1).getValue());',
        '    if (key === "MODULES" || key === "MONTHS") cfg.deleteRow(r);',
        '  }',
        '  const defaults = [',
        '    ["EDITOR_PIN", "2026"],',
        '    ["MAX_FILES_PER_MODULE", "5"],',
        '    ["NEW_FILE_GRACE_DAYS", "7"],',
        '    ["SUBJECTS", ALL_SUBJECTS.join(", ")],',
        '    ["COURSES", "DSC-A, DSC-B, DSC-C, MDC", "Course streams. Add or remove any time."],',
        '    ["NO_COURSE_SUBJECTS", "ENG, FRENCH", "Subjects with no course layer (files go by month, not by module)."],',
        '    ["ECO_COURSES", "DSC-A, DSC-B", "Courses allowed for ECO."],',
        '    ["ECO_ONLY_COURSES", "DSC-A", "Courses that only ECO may use (hidden for other subjects)."],',
        '    ["BATCHES", "2631|2026-31 Batch|2026", "One class code per batch: CODE|Label|Admission Year (4 digits). Semicolon-separated. Add a new row every intake - this is what the Join Class box reads, and the app uses the year to guess the batch\'s current semester."],',
        '    ["STRUCTURE", "", "Optional per-semester course map (JSON), edited from the Editor tab\'s Course Structure panel. Leave blank to keep one SUBJECTS/COURSES list for every semester."]',
        '  ];',
        '  defaults.forEach(function(pair) {',
        '    if (!existing[pair[0]]) cfg.appendRow(pair);',
        '  });',
        '  try { cfg.getRange(1, 2, Math.max(cfg.getLastRow(), 1), 1).setNumberFormat("@"); } catch (fmtErr) {}',
        '  return cfg;',
        '}',
        '',
        'function repairSheets() {',
        '  withLock(function() {',
        '    const main = getMainSheet();',
        '    ensureConfigSheet(main);',
        '    SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(main);',
        '    try { SpreadsheetApp.getUi().alert("Done. Upload tab: " + main.getName() + " | Settings tab: " + CONFIG_SHEET_NAME + ". Config rows no longer live in the upload tab."); } catch (e) {}',
        '  });',
        '}',
        '',
        'function findCol(headerRow, name) {',
        '  const key = up(name);',
        '  for (let i = 0; i < headerRow.length; i++) {',
        '    if (up(headerRow[i]) === key) return i;',
        '  }',
        '  return -1;',
        '}',
        '',
        'function normalizeScope(raw) {',
        '  return up(raw) === "DAILY" ? "DAILY" : "COMPLETE";',
        '}',
        '',
        'function getConfigSheet() {',
        '  const all = SpreadsheetApp.getActiveSpreadsheet().getSheets();',
        '  for (let i = 0; i < all.length; i++) {',
        '    if (up(all[i].getName()) === CONFIG_SHEET_NAME) return all[i];',
        '  }',
        '  return null;',
        '}',
        '',
        '// The folder ID typed at the top of this script, or (if that is still the placeholder) the last ID that worked.',
        '// Whichever folder was changed most recently wins: a NEW ID typed into ROOT_FOLDER_ID above wins once,',
        '// and after that the app\'s "Apply to Everyone" folder button (saved in Script Properties) wins.',
        'function getRootFolderId() {',
        '  const props = PropertiesService.getScriptProperties();',
        '  const saved = clean(props.getProperty("ROOT_FOLDER_ID"));',
        '  const fromCode = clean(ROOT_FOLDER_ID);',
        '  const codeIsReal = fromCode && fromCode.indexOf("PASTE_") !== 0;',
        '  if (codeIsReal && clean(props.getProperty("ROOT_FOLDER_ID_IN_CODE")) !== fromCode) return fromCode;',
        '  return saved || (codeIsReal ? fromCode : "");',
        '}',
        '',
        '// Opens the main notes folder. Every ID that works is remembered in Script Properties, so pasting new code',
        '// later with a wrong or placeholder ROOT_FOLDER_ID still finds the folder instead of breaking everything.',
        'function getRootFolder() {',
        '  const props = PropertiesService.getScriptProperties();',
        '  const saved = clean(props.getProperty("ROOT_FOLDER_ID"));',
        '  const fromCode = clean(ROOT_FOLDER_ID);',
        '  const codeIsReal = fromCode && fromCode.indexOf("PASTE_") !== 0;',
        '  const tries = [];',
        '  const first = getRootFolderId();',
        '  if (first) tries.push(first);',
        '  if (saved && tries.indexOf(saved) === -1) tries.push(saved);',
        '  if (codeIsReal && tries.indexOf(fromCode) === -1) tries.push(fromCode);',
        '  for (let i = 0; i < tries.length; i++) {',
        '    try {',
        '      const folder = DriveApp.getFolderById(tries[i]);',
        '      folder.getName(); // fails here if this account cannot open it',
        '      if (saved !== tries[i]) props.setProperty("ROOT_FOLDER_ID", tries[i]);',
        '      if (codeIsReal && clean(props.getProperty("ROOT_FOLDER_ID_IN_CODE")) !== fromCode) props.setProperty("ROOT_FOLDER_ID_IN_CODE", fromCode);',
        '      return folder;',
        '    } catch (err) {}',
        '  }',
        '  // No ID works (or none was given): use the notes folder that sits next to this Sheet, making it if needed.',
        '  const made = findOrCreateFolderNextToSheet();',
        '  props.setProperty("ROOT_FOLDER_ID", made.folder.getId());',
        '  props.setProperty("ROOT_FOLDER_NOTE", (made.created ? "Created" : "Using") + " the folder \'" + AUTO_FOLDER_NAME + "\' next to your Sheet" +',
        '    (tries.length ? " because the folder ID " + tries[0] + " couldn\'t be opened. Notes already in that old folder stay there." : " because no folder ID was set."));',
        '  return made.folder;',
        '}',
        '',
        'const AUTO_FOLDER_NAME = "DEPT NOTES ARCHIVE";',
        '',
        '// Looks in the same Drive folder as this spreadsheet for AUTO_FOLDER_NAME and makes it if it isn\'t there,',
        '// so running setup twice never creates two archive folders.',
        'function findOrCreateFolderNextToSheet() {',
        '  let parent = DriveApp.getRootFolder();',
        '  try {',
        '    const parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();',
        '    if (parents.hasNext()) parent = parents.next();',
        '  } catch (err) {}',
        '  const existing = parent.getFoldersByName(AUTO_FOLDER_NAME);',
        '  if (existing.hasNext()) return { folder: existing.next(), created: false };',
        '  return { folder: parent.createFolder(AUTO_FOLDER_NAME), created: true };',
        '}',
        '',
        'function readNotices() {',
        '  try {',
        '    const raw = PropertiesService.getScriptProperties().getProperty("NOTICES");',
        '    const list = raw ? JSON.parse(raw) : [];',
        '    return Array.isArray(list) ? list : [];',
        '  } catch (err) {',
        '    return [];',
        '  }',
        '}',
        '',
        'function saveNotices(list) {',
        '  PropertiesService.getScriptProperties().setProperty("NOTICES", JSON.stringify(list));',
        '}',
        '',
        'function getNotices() {',
        '  return readNotices().map(function(n) {',
        '    let when = "";',
        '    try { when = Utilities.formatDate(new Date(n.ts), Session.getScriptTimeZone(), "d MMM") + " • "; } catch (err) {}',
        '    return { id: n.id, title: "📣 " + n.title, body: n.body, time: when + "Editor Notice" };',
        '  });',
        '}',
        '',
        'function getForwardUrl() {',
        '  return clean(PropertiesService.getScriptProperties().getProperty("FORWARD_URL"));',
        '}',
        '',
        'function ensureFolderStructure(root) {',
        '  getOrCreateFolder(root, PENDING_FOLDER_NAME);',
        '  getOrCreateFolder(root, OVERFLOW_FOLDER_NAME);',
        '  for (let y = 1; y <= 5; y++) {',
        '    const yearFolder = getOrCreateFolder(root, "YEAR " + y);',
        '    getOrCreateFolder(yearFolder, "SEM " + (y * 2 - 1));',
        '    getOrCreateFolder(yearFolder, "SEM " + (y * 2));',
        '  }',
        '}',
        '',
        'function withLock(fn) {',
        '  const lock = LockService.getScriptLock();',
        '  lock.waitLock(30000);',
        '  try {',
        '    return fn();',
        '  } finally {',
        '    lock.releaseLock();',
        '  }',
        '}',
        '',
        'function getConfig() {',
        '  const cfg = { EDITOR_PIN: "2026", MAX_FILES_PER_MODULE: 5, NEW_FILE_GRACE_DAYS: 7 };',
        '  try {',
        '    const s = getConfigSheet();',
        '    if (s && s.getLastRow() > 0) {',
        '      s.getRange(1, 1, s.getLastRow(), 2).getValues().forEach(function(r) {',
        '        const k = up(r[0]);',
        '        const v = clean(r[1]);',
        '        if (k === "EDITOR_PIN" && v) cfg.EDITOR_PIN = v;',
        '        if (k === "MAX_FILES_PER_MODULE" && Number(v) > 0) cfg.MAX_FILES_PER_MODULE = Number(v);',
        '        if (k === "NEW_FILE_GRACE_DAYS" && v !== "" && Number(v) >= 0) cfg.NEW_FILE_GRACE_DAYS = Number(v);',
        '      });',
        '    }',
        '  } catch (err) {}',
        '  return cfg;',
        '}',
        '',
        'function getOrCreateFolder(parentFolder, name) {',
        '  const wanted = up(name);',
        '  const target = normalizeText(wanted) || wanted.toLowerCase();',
        '  const folders = parentFolder.getFolders();',
        '  while (folders.hasNext()) {',
        '    const f = folders.next();',
        '    const key = normalizeText(f.getName()) || String(f.getName()).toLowerCase();',
        '    if (key === target) {',
        '      if (f.getName() !== wanted) {',
        '        try { f.setName(wanted); } catch (renameErr) {}',
        '      }',
        '      return f;',
        '    }',
        '  }',
        '  return parentFolder.createFolder(wanted);',
        '}',
        '',
        'function findFileCaseInsensitive(folder, name) {',
        '  const targetName = up(name);',
        '  const files = folder.getFiles();',
        '  while (files.hasNext()) {',
        '    const f = files.next();',
        '    if (up(f.getName()) === targetName) {',
        '      return f;',
        '    }',
        '  }',
        '  return null;',
        '}',
        '',
        'function getFullPath(folder) {',
        '  let path = folder.getName();',
        '  let parents = folder.getParents();',
        '  while (parents.hasNext()) {',
        '    const parent = parents.next();',
        '    if (parent.getId() === DriveApp.getRootFolder().getId()) break;',
        '    path = parent.getName() + " / " + path;',
        '    parents = parent.getParents();',
        '  }',
        '  return path;',
        '}',
        '',
        'function getUniqueFileName(folder, baseName, ownFileId) {',
        '  const base = String(baseName);',
        '  let candidate = base;',
        '  let count = 2;',
        '  while (true) {',
        '    const hit = findFileCaseInsensitive(folder, candidate);',
        '    if (hit === null || (ownFileId && hit.getId() === ownFileId)) break;',
        '    candidate = base + "(" + count + ")";',
        '    count++;',
        '  }',
        '  return candidate;',
        '}',
        '',
        'function extractDriveId(rawUrlOrId) {',
        '  const s = String(rawUrlOrId || "").trim();',
        '  if (s.indexOf("/d/") > -1) {',
        '    return s.split("/d/")[1].split("/")[0].split("?")[0].trim();',
        '  }',
        '  if (s.indexOf("id=") > -1) {',
        '    return s.split("id=")[1].split("&")[0].trim();',
        '  }',
        '  return s;',
        '}',
        '',
        'function getFileFromFormUpload(fileUrlOrId) {',
        '  return DriveApp.getFileById(extractDriveId(fileUrlOrId));',
        '}',
        '',
        '// Deletes a file for good so it stops using Drive space. With the Drive API service switched on',
        '// (Apps Script → Services → + → Drive API) it is removed at once; without it, it goes to the Drive trash,',
        '// which Google empties by itself after 30 days.',
        'function deleteDriveFileForGood(fileUrlOrId) {',
        '  const id = extractDriveId(fileUrlOrId);',
        '  if (!id) return;',
        '  try {',
        '    if (typeof Drive !== "undefined" && Drive.Files) { Drive.Files.remove(id); return; }',
        '  } catch (err) {}',
        '  try { DriveApp.getFileById(id).setTrashed(true); } catch (err2) {}',
        '}',
        '',
        '// Clears out uploads rejected before rejecting deleted them: deletes each one\'s file and row (bottom-up so row numbers stay valid).',
        'function purgeRejectedRows(sheet) {',
        '  sheet = sheet || getMainSheet();',
        '  if (sheet.getLastRow() < 2) return 0;',
        '  const data = sheet.getDataRange().getValues();',
        '  const processedIdx = findCol(data[0], "Processed");',
        '  const linkIdx = findCol(data[0], "File Link");',
        '  if (processedIdx === -1) return 0;',
        '  let removed = 0;',
        '  for (let r = data.length - 1; r >= 1; r--) {',
        '    if (up(data[r][processedIdx]) !== "REJECTED") continue;',
        '    deleteDriveFileForGood((linkIdx > -1 && data[r][linkIdx]) || data[r][COL.FILE]);',
        '    sheet.deleteRow(r + 1);',
        '    removed++;',
        '  }',
        '  return removed;',
        '}',
        '',
        'function purgeRejectedMenu() {',
        '  const n = withLock(function() { return purgeRejectedRows(getMainSheet()); });',
        '  try { SpreadsheetApp.getUi().alert(n + " rejected upload(s) deleted."); } catch (e) {}',
        '}',
        '',
        'function moveFileTo(file, dest) {',
        '  try {',
        '    file.moveTo(dest);',
        '    return;',
        '  } catch (err) {}',
        '  dest.addFile(file);',
        '  const parents = file.getParents();',
        '  while (parents.hasNext()) {',
        '    const p = parents.next();',
        '    if (p.getId() !== dest.getId()) {',
        '      try { p.removeFile(file); } catch (err2) {}',
        '    }',
        '  }',
        '}'
      ];
      return lines.join('\n');
    }

    // ==================== EVENT LISTENERS & INITIALIZATION ====================
    function switchTab(targetId) {
      if (targetId === 'viewSetup' && !canSeeSetup()) return;
      state.activeTab = targetId;
      if (targetId === 'viewUpload' && !state.batch && !batchPromptShown) {
        batchPromptShown = true;
        openBatchModal();
      }
      ['viewBrowse', 'viewUpload', 'viewFeed', 'viewEditor', 'viewSetup'].forEach(id => {
        const sec = document.getElementById(id);
        if (!sec) return;
        if (id === targetId) sec.classList.remove('hidden');
        else sec.classList.add('hidden');
      });

      document.querySelectorAll('.nav-tab').forEach(btn => {
        const isSetupBtn = btn.id === 'tabBtnSetup';
        const hideClass = (isSetupBtn && !canSeeSetup()) ? 'hidden ' : '';
        if (btn.getAttribute('data-target') === targetId) {
          btn.className = hideClass + 'nav-tab px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all bg-white text-indigo-700 shadow-sm flex items-center gap-1.5';
        } else {
          btn.className = hideClass + 'nav-tab px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all text-slate-600 hover:text-slate-900 flex items-center gap-1.5';
        }
      });
      applySetupGate();
    }
    window.switchTab = switchTab;

    // ==================== BATCH / "JOIN CLASS" (soft convenience login — never a security gate) ====================
    // The only job this does: once a student types their batch's class code, every file they upload from this
    // device is tagged with it automatically, so nobody has to remember to pick a year and notes can't land
    // under the wrong batch by mistake. The code must be one the Editor added (Editor tab → Batches); it isn't secret.
    let batchPromptShown = false;

    function knownBatches() {
      const opt = window.DeptOptions && window.DeptOptions.get ? window.DeptOptions.get() : null;
      return (opt && Array.isArray(opt.batches)) ? opt.batches : [];
    }

    // Guesses which semester a batch is currently in from its admission year (new academic year ~ July).
    // Purely a convenience default for the Upload form's Sem select — students can always change it themselves.
    function semesterForBatch(startYear) {
      if (!Number.isFinite(startYear)) return null;
      const now = new Date();
      const month = now.getMonth() + 1; // 1-12
      let yearsIn = now.getFullYear() - startYear;
      let half = 1;
      if (month < 7) { yearsIn -= 1; half = 2; }
      const sem = yearsIn * 2 + half;
      return Math.min(10, Math.max(1, sem));
    }

    function updateBatchChip() {
      const chip = document.getElementById('batchChip');
      if (chip) {
        if (state.batch) {
          chip.textContent = '🎓 ' + state.batch.label;
          chip.title = 'Uploads are tagged "' + state.batch.code + '" automatically. Click to change.';
        } else {
          chip.textContent = '🎓 Set your batch';
          chip.title = 'Join your class so uploads get tagged with your batch automatically.';
        }
      }
      const readout = document.getElementById('upBatchReadout');
      const label = document.getElementById('upBatchReadoutLabel');
      if (readout && label) {
        if (state.batch) { label.textContent = state.batch.label; readout.classList.remove('hidden'); }
        else { readout.classList.add('hidden'); }
      }
    }

    function saveBatch(code, label, startYear) {
      const clean = String(code || '').trim().toUpperCase();
      if (!clean) return;
      state.batch = { code: clean, label: label || clean, startYear: Number.isFinite(startYear) ? startYear : null };
      try { localStorage.setItem('deptnotes_batch', JSON.stringify(state.batch)); } catch (e) {}
      updateBatchChip();
      applyBatchDefaultSem();
      // Once a batch is known, default Browse to "My Batch" instead of "All" — the whole point is less picking, not more.
      const fb = document.getElementById('filterBatch');
      if (fb && fb.value === 'ALL') { fb.value = 'MINE'; renderBrowse(); }
    }

    function clearBatchChoice() {
      state.batch = null;
      try { localStorage.removeItem('deptnotes_batch'); } catch (e) {}
      updateBatchChip();
    }

    function applyBatchDefaultSem() {
      if (!state.batch || !Number.isFinite(state.batch.startYear)) return;
      const guess = semesterForBatch(state.batch.startYear);
      const upSemSel = document.getElementById('upSem');
      if (guess && upSemSel) {
        const want = 'SEM' + guess;
        if (Array.prototype.some.call(upSemSel.options, o => o.value === want)) {
          upSemSel.value = want;
          try { updateUploadPreview(); } catch (e) {}
        }
      }
    }

    // Used by renderBrowse(): never hides a file that predates this feature (no batch tag yet) or when nobody has joined a class on this device.
    function matchesBatchFilter(f) {
      const modeEl = document.getElementById('filterBatch');
      const mode = modeEl ? modeEl.value : 'ALL';
      if (mode === 'ALL') return true;
      const mine = state.batch && state.batch.code;
      if (!mine) return true;
      if (!f.batch) return true;
      if (mode === 'MINE') return f.batch === mine;
      if (mode === 'SENIORS') return f.batch !== mine;
      return true;
    }

    function renderKnownBatchChips() {
      const wrap = document.getElementById('batchKnownList');
      if (!wrap) return;
      wrap.innerHTML = '';
      knownBatches().forEach(b => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'text-xs font-medium px-2 py-1 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-700 hover:text-indigo-700 border border-slate-200 transition';
        btn.textContent = b.label;
        btn.addEventListener('click', () => { document.getElementById('batchCodeInput').value = b.code; });
        wrap.appendChild(btn);
      });
    }

    // Editor tab → Batches: one chip per class code, tap ✕ to remove it.
    function renderBatchAdmin() {
      const wrap = document.getElementById('batchAdminList');
      if (!wrap) return;
      const list = knownBatches();
      if (!list.length) {
        wrap.innerHTML = '<p class="text-xs text-slate-400 italic">No batches yet, so students can join with any code. Add one below.</p>';
        return;
      }
      wrap.innerHTML = list.map(b =>
        '<button type="button" data-rm-batch="' + esc(b.code) + '" title="Remove ' + esc(b.code) + '" class="text-xs font-medium px-2.5 py-1 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 transition">' +
          esc(b.label) + ' <span class="opacity-70">(' + esc(b.code) + (b.startYear ? ' · ' + esc(b.startYear) : '') + ')</span> ✕</button>'
      ).join('');
    }

    async function saveBatchList(list, okMsg) {
      const res = await postToLiveDrive({ action: 'saveBatches', batches: list });
      if (!res || !res.ok) {
        if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Could not save batches: ' + res.error, 'warn');
        return false;
      }
      showToast(okMsg, 'success');
      await syncFromLiveDrive(true);
      return true;
    }

    function openBatchModal() {
      renderKnownBatchChips();
      document.getElementById('batchCodeInput').value = state.batch ? state.batch.code : '';
      document.getElementById('btnClearBatch').classList.toggle('hidden', !state.batch);
      const modal = document.getElementById('batchModal');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      try { document.getElementById('batchCodeInput').focus({ preventScroll: true }); } catch (e) {}
    }

    function closeBatchModal() {
      const modal = document.getElementById('batchModal');
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    // ==================== COURSE STRUCTURE EDITOR (per-semester Subjects / Courses, editable from the Editor Console) ====================
    // structDraft is a working copy of { "<semNum>": { subjects, labels, noCourseSubjects, courses } } the Editor edits in memory.
    // It is loaded once (lazily) from the synced STRUCTURE config and only reloaded after an explicit Save, so a background
    // sync every 45s never wipes out an edit the Editor is in the middle of typing.
    let structDraft = null;

    // Plays the .anim-out animation on an element, then runs `done` (e.g. re-render or el.remove()).
    // With reduced motion on, there's no animation, so `done` runs straight away.
    function animateOut(el, done) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!el || reduce) { done(); return; }
      el.classList.add('anim-out');
      setTimeout(done, 170);
    }

    // Today's shared Subjects / Courses lists (from Setup) shaped like one semester's entry:
    // every subject with the courses it's allowed now. Returns null until the first sync brings the lists in.
    function sharedListsEntry() {
      const opt = window.DeptOptions && window.DeptOptions.get ? window.DeptOptions.get() : null;
      if (!opt || !opt.subjects || !opt.subjects.length) return null;
      const courses = {};
      opt.subjects.forEach(s => {
        if (opt.noCourseSubjects.indexOf(s) > -1) return;
        const list = window.DeptOptions.allowedCourses(s);
        if (list && list.length) courses[s] = list.slice();
      });
      return { subjects: opt.subjects.slice(), labels: {}, noCourseSubjects: opt.noCourseSubjects.slice(), courses: courses };
    }

    // The current subjects and courses only apply up to SEM 3 (things change after that), so SEM 1–3
    // open pre-filled with them, ready to edit. SEM 4–10 start empty for you to set up when you know them.
    const PREFILL_SEMS = SHARED_LIST_SEMS;
    const structSeeded = new Set(); // sems showing the pre-filled lists that you haven't changed yet

    function seedEarlySems() {
      if (!structDraft) return;
      PREFILL_SEMS.forEach(s => {
        if (structDraft[s]) return;
        const e = sharedListsEntry();
        if (e) { structDraft[s] = e; structSeeded.add(s); }
      });
    }

    function ensureStructDraft() {
      if (!structDraft) {
        const opt = window.DeptOptions && window.DeptOptions.get ? window.DeptOptions.get() : null;
        const raw = (opt && opt.structure && typeof opt.structure === 'object') ? opt.structure : {};
        structSeeded.clear();
        try { structDraft = JSON.parse(JSON.stringify(raw)); } catch (e) { structDraft = {}; }
      }
      seedEarlySems(); // retried every time, in case the shared lists hadn't synced yet the first time
    }

    function currentStructSem() {
      const sel = document.getElementById('structSemSelect');
      return sel ? sel.value : '1';
    }

    // UI-only state for the editor: which subject has its "+ course" box open, whether the
    // "+ subject" box is open, which item is waiting for a second tap to confirm removal, and
    // which item was just added (only that one animates in, so a re-render doesn't replay everything).
    const structUi = { addingCourseFor: null, addingSubject: false, confirmKey: null, confirmTimer: 0, animKey: null };

    // How many notes (approved or pending) sit under this sem + subject (+ course, if given).
    function notesUsing(semNum, subject, course) {
      const want = 'SEM' + semNum;
      return state.files.concat(state.pending).filter(f =>
        f.sem === want && f.subject === subject && (!course || f.course === course)).length;
    }

    function markStructDirty(on) {
      if (on) structSeeded.delete(currentStructSem());
      const b = document.getElementById('btnStructSave');
      if (b) b.textContent = on ? '💾 Save Structure •' : '💾 Save Structure';
    }

    function noteWord(n) { return n + ' note' + (n === 1 ? '' : 's'); }
    function usesIt(n) { return noteWord(n) + (n === 1 ? ' uses it' : ' use it'); }

    function renderStructurePanel() {
      const wrap = document.getElementById('structSubjectRows');
      if (!wrap) return;
      ensureStructDraft();
      const semNum = currentStructSem();
      const entry = structDraft[semNum];

      const badge = document.getElementById('structOverrideBadge');
      if (entry && structSeeded.has(semNum)) {
        badge.textContent = 'Current subjects, not saved yet';
        badge.className = 'text-xs font-semibold px-2 py-0.5 rounded-md border bg-amber-100 text-amber-800 border-amber-200';
      } else if (entry && entry.subjects.length) {
        badge.textContent = 'Custom for SEM ' + semNum;
        badge.className = 'text-xs font-semibold px-2 py-0.5 rounded-md border bg-indigo-50 text-indigo-700 border-indigo-200';
      } else {
        badge.textContent = 'Not set up yet';
        badge.className = 'text-xs font-semibold px-2 py-0.5 rounded-md border bg-slate-100 text-slate-500 border-slate-200';
      }

      const anim = structUi.animKey;
      structUi.animKey = null;
      // Wiping the panel removes any focused input, which fires "focusout". The flag tells
      // the focusout handler that this is a re-render, not you clicking away.
      structUi.rendering = true;
      wrap.innerHTML = '';
      structUi.rendering = false;

      if ((!entry || !entry.subjects.length) && !structUi.addingSubject) {
        wrap.innerHTML = '<p class="text-xs text-slate-400 italic py-2 anim-in">SEM ' + esc(semNum) + ' has no subjects set up yet. Add them here when you know them, or Copy In from another sem. ' +
          (PREFILL_SEMS.indexOf(semNum) > -1 ? 'Until then it uses the shared lists from Setup.' : 'Until then, nobody can pick SEM ' + esc(semNum) + ' when sharing a file.') + '</p>';
        return;
      }

      (entry ? entry.subjects : []).forEach(code => {
        const courses = (entry.courses && entry.courses[code]) || [];
        const sKey = 'subj:' + code;
        const confirmingSubj = structUi.confirmKey === sKey;

        const chips = courses.map(c => {
          const cKey = 'course:' + code + ':' + c;
          const confirming = structUi.confirmKey === cKey;
          const look = confirming
            ? 'bg-rose-100 text-rose-800 border-rose-200'
            : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100';
          const label = confirming
            ? 'Remove ' + esc(c) + '? ' + usesIt(notesUsing(semNum, code, c))
            : esc(c) + ' ✕';
          return '<button type="button" data-rm-course="' + esc(code) + '" data-course="' + esc(c) + '" title="Remove ' + esc(c) +
            '" class="text-xs font-medium px-2.5 py-1 rounded-full border transition ' + look + (anim === cKey ? ' anim-pop' : '') + '">' + label + '</button>';
        }).join('');

        const addBox = structUi.addingCourseFor === code
          ? '<input data-new-course="' + esc(code) + '" placeholder="DSC-A" aria-label="New course for ' + esc(code) +
            '" class="uppercase w-28 text-xs px-2.5 py-1 rounded-full border border-indigo-200 bg-white focus:border-indigo-500 focus:outline-none anim-pop" />'
          : '<button type="button" data-add-course="' + esc(code) + '" class="text-xs font-medium px-2.5 py-1 rounded-full border border-dashed border-slate-300 text-slate-500 hover:text-indigo-700 transition">+ course</button>';

        const rmLook = confirmingSubj
          ? 'bg-rose-100 text-rose-800 border border-rose-200'
          : 'text-rose-500 hover:text-rose-700';
        const rmLabel = confirmingSubj
          ? 'Remove ' + esc(code) + '? ' + usesIt(notesUsing(semNum, code))
          : '✕';

        const card = document.createElement('div');
        card.className = 'bg-slate-50 rounded-xl p-3 border border-slate-200' + (anim === sKey ? ' anim-in' : '');
        card.innerHTML =
          '<div class="flex items-center justify-between gap-2 mb-2">' +
            '<span class="font-mono font-bold text-sm text-slate-900">' + esc(code) + '</span>' +
            '<button type="button" data-rm-subject="' + esc(code) + '" title="Remove ' + esc(code) + ' from SEM ' + esc(semNum) +
              '" class="text-xs font-semibold px-2 py-0.5 rounded-lg transition ' + rmLook + '">' + rmLabel + '</button>' +
          '</div>' +
          '<div class="flex flex-wrap items-center gap-1.5">' +
            (chips || '<span class="text-xs text-slate-400 mr-1">No courses, so files go by month</span>') +
            addBox +
          '</div>';
        wrap.appendChild(card);
      });

      if (structUi.addingSubject) {
        const row = document.createElement('div');
        row.className = 'flex flex-wrap items-center gap-2 bg-slate-50 rounded-xl p-3 border border-dashed border-slate-300 anim-in';
        row.innerHTML = '<input data-new-subject placeholder="Subject code, e.g. ECO" aria-label="New subject code" class="uppercase w-48 text-xs font-mono px-3 py-1.5 rounded-lg border border-slate-300 bg-white focus:border-indigo-500 focus:outline-none" />' +
          '<span class="text-xs text-slate-400">Enter to add, Esc to cancel</span>';
        wrap.appendChild(row);
      }

      const open = wrap.querySelector('input[data-new-course], input[data-new-subject]');
      if (open) { try { open.focus({ preventScroll: true }); } catch (e) {} }
    }

    // Two-tap removal: if notes use the item, the first tap turns it red with the count, the second removes it.
    // The red state clears itself after 4 seconds if you don't tap again.
    function askOrRemove(key, count, el, doRemove) {
      if (count > 0 && structUi.confirmKey !== key) {
        structUi.confirmKey = key;
        clearTimeout(structUi.confirmTimer);
        structUi.confirmTimer = setTimeout(() => { structUi.confirmKey = null; renderStructurePanel(); }, 4000);
        renderStructurePanel();
        return;
      }
      structUi.confirmKey = null;
      clearTimeout(structUi.confirmTimer);
      animateOut(el, () => { doRemove(); markStructDirty(true); renderStructurePanel(); });
    }

    function commitNewCourse(subject, raw) {
      const v = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
      if (!v) return false;
      const entry = structDraft[currentStructSem()];
      if (!entry) return false;
      entry.courses = entry.courses || {};
      const list = entry.courses[subject] || (entry.courses[subject] = []);
      if (list.indexOf(v) > -1) { showToast(subject + ' already has ' + v + '.', 'warn'); return false; }
      list.push(v);
      structUi.animKey = 'course:' + subject + ':' + v;
      markStructDirty(true);
      return true;
    }

    function commitNewSubject(raw) {
      const v = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
      if (!v) return false;
      const semNum = currentStructSem();
      if (!structDraft[semNum]) structDraft[semNum] = { subjects: [], labels: {}, noCourseSubjects: [], courses: {} };
      const entry = structDraft[semNum];
      if (entry.subjects.indexOf(v) > -1) { showToast('SEM ' + semNum + ' already has ' + v + '.', 'warn'); return false; }
      entry.subjects.push(v);
      structUi.animKey = 'subj:' + v;
      markStructDirty(true);
      return true;
    }

    window.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.nav-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.getAttribute('data-target')));
      });

      updateBatchChip();

      // ---- Enter key: pressing Enter in a box clicks the button that goes with it ----
      // To add one: put "inputId: 'buttonId'" in this list. (The upload form already submits on Enter by itself.)
      const ENTER_PRESSES = {
        editorPinInput: 'btnUnlockEditor',
        batchCodeInput: 'btnSaveBatch',
        inputTestFolderId: 'btnInjectFolderId',
        inputWebAppUrl: 'btnConnectLiveUrl',
        mergedMonthTitle: 'btnMergeSelectedDaily',
        editModalTopics: 'btnSaveFilePropsModal',
        batchAdminCode: 'btnBatchAdminAdd',
        batchAdminLabel: 'btnBatchAdminAdd',
        batchAdminYear: 'btnBatchAdminAdd',
        annTitleInput: 'annBodyInput'          // headline → jump to the details box
      };
      Object.keys(ENTER_PRESSES).forEach(inputId => {
        const input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
          if (input.readOnly) return;                       // e.g. the locked Web App URL box
          const target = document.getElementById(ENTER_PRESSES[inputId]);
          if (!target || target.disabled) return;
          e.preventDefault();
          if (target.tagName === 'BUTTON') target.click(); else target.focus();
        });
      });
      // The notice details box needs Enter for new lines, so Ctrl+Enter (Cmd+Enter on Mac) posts it.
      document.getElementById('annBodyInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('btnPostAnnouncement').click(); }
      });
      // Search: Enter closes the phone keyboard (results already update as you type).
      document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      });
      // Esc closes whichever popup is open.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('batchModal').classList.contains('flex')) { closeBatchModal(); return; }
        if (document.getElementById('fileModal').classList.contains('flex')) closeFileModal();
      });

      document.getElementById('btnOpenSetupFromBanner').addEventListener('click', () => {
        if (canSeeSetup()) switchTab('viewSetup');
        else { showToast('Unlock the console with your Editor PIN first.', 'warn'); try { document.getElementById('editorPinInput').focus(); } catch (e) {} }
      });
      document.getElementById('btnRecheckScript').addEventListener('click', async () => {
        const btn = document.getElementById('btnRecheckScript');
        btn.textContent = 'Checking…'; btn.disabled = true;
        await checkUploadHealth();
        btn.textContent = "I've redeployed, check again"; btn.disabled = false;
        const stillOld = !document.getElementById('scriptVersionBanner').classList.contains('hidden');
        showToast(stillOld ? 'Still the old script. Make sure you picked Version: New version when deploying.' : 'Apps Script is up to date.', stillOld ? 'warn' : 'success');
      });
      document.getElementById('batchChip').addEventListener('click', openBatchModal);
      document.getElementById('btnChangeBatchInline').addEventListener('click', openBatchModal);
      document.getElementById('btnCancelBatch').addEventListener('click', closeBatchModal);
      document.getElementById('batchModal').addEventListener('click', (e) => {
        if (e.target.id === 'batchModal') closeBatchModal();
      });
      document.getElementById('btnClearBatch').addEventListener('click', () => {
        clearBatchChoice();
        closeBatchModal();
        showToast('Batch cleared — uploads will go untagged until you join again.', 'info');
      });
      document.getElementById('btnSaveBatch').addEventListener('click', () => {
        const raw = document.getElementById('batchCodeInput').value.trim().toUpperCase();
        if (!raw) { showToast('Type a class code first.', 'warn'); return; }
        const list = knownBatches();
        const known = list.find(b => b.code === raw);
        // Only codes the Editor has added count, so a typo can't tag every future upload with a batch that doesn't exist.
        // (If no batches are set up at all, any code is still accepted.)
        if (!known && list.length) {
          showToast('"' + raw + '" isn\'t one of this department\'s class codes. Tap yours below, or ask your Editor to add it.', 'warn');
          return;
        }
        saveBatch(raw, known ? known.label : raw, known ? known.startYear : null);
        closeBatchModal();
        showToast('Joined ' + (known ? known.label : raw) + ' — your uploads are tagged automatically now.', 'success');
      });

      document.getElementById('btnBatchAdminAdd').addEventListener('click', async () => {
        const codeBox = document.getElementById('batchAdminCode');
        const labelBox = document.getElementById('batchAdminLabel');
        const yearBox = document.getElementById('batchAdminYear');
        const code = UP(codeBox.value).replace(/[|;]/g, '');
        const yearRaw = yearBox.value.trim();
        if (!code) { showToast('Type the batch code first.', 'warn'); codeBox.focus(); return; }
        if (yearRaw && !/^\d{4}$/.test(yearRaw)) { showToast('Admission year must be 4 digits, e.g. 2027.', 'warn'); yearBox.focus(); return; }
        const list = knownBatches().map(b => ({ code: b.code, label: b.label, startYear: b.startYear }));
        if (list.some(b => b.code === code)) { showToast('Batch ' + code + ' is already there.', 'warn'); return; }
        list.push({ code, label: labelBox.value.trim() || code, startYear: yearRaw ? Number(yearRaw) : null });
        if (await saveBatchList(list, 'Added batch ' + code + ' — students can join with it now.')) {
          codeBox.value = ''; labelBox.value = ''; yearBox.value = '';
        }
      });
      document.getElementById('batchAdminList').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-rm-batch]');
        if (!btn) return;
        const code = btn.getAttribute('data-rm-batch');
        const list = knownBatches().filter(b => b.code !== code).map(b => ({ code: b.code, label: b.label, startYear: b.startYear }));
        await saveBatchList(list, 'Removed batch ' + code + '. Its notes keep their tag.');
      });

      document.getElementById('structSemSelect').addEventListener('change', () => {
        structUi.addingCourseFor = null; structUi.addingSubject = false; structUi.confirmKey = null;
        renderStructurePanel();
      });

      const structWrap = document.getElementById('structSubjectRows');

      structWrap.addEventListener('click', (e) => {
        const semNum = currentStructSem();
        const entry = structDraft && structDraft[semNum];

        const add = e.target.closest('[data-add-course]');
        if (add) {
          structUi.addingCourseFor = add.getAttribute('data-add-course');
          structUi.addingSubject = false;
          renderStructurePanel();
          return;
        }

        const rmC = e.target.closest('[data-rm-course]');
        if (rmC && entry) {
          const subj = rmC.getAttribute('data-rm-course'), c = rmC.getAttribute('data-course');
          const n = notesUsing(semNum, subj, c);
          askOrRemove('course:' + subj + ':' + c, n, rmC, () => {
            const list = (entry.courses[subj] || []).filter(x => x !== c);
            if (list.length) entry.courses[subj] = list; else delete entry.courses[subj];
            if (n) showToast('Removed ' + c + '. Its ' + noteWord(n) + ' stay safe under All.', 'info');
          });
          return;
        }

        const rmS = e.target.closest('[data-rm-subject]');
        if (rmS && entry) {
          const subj = rmS.getAttribute('data-rm-subject');
          const n = notesUsing(semNum, subj);
          askOrRemove('subj:' + subj, n, rmS.closest('.rounded-xl'), () => {
            entry.subjects = entry.subjects.filter(x => x !== subj);
            if (entry.courses) delete entry.courses[subj];
            if (entry.labels) delete entry.labels[subj];
            // An empty sem isn't saved, so uploads fall back to the shared list for it.
            if (structUi.addingCourseFor === subj) structUi.addingCourseFor = null;
            if (n) showToast('Removed ' + subj + '. Its ' + noteWord(n) + ' stay safe under All.', 'info');
          });
        }
      });

      structWrap.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t.hasAttribute('data-new-course')) {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitNewCourse(t.getAttribute('data-new-course'), t.value); // box stays open so you can add the next one
            t.value = '';
            renderStructurePanel();
          } else if (e.key === 'Escape') {
            structUi.addingCourseFor = null;
            renderStructurePanel();
          }
        } else if (t.hasAttribute('data-new-subject')) {
          if (e.key === 'Enter') {
            e.preventDefault();
            const v = t.value;
            t.value = '';
            if (commitNewSubject(v)) {
              structUi.addingSubject = false;
              structUi.addingCourseFor = v.trim().replace(/\s+/g, ' ').toUpperCase(); // jump straight to adding its courses
            }
            renderStructurePanel();
          } else if (e.key === 'Escape') {
            structUi.addingSubject = false;
            renderStructurePanel();
          }
        }
      });

      // Clicking away from an open box: save what's typed, or just close it if it's empty.
      structWrap.addEventListener('focusout', (e) => {
        const t = e.target;
        if (structUi.rendering || !t.isConnected) return; // removed by a re-render, not a real click-away
        if (t.hasAttribute('data-new-course')) {
          const subj = t.getAttribute('data-new-course');
          if (structUi.addingCourseFor !== subj) return;
          if (t.value.trim()) commitNewCourse(subj, t.value);
          structUi.addingCourseFor = null;
          setTimeout(renderStructurePanel, 0); // let a click on another chip land first
        } else if (t.hasAttribute('data-new-subject')) {
          if (!structUi.addingSubject) return;
          const v = t.value;
          if (v.trim() && commitNewSubject(v)) structUi.addingCourseFor = v.trim().replace(/\s+/g, ' ').toUpperCase();
          structUi.addingSubject = false;
          setTimeout(renderStructurePanel, 0);
        }
      });

      document.getElementById('btnStructAddSubject').addEventListener('click', () => {
        ensureStructDraft();
        structUi.addingSubject = true;
        structUi.addingCourseFor = null;
        renderStructurePanel();
      });

      document.getElementById('btnStructClearSem').addEventListener('click', () => {
        ensureStructDraft();
        const semNum = currentStructSem();
        delete structDraft[semNum];
        structUi.addingCourseFor = null; structUi.addingSubject = false; structUi.confirmKey = null;
        markStructDirty(true);
        seedEarlySems(); // SEM 1–3 refill with the current lists; later sems stay empty
        renderStructurePanel();
        showToast(PREFILL_SEMS.indexOf(semNum) > -1
          ? 'SEM ' + semNum + ' is back to the current subjects. Save Structure to keep it.'
          : 'SEM ' + semNum + ' is cleared. Save Structure to keep it.', 'info');
      });

      document.getElementById('btnStructCopy').addEventListener('click', () => {
        ensureStructDraft();
        const semNum = currentStructSem();
        const fromSem = document.getElementById('structCopyFromSelect').value;
        let source = null;
        if (!fromSem) {
          source = sharedListsEntry();
        } else if (structDraft[fromSem]) {
          try { source = JSON.parse(JSON.stringify(structDraft[fromSem])); } catch (e) { source = null; }
        }
        if (!source || !source.subjects || !source.subjects.length) { showToast('Nothing to copy from there yet.', 'warn'); return; }
        structDraft[semNum] = source;
        structUi.addingCourseFor = null; structUi.addingSubject = false; structUi.confirmKey = null;
        markStructDirty(true);
        renderStructurePanel();
        showToast('Copied into SEM ' + semNum + ' — review it, then Save Structure.', 'success');
      });

      document.getElementById('btnStructSave').addEventListener('click', async () => {
        ensureStructDraft();
        const cleaned = {};
        Object.keys(structDraft).forEach(k => {
          const e = structDraft[k];
          const subs = e && Array.isArray(e.subjects) ? e.subjects.filter(Boolean) : [];
          if (subs.length) {
            const courses = e.courses || {};
            // A subject with no courses has no course layer (its files go by month). Worked out here,
            // so nobody has to tick a box, and the Apps Script still gets the noCourseSubjects list it reads.
            const noCourse = subs.filter(s => !(courses[s] || []).length);
            cleaned[k] = { subjects: subs, labels: e.labels || {}, noCourseSubjects: noCourse, courses: courses };
          }
        });
        const res = await postToLiveDrive({ action: 'saveStructure', structure: JSON.stringify(cleaned) });
        if (!res || !res.ok) {
          if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Save failed: ' + res.error, 'warn');
          return;
        }
        showToast('Course structure saved — every device picks it up on its next sync.', 'success');
        await syncFromLiveDrive(true);
        structDraft = null;
        structUi.addingCourseFor = null; structUi.addingSubject = false; structUi.confirmKey = null;
        markStructDirty(false);
        renderStructurePanel();
      });

      document.getElementById('btnDisconnectLiveQuick').addEventListener('click', () => {
        applyLiveUrl('');
        showToast('Disconnected on this device — paste a working Web App URL in ⚙️ Setup & Code.', 'info');
      });

      document.getElementById('btnSyncNow').addEventListener('click', () => syncFromLiveDrive(false));

      ['filterSem', 'filterSubject', 'filterCourse', 'filterType', 'filterModule', 'filterMonth', 'filterBatch'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderBrowse);
      });
      // Year & Semester also narrows which Subjects are shown, when the Editor's Course Structure panel has set up a different subject list for that semester.
      document.getElementById('filterSem').addEventListener('change', () => {
        if (window.DeptOptions) { window.DeptOptions.cascadeBrowse(); renderBrowse(); }
      });
      document.getElementById('filterSubject').addEventListener('change', () => {
        if (window.DeptOptions) { window.DeptOptions.cascadeBrowse(); renderBrowse(); }
      });
      document.getElementById('searchInput').addEventListener('input', renderBrowse);

      document.getElementById('btnResetFilters').addEventListener('click', () => {
        document.getElementById('filterSem').value = 'ALL';
        document.getElementById('filterSubject').value = 'ALL';
        document.getElementById('filterCourse').value = 'ALL';
        document.getElementById('filterType').value = 'ALL';
        document.getElementById('filterModule').value = 'ALL';
        document.getElementById('filterMonth').value = 'ALL';
        document.getElementById('filterBatch').value = 'ALL';
        document.getElementById('searchInput').value = '';
        if (window.DeptOptions) window.DeptOptions.cascadeBrowse();
        renderBrowse();
        showToast('Showing all Years (1–5), Courses, Batches & Modules', 'info');
      });

      ['upName', 'upMonth', 'upSem', 'upSubject', 'upCourse', 'upType', 'upModule', 'upScope'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateUploadPreview);
        document.getElementById(id).addEventListener('change', updateUploadPreview);
      });
      // Year & Semester narrows which Subjects are offered too, when the Editor's Course Structure panel has set up a different subject list for that semester.
      document.getElementById('upSem').addEventListener('change', () => {
        if (window.DeptOptions) window.DeptOptions.applySemFilter('upSubject', document.getElementById('upSem').value);
        updateUploadPreview();
      });

      document.getElementById('btnTriggerFileSelect').addEventListener('click', () => {
        document.getElementById('upFileInput').click();
      });

      document.getElementById('upFileInput').addEventListener('change', (e) => {
        const files = e.target.files;
        const label = document.getElementById('selectedFileLabel');
        if (files && files.length > 0) {
          label.textContent = `${files.length} file(s) ready: ${Array.from(files).map(f => f.name).join(', ')}`;
          label.className = 'text-xs text-emerald-700 font-semibold mt-2';
        }
      });

      document.getElementById('uploadForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('btnSubmitUpload');
        const rawName = UP(document.getElementById('upName').value) || 'ANON';
        const month = document.getElementById('upMonth').value;
        const sem = document.getElementById('upSem').value;
        if (semHasNoSubjects(sem)) {
          showToast(sem.replace('SEM', 'SEM ') + ' isn\'t set up yet, so there\'s nowhere to file this. Ask your Editor.', 'warn');
          return;
        }
        const subject = document.getElementById('upSubject').value;
        const noCourse = noCourseFor(subject, sem);
        const course = noCourse ? 'NONE' : document.getElementById('upCourse').value;
        const contentType = document.getElementById('upType').value;
        const modNum = document.getElementById('upModule').value;
        const module = modNum ? `MODULE ${modNum}` : 'MODULE';
        const scope = document.getElementById('upScope').value;
        const topics = document.getElementById('upTopics').value.trim() || 'General Class Notes';

        const fileInput = document.getElementById('upFileInput');
        const chosenFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;

        if (!state.liveWebAppUrl) {
          showToast('Not connected to the department Drive yet — ask your Editor for the join link.', 'warn');
          return;
        }
        if (!chosenFile) {
          showToast('Choose a file first — Live Drive needs the actual file.', 'warn');
          return;
        }

        const baseName = `${rawName}.${month}`;
        const existingInPending = state.pending.filter(p => p.displayName.toLowerCase().startsWith(baseName.toLowerCase()));
        const pendingName = existingInPending.length === 0 ? baseName : `${baseName}(${existingInPending.length + 1})`;

        // Upload EVERY selected file (the picker allows several) and check each one really landed.
        const allFiles = Array.from(fileInput.files || []).filter(f => f.size <= 30 * 1024 * 1024);
        const skipped = (fileInput.files ? fileInput.files.length : 0) - allFiles.length;
        submitBtn.disabled = true;
        if (window.upLoader) window.upLoader.show(allFiles.length);
        let okCount = 0;
        let lastError = '';
        for (let i = 0; i < allFiles.length; i++) {
          const f = allFiles[i];
          submitBtn.textContent = 'Uploading ' + (i + 1) + ' of ' + allFiles.length + '...';
          if (window.upLoader) window.upLoader.step(i, allFiles.length);
          const thisPendingName = allFiles.length === 1 ? pendingName : (pendingName + ' (file ' + (i + 1) + ')');
          let b64 = '';
          try { b64 = await fileToBase64(f); } catch (err) { lastError = 'Could not read ' + f.name; continue; }
          const liveResult = await postToLiveDrive({
            action: 'upload',
            name: rawName,
            month,
            sem,
            subject,
            course,
            contentType,
            module,
            scope,
            topics,
            batch: state.batch ? state.batch.code : '',
            fileName: f.name,
            base64Data: b64,
            mimeType: f.type || 'application/pdf'
          }, true);
          if (!liveResult) { lastError = 'No answer from the Drive script for ' + f.name + ' — check your internet and the Web App link.'; continue; }
          if (!liveResult.ok) { lastError = liveResult.error || 'Unknown error'; continue; }
          okCount++;
          state.pending.unshift({
            id: liveResult.recordId,
            recordId: liveResult.recordId,
            name: rawName, month, displayName: thisPendingName, sem, subject, course, contentType, module, scope, topics,
            size: (Math.max(0.1, f.size / (1024 * 1024))).toFixed(1) + ' MB',
            fileUrl: liveResult.fileUrl || ''
          });
          addMyUpload({
            recordId: liveResult.recordId,
            label: thisPendingName + ' • ' + subject + ' ' + sem.toUpperCase().replace('SEM', 'SEM ') + ' • ' + contentType,
            savedIn: liveResult.savedIn || '🕓 PENDING REVIEW',
            time: Date.now()
          });
        }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit to Pending Review';
        if (window.upLoader) await window.upLoader.finish(okCount > 0, rawName, okCount);
        if (skipped > 0) showToast(skipped + ' file(s) were over 30 MB and were skipped — send big videos through the Google Form.', 'warn');
        if (okCount === 0) {
          showToast('Upload failed: ' + (lastError || 'nothing was saved') + ' — nothing was lost on your side, please try again.', 'warn');
          return;
        }
        if (lastError) showToast(okCount + ' uploaded, but one failed: ' + lastError, 'warn');

        document.getElementById('upTopics').value = '';
        document.getElementById('upFileInput').value = '';
        const lbl = document.getElementById('selectedFileLabel');
        if (lbl) { lbl.textContent = 'No file chosen yet'; lbl.className = 'text-xs text-slate-500 mt-2'; }
        renderEditor();
        renderMyUploads();
        showToast('🙏 Thank you, ' + (window.upLoader ? window.upLoader.nice(rawName) : rawName) + '! ✅ Uploaded ' + okCount + ' file(s) to 🕓 Pending Review. They show in Browse once the Editor approves them.', 'success');
        { const r = document.getElementById('myUploadsBox'); if (r) r.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      });

      document.getElementById('btnUnlockEditor').addEventListener('click', async () => {
        const pin = document.getElementById('editorPinInput').value.trim();
        if (!state.liveWebAppUrl) {
          showToast('Not connected to a Drive yet — connect the Web App first (⚙️ Setup & Code).', 'warn');
          return;
        }
        if (!pin) {
          showToast('Enter the Editor PIN', 'warn');
          return;
        }
        const res = await postToLiveDrive({ action: 'verifyPin', pin }, true);
        if (res === null) {
          showToast('Could not reach the Drive — check your connection and try again.', 'warn');
          return;
        }
        if (res.ok) {
          state.editorUnlocked = true;
          state.editorPin = pin;
          document.getElementById('editorMainContent').classList.remove('hidden');
          document.getElementById('btnUnlockEditor').textContent = 'Unlocked ✓';
          applySetupGate();
          refreshLiveConfig();
          renderFeedAndLeaderboard();
          structDraft = null;
          renderStructurePanel();
          lastSyncSig = '';
          syncFromLiveDrive(true); // fetches the pending files' Drive links, which only the Editor gets
          showToast('Editor Console unlocked (PIN verified) — Setup & Code tab is now visible', 'success');
        } else if (res.error === 'Wrong editor PIN') {
          lockEditor();
          showToast('Wrong Editor PIN', 'warn');
        } else {
          showToast('The Drive script replied: ' + (res.error || 'unknown error') + ' — redeploy it as a New version.', 'warn');
        }
      });

      document.getElementById('btnApproveAllPending').addEventListener('click', async () => {
        if (state.pending.length === 0) {
          showToast('No pending files to approve', 'info');
          return;
        }
        const ids = state.pending.map(p => p.id);
        for (const id of ids) {
          if (!state.editorUnlocked) break; // a wrong/changed PIN locked the console: stop instead of failing every file
          await approvePendingItem(id, true);
        }
        if (state.liveWebAppUrl) await syncFromLiveDrive(true);
      });

      // ---- Month-end merger: the browser pulls each ticked daily note from Drive ONE AT A TIME (so a big month never piles
      // up in memory), stitches them into one PDF with pdf-lib, then files it through the normal upload + approve.
      // The original daily notes are left untouched.
      const MERGE_MAX_BYTES = 35 * 1024 * 1024;   // Apps Script rejects much bigger POST bodies once base64-encoded
      let pdfLibPromise = null;
      function loadPdfLib() {
        if (window.PDFLib) return Promise.resolve(window.PDFLib);
        if (!pdfLibPromise) {
          pdfLibPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
            s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('the PDF tool did not load'));
            s.onerror = () => { pdfLibPromise = null; reject(new Error('could not load the PDF tool — check your internet')); };
            document.head.appendChild(s);
          });
        }
        return pdfLibPromise;
      }
      function base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      function mostCommon(list) {
        const n = {};
        let best = list[0];
        list.forEach(v => { n[v] = (n[v] || 0) + 1; if (n[v] > n[best]) best = v; });
        return best;
      }
      // Any other image the browser can open (webp, gif, bmp...) is redrawn as a JPEG so pdf-lib can embed it.
      async function imageToJpegBytes(bytes, mime) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: mime || 'image/*' }));
        const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        if (bmp.close) bmp.close();
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
        c.width = c.height = 0;
        if (!blob) throw new Error('image could not be converted');
        return new Uint8Array(await blob.arrayBuffer());
      }
      // Adds one note to the merged PDF: PDFs keep their pages, photos become one A4 page each (fitted, centred).
      async function appendToMergedPdf(out, bytes, mime, PDFLib) {
        const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;   // %PDF
        if (isPdf) {
          const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach(p => out.addPage(p));
          return;
        }
        const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
        const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(isJpg ? bytes : await imageToJpegBytes(bytes, mime));
        const W = 595.28, H = 841.89, M = 18;
        const s = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height);
        const w = img.width * s, h = img.height * s;
        out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
      }

      document.getElementById('btnMergeSelectedDaily').addEventListener('click', async () => {
        const btn = document.getElementById('btnMergeSelectedDaily');
        if (btn.disabled) return;
        if (!state.liveWebAppUrl) { showToast('Not connected to a Drive.', 'warn'); return; }
        if (!state.editorUnlocked) { showToast('Unlock the Editor Console first.', 'warn'); return; }

        const ids = Array.from(document.querySelectorAll('#dailyMergeList .daily-merge-check:checked')).map(cb => cb.value);
        const picked = ids.map(id => state.files.find(f => f.id === id && f.approved && f.scope === 'DAILY')).filter(Boolean);
        if (picked.length < 2) { showToast('Tick at least two daily notes to combine.', 'warn'); return; }
        const subject = picked[0].subject, course = picked[0].course;
        if (picked.some(f => f.subject !== subject || f.course !== course)) {
          showToast('Only daily notes from the same subject + course can be combined.', 'warn');
          return;
        }
        const month = mostCommon(picked.map(f => f.month));
        const titleBox = document.getElementById('mergedMonthTitle');
        const title = UP(titleBox.value) || ('COMBINED_DAILY_' + month);

        const idleText = btn.textContent;
        btn.disabled = true;
        const skipped = [];
        try {
          btn.textContent = 'Loading PDF tool...';
          const PDFLib = await loadPdfLib();
          const out = await PDFLib.PDFDocument.create();
          for (let i = 0; i < picked.length; i++) {
            const f = picked[i];
            btn.textContent = 'Merging ' + (i + 1) + ' of ' + picked.length + '...';
            const res = await postToLiveDrive({ action: 'getFileData', recordId: f.id }, true);
            if (res && res.error === 'Wrong editor PIN') return;
            if (res && res.ok === false && String(res.error).indexOf('out of date') > -1) throw new Error(res.error);
            if (!res || !res.ok || !res.base64Data) {
              skipped.push(f.displayName + (res && res.error ? ' (' + res.error + ')' : ' (no answer from Drive)'));
              continue;
            }
            try {
              let bytes = base64ToBytes(res.base64Data);
              res.base64Data = '';
              await appendToMergedPdf(out, bytes, res.mimeType, PDFLib);
              bytes = null;
            } catch (err) {
              skipped.push(f.displayName + ' (file type could not be read)');
            }
          }
          if (out.getPageCount() === 0) {
            showToast('Nothing could be combined: ' + skipped.join(', '), 'warn');
            return;
          }

          btn.textContent = 'Saving to Drive...';
          out.setTitle(title);
          const pdfBytes = await out.save();
          if (pdfBytes.length > MERGE_MAX_BYTES) {
            showToast('The combined PDF is ' + (pdfBytes.length / 1048576).toFixed(1) + ' MB — too big to save. Untick some notes and combine in two parts.', 'warn');
            return;
          }
          const b64 = await fileToBase64(new Blob([pdfBytes], { type: 'application/pdf' }));
          const saved = await postToLiveDrive({
            action: 'upload',
            name: title,
            month,
            sem: mostCommon(picked.map(f => f.sem)),
            subject,
            course,
            contentType: mostCommon(picked.map(f => f.contentType)),
            module: mostCommon(picked.map(f => f.module)),
            scope: 'COMPLETE',
            topics: ('Combined daily notes: ' + Array.from(new Set(picked.map(f => f.topics).filter(Boolean))).join('; ')).slice(0, 300),
            batch: mostCommon(picked.map(f => f.batch || '')),
            fileName: title + '.pdf',
            base64Data: b64,
            mimeType: 'application/pdf'
          }, true);
          if (!saved || !saved.ok) {
            showToast('Could not save the combined PDF: ' + ((saved && saved.error) || 'no answer from the Drive script'), 'warn');
            return;
          }
          const ap = await postToLiveDrive({ action: 'approve', recordId: saved.recordId });
          await syncFromLiveDrive(true);
          const extra = skipped.length ? ' Skipped: ' + skipped.join(', ') + '.' : '';
          if (ap && ap.ok) showToast('✅ Combined ' + (picked.length - skipped.length) + ' daily notes into "' + title + '" — live in Browse.' + extra, skipped.length ? 'warn' : 'success');
          else showToast('Combined PDF saved, but it is waiting in Pending — approve it there.' + extra, 'warn');
        } catch (err) {
          showToast('Merge failed: ' + (err && err.message ? err.message : err), 'warn');
        } finally {
          btn.disabled = false;
          btn.textContent = idleText;
        }
      });

      document.getElementById('btnPostAnnouncement').addEventListener('click', async () => {
        const title = document.getElementById('annTitleInput').value.trim();
        const body = document.getElementById('annBodyInput').value.trim();
        if (!title || !body) {
          showToast('Enter both a headline and details for the announcement', 'warn');
          return;
        }
        const res = await postToLiveDrive({ action: 'postNotice', title, body });
        if (!res || !res.ok) {
          if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Could not post: ' + res.error, 'warn');
          return;
        }
        document.getElementById('annTitleInput').value = '';
        document.getElementById('annBodyInput').value = '';
        await syncFromLiveDrive(true);
        showToast('Posted — everyone will see it in their Feed', 'success');
        switchTab('viewFeed');
      });

      document.getElementById('btnCloseModal').addEventListener('click', closeFileModal);
      document.getElementById('fileModal').addEventListener('click', (e) => {
        if (e.target.id === 'fileModal') closeFileModal();
      });
      ['editModalSem', 'editModalSubject'].forEach(id => document.getElementById(id).addEventListener('change', () => {
        if (window.DeptOptions) window.DeptOptions.cascadeEditModal();
      }));

      document.getElementById('btnSaveFilePropsModal').addEventListener('click', async () => {
        const f = state.files.find(x => x.id === state.activeModalFileId);
        if (!f) return;
        const res = await postToLiveDrive({
          action: 'editProps',
          recordId: f.id,
          sem: document.getElementById('editModalSem').value,
          subject: document.getElementById('editModalSubject').value,
          course: document.getElementById('editModalCourse').value,
          module: document.getElementById('editModalModule').value,
          month: document.getElementById('editModalMonth').value,
          topics: document.getElementById('editModalTopics').value.trim() || f.topics
        });
        if (!res || !res.ok) {
          if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Save failed: ' + res.error, 'warn');
          return;
        }
        closeFileModal();
        showToast('Saved & moved in Drive', 'success');
        await syncFromLiveDrive(true);
      });

      document.getElementById('btnDeleteFileModal').addEventListener('click', async () => {
        const idx = state.files.findIndex(x => x.id === state.activeModalFileId);
        if (idx === -1) return;
        // Two taps, like removing a subject in Course Structure: the first asks, the second (within 4 s) removes.
        const delBtn = document.getElementById('btnDeleteFileModal');
        if (!delBtn.dataset.confirm) {
          delBtn.dataset.confirm = '1';
          delBtn.textContent = 'Tap again to remove';
          clearTimeout(deleteConfirmTimer);
          deleteConfirmTimer = setTimeout(resetDeleteButton, 4000);
          return;
        }
        resetDeleteButton();
        const target = state.files[idx];
        const res = await postToLiveDrive({ action: 'delete', recordId: target.id });
        if (!res || !res.ok) {
          if (res && res.error && res.error !== 'Wrong editor PIN') showToast('Delete failed: ' + res.error, 'warn');
          return;
        }
        state.files.splice(idx, 1);
        showToast(`Moved "${target.displayName}" to _Overflow / Archive`, 'warn');
        closeFileModal();
        renderBrowse();
        renderEditor();
        renderFeedAndLeaderboard();
      });

      const codeBlock = document.getElementById('appsScriptCodeBlock');
      document.getElementById('inputTestFolderId').value = state.testFolderId;
      applySetupGate();

      document.getElementById('btnInjectFolderId').addEventListener('click', () => {
        state.testFolderId = cleanFolderIdOrPlaceholder(document.getElementById('inputTestFolderId').value);
        codeBlock.textContent = generateAppsScriptCode(state.testFolderId);
        showToast('Updated ROOT_FOLDER_ID inside Apps Script code!', 'success');
      });

      // Switches the live script (same Web App URL) to another Drive folder. Every device sees it on its next refresh or sync.
      document.getElementById('btnApplyFolderLive').addEventListener('click', async () => {
        const newId = cleanFolderId(document.getElementById('inputTestFolderId').value);
        if (!newId || newId.indexOf('PASTE_') === 0) { showToast('Paste a Drive folder ID or folder link into box 1 first.', 'warn'); return; }
        if (!state.liveWebAppUrl) { showToast('Connect a Web App URL first (box 2).', 'warn'); return; }
        if (!state.editorUnlocked) { showToast('Unlock the Editor console first.', 'warn'); return; }
        if (newId === liveRootFolderId) { showToast('The live script already uses that folder.', 'info'); return; }
        const res = await postToLiveDrive({ action: 'setRootFolder', folderId: newId }, true);
        if (!res || !res.ok) {
          if (!res || res.error !== 'Wrong editor PIN') showToast('Folder not switched: ' + (res && res.error ? res.error : 'the Web App did not answer.'), 'warn');
          return;
        }
        state.testFolderId = newId;
        codeBlock.textContent = generateAppsScriptCode(state.testFolderId);
        showToast('Every device now uses folder "' + (res.rootFolderName || newId) + '" on its next refresh or sync.', 'success');
        lastSyncSig = '';
        await syncFromLiveDrive(true);
        refreshLiveConfig();
      });

      document.getElementById('btnCopyScript').addEventListener('click', () => {
        const id = String(state.testFolderId || '');
        if (!id || id.indexOf('PASTE_') === 0) {
          showToast('No folder ID in box 1, so setup will use (or create) a "DEPT NOTES ARCHIVE" folder next to your Sheet.', 'info');
        }
        if (liveRootFolderId && liveRootFolderId.indexOf('PASTE_') !== 0 && liveRootFolderId !== id) {
          showToast('Heads up: this code uses folder ' + id + ', but your live script uses ' + liveRootFolderId + '. Copied anyway. Double-check box 1.', 'warn');
        }
        const text = codeBlock.textContent;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => {
            showToast('Copied complete Code.gs (with doGet & doPost) to clipboard!', 'success');
          }).catch(() => fallbackCopy(text));
        } else {
          fallbackCopy(text);
        }
      });

      const urlBox = document.getElementById('inputWebAppUrl');
      const urlBtn = document.getElementById('btnConnectLiveUrl');
      function lockUrlBox() { urlBox.readOnly = true; urlBtn.textContent = 'Change'; }
      document.getElementById('btnConnectLiveUrl').addEventListener('click', async () => {
        if (urlBox.readOnly) {
          urlBox.readOnly = false;
          urlBtn.textContent = 'Apply to Everyone';
          urlBox.focus();
          urlBox.select();
          return;
        }
        const url = document.getElementById('inputWebAppUrl').value.trim();
        if (!url) {
          urlBox.value = state.liveWebAppUrl || DEFAULT_WEBAPP_URL;
          lockUrlBox();
          return;
        }
        if (!isValidWebAppUrl(url)) { showToast('That does not look like a deployed Web App URL (it must end with /exec).', 'warn'); return; }
        if (url === state.liveWebAppUrl) { lockUrlBox(); await syncFromLiveDrive(false); checkUploadHealth(); if (!isValidWebAppUrl(DEFAULT_WEBAPP_URL)) showToast('Saved on THIS device only. For other devices click "Download everyone-ready index.html" below and upload it to GitHub.', 'info'); return; }
        try {
          const t = await (await fetch(url + '?action=listAll', { redirect: 'follow' })).json();
          if (!t || !t.ok) throw new Error('bad reply');
        } catch (e) {
          showToast('That Web App did not answer — check Execute as: Me and Access: Anyone.', 'warn');
          return;
        }
        const oldUrl = state.liveWebAppUrl;
        if (oldUrl && state.editorUnlocked) {
          const r = await postToLiveDrive({ action: 'setForwardUrl', forwardUrl: url }, true);
          if (r && r.ok) showToast('Saved — every device will follow to the new Web App on its next refresh.', 'success');
          else showToast('Switched this device to the new Web App URL.', 'info');
        }
        if (!oldUrl && !state.editorUnlocked) state.bootstrapSession = true; // first-time connect: keep ⚙️ Setup open this session so the permanent line can be copied
        applyLiveUrl(url);
        lockUrlBox();
        lastSyncSig = '';
        if (state.editorUnlocked) {
          const v = await postToLiveDrive({ action: 'verifyPin', pin: state.editorPin }, true);
          if (v && v.error === 'Wrong editor PIN') { lockEditor(); showToast('Connected, but the Editor PIN differs on the new script — unlock again with its PIN.', 'warn'); }
          else if (v && v.ok) await postToLiveDrive({ action: 'setForwardUrl', forwardUrl: '' }, true);
        }
        await syncFromLiveDrive(false);
        checkUploadHealth();
        if (state.editorUnlocked) refreshLiveConfig();
        if (!isValidWebAppUrl(DEFAULT_WEBAPP_URL)) {
          showToast('Saved on THIS device only. To reach everyone: click "Download everyone-ready index.html" below and upload it to GitHub.', 'info');
        }
      });

      document.getElementById('btnDownloadEveryoneFile').addEventListener('click', async () => {
        const st = document.getElementById('everyoneStatus');
        if (!state.liveWebAppUrl) { showToast('Connect a Web App URL first (Box 2 → Apply to Everyone).', 'warn'); return; }
        try {
          let raw = '';
          const sources = location.protocol === 'file:' ? [SITE_URL] : [location.href.split('#')[0], SITE_URL];
          for (const src of sources) {
            try { raw = await (await fetch(src, { cache: 'no-store' })).text(); if (raw.indexOf('DEFAULT_WEBAPP_URL') > -1) break; } catch (e) {}
          }
          if (!raw) throw new Error('file');
          const marker = /const DEFAULT_WEBAPP_URL = '[^']*';/;
          if (!marker.test(raw)) throw new Error('marker');
          let out = raw.replace(marker, function () { return "const DEFAULT_WEBAPP_URL = '" + state.liveWebAppUrl + "';"; });
          const liveFolder = liveRootFolderId && liveRootFolderId.indexOf('PASTE_') !== 0 ? liveRootFolderId : '';
          if (liveFolder) out = out.replace(/const DEFAULT_ROOT_FOLDER_ID = '[^']*';/, function () { return "const DEFAULT_ROOT_FOLDER_ID = '" + liveFolder + "';"; });
          const blob = new Blob([out], { type: 'text/html' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'index.html';
          document.body.appendChild(a);
          a.click();
          a.remove();
          st.textContent = 'Downloaded. Now upload this index.html to GitHub (replace the old one). Everyone who opens your site is connected automatically.';
          showToast('Everyone-ready index.html downloaded — upload it to GitHub.', 'success');
        } catch (err) {
          st.textContent = 'This page was opened from a local file, so it cannot copy itself. Open it from your hosted link instead, or use the Permanent GitHub line below (one-time paste).';
          showToast('Could not build the file here — use the Permanent GitHub line below instead.', 'warn');
        }
      });

      document.getElementById('btnTestEveryone').addEventListener('click', async () => {
        const st = document.getElementById('everyoneStatus');
        if (!state.liveWebAppUrl) { showToast('Connect a Web App URL first.', 'warn'); return; }
        st.textContent = 'Testing...';
        try {
          const h = await (await fetch(state.liveWebAppUrl + '?action=health', { redirect: 'follow' })).json();
          if (!h || !h.problems) { st.textContent = '❌ The deployed script is OLD (no health check). Paste the latest code, then Deploy → Manage deployments → pencil → New version.'; return; }
          if (h.ok) st.textContent = '✅ Ready for everyone. Uploads go to: ' + h.rootFolderName + ' / ' + h.pendingFolder + ' • Sheet tab: ' + h.uploadsSheet + ' • CONFIG tab: ' + (h.configSheet ? 'found' : 'missing');
          else st.textContent = '❌ ' + h.problems.join(' • ');
        } catch (err) {
          st.textContent = '❌ Could not reach the Web App. Deploy it as Execute as: Me, Who has access: Anyone.';
        }
      });

      function copyField(id, okMsg) {
        const el = document.getElementById(id);
        if (!state.liveWebAppUrl) { showToast('Connect a Web App URL first.', 'warn'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(el.value).then(() => showToast(okMsg, 'success')).catch(() => { el.select(); showToast('Press Ctrl+C / Cmd+C to copy', 'info'); });
        } else { el.select(); showToast('Press Ctrl+C / Cmd+C to copy', 'info'); }
      }

      document.getElementById('btnCopyShareLink').addEventListener('click', () => {
        copyField('inputShareLink', 'Join link copied!');
      });
      document.getElementById('btnCopyPermanentLine').addEventListener('click', () => copyField('inputPermanentLine', 'Line copied — paste it into the HTML file on GitHub.'));

      updateUploadPreview();
      renderBrowse();
      renderFeedAndLeaderboard();
      renderEditor();
      renderMyUploads();
      document.getElementById('btnClearMyUploads').addEventListener('click', () => { saveMyUploads([]); renderMyUploads(); });
      applyLiveUrl(state.liveWebAppUrl);
      if (state.liveWebAppUrl) { syncFromLiveDrive(true); checkUploadHealth(); }

      setInterval(() => { if (state.liveWebAppUrl && !document.hidden) syncFromLiveDrive(true); }, 45000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && state.liveWebAppUrl) syncFromLiveDrive(true); });
    });

    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast('Copied complete Code.gs to clipboard!', 'success');
      } catch (e) {
        showToast('Select the code block and press Ctrl+C / Cmd+C to copy', 'info');
      }
      ta.remove();
    }
