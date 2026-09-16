// Equivalent to auth_lock.php: guards a route so it can only be
// reached by a session with loggedin === true.
module.exports = function requireAuth(req, res, next) {
  if (req.session && req.session.loggedin === true) {
    return next();
  }

  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  return res.redirect('/login.html');
};
