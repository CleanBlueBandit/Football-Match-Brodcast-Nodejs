require('dotenv').config();

// Vercel Prisma Postgres integration creates these variables.
// Normalize them so the rest of the application can keep using
// the normal DATABASE_URL / POSTGRES_URL names.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    process.env.db_DATABASE_URL ||
    process.env.db_PRISMA_DATABASE_URL ||
    process.env.db_POSTGRES_URL;
}

if (!process.env.POSTGRES_URL) {
  process.env.POSTGRES_URL =
    process.env.db_POSTGRES_URL ||
    process.env.db_DATABASE_URL ||
    process.env.db_PRISMA_DATABASE_URL;
}

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');

const pool = require('./db/pool');
const { setupWebSocket } = require('./ws');
const requireAuth = require('./middleware/auth');
const authRoutes = require('./routes/auth');

const PgSession = pgSessionFactory(session);

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'session',
    }),

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

app.get('/login.html', (req, res) => {
  if (req.session.loggedin) {
    return res.redirect('/control.html');
  }

  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/control.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/', (req, res) => {
  res.redirect(
    req.session.loggedin ? '/control.html' : '/login.html'
  );
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
  })
);

// Keep your existing WebSocket setup.
setupWebSocket(server);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Broadcast control server listening on port ${PORT}`);
});
