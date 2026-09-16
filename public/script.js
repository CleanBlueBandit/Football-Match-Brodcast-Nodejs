// Control panel logic. This replaces the old pattern of mutating a local
// `state` object and POSTing the whole thing to save_state.php: every
// action here sends a small { type: 'command', action, ... } message over
// the WebSocket, the server applies it against the authoritative state,
// persists it to Postgres, and broadcasts the full state back to every
// connected client (this tab, any other control tab, and tv.html).

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
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---- Match control ----

window.toggleTimer = function () {
  send('toggleTimer');
};

window.resetTimer = function () {
  send('resetTimer');
};

window.modScore = function (team, delta) {
  send('modScore', { team, delta });
};

window.updateStat = function (field, value) {
  send('updateStat', { field, value });
};

window.updatePossession = function () {
  send('updatePossession', {
    home: document.getElementById('inp-home-poss').value,
    away: document.getElementById('inp-away-poss').value,
  });
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
  s.innerHTML = opts;
  if (a) a.innerHTML = `<option value="">-- None --</option>${opts}`;
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
  send('triggerGoal', {
    team: document.getElementById('goal-team').value,
    scorerNumber: sParts[0],
    scorerName: sParts[1],
    assistNumber: aParts[0],
    assistName: aParts[1],
  });
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
    goalHistory: 'btn-goal-history',
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
    'inp-home-fouls': state.match.homeFouls,
    'inp-away-fouls': state.match.awayFouls,
    'inp-home-poss': state.match.homePossession,
    'inp-away-poss': state.match.awayPossession,
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

connectWebSocket();
