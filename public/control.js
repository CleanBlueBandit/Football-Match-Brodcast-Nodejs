let socket = null;
let state = null;
let reconnectDelay = 1000;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    setWsStatus('connected');
    reconnectDelay = 1000;
  });

  socket.addEventListener('close', () => {
    setWsStatus('disconnected');
    setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  socket.addEventListener('error', () => socket.close());

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') {
      state = msg.state;
      renderControl();
    } else if (msg.type === 'rejected') {
      alert('You do not have permission to do that.');
    }
  });
}

function setWsStatus(status) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  el.textContent = status === 'connected' ? 'live' : 'reconnecting…';
  el.className = `ws-status ${status}`;
}

function send(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'command', action, ...payload }));
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Match control ----

window.toggleTimer = function () {
  send('toggleTimer');
};

window.resetTimer = function () {
  send('resetTimer');
};

window.updateStat = function (field, value) {
  send('updateStat', { field, value });
};

// Team-name inputs sync live, as-you-type - matching the original
// document-level 'input' listener rather than waiting for blur/change.
document.addEventListener('input', (e) => {
  if (e.target.id === 'inp-home-name') send('setTeamName', { team: 'home', value: e.target.value });
  if (e.target.id === 'inp-away-name') send('setTeamName', { team: 'away', value: e.target.value });
});

// ---- Team setup ----

window.addPlayer = function (team) {
  const nameInput = document.getElementById(`add-${team}-name`);
  const numInput = document.getElementById(`add-${team}-num`);
  const name = nameInput.value.trim();
  const number = parseInt(numInput.value, 10);
  if (!name || Number.isNaN(number)) {
    alert('Enter name and number');
    return;
  }
  if (state && (state.players[team] || []).some((p) => String(p.number) === String(number))) {
    alert(`Shirt number ${number} is already taken on this team.`);
    return;
  }
  send('addPlayer', { team, name, number });
  nameInput.value = '';
  numInput.value = '';
};

window.removePlayer = function (team, idx) {
  send('removePlayer', { team, index: idx });
};

function renderPlayerLists() {
  ['home', 'away'].forEach((team) => {
    const el = document.getElementById(`list-${team}`);
    if (!el || !state) return;
    el.innerHTML = state.players[team]
      .map(
        (p, i) =>
          `<li><span>${p.number} ${escapeHtml(p.name)}</span><button class="btn" onclick="removePlayer('${team}', ${i})">Remove</button></li>`
      )
      .join('');
  });
}

// Option values are encoded "number|name", matching tv.js's original
// populateGoalSelects()/populatePlayers() convention.
function populateGoalSelects() {
  const s = document.getElementById('goal-scorer');
  const a = document.getElementById('goal-assist');
  if (!s || !state) return;
  const team = document.getElementById('goal-team')?.value || 'home';
  const plist = state.players[team] || [];
  const opts = plist.map((p) => `<option value="${p.number}|${escapeHtml(p.name)}">${p.number} ${escapeHtml(p.name)}</option>`).join('');
  // This runs on every state update (once a second while the clock runs), so
  // keep whatever the operator already picked instead of resetting it.
  const prevScorer = s.value;
  const prevAssist = a ? a.value : '';
  s.innerHTML = opts;
  if (a) a.innerHTML = `<option value="">-- None --</option>${opts}`;
  if ([...s.options].some((o) => o.value === prevScorer)) s.value = prevScorer;
  if (a && [...a.options].some((o) => o.value === prevAssist)) a.value = prevAssist;
}

function populatePlayers(context) {
  const teamEl = document.getElementById(`${context}-team`);
  if (!teamEl || !state) return;
  const plist = state.players[teamEl.value] || [];
  const opts = plist.map((p) => `<option value="${p.number}|${escapeHtml(p.name)}">${p.number} ${escapeHtml(p.name)}</option>`).join('');
  ['player', 'out', 'in'].forEach((target) => {
    const el = document.getElementById(`${context}-${target}`);
    if (el) el.innerHTML = opts;
  });
}

