(function () {
  const FORMATIONS = {
    '4-3-3': [{ t: 85, l: 50 }, { t: 65, l: 15 }, { t: 65, l: 38 }, { t: 65, l: 62 }, { t: 65, l: 85 }, { t: 40, l: 20 }, { t: 40, l: 50 }, { t: 40, l: 80 }, { t: 15, l: 20 }, { t: 15, l: 50 }, { t: 15, l: 80 }],
    '4-4-2': [{ t: 85, l: 50 }, { t: 65, l: 15 }, { t: 65, l: 38 }, { t: 65, l: 62 }, { t: 65, l: 85 }, { t: 40, l: 12 }, { t: 40, l: 37 }, { t: 40, l: 63 }, { t: 40, l: 88 }, { t: 15, l: 35 }, { t: 15, l: 65 }],
    '3-5-2': [{ t: 85, l: 50 }, { t: 65, l: 25 }, { t: 65, l: 50 }, { t: 65, l: 75 }, { t: 40, l: 12 }, { t: 40, l: 31 }, { t: 40, l: 50 }, { t: 40, l: 69 }, { t: 40, l: 88 }, { t: 15, l: 35 }, { t: 15, l: 65 }],
    '5-4-1': [{ t: 85, l: 50 }, { t: 65, l: 10 }, { t: 65, l: 30 }, { t: 65, l: 50 }, { t: 65, l: 70 }, { t: 65, l: 90 }, { t: 40, l: 15 }, { t: 40, l: 38 }, { t: 40, l: 62 }, { t: 40, l: 85 }, { t: 15, l: 50 }],
  };

  let state = null;
  let socket = null;
  let reconnectDelay = 1000;

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.addEventListener('open', () => {
      reconnectDelay = 1000;
    });

    socket.addEventListener('close', () => {
      setTimeout(connectWebSocket, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    });

    socket.addEventListener('error', () => socket.close());

    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== 'state') return;

      state = sanitize(msg.state);
      renderTV();
    });
  }

  // The server (ws/index.js) sends:
  //   match.{homeTeam,awayTeam}  team ids        match.timer  seconds
  //   teams[], players[] (flat, with teamId), table[], goalHistory[]
  //   overlay: { visible, type, data }           (one overlay at a time)
  // The renderer below was written for a richer per-overlay shape, so convert
  // the server state into that shape here.
  function sanitize(s) {
    const m = s.match || {};
    const teams = s.teams || [];
    const players = s.players || [];
    const nameOf = (id) => (teams.find((t) => t.id === id) || {}).name || id || '';
    const side = (id) => players.filter((p) => p.teamId === id);
    const sum = (list, key) => list.reduce((n, p) => n + (p[key] || 0), 0);

    // A match is on screen once two teams are chosen (the final score stays
    // up after "End Match", same rule the control panel uses).
    const live = !!(m.homeTeam && m.awayTeam);

    const ov = s.overlay || {};
    const on = (type) => !!(ov.visible && ov.type === type);

    return {
      status: live ? 'live' : 'waiting',
      match: {
        homeTeam: nameOf(m.homeTeam),
        awayTeam: nameOf(m.awayTeam),
        homeScore: m.homeScore || 0,
        awayScore: m.awayScore || 0,
        homePossession: m.homePossession ?? 50,
        awayPossession: m.awayPossession ?? 50,
        homeFouls: sum(side(m.homeTeam), 'fouls'),
        awayFouls: sum(side(m.awayTeam), 'fouls'),
        homeFormation: '4-3-3',
        awayFormation: '4-3-3',
        time: m.timer || 0,
        addedTime: 0,
      },
      players: { home: side(m.homeTeam), away: side(m.awayTeam) },
      goals: (s.goalHistory || []).map((g) => ({
        team: g.side,
        scorer: g.playerName,
        // The server stores whole minutes; renderGoalHistory expects seconds.
        minute: (Number(g.minute) || 0) * 60,
      })),
      table: (s.table || []).map((r, i) => ({
        pos: i + 1,
        team: r.name,
        p: r.played,
        pts: r.points,
      })),
      overlays: {
        goal: { visible: false },
        card: { visible: false },
        sub: { visible: false },
        var: { visible: on('var'), phase: '', checkType: '', verdict: '' },
        possession: on('possession'),
        fouls: on('fouls'),
        formations: on('formations'),
        table: on('table'),
        offside: on('offside'),
        advantage: on('advantage'),
        penaltyCall: on('penalty') || on('penaltyCall'),
        handball: on('handball'),
        replay: on('replay'),
      },
    };
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // Goals are listed under the team they count for, so a self goal appears
  // in the column of the team that benefited.
  function renderGoalHistory(listId, side) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.textContent = '';
    const goals = (state.goals || []).filter((gEv) => gEv.team === side);
    if (goals.length === 0) {
      const li = document.createElement('li');
      li.className = 'gh-item gh-empty';
      li.textContent = 'No goals';
      list.appendChild(li);
      return;
    }
    goals.forEach((gEv) => {
      const li = document.createElement('li');
      li.className = 'gh-item';
      li.appendChild(document.createTextNode(gEv.scorer || 'Unknown'));
      const minute = document.createElement('span');
      minute.className = 'gh-minute';
      minute.textContent = Math.floor((Number(gEv.minute) || 0) / 60) + 1 + "'";
      li.appendChild(minute);
      list.appendChild(li);
    });
  }

  function renderPitch(containerId, formation, players, colorVar) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="center-spot"></div>';
    const positions = FORMATIONS[formation] || FORMATIONS['4-3-3'];
    positions.forEach((pos, idx) => {
      const dot = document.createElement('div');
      dot.className = 'player-dot';
      dot.style.top = pos.t + '%';
      dot.style.left = pos.l + '%';
      dot.style.background = colorVar;
      const pl = players[idx];
      dot.textContent = pl ? pl.number : idx + 1;
      if (pl) {
        const label = document.createElement('div');
        label.className = 'player-label';
        label.textContent = pl.name;
        dot.appendChild(label);
      }
      container.appendChild(dot);
    });
  }

  function renderTV() {
    // No live match: show the "match will begin soon" card, hide the broadcast.
    const live = state.status === 'live';
    document.getElementById('waiting-card').hidden = live;
    document.getElementById('broadcast').hidden = !live;
    if (!live) return;

    document.getElementById('sb-home-name').textContent = state.match.homeTeam;
    document.getElementById('sb-away-name').textContent = state.match.awayTeam;
    document.getElementById('sb-home-score').textContent = state.match.homeScore;
    document.getElementById('sb-away-score').textContent = state.match.awayScore;
    document.getElementById('sb-time').textContent = formatTime(state.match.time);

    const anyOverlayActive =
      (state.overlays.goal && state.overlays.goal.visible) ||
      state.overlays.possession ||
      state.overlays.fouls ||
      (state.overlays.card && state.overlays.card.visible) ||
      (state.overlays.sub && state.overlays.sub.visible) ||
      (state.overlays.var && state.overlays.var.visible) ||
      state.overlays.formations ||
      state.overlays.table ||
      state.overlays.offside ||
      state.overlays.advantage ||
      state.overlays.penaltyCall ||
      state.overlays.handball ||
      state.overlays.replay;

    let shrinkScorebug;
    if (state.match.addedTime > 0) {
      shrinkScorebug = anyOverlayActive;
    } else {
      shrinkScorebug =
        (state.overlays.var && state.overlays.var.visible) ||
        (state.overlays.card && state.overlays.card.visible) ||
        state.overlays.formations ||
        state.overlays.table ||
        state.overlays.offside ||
        state.overlays.advantage ||
        state.overlays.penaltyCall ||
        state.overlays.handball ||
        state.overlays.replay;
    }

    const scorebugEl = document.getElementById('scorebug');
    const homeScoreEl = document.getElementById('sb-home-score');
    const awayScoreEl = document.getElementById('sb-away-score');
    if (!shrinkScorebug) {
      scorebugEl.classList.add('scorebug-big');
      homeScoreEl.classList.add('scorebug-score-big');
      awayScoreEl.classList.add('scorebug-score-big');
    } else {
      scorebugEl.classList.remove('scorebug-big');
      homeScoreEl.classList.remove('scorebug-score-big');
      awayScoreEl.classList.remove('scorebug-score-big');
    }

    const addEl = document.getElementById('sb-added');
    const externalTimeEl = document.getElementById('external-time');
    const externalAddedEl = document.getElementById('external-added');
    if (!anyOverlayActive && state.match.addedTime > 0) {
      addEl.style.display = 'none';
      externalTimeEl.style.display = 'flex';
      externalAddedEl.textContent = '+' + state.match.addedTime;
    } else {
      externalTimeEl.style.display = 'none';
      if (state.match.addedTime > 0) {
        addEl.textContent = '+' + state.match.addedTime;
        addEl.style.display = 'inline';
      } else {
        addEl.style.display = 'none';
      }
    }

    const g = document.getElementById('goal-overlay');
    if (state.overlays.goal.visible) {
      document.getElementById('g-title').textContent = 'GOAL!';
      document.getElementById('g-team').textContent = state.overlays.goal.team;
      document.getElementById('g-scorer').textContent =
        (state.overlays.goal.number ? '#' + state.overlays.goal.number + ' ' : '') + state.overlays.goal.scorer;
      document.getElementById('g-assist').textContent = state.overlays.goal.assist
        ? 'Assist: ' + (state.overlays.goal.assistNumber ? '#' + state.overlays.goal.assistNumber + ' ' : '') + state.overlays.goal.assist
        : '';
      g.classList.add('active');
    } else g.classList.remove('active');

    const p = document.getElementById('possession-overlay');
    if (state.overlays.possession) {
      document.getElementById('p-home').style.width = state.match.homePossession + '%';
      document.getElementById('p-away').style.width = state.match.awayPossession + '%';
      document.getElementById('p-home-text').textContent = state.match.homeTeam + ' ' + state.match.homePossession + '%';
      document.getElementById('p-away-text').textContent = state.match.awayPossession + '% ' + state.match.awayTeam;
      p.classList.add('active');
    } else p.classList.remove('active');

    const f = document.getElementById('fouls-overlay');
    if (state.overlays.fouls) {
      document.getElementById('f-home-name').textContent = state.match.homeTeam;
      document.getElementById('f-away-name').textContent = state.match.awayTeam;
      document.getElementById('f-home-val').textContent = state.match.homeFouls;
      document.getElementById('f-away-val').textContent = state.match.awayFouls;
      f.classList.add('active');
    } else f.classList.remove('active');

    const c = document.getElementById('card-overlay');
    if (state.overlays.card.visible) {
      document.getElementById('c-team').textContent = state.overlays.card.team;
      document.getElementById('c-player').textContent =
        (state.overlays.card.number ? '#' + state.overlays.card.number + ' ' : '') + state.overlays.card.player;
      document.getElementById('c-type').textContent = state.overlays.card.type + ' card';
      document.getElementById('c-icon').className = 'card-icon ' + (state.overlays.card.type === 'red' ? 'card-red' : 'card-yellow');
      c.classList.add('active');
    } else c.classList.remove('active');

    const s = document.getElementById('sub-overlay');
    if (state.overlays.sub.visible) {
      document.getElementById('s-out').textContent = (state.overlays.sub.outNumber ? '#' + state.overlays.sub.outNumber + ' ' : '') + state.overlays.sub.out;
      document.getElementById('s-in').textContent = (state.overlays.sub.inNumber ? '#' + state.overlays.sub.inNumber + ' ' : '') + state.overlays.sub.in;
      document.getElementById('s-team').textContent = state.overlays.sub.team;
      s.classList.add('active');
    } else s.classList.remove('active');

    const varEl = document.getElementById('var-overlay');
    if (state.overlays.var && state.overlays.var.visible) {
      varEl.classList.add('active');
      const varInner = document.getElementById('var-inner');
      const varMain = document.getElementById('var-main');
      const varSub = document.getElementById('var-sub');
      const checkType = state.overlays.var.checkType;
      const verdict = state.overlays.var.verdict;

      varInner.classList.remove('checking', 'verdict', 'confirmed', 'overturned');

      if (state.overlays.var.phase === 'checking') {
        varInner.classList.add('checking');
        if (varMain) varMain.textContent = 'VAR CHECK IN PROGRESS';
        if (varSub) varSub.textContent = 'Checking ' + (checkType || '');
      } else if (state.overlays.var.phase === 'verdict') {
        varInner.classList.add('verdict');
        if (varSub) varSub.textContent = checkType || '';

        switch (verdict) {
          case 'Offside':
            varMain.textContent = checkType === 'Goal' ? 'NO GOAL - OFFSIDE' : 'OFFSIDE';
            varInner.classList.add('overturned');
            break;
          case 'Foul':
            if (checkType === 'Goal') varMain.textContent = 'NO GOAL - FOUL';
            else if (checkType === 'Penalty') varMain.textContent = 'NO PENALTY - FOUL';
            else if (checkType === 'Red Card') {
              varMain.textContent = 'RED CARD CONFIRMED - FOUL';
              varInner.classList.add('confirmed');
            } else if (checkType === 'Foul') {
              varMain.textContent = 'FOUL CONFIRMED';
              varInner.classList.add('confirmed');
            } else varMain.textContent = 'FOUL';
            if (!varInner.classList.contains('confirmed')) varInner.classList.add('overturned');
            break;
          case 'No Penalty':
            varMain.textContent = checkType === 'Penalty' ? 'NO PENALTY' : 'OVERTURNED';
            varInner.classList.add(checkType === 'Penalty' ? 'confirmed' : 'overturned');
            break;
          case 'Overturned':
            varInner.classList.add('overturned');
            if (checkType === 'Goal') varMain.textContent = 'NO GOAL';
            else if (checkType === 'Penalty') varMain.textContent = 'NO PENALTY';
            else if (checkType === 'Red Card') varMain.textContent = 'NO RED CARD';
            else if (checkType === 'Identity') varMain.textContent = 'IDENTITY MISTAKE OVERTURNED';
            else if (checkType === 'Foul') varMain.textContent = 'NO FOUL';
            break;
          case 'Confirmed':
            varInner.classList.add('confirmed');
            if (checkType === 'Goal') varMain.textContent = 'GOAL CONFIRMED';
            else if (checkType === 'Penalty') varMain.textContent = 'PENALTY GIVEN';
            else if (checkType === 'Red Card') varMain.textContent = 'RED CARD CONFIRMED';
            else if (checkType === 'Identity') varMain.textContent = 'IDENTITY MISTAKE CONFIRMED';
            else if (checkType === 'Foul') varMain.textContent = 'FOUL CONFIRMED';
            break;
        }
      }
    } else {
      varEl.classList.remove('active');
    }

    const fm = document.getElementById('formations-overlay');
    if (state.overlays.formations) {
      document.getElementById('f-home-title').textContent = state.match.homeTeam;
      document.getElementById('f-away-title').textContent = state.match.awayTeam;
      renderPitch('formation-home', state.match.homeFormation, state.players.home, 'var(--home-color)');
      renderPitch('formation-away', state.match.awayFormation, state.players.away, 'var(--away-color)');
      fm.classList.add('active');
    } else fm.classList.remove('active');

    const t = document.getElementById('table-overlay');
    if (state.overlays.table) {
      const tBody = document.getElementById('table-body');
      if (tBody && state.table) {
        tBody.innerHTML = state.table
          .map((r) => `<tr><td>${r.pos}</td><td>${String(r.team).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</td><td>${r.p}</td><td>${r.pts}</td></tr>`)
          .join('');
      }
      t.classList.add('active');
    } else t.classList.remove('active');

    // Goal history is always visible; it just follows the goals list.
    document.getElementById('gh-home-team').textContent = state.match.homeTeam;
    document.getElementById('gh-away-team').textContent = state.match.awayTeam;
    renderGoalHistory('goal-history-home', 'home');
    renderGoalHistory('goal-history-away', 'away');

    document.getElementById('offside-overlay')?.classList.toggle('active', !!state.overlays.offside);
    document.getElementById('advantage-overlay')?.classList.toggle('active', !!state.overlays.advantage);
    document.getElementById('penalty-overlay')?.classList.toggle('active', !!state.overlays.penaltyCall);
    document.getElementById('handball-overlay')?.classList.toggle('active', !!state.overlays.handball);
    document.getElementById('replay-overlay')?.classList.toggle('active', !!state.overlays.replay);
  }

  connectWebSocket();
})();