// Statistics page. Two ways of changing numbers:
//   * the LIVE match goes over the WebSocket (same commands the broadcast uses,
//     so the TV overlay follows immediately), and
//   * scheduled / finished matches are loaded, edited and saved over HTTP.

let socket = null;
let state = null; // latest live state from the server
let reconnectDelay = 1000;
let matches = []; // list shown in the Matches panel
let editor = null; // { match, squads, stats, dirty } while a non-live match is open
let liveKey = null; // changes when a match starts/ends, to refresh the list

const FIELDS = [
  ['goals', 'G', 'Goals'],
  ['assists', 'A', 'Assists'],
  ['fouls', 'F', 'Fouls'],
  ['yellow_cards', 'Y', 'Yellow cards'],
  ['red_cards', 'R', 'Red cards'],
];

const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'No date set');

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function flash(el, text, ok = false) {
  if (!el) return;
  el.textContent = text || '';
  el.className = ok ? 'form-ok' : 'form-error';
  el.hidden = !text;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// WebSocket (live match)
// ---------------------------------------------------------------------------
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
      renderLive();
      const key = `${state.status}:${state.currentMatch?.matchId ?? ''}`;
      if (key !== liveKey) {
        liveKey = key;
        loadMatches();
      }
    } else if (msg.type === 'rejected') {
      alert('You do not have permission to do that.');
    }
  });
}

function setWsStatus(status) {
  const el = $('ws-status');
  if (!el) return;
  el.textContent = status === 'connected' ? 'live' : 'reconnecting…';
  el.className = `ws-status ${status}`;
}

function send(action, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'command', action, ...payload }));
}

window.modScore = (team, delta) => send('modScore', { team, delta });
window.setTeamStat = (field, value) => send('setTeamStat', { field, value });
window.updatePossession = (home) => {
  const h = Math.min(100, Math.max(0, parseInt(home, 10) || 0));
  send('updatePossession', { home: h, away: 100 - h });
};

// ---------------------------------------------------------------------------
// Player stat rows (shared by the live panel and the editor)
// ---------------------------------------------------------------------------
function statRowsHtml(ctx, team, players, stats) {
  if (!players.length) return '<div class="hint">No players</div>';
  return players
    .map((p) => {
      const st = stats[String(p.number)] || {};
      const cells = FIELDS.map(([f, label, title]) => {
        const data = `data-ctx="${ctx}" data-team="${team}" data-number="${esc(p.number)}" data-stat="${f}"`;
        return (
          `<span class="stat-cell stat-${f}" title="${title}"><span class="lbl">${label}</span>` +
          `<button ${data} data-delta="-1">-</button><span class="val">${st[f] || 0}</span>` +
          `<button ${data} data-delta="1">+</button></span>`
        );
      }).join('');
      return `<div class="stat-row"><span class="stat-name">${esc(p.number)} ${esc(p.name)}</span><span class="stat-cells">${cells}</span></div>`;
    })
    .join('');
}

// Delegated: the rows are rebuilt whenever stats change.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-stat]');
  if (!btn) return;
  const { ctx, team, number, stat } = btn.dataset;
  const delta = Number(btn.dataset.delta);
  if (ctx === 'live') send('adjustPlayerStat', { team, number, field: stat, delta });
  else if (ctx === 'edit') editorAdjust(team, number, stat, delta);
});

// ---------------------------------------------------------------------------
// Live panel
// ---------------------------------------------------------------------------
let liveSig = '';
function renderLive() {
  if (!state) return;
  const live = state.status === 'live';
  $('live-empty').hidden = live;
  $('live-body').hidden = !live;
  if (!live) {
    liveSig = '';
    return;
  }

  const m = state.match;
  $('live-home-name').textContent = m.homeTeam;
  $('live-away-name').textContent = m.awayTeam;
  $('live-home-score').textContent = m.homeScore;
  $('live-away-score').textContent = m.awayScore;
  $('live-clock').textContent = formatTime(m.time);
  $('live-clock-state').textContent = m.isRunning ? 'clock running' : 'clock stopped';
  $('live-away-poss').textContent = m.awayPossession;

  // Don't clobber a field being typed into.
  const focused = document.activeElement && document.activeElement.id;
  const echo = { 'live-home-fouls': m.homeFouls, 'live-away-fouls': m.awayFouls, 'live-home-poss': m.homePossession };
  Object.entries(echo).forEach(([id, value]) => {
    if (id !== focused) $(id).value = value;
  });

  // Rebuilding (and eating clicks) once a second while the clock runs would be bad.
  const sig = JSON.stringify([state.players, state.playerStats, m.homeTeam, m.awayTeam]);
  if (sig === liveSig) return;
  liveSig = sig;
  $('live-stats-home-title').textContent = m.homeTeam;
  $('live-stats-away-title').textContent = m.awayTeam;
  ['home', 'away'].forEach((team) => {
    $(`live-stats-${team}`).innerHTML = statRowsHtml('live', team, state.players[team] || [], state.playerStats?.[team] || {});
  });
}

