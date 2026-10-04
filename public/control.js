let socket = null;
let state = null;
let reconnectDelay = 1000;

// ---- WebSocket ----

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

  socket.addEventListener('error', () => {
    socket.close();
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'state') {
        state = msg.state;
        renderControl();
      } else if (msg.type === 'rejected') {
        alert('You do not have permission to do that.');
      }
    } catch (error) {
      console.error('Invalid WebSocket message:', error);
    }
  });
}

function setWsStatus(status) {
  const el = document.getElementById('ws-status');

  if (!el) return;

  el.textContent =
    status === 'connected'
      ? 'live'
      : 'reconnecting…';

  el.className = `ws-status ${status}`;
}

function send(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error('WebSocket is not open:', socket?.readyState);
    return;
  }

  const message = {
    type: 'command',
    action,
    ...payload,
  };

  console.log('Sending:', message);

  socket.send(JSON.stringify(message));
}

// ---- Helpers ----

function formatTime(sec) {
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0');

  const s = (sec % 60)
    .toString()
    .padStart(2, '0');

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

function getTeam(teamId) {
  if (!state || !Array.isArray(state.teams)) return null;

  return state.teams.find(
    (team) => String(team.id) === String(teamId)
  );
}

function getTeamPlayers(teamId) {
  if (!state) return [];

  return state.players.filter(
    (player) => String(player.teamId) === String(teamId)
  );
}

function getTeamName(teamId) {
  return getTeam(teamId)?.name || '';
}

function isMatchLive() {
  return !!(
    state &&
    state.match &&
    state.match.homeTeam &&
    state.match.awayTeam
  );
}

// ---- Match control ----

window.toggleTimer = function () {
  if (!state?.match) return;

  send(
    state.match.running
      ? 'pause-timer'
      : 'start-timer'
  );
};

window.resetTimer = function () {
  send('reset-timer');
};

/*
 * Server-side stat command:
 *
 * {
 *   action: 'stat',
 *   playerId,
 *   stat,
 *   amount
 * }
 *
 * The previous client API was:
 *
 * updateStat(field, value)
 *
 * so this function now accepts:
 *
 * updateStat(playerId, stat, amount)
 *
 * or:
 *
 * updateStat({ playerId, stat, amount })
 */
window.updateStat = function (playerId, stat, amount = 1) {
  if (
    playerId &&
    typeof playerId === 'object'
  ) {
    send('stat', {
      playerId: playerId.playerId,
      stat: playerId.stat,
      amount: playerId.amount ?? 1,
    });

    return;
  }

  send('stat', {
    playerId,
    stat,
    amount,
  });
};

// ---- Team-name inputs ----
//
// The current server does not have a setTeamName command.
// Team names are database-backed and are therefore intentionally
// not sent through the WebSocket.

document.addEventListener('input', (e) => {
  if (
    e.target.id === 'inp-home-name' ||
    e.target.id === 'inp-away-name'
  ) {
    // Do nothing.
    //
    // These fields are now display-only because the server does not
    // expose a setTeamName command.
  }
});

// ---- Team setup ----
//
// The current ws.js does not expose addPlayer/removePlayer commands.
// Players are loaded from the database by loadLeague().
//
// Keep these functions harmless if the existing HTML still references them.

window.addPlayer = function () {
  alert('Players must be added through the database.');
};

window.removePlayer = function () {
  alert('Players must be removed through the database.');
};

function renderPlayerLists() {
  if (!state) return;

  ['home', 'away'].forEach((side) => {
    const el = document.getElementById(`list-${side}`);

    if (!el) return;

    const teamId =
      side === 'home'
        ? state.match.homeTeam
        : state.match.awayTeam;

    const players = getTeamPlayers(teamId);

    el.innerHTML = players
      .map(
        (player) => `
          <li>
            <span>
              ${escapeHtml(player.number ?? '')}
              ${escapeHtml(player.name)}
            </span>
          </li>
        `
      )
      .join('');
  });
}

// ---- Player selects ----

function playerOption(player) {
  const number = player.number ?? '';

  return `
    <option value="${escapeHtml(String(player.id))}">
      ${escapeHtml(String(number))}
      ${escapeHtml(player.name)}
    </option>
  `;
}

function populateGoalSelects() {
  const scorer = document.getElementById('goal-scorer');
  const assist = document.getElementById('goal-assist');

  if (!scorer || !state) return;

  const teamEl = document.getElementById('goal-team');

  const teamId =
    teamEl?.value ||
    state.match.homeTeam;

  const players = getTeamPlayers(teamId);

  const previousScorer = scorer.value;
  const previousAssist = assist?.value || '';

  const opts = players
    .map(playerOption)
    .join('');

  scorer.innerHTML = opts;

  if (assist) {
    assist.innerHTML =
      `<option value="">-- None --</option>${opts}`;
  }

  if (
    [...scorer.options].some(
      (option) => option.value === previousScorer
    )
  ) {
    scorer.value = previousScorer;
  }

  if (
    assist &&
    [...assist.options].some(
      (option) => option.value === previousAssist
    )
  ) {
    assist.value = previousAssist;
  }
}

function populatePlayers(context) {
  const teamEl =
    document.getElementById(`${context}-team`);

  if (!teamEl || !state) return;

  const players = getTeamPlayers(teamEl.value);

  const opts = players
    .map(playerOption)
    .join('');

  ['player', 'out', 'in'].forEach((target) => {
    const el = document.getElementById(
      `${context}-${target}`
    );

    if (el) {
      el.innerHTML = opts;
    }
  });
}

document
  .getElementById('goal-team')
  ?.addEventListener(
    'change',
    populateGoalSelects
  );

document
  .getElementById('card-team')
  ?.addEventListener(
    'change',
    () => populatePlayers('card')
  );

document
  .getElementById('sub-team')
  ?.addEventListener(
    'change',
    () => populatePlayers('sub')
  );

// ---- Goal ----

window.triggerGoal = function () {
  const scorerId =
    document.getElementById('goal-scorer')?.value;

  const assistId =
    document.getElementById('goal-assist')?.value;

  const team =
    document.getElementById('goal-team')?.value;

  const ownEl =
    document.getElementById('goal-self');

  const selfGoal =
    !!(ownEl && ownEl.checked);

  if (!team || !scorerId) {
    alert('Select a team and scorer.');
    return;
  }

  const side =
    String(team) === String(state.match.awayTeam)
      ? 'away'
      : 'home';

  const scorer =
    state.players.find(
      (player) =>
        String(player.id) === String(scorerId)
    );

  if (!scorer) {
    alert('Selected scorer could not be found.');
    return;
  }

  // The server's goal command handles the actual goal.
  send('goal', {
    side,
    playerId: selfGoal ? null : scorer.id,
    playerName: scorer.name,
  });

  // An assist is a separate server command.
  //
  // Don't record an assist for an own goal.
  if (!selfGoal && assistId) {
    send('assist', {
      playerId: assistId,
    });
  }

  if (ownEl) {
    ownEl.checked = false;
  }
};

// ---- Cards ----

window.triggerCard = function () {
  const playerId =
    document.getElementById('card-player')?.value;

  const cardType =
    document.getElementById('card-type')?.value;

  if (!playerId || !cardType) {
    return;
  }

  /*
   * The server has a generic "stat" command.
   *
   * Expected stat names are those in STAT_FIELDS.
   *
   * The common card names are:
   *   yellowCards
   *   redCards
   */

  let stat;

  if (cardType === 'yellow') {
    stat = 'yellowCards';
  } else if (cardType === 'red') {
    stat = 'redCards';
  } else {
    // In case the HTML already uses yellowCards/redCards.
    stat = cardType;
  }

  send('stat', {
    playerId,
    stat,
    amount: 1,
  });
};

// ---- Substitutions ----
//
// The current server does not expose a substitution command.
// Keep the function so existing HTML onclick handlers don't throw.

window.triggerSub = function () {
  console.warn(
    'Substitutions are not supported by the current WebSocket server.'
  );
};

// ---- Overlay ----

window.hideOverlay = function (name) {
  send('overlay', {
    visible: false,
    type: name || null,
    data: null,
  });
};

window.toggleOverlay = function (name) {
  const currentlyVisible =
    !!state?.overlay?.visible;

  send('overlay', {
    visible: !currentlyVisible,
    type: name || state?.overlay?.type || null,
    data: state?.overlay?.data || null,
  });
};

// ---- VAR / referee calls ----
//
// These commands don't exist in the current ws.js.
// Keep the functions so the existing HTML remains functional,
// but don't pretend they are being sent to the server.

window.triggerVarCheck = function () {
  console.warn(
    'VAR commands are not supported by the current WebSocket server.'
  );
};

window.showVarVerdict = function () {
  console.warn(
    'VAR commands are not supported by the current WebSocket server.'
  );
};

window.clearVarGraphic = function () {
  send('overlay', {
    visible: false,
    type: 'var',
    data: null,
  });
};

window.quickRefCall = function () {
  console.warn(
    'Referee call commands are not supported by the current WebSocket server.'
  );
};

// ---- Start / end match ----

window.startScheduled = function (matchId) {
  document.getElementById('start-error').hidden = true;

  /*
   * The current WebSocket server does NOT have a "startMatch"
   * command or a scheduled-match command.
   *
   * Scheduled matches therefore need to be converted to:
   * set-match + homeTeam/awayTeam IDs.
   */

  loadScheduled()
    .then(async () => {
      try {
        const res = await fetch(
          `/api/matches/${encodeURIComponent(matchId)}`
        );

        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}`
          );
        }

        const match = await res.json();

        const homeId =
          match.homeId ??
          match.home?.id;

        const awayId =
          match.awayId ??
          match.away?.id;

        if (!homeId || !awayId) {
          throw new Error(
            'Scheduled match did not contain team IDs.'
          );
        }

        startMatchWithTeams(
          homeId,
          awayId
        );
      } catch (error) {
        console.error(
          'Failed to start scheduled match:',
          error
        );

        const err =
          document.getElementById(
            'start-error'
          );

        if (err) {
          err.textContent =
            'Could not load the scheduled match.';
          err.hidden = false;
        }
      }
    });
};

function startMatchWithTeams(homeId, awayId) {
  if (!homeId || !awayId) {
    return;
  }

  if (
    String(homeId) === String(awayId)
  ) {
    const err =
      document.getElementById('start-error');

    if (err) {
      err.textContent =
        'Pick two different teams.';
      err.hidden = false;
    }

    return;
  }

  send('set-match', {
    homeTeam: homeId,
    awayTeam: awayId,
  });
}

window.startMatch = function () {
  const homeId =
    document.getElementById('start-home')?.value;

  const awayId =
    document.getElementById('start-away')?.value;

  const err =
    document.getElementById('start-error');

  if (!homeId || !awayId) {
    if (err) {
      err.textContent =
        'No teams available. Add some to the database (npm run seed or npx prisma studio).';
      err.hidden = false;
    }

    return;
  }

  if (
    String(homeId) === String(awayId)
  ) {
    if (err) {
      err.textContent =
        'Pick two different teams.';
      err.hidden = false;
    }

    return;
  }

  if (err) {
    err.hidden = true;
  }

  startMatchWithTeams(
    homeId,
    awayId
  );
};

window.endMatch = function () {
  if (!state?.match) return;

  const m = state.match;

  const save =
    document.getElementById('end-save')?.checked;

  const homeName =
    getTeamName(m.homeTeam);

  const awayName =
    getTeamName(m.awayTeam);

  const summary =
    `${homeName} ${m.homeScore} - ${m.awayScore} ${awayName}`;

  const note = save
    ? 'The result and player stats will be saved to the league.'
    : 'The result and player stats will NOT be saved.';

  if (
    !confirm(
      `End the match?\n\n${summary}\n${note}`
    )
  ) {
    return;
  }

  /*
   * The current server's finish-match command
   * ALWAYS saves the result.
   *
   * The old client had saveResult, but the current
   * server does not read it.
   */

  send('finish-match');
};

// ---- Team dropdowns ----

let teamListSignature = '';

function populateTeamSelects() {
  if (!state) return;

  const teams = state.teams || [];

  const signature = teams
    .map(
      (team) =>
        `${team.id}:${team.name}`
    )
    .join('|');

  if (
    signature === teamListSignature
  ) {
    return;
  }

  teamListSignature = signature;

  const opts = teams
    .map(
      (team) =>
        `<option value="${escapeHtml(
          String(team.id)
        )}">${escapeHtml(team.name)}</option>`
    )
    .join('');

  const home =
    document.getElementById('start-home');

  const away =
    document.getElementById('start-away');

  if (!home || !away) return;

  home.innerHTML = opts;
  away.innerHTML = opts;

  if (teams.length > 1) {
    away.selectedIndex = 1;
  }
}

