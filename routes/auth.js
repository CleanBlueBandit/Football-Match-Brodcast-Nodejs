const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { isRole, homeFor } = require('../lib/roles');

const router = express.Router();

function getVisitorIP(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'UNKNOWN';
}

// Strip newlines the same way login.php's $sanitize() closure did,
// to prevent log injection.
function sanitize(val) {
  return String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
}

async function logLoginEvent(username, success, message, ip) {
  try {
    await prisma.loginEvent.create({
      data: { username: sanitize(username), success, message: sanitize(message), ip },
    });
  } catch (err) {
    console.error('Login log error:', err.message);
  }
}

// PHP's password_hash() produces bcrypt hashes prefixed with $2y$.
// The Node `bcryptjs` (and native `bcrypt`) libraries expect the
// $2a$/$2b$ prefix, so normalize before comparing. If you are
// generating new hashes from Node, this is a no-op.
function normalizeBcryptHash(hash) {
  return hash.startsWith('$2y$') ? '$2a$' + hash.slice(4) : hash;
}

router.post('/login', async (req, res) => {
  const username = trimOrEmpty(req.body.username);
  const password = req.body.password || '';
  const ip = getVisitorIP(req);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, passwordHash: true, role: true },
    });

    if (!user) {
      const msg = 'No account found with that username.';
      await logLoginEvent(username, false, msg, ip);
      return res.status(401).json({ error: msg });
    }

    const { id, passwordHash, role } = user;
    const match = await bcrypt.compare(password, normalizeBcryptHash(passwordHash));

    if (!match) {
      const msg = 'Invalid password.';
      await logLoginEvent(username, false, msg, ip);
      return res.status(401).json({ error: msg });
    }

    req.session.loggedin = true;
    req.session.userId = id;
    req.session.username = username;
    req.session.role = role;

    await logLoginEvent(username, true, `User ID: ${id}, role: ${role}`, ip);
    res.json({ status: 'ok', role, redirect: homeFor(role) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ status: 'ok', redirect: '/login' });
  });
});

router.get('/session', (req, res) => {
  const loggedin = !!(req.session && req.session.loggedin && isRole(req.session.role));
  res.json({
    loggedin,
    username: loggedin ? req.session.username || null : null,
    role: loggedin ? req.session.role : null,
  });
});

function trimOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

module.exports = router;
