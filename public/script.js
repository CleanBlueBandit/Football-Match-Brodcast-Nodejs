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
    away: 100 - document.getElementById('inp-home-poss').value,
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

// ---- Player stats (goals / assists / fouls) ----

// Delegated click handler: the rows are rebuilt when stats change, so
// individual button listeners would be lost.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-stat]');
  if (!btn) return;
  send('adjustPlayerStat', {
    team: btn.dataset.team,
    number: btn.dataset.number,
    field: btn.dataset.stat,
    delta: Number(btn.dataset.delta),
  });
});

let statsSignature = '';
function renderPlayerStats() {
  const sig = JSON.stringify([state.players, state.playerStats, state.match.homeTeam, state.match.awayTeam]);
  if (sig === statsSignature) return; // don't rebuild (and eat clicks) on every clock tick
  statsSignature = sig;

  const fields = [
    ['goals', 'G', 'Goals'],
    ['assists', 'A', 'Assists'],
    ['fouls', 'F', 'Fouls'],
    ['yellow_cards', 'Y', 'Yellow cards'],
    ['red_cards', 'R', 'Red cards'],
  ];
  ['home', 'away'].forEach((team) => {
    const title = document.getElementById(`stats-${team}-title`);
    if (title) title.textContent = team === 'home' ? state.match.homeTeam : state.match.awayTeam;
    const el = document.getElementById(`stats-${team}`);
    if (!el) return;
    const stats = (state.playerStats && state.playerStats[team]) || {};
    el.innerHTML =
      (state.players[team] || [])
        .map((p) => {
          const st = stats[String(p.number)] || {};
          const cells = fields
            .map(([f, label, title]) => {
              const data = `data-team="${team}" data-number="${escapeHtml(String(p.number))}" data-stat="${f}"`;
              return `<span class="stat-cell stat-${f}" title="${title}"><span class="lbl">${label}</span>` +
                `<button ${data} data-delta="-1">-</button><span class="val">${st[f] || 0}</span>` +
                `<button ${data} data-delta="1">+</button></span>`;
            })
            .join('');
          return `<div class="stat-row"><span class="stat-name">${escapeHtml(String(p.number))} ${escapeHtml(p.name)}</span><span class="stat-cells">${cells}</span></div>`;
        })
        .join('') || '<div class="hint">No players</div>';
  });
}

// ---- Start / end match ----

window.startMatch = function () {
  const homeId = document.getElementById('start-home').value;
  const awayId = document.getElementById('start-away').value;
  const err = document.getElementById('start-error');
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

// Returns true when a match is live. Idle -> start menu, live -> controls.
function renderMode() {
  const live = state.status === 'live';
  document.getElementById('start-menu').hidden = live;
  document.getElementById('live-controls').hidden = !live;
  if (!live) populateTeamSelects();
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
  renderPlayerStats();
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
