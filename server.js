require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const { prisma, pool } = require('./db/prisma');
const { setupWebSocket, flushState } = require('./ws');
const { importStandings } = require('./db/importStandings');
const { importSchedule } = require('./db/importSchedule');
const { requirePermission, isLoggedIn } = require('./middleware/auth');
const { homeFor } = require('./lib/roles');
const authRoutes = require('./routes/auth');
const exportRoutes = require('./routes/export');
const matchRoutes = require('./routes/matches');
const { cwd } = require('process');

const PgSession = pgSessionFactory(session);


const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));



const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax', 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8,
  },
});
app.use(sessionMiddleware);

app.use('/api', authRoutes);
app.use('/api', exportRoutes);
app.use('/api', matchRoutes);


app.get('/login', (req, res) => {
  if (isLoggedIn(req)) return res.redirect(homeFor(req.session.role));
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/control', requirePermission('broadcast:control'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'control.html'));
});

app.get('/stats', requirePermission('stats:manage'), (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'stats.html'));
});

// Old bookmarks / links.
app.get('/control.html', (req, res) => res.redirect('/control'));
app.get('/stats.html', (req, res) => res.redirect('/stats'));

app.get('/', (req, res) => {
  res.redirect(isLoggedIn(req) ? homeFor(req.session.role) : '/login');
});

app.get('/src/background.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'background.jpg'));
})

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;

async function start() {

  for (const [label, run] of [['Standings', importStandings], ['Schedule', importSchedule]]) {
    try {
      await run();
    } catch (err) {
      console.error(`${label} import failed:`, err.message);
    }
  }


  await setupWebSocket(server, sessionMiddleware);
  server.listen(PORT, () => {
    console.log(`Broadcast control server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});

async function shutdown() {
  console.log("Server shutdown at" + new Date().toLocaleString());
  await flushState();
  server.close();
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.once('SIGUSR2', async () => {
  await flushState();
  process.kill(process.pid, 'SIGUSR2');
});
process.on('SIGINT', shutdown);
