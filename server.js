require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const { prisma, pool } = require('./db/prisma');
const { setupWebSocket } = require('./ws');
const { importStandings } = require('./db/importStandings');
const requireAuth = require('./middleware/auth');
const authRoutes = require('./routes/auth');

const PgSession = pgSessionFactory(session);

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));



app.use(
  session({
    store: new PgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use('/api', authRoutes);





app.get('/login', (req, res) => {
  if (req.session.loggedin) return res.redirect('/control');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/control', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/', (req, res) => {
  res.redirect(req.session.loggedin ? '/control.html' : '/login');
});

app.get('/src/background.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'background.jpg'));
})

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;

async function start() {
  // Load standings from the JSON file into Postgres before the websocket layer
  // reads the teams table. A bad or missing file must not stop the server.
  try {
    await importStandings();
  } catch (err) {
    console.error('Standings import failed (continuing without it):', err);
  }

  setupWebSocket(server);
  server.listen(PORT, () => {
    console.log(`Broadcast control server listening on port ${PORT}`);
  });
}

start();

async function shutdown() {
  server.close();
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
