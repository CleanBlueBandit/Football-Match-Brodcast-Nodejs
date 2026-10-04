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

## Roles and pages

Every account has one of four roles (`users.role`). Access is enforced on the
server: page routes, REST routes and every WebSocket command check the role
(`lib/roles.js` is the single place that says who may do what).

| Role | Can use | Notes |
|---|---|---|
| `viewer` | the broadcast output (`/tv.html`) | lands on `/tv.html` after login |
| `broadcaster` | `/control` - the live broadcast: clock, added time, formations, squads, goal/card/sub graphics, VAR and referee calls, overlay toggles, start/end match | cannot change the score, team fouls, possession or player stats by hand |
| `statistician` | `/stats` - live match stats, every past / upcoming match's stats, scheduling fixtures, **Download Excel** | cannot touch the broadcast (no clock, graphics, start/end) |
| `admin` | everything: `/control` and `/stats` (with links between them) | |

`/tv.html` stays public (an OBS Browser Source can't log in), so the "viewer"
role mostly matters for where a login lands and for what that login may *not* do.
Anonymous WebSocket connections (the TV page) can watch but never send commands.

**Broadcaster vs statistician, in the live match.** The broadcaster still
triggers the Goal and Card events (they show the graphic and, as before, count
the goal / record the card against the player). Everything manual about numbers
is the statistician's: **score +/-**, **team fouls**, **possession** and the
**Player Stats** +/- panel, all on `/stats`, applied live and shown on the TV
immediately.

**Past and upcoming matches.** Every match is a row in `matches` (scheduled →
live → finished). On `/stats` the statistician can:

- **schedule** a fixture (two teams, optional date/time), reschedule or delete it
  while it hasn't started;
- open **any upcoming or finished match** and edit its score, fouls, possession
  and every player's goals / assists / fouls / cards, then **Save**;
- see the live match in the same list (its controls are the live panel at the top).

Numbers entered for an upcoming match are kept and are loaded into the live
match when the broadcaster starts it (from the "Scheduled Matches" list on the
start menu; "Start a Match" with two teams still works for ad-hoc matches).

**Correcting a finished match fixes the league.** The league table and player
totals are kept as running totals, so a correction applies the *difference*
between the old and new numbers (a 2-1 win corrected to a 1-1 draw moves both
teams' points, goals and W/D/L, and moves the player totals) inside one
transaction. A match ended with "Record result" unticked is kept as a match
but never counts; the statistician can tick "Counts towards the league table"
later (or untick it) and the totals follow. Matches played before this version
have no row, so they can't be edited (their totals are the starting point).

Role changes take effect at the user's next login (the role is stored in the
session). Sessions created before this version have no role and are asked to
log in again.

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
- **Excel report:** the **Download Excel** button on the statistics page (or
  `GET /api/export.xlsx` as a statistician/admin) downloads a workbook with a `Teams` sheet
  (standings), a `Players` sheet (every player's season totals, grouped by team), a
  `Matches` sheet (every scheduled / live / finished match) and, while a match is
  live, `Current Match` and `Match Player Stats` sheets. Live match stats
  only reach the `Teams`/`Players` totals once the match is ended with the result saved.
- **Start match:** with no match running, the control page shows only a
  "Start a Match" menu (home team / away team). Starting loads both squads and
  team names and reveals the controls; scheduled fixtures are listed there too and
  start with one click. Match state (score, clock, overlays, goals) starts fresh,
  except for numbers a statistician already entered for that fixture.
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
  sends the player off. The +/- corrections themselves are made on the statistics
  page (statistician), not the control panel.
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
npm run register       # create a user (it asks for a role: admin / broadcaster / statistician / viewer)
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

Run `npm run register` and enter a username, a password and a role (`admin`,
`broadcaster`, `statistician` or `viewer`; Enter alone means `viewer`). It stores a
bcrypt hash in the `users` table via Prisma (re-running with the same username
resets the password and sets the role again).

**Upgrading:** the migration adds `users.role` and turns every account that
already exists into an `admin` (they had full access before), so nobody is locked
out; create the broadcaster / statistician accounts after migrating. Hashes from the old PHP app (`$2y$`) still work:
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

- `users` — login credentials and role
- `matches` / `match_player_stats` — every fixture (scheduled, live, finished) with its team stats and each player's numbers in it
- `login_events` — replaces `login.log` (success/failure, username, message, IP)
- `request_logs` — replaces `visitor_logs.txt` (per-request IP, UA, referer, etc.)
- `app_state` — single-row JSONB blob with the live match state (score, clock, overlays)
- `teams` / `players` — replace `data/league.json` (standings, squads, player totals)
- `session` — server-side session storage for `connect-pg-simple`