// ---- Scheduled fixtures ----

const fmtWhen = (iso) =>
  iso
    ? new Date(iso).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'No date set';

async function loadScheduled() {
  try {
    const res = await fetch(
      '/api/matches?status=scheduled'
    );

    if (!res.ok) return;

    const data = await res.json();

    const matches =
      Array.isArray(data)
        ? data
        : data.matches || [];

    const panel =
      document.getElementById(
        'scheduled-panel'
      );

    const list =
      document.getElementById(
        'scheduled-list'
      );

    if (!panel || !list) return;

    panel.hidden =
      matches.length === 0;

    list.innerHTML = matches
      .map((match) => {
        const home =
          match.home?.name ??
          match.homeTeam?.name ??
          '';

        const away =
          match.away?.name ??
          match.awayTeam?.name ??
          '';

        const id =
          Number(match.id);

        return `
          <li>
            <span>
              ${escapeHtml(home)}
              vs
              ${escapeHtml(away)}

              <span
                class="hint"
                style="margin:0;"
              >
                · ${escapeHtml(
                  fmtWhen(
                    match.scheduledAt
                  )
                )}
              </span>
            </span>

            <button
              class="btn primary"
              onclick="startScheduled(${id})"
            >
              Start
            </button>
          </li>
        `;
      })
      .join('');
  } catch (error) {
    console.error(
      'Failed to load scheduled matches:',
      error
    );
  }
}