// ---------------------------------------------------------------------------
// Matches list
// ---------------------------------------------------------------------------
async function loadMatches() {
  try {
    matches = (await api('GET', '/api/matches')).matches;
    renderMatchList();
  } catch (err) {
    flash($('matches-msg'), err.message);
  }
}

function renderMatchList() {
  const filter = $('filter').value;
  const rows = matches.filter((m) => filter === 'all' || m.status === filter);
  $('match-list').innerHTML =
    rows
      .map((m) => {
        const showScore = m.status !== 'scheduled';
        const note = m.status === 'finished' && !m.countsInLeague ? '<span class="badge note">not in table</span>' : '';
        const open = editor && editor.match.id === m.id ? ' open' : '';
        const buttons =
          m.status === 'live'
            ? `<button class="btn primary" onclick="focusLive()">Live controls</button>`
            : `<button class="btn" onclick="openEditor(${m.id})">${m.status === 'finished' ? 'View / correct' : 'Edit stats'}</button>` +
              (m.status === 'scheduled' ? `<button class="btn danger" onclick="deleteMatch(${m.id})">Delete</button>` : '');
        return (
          `<div class="match-row${open}">` +
          `<span class="badge ${m.status}">${m.status === 'scheduled' ? 'upcoming' : m.status}</span>` +
          `<span class="teams">${esc(m.home.name)} vs ${esc(m.away.name)}${note}<span class="when">${esc(fmtWhen(m.scheduledAt || m.startedAt))}</span></span>` +
          `<span class="score">${showScore ? `${m.homeScore} - ${m.awayScore}` : '–'}</span>` +
          `<span class="actions">${buttons}</span></div>`
        );
      })
      .join('') || '<div class="hint">No matches yet. Schedule one above.</div>';
}
window.renderMatchList = renderMatchList;

