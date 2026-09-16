# Broadcast Control Panel — Node.js / Express / PostgreSQL / WebSockets

A port of the original PHP + MySQL + flat-file (`state.json`) app to:

- **Express** for routing, sessions, and auth
- **PostgreSQL** for users, request/login logging, and persisted app state
- **WebSockets** (`ws`) for real-time state sync, replacing `save_state.php`'s
  file-write-and-poll approach

## What maps to what

| Old (PHP) | New (Node) |
|---|---|
| `db.php` (mysqli connect) | `db/pool.js` (`pg` Pool) |
| `auth_lock.php` | `middleware/auth.js` (`requireAuth`) |
| `logger.php` (appends to `visitor_logs.txt`) | `middleware/requestLogger.js` (writes to `request_logs` table) |
| `index.php` / `login.php` (login form + `login.log`) | `routes/auth.js` (`POST /api/login`, writes to `login_events` table) |
| `logout.php` | `routes/auth.js` (`POST /api/logout`) |
| `save_state.php` → `state.json` | `ws/index.js` — in-memory authoritative state, debounced write-through to the `app_state` table, broadcast to every connected WebSocket client |
| `control.php` + `script.js` (control panel) | `public/control.html` + `public/script.js`, driven entirely by WebSocket messages |
| `tv.html` / `tv.css` / `tv.js` (the actual broadcast output/overlay page) | `public/tv.html` / `public/tv.css` / `public/tv.js`, unchanged visually, now fed by the same WebSocket feed as the control panel instead of polling `state.json` every second |
| PHP `$_SESSION` | `express-session` + `connect-pg-simple` (sessions stored in Postgres, not memory, so they survive restarts/multiple instances) |

## The TV / broadcast output page

`public/tv.html` is the page you point an OBS Browser Source (or any browser)
at — it renders the scorebug and all the lower-thirds/overlays. It is served
at `GET /tv.html`, **unauthenticated**, same as the original (OBS can't do a
login flow, and nothing in the old code protected it either). If you need to
restrict who can load it, put it behind a reverse-proxy IP allowlist or a
shared-secret query param — that's not built in.

`tv.js` no longer polls `state.json` once a second. It opens the same
`ws(s)://<host>/ws` WebSocket the control panel uses, gets pushed a fresh
`state` message the instant anything changes, and re-renders immediately —
so goal graphics, cards, VAR verdicts, etc. appear on the output with no
polling delay.

**Shared state schema.** The authoritative state object in `ws/index.js` was
rewritten to match the actual shape `tv.js` expects (`state.match.*`,
nested `overlays.goal/card/sub/var` objects with a `visible` flag, plus
`goals` and `table` arrays) — this is different, and more complete, than the
placeholder schema used in an earlier version of this port. `control.html`'s
buttons and `tv.html`'s rendering now agree on one shape end-to-end.

**Bug fix carried over on purpose:** the original control panel's "Penalty"
button called `quickRefCall('penalty')`, but `tv.js`'s renderer only ever
checked `overlays.penaltyCall` — so on the real site that button silently did
nothing. `ws/index.js` normalizes `'penalty'` → `'penaltyCall'` so the button
now actually shows the penalty graphic.

**Seed data.** The original `tv.js` fetched `standings.json` and
`players.json` from the client on every page load just to write them into
shared state. That's now done once, server-side, the first time `app_state`
is created (see `seedFromFiles()` in `ws/index.js`) — edit
`public/standings.json` / `public/players.json` before first run if you want
different starting data, or just add players from the control panel's "Team
Setup" section afterward.

## Setup

```bash
cd broadcast-control-node
npm install
cp .env.example .env   # fill in your real Postgres credentials + a random SESSION_SECRET
npm run migrate        # applies db/schema.sql
npm start
```

Server listens on `http://localhost:3000` (or `$PORT`).

## Creating a user

The old MySQL `users` table (`id`, `username`, `password` as a bcrypt hash from
PHP's `password_hash()`) maps directly to the new `users` table
(`id`, `username`, `password_hash`). You can either:

1. **Reuse existing hashes** — dump the old `users` table and `INSERT` the rows
   directly into Postgres's `users` table. PHP's `password_hash()` produces
   `$2y$` bcrypt hashes; `routes/auth.js` normalizes `$2y$` to `$2a$` before
   comparing, since Node's bcrypt implementations expect that prefix. No
   re-hashing needed.
2. **Create a fresh user** with Node:

   ```js
   const bcrypt = require('bcryptjs');
   const pool = require('./db/pool');

   (async () => {
     const hash = await bcrypt.hash('your-password', 10);
     await pool.query(
       'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
       ['your-username', hash]
     );
     await pool.end();
   })();
   ```

## Real-time state (replaces `state.json`)

Instead of the browser POSTing a full JSON blob to `save_state.php` and some
other reader (e.g. an OBS browser source) polling `state.json`, everything
now goes over one WebSocket endpoint: `ws(s)://<host>/ws`.

- On connect, the server immediately sends the current state:
  `{ "type": "state", "state": { ... } }`
- The control panel sends small commands:
  `{ "type": "command", "action": "modScore", "team": "home", "delta": 1 }`
- The server applies the command, persists it to the `app_state` table
  (debounced 500ms so rapid clicks don't spam Postgres), and rebroadcasts the
  full state to **every** connected client — so multiple control tabs (or an
  overlay page you build later) stay in sync instantly, with no polling.
- The match clock is authoritative on the server: a single `setInterval`
  increments `timer.seconds` and broadcasts once per second while running,
  so all clients see identical time regardless of local clock drift.

See `ws/index.js` for the full list of supported `action` values — they
correspond 1:1 with the button handlers already wired up in
`public/control.html` / `public/script.js` (`modScore`, `toggleTimer`,
`triggerGoal`, `triggerCard`, `triggerSub`, `toggleOverlay`,
`triggerVarCheck`, `quickRefCall`, `addPlayer`, `removePlayer`,
`setTeamName`, etc.), and `public/tv.js` renders every field of the
resulting state on the broadcast output page.

## Database schema

See `db/schema.sql`. Tables:

- `users` — login credentials
- `login_events` — replaces `login.log` (success/failure, username, message, IP)
- `request_logs` — replaces `visitor_logs.txt` (per-request IP, UA, referer, etc.)
- `app_state` — single-row JSONB blob, replaces `state.json`
- `session` — required by `connect-pg-simple` for server-side session storage