let scheduledTimer = null;

function renderMode() {
  if (!state) return false;

  const live = isMatchLive();

  const startMenu =
    document.getElementById(
      'start-menu'
    );

  const liveControls =
    document.getElementById(
      'live-controls'
    );

  if (startMenu) {
    startMenu.hidden = live;
  }

  if (liveControls) {
    liveControls.hidden = !live;
  }

  if (!live) {
    populateTeamSelects();

    if (!scheduledTimer) {
      loadScheduled();

      scheduledTimer = setInterval(
        loadScheduled,
        10000
      );
    }
  } else if (scheduledTimer) {
    clearInterval(
      scheduledTimer
    );

    scheduledTimer = null;
  }

  return live;
}

// ---- Render ----

function updateTimerDisplay() {
  const el =
    document.getElementById(
      'ctrl-timer'
    );

  if (el) {
    el.textContent =
      formatTime(
        state.match.timer || 0
      );
  }

  const btn =
    document.getElementById(
      'btn-start'
    );

  if (btn) {
    btn.textContent =
      state.match.running
        ? 'Pause'
        : 'Start';
  }
}

function updateScoreDisplay() {
  const home =
    document.getElementById(
      'ctrl-home-score'
    );

  const away =
    document.getElementById(
      'ctrl-away-score'
    );

  if (home) {
    home.textContent =
      state.match.homeScore;
  }

  if (away) {
    away.textContent =
      state.match.awayScore;
  }
}