window.focusLive = () => $('live-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

async function loadTeams() {
  try {
    const { teams } = await api('GET', '/api/teams');
    const opts = teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    $('new-home').innerHTML = opts;
    $('new-away').innerHTML = opts;
    if (teams.length > 1) $('new-away').selectedIndex = 1;
  } catch (err) {
    flash($('matches-msg'), err.message);
  }
}

window.scheduleMatch = async () => {
  const homeId = $('new-home').value;
  const awayId = $('new-away').value;
  if (!homeId || !awayId) return flash($('matches-msg'), 'No teams available.');
  if (homeId === awayId) return flash($('matches-msg'), 'Pick two different teams.');
  try {
    await api('POST', '/api/matches', { homeId, awayId, scheduledAt: fromLocalInput($('new-when').value) });
    $('new-when').value = '';
    flash($('matches-msg'), '');
    await loadMatches();
  } catch (err) {
    flash($('matches-msg'), err.message);
  }
};

window.deleteMatch = async (id) => {
  const m = matches.find((x) => x.id === id);
  if (!m || !confirm(`Delete the scheduled match ${m.home.name} vs ${m.away.name}?`)) return;
  try {
    await api('DELETE', `/api/matches/${id}`);
    if (editor && editor.match.id === id) closeEditor(true);
    await loadMatches();
  } catch (err) {
    flash($('matches-msg'), err.message);
    loadMatches();
  }
};

// ---------------------------------------------------------------------------
// Match editor (scheduled / finished matches)
// ---------------------------------------------------------------------------
window.markDirty = () => {
  if (!editor) return;
  editor.dirty = true;
  $('ed-dirty').hidden = false;
};

window.syncEdPoss = () => {
  const home = Math.min(100, Math.max(0, parseInt($('ed-home-poss').value, 10) || 0));
  $('ed-away-poss').textContent = 100 - home;
};

function fillEditor() {
  const { match, squads, stats } = editor;
  const finished = match.status === 'finished';
  $('editor-title').textContent = `${match.home.name} vs ${match.away.name}`;
  $('editor-hint').textContent = finished
    ? match.countsInLeague
      ? 'Finished match. Saving a correction also corrects the league table and player totals.'
      : 'Finished match that was not recorded in the league table, so corrections here do not change the table or player totals.'
    : 'This match has not been played yet. Numbers saved here are kept and are loaded when the broadcaster starts it.';

  $('ed-when-row').hidden = finished;
  $('ed-when').value = toLocalInput(match.scheduledAt);
  $('ed-home-score').value = match.homeScore;
  $('ed-away-score').value = match.awayScore;
  $('ed-home-fouls').value = match.homeFouls;
  $('ed-away-fouls').value = match.awayFouls;
  $('ed-home-poss').value = match.homePossession;
  window.syncEdPoss();
  $('ed-league-row').hidden = !finished;
  $('ed-counts').checked = match.countsInLeague;
  $('ed-stats-home-title').textContent = match.home.name;
  $('ed-stats-away-title').textContent = match.away.name;
  renderEditorStats();
  $('ed-dirty').hidden = !editor.dirty;
}

function renderEditorStats() {
  ['home', 'away'].forEach((team) => {
    $(`ed-stats-${team}`).innerHTML = statRowsHtml('edit', team, editor.squads[team], editor.stats[team]);
  });
}

function editorAdjust(team, number, field, delta) {
  const st = editor.stats[team][String(number)];
  if (!st) return;
  const before = st[field] || 0;
  st[field] = Math.max(0, before + delta);
  // Same rule as the live panel: a player foul is also a team foul.
  if (field === 'fouls' && st.fouls !== before) {
    const input = $(`ed-${team}-fouls`);
    input.value = Math.max(0, (parseInt(input.value, 10) || 0) + (st.fouls - before));
  }
  window.markDirty();
  renderEditorStats();
}

window.openEditor = async (id) => {
  if (editor && editor.dirty && editor.match.id !== id && !confirm('Discard your unsaved changes?')) return;
  try {
    const detail = await api('GET', `/api/matches/${id}`);
    if (detail.match.status === 'live') return window.focusLive();
    editor = { ...detail, dirty: false };
    flash($('editor-msg'), '');
    $('editor-panel').hidden = false;
    fillEditor();
    renderMatchList();
    $('editor-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    flash($('matches-msg'), err.message);
  }
};

function closeEditor(force) {
  if (!force && editor && editor.dirty && !confirm('Discard your unsaved changes?')) return;
  editor = null;
  $('editor-panel').hidden = true;
  renderMatchList();
}
window.closeEditor = () => closeEditor(false);

window.saveEditor = async () => {
  if (!editor) return;
  const { match } = editor;
  const num = (id) => parseInt($(id).value, 10);
  const payload = {
    match: {
      homeScore: num('ed-home-score'),
      awayScore: num('ed-away-score'),
      homeFouls: num('ed-home-fouls'),
      awayFouls: num('ed-away-fouls'),
      homePossession: num('ed-home-poss'),
    },
    players: { home: Object.values(editor.stats.home), away: Object.values(editor.stats.away) },
  };
  if (match.status === 'finished') payload.match.countsInLeague = $('ed-counts').checked;
  if (Object.values(payload.match).some((v) => typeof v === 'number' && Number.isNaN(v))) {
    return flash($('editor-msg'), 'Fill in every number.');
  }

  $('ed-save').disabled = true;
  try {
    if (match.status === 'scheduled') {
      const when = fromLocalInput($('ed-when').value);
      const before = match.scheduledAt ? new Date(match.scheduledAt).toISOString() : null;
      if (when !== before) await api('PATCH', `/api/matches/${match.id}`, { scheduledAt: when });
    }
    const detail = await api('PUT', `/api/matches/${match.id}/stats`, payload);
    editor = { ...detail, dirty: false };
    fillEditor();
    flash($('editor-msg'), 'Saved.', true);
    loadMatches();
  } catch (err) {
    flash($('editor-msg'), err.message);
  } finally {
    $('ed-save').disabled = false;
  }
};

window.addEventListener('beforeunload', (e) => {
  if (editor && editor.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
window.logout = logout;

// Admins get a link across to the broadcast control page.
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    if (s.role === 'admin') $('nav-control').hidden = false;
  })
  .catch(() => {});

loadTeams();
loadMatches();
setInterval(() => {
  if (!editor || !editor.dirty) loadMatches(); // pick up fixtures other people add
}, 20000);
connectWebSocket();
