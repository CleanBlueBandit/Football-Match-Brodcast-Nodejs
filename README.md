# Broadcast Control Panel — Node.js / Express / Prisma / PostgreSQL / WebSockets

A port of the original PHP + MySQL + flat-file (`state.json`) app to:

- **Express** for routing, sessions, and auth
- **PostgreSQL via Prisma** for users, request/login logging, teams/players/standings, and persisted app state
- **WebSockets** (`ws`) for real-time state sync, replacing `save_state.php`'s
  file-write-and-poll approach

## What maps to what

| Old (PHP) | New (Node) |
|---|---|
| `db.php` (mysqli connect) | `db/prisma.js` (Prisma client on a shared `pg` pool, `db/pool.js`) |
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

## Matches, teams and standings

The app runs one match at a time, and you can run as many matches as you like
one after another.

- **Teams, squads and standings live in Postgres** (`teams` and `players`
  tables, managed by Prisma). Each team has `id` (a slug like `red-lions`),
  `name`, `played/won/drawn/lost/gf/ga/points`; each player has `number`,
  `name` and running totals. Add or edit teams and players with
  `npm run studio` (Prisma Studio) or by editing `prisma/seed/league.json` and
  running `npm run seed`. Changes are picked up between matches without a
  restart.
- **Standings import on startup:** every time the server starts it imports the
  standings and squads (the `teams` and `players` rows) from `prisma/seed/league.json` (override with
  `STANDINGS_FILE`). By default only teams and players that don't exist yet are created, so
  results and player stats recorded in live matches are never overwritten. Set
  `STANDINGS_IMPORT=overwrite` to reset standings and player stats to the file's values, or
  `STANDINGS_IMPORT=off` to disable it. You can also run it manually with
  `npm run import:standings [file] [-- --overwrite]`.
- **Start match:** with no match running, the control page shows only a
  "Start a Match" menu (home team / away team). Starting loads both squads and
  team names and reveals the controls. Match state (score, clock, overlays,
  goals) always starts fresh.
- **End match:** the button at the bottom of the controls (with a confirm
  dialog and a "Record result in the league table" checkbox) stops the clock,
  adds the result to the `teams` table (3 pts win / 1 draw) and returns every
  control tab to the start menu.
- **TV page:** while no match is live, `tv.html` shows a "The match will begin
  soon" card instead of the scorebug; it comes back automatically after a match
  ends.
- **Player stats:** every player in the `players` table has `goals`, `assists`,
  `fouls`, `yellow_cards` and `red_cards` (running totals). During a match they
  are tracked per player in a "Player Stats" panel: the Goal Event credits the
  scorer and assister, the Card Event credits a yellow or red card to the
  carded player, and the +/- buttons record fouls or correct mistakes.
  A card also counts as a foul: the Card Event adds one foul to the player and
  to the team's foul count, so you don't need to add it separately. Use the F
  buttons for fouls that weren't carded. A player foul always bumps the team's
  foul count; goals, assists and cards do not change the score. Two yellows are
  not turned into a red automatically; add the red yourself if the referee
  sends the player off.
  When the match ends with "Record result and player stats" ticked, the
  match's numbers are added onto each player's totals in the database;
  unticked, they are discarded. Shirt numbers must be unique within a team,
  and a player added from the control panel mid-match is added to the
  team's squad in the database if they recorded any stats.
- The league table overlay is derived from the `teams` table (sorted by points,
  goal difference, goals scored). Result and player totals are saved in a single
  transaction, so a failure can't leave half a result behind.

Match commands (`toggleTimer`, `modScore`, ...) are ignored by the server while
no match is live, and `startMatch` is ignored while one is.

## Setup

```bash
npm install            # also runs `prisma generate`
cp .env.example .env   # set DATABASE_URL + a random SESSION_SECRET
npm run migrate        # applies prisma/migrations (prisma migrate deploy)
npm run seed           # loads the sample teams/players from prisma/seed/league.json
npm run register       # create the admin user
npm start
```

Server listens on `http://localhost:3000` (or `$PORT`). For a local Postgres
without SSL, set `DB_SSL=false`. After changing `prisma/schema.prisma`, run
`npm run migrate:dev`.

**Upgrading from the JSON version:** `npm run migrate` adds the `teams` and
`players` tables. `npm run seed` imports the old `data/league.json` (now at
`prisma/seed/league.json`). If you already played matches, copy your current
standings/stats into that file *before* seeding (seeding only fills in missing
rows and never overwrites existing standings).

## Creating a user

Run `npm run register` and enter a username and password. It stores a bcrypt
hash in the `users` table via Prisma (re-running with the same username resets
the password). Hashes from the old PHP app (`$2y$`) still work:
`routes/auth.js` normalizes them to `$2a$` before comparing.

## Real-time state (replaces `state.json`)

Instead of the browser POSTing a full JSON blob to `save_state.php` and some
other reader (e.g. an OBS browser source) polling `state.json`, everything
now goes over one WebSocket endpoint: `ws(s)://<host>/ws`.

- On connect, the server immediately sends the current state:
  `{ "type": "state", "state": { ... } }`
- The control panel sends small commands:
  `{ "type": "command", "action": "modScore", "team": "home", "delta": 1 }`
- The server applies the command, persists it to the `app_state` table through Prisma
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

Defined in `prisma/schema.prisma`; SQL history in `prisma/migrations/`. Tables:

- `users` — login credentials
- `login_events` — replaces `login.log` (success/failure, username, message, IP)
- `request_logs` — replaces `visitor_logs.txt` (per-request IP, UA, referer, etc.)
- `app_state` — single-row JSONB blob with the live match state (score, clock, overlays)
- `teams` / `players` — replace `data/league.json` (standings, squads, player totals)
- `session` — server-side session storage for `connect-pg-simple`