function updateToggleButtons() {
  /*
   * The current server only exposes one overlay:
   *
   * state.overlay
   *
   * The old client expected:
   *
   * state.overlays.possession
   * state.overlays.fouls
   * etc.
   *
   * Therefore all overlay buttons reflect the single
   * server-side overlay visibility state.
   */

  const map = {
    possession: 'btn-possession',
    fouls: 'btn-fouls',
    table: 'btn-table',
    formations: 'btn-formations',
    var: 'btn-var',
    replay: 'btn-replay',
  };

  Object.entries(map).forEach(
    ([key, id]) => {
      const btn =
        document.getElementById(id);

      if (!btn) return;

      const active =
        !!state?.overlay?.visible &&
        (
          !state.overlay.type ||
          state.overlay.type === key
        );

      btn.classList.toggle(
        'active',
        active
      );
    }
  );
}

function updateTeamLabels() {
  if (!state?.match) return;

  const homeName =
    getTeamName(
      state.match.homeTeam
    );

  const awayName =
    getTeamName(
      state.match.awayTeam
    );

  // Event team selects
  [
    'goal-team',
    'card-team',
    'sub-team',
  ].forEach((id) => {
    const el =
      document.getElementById(id);

    if (!el) return;

    if (el.options.length >= 2) {
      el.options[0].textContent =
        homeName;

      el.options[0].value =
        state.match.homeTeam;

      el.options[1].textContent =
        awayName;

      el.options[1].value =
        state.match.awayTeam;
    }
  });

  // Team-name fields
  const homeInput =
    document.getElementById(
      'inp-home-name'
    );

  const awayInput =
    document.getElementById(
      'inp-away-name'
    );

  const focusedId =
    document.activeElement?.id;

  if (
    homeInput &&
    focusedId !== 'inp-home-name'
  ) {
    homeInput.value =
      homeName;
  }

  if (
    awayInput &&
    focusedId !== 'inp-away-name'
  ) {
    awayInput.value =
      awayName;
  }
}

function renderControl() {
  if (!state) return;

  const live = renderMode();

  if (!live) return;

  updateTeamLabels();

  updateTimerDisplay();
  updateScoreDisplay();

  renderPlayerLists();

  populateGoalSelects();

  if (
    document.getElementById(
      'card-team'
    )
  ) {
    populatePlayers('card');
  }

  if (
    document.getElementById(
      'sub-team'
    )
  ) {
    populatePlayers('sub');
  }

  updateToggleButtons();
}

// ---- Auth ----

async function logout() {
  try {
    await fetch(
      '/api/logout',
      {
        method: 'POST',
      }
    );
  } finally {
    window.location.href =
      '/login.html';
  }
}

window.logout = logout;

// Admins get a link across to the statistics page.

fetch('/api/session')
  .then((response) => {
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return response.json();
  })
  .then((session) => {
    const link =
      document.getElementById(
        'nav-stats'
      );

    if (
      link &&
      session.role === 'admin'
    ) {
      link.hidden = false;
    }
  })
  .catch(() => {});

// ---- Start ----

connectWebSocket();