document.getElementById('goal-team')?.addEventListener('change', populateGoalSelects);

// ---- Goal / Card / Sub events ----

window.triggerGoal = function () {
  const sParts = (document.getElementById('goal-scorer').value || '').split('|');
  const assistVal = document.getElementById('goal-assist').value;
  const aParts = assistVal ? assistVal.split('|') : ['', ''];
  const ownEl = document.getElementById('goal-self');
  const selfGoal = !!(ownEl && ownEl.checked);
  send('triggerGoal', {
    team: document.getElementById('goal-team').value,
    selfGoal,
    scorerNumber: sParts[0],
    scorerName: sParts[1],
    assistNumber: selfGoal ? '' : aParts[0],
    assistName: selfGoal ? '' : aParts[1],
  });
  if (ownEl) ownEl.checked = false; // don't carry "self goal" over to the next goal
};

window.triggerCard = function () {
  const parts = (document.getElementById('card-player').value || '').split('|');
  send('triggerCard', {
    team: document.getElementById('card-team').value,
    playerNumber: parts[0],
    playerName: parts[1],
    cardType: document.getElementById('card-type').value,
  });
};

window.triggerSub = function () {
  const outP = (document.getElementById('sub-out').value || '').split('|');
  const inP = (document.getElementById('sub-in').value || '').split('|');
  send('triggerSub', {
    team: document.getElementById('sub-team').value,
    outNumber: outP[0],
    outName: outP[1],
    inNumber: inP[0],
    inName: inP[1],
  });
};

window.hideOverlay = function (name) {
  send('hideOverlay', { name });
};

window.toggleOverlay = function (name) {
  send('toggleOverlay', { name });
};

// ---- VAR & referee calls ----

window.triggerVarCheck = function () {
  send('triggerVarCheck', { checkType: document.getElementById('var-check-type').value });
};

window.showVarVerdict = function () {
  send('showVarVerdict', { verdict: document.getElementById('var-verdict').value });
};

window.clearVarGraphic = function () {
  send('clearVarGraphic');
};

window.quickRefCall = function (call) {
  send('quickRefCall', { call });
};

// ---- Start / end match ----

window.startScheduled = function (matchId) {
  document.getElementById('start-error').hidden = true;
  send('startMatch', { matchId });
};

window.startMatch = function () {
  const homeId = document.getElementById('start-home').value;
  const awayId = document.getElementById('start-away').value;
  const err = document.getElementById('start-error');
  console.log({ homeId, awayId, socketState: socket?.readyState });
  if (!homeId || !awayId) {
    err.textContent = 'No teams available. Add some to the database (npm run seed or npx prisma studio).';
    err.hidden = false;
    return;
  }
  if (homeId === awayId) {
    err.textContent = 'Pick two different teams.';
    err.hidden = false;
    return;
  }
  err.hidden = true;
  send('startMatch', { homeId, awayId });
};

window.endMatch = function () {
  if (!state) return;
  const m = state.match;
  const save = document.getElementById('end-save').checked;
  const summary = `${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}`;
  const note = save
    ? 'The result and player stats will be saved to the league.'
    : 'The result and player stats will NOT be saved.';
  if (!confirm(`End the match?\n\n${summary}\n${note}`)) return;
  send('endMatch', { saveResult: save });
};

// Rebuilds the team dropdowns only when the team list changes, so a
// broadcast never resets a selection the operator is in the middle of making.
let teamListSignature = '';
function populateTeamSelects() {
  const teams = state.teams || [];
  const signature = teams.map((t) => `${t.id}:${t.name}`).join('|');
  if (signature === teamListSignature) return;
  teamListSignature = signature;

  const opts = teams.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  const home = document.getElementById('start-home');
  const away = document.getElementById('start-away');
  home.innerHTML = opts;
  away.innerHTML = opts;
  if (teams.length > 1) away.selectedIndex = 1;
}

// Scheduled fixtures (created by the statistician) that can be started. Loaded
// over HTTP while the start menu is showing, and refreshed every 10 s so a fixture
// scheduled a moment ago shows up.
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'No date set');
async function loadScheduled() {
  try {
    const res = await fetch('/api/matches?status=scheduled');
    if (!res.ok) return;
    const { matches } = await res.json();
    document.getElementById('scheduled-panel').hidden = matches.length === 0;
    document.getElementById('scheduled-list').innerHTML = matches
      .map(
        (m) =>
          `<li><span>${escapeHtml(m.home.name)} vs ${escapeHtml(m.away.name)} <span class="hint" style="margin:0;">· ${escapeHtml(fmtWhen(m.scheduledAt))}</span></span>` +
          `<button class="btn primary" onclick="startScheduled(${Number(m.id)})">Start</button></li>`
      )
      .join('');
  } catch {
    /* start menu still works with the team pickers */
  }
}
let scheduledTimer = null;

// Returns true when a match is live. Idle -> start menu, live -> controls.
function renderMode() {
  const live = state.status === 'live';
  const wasHidden = document.getElementById('start-menu').hidden;
  document.getElementById('start-menu').hidden = live;
  document.getElementById('live-controls').hidden = !live;
  if (!live) {
    populateTeamSelects();
    if (wasHidden) loadScheduled(); // just became idle (or first render)
    if (!scheduledTimer) scheduledTimer = setInterval(loadScheduled, 10000);
  } else if (scheduledTimer) {
    clearInterval(scheduledTimer);
    scheduledTimer = null;
  }
  return live;
}

// ---- Render ----

function updateTimerDisplay() {
  const el = document.getElementById('ctrl-timer');
  if (el) el.textContent = formatTime(state.match.time);
  const btn = document.getElementById('btn-start');
  if (btn) btn.textContent = state.match.isRunning ? 'Pause' : 'Start';
}

function updateScoreDisplay() {
  const h = document.getElementById('ctrl-home-score');
  const a = document.getElementById('ctrl-away-score');
  if (h) h.textContent = state.match.homeScore;
  if (a) a.textContent = state.match.awayScore;
}

function updateToggleButtons() {
  const map = {
    possession: 'btn-possession',
    fouls: 'btn-fouls',
    table: 'btn-table',
    formations: 'btn-formations',
    var: 'btn-var',
    replay: 'btn-replay',
  };
  Object.entries(map).forEach(([key, id]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const overlayVal = state.overlays[key];
    const active = typeof overlayVal === 'object' ? !!overlayVal.visible : !!overlayVal;
    btn.classList.toggle('active', active);
  });
}

function renderControl() {
  if (!state) return;
  if (!renderMode()) return; // no match running: nothing else to render

  // Team dropdowns in the event panels show the real team names.
  ['goal-team', 'card-team', 'sub-team'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.options.length < 2) return;
    el.options[0].textContent = state.match.homeTeam;
    el.options[1].textContent = state.match.awayTeam;
  });

  const fieldMap = {
    'inp-home-formation': state.match.homeFormation,
    'inp-away-formation': state.match.awayFormation,
  };
  Object.entries(fieldMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });

  // Don't clobber a field the user is actively typing into.
  const focusedId = document.activeElement && document.activeElement.id;
  const echoFields = {
    'inp-home-name': state.match.homeTeam,
    'inp-away-name': state.match.awayTeam,
    'inp-added': state.match.addedTime,
  };
  Object.entries(echoFields).forEach(([id, value]) => {
    if (id === focusedId) return;
    const el = document.getElementById(id);
    if (el) el.value = value;
  });

  updateTimerDisplay();
  updateScoreDisplay();
  renderPlayerLists();
  populateGoalSelects();
  if (document.getElementById('card-team')) populatePlayers('card');
  if (document.getElementById('sub-team')) populatePlayers('sub');
  updateToggleButtons();
}

// ---- Auth ----

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
window.logout = logout;

// Admins get a link across to the statistics page.
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    const link = document.getElementById('nav-stats');
    if (link && s.role === 'admin') link.hidden = false;
  })
  .catch(() => {});

connectWebSocket();
