const { isRole, can, homeFor } = require('../lib/roles');

function isLoggedIn(req) {
  // Sessions created before roles existed have no role: treat them as logged
  // out so the user signs in again and picks one up.
  return !!(req.session && req.session.loggedin === true && isRole(req.session.role));
}

function deny(req, res, status, message, redirectTo) {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(status).json({ error: message });
  }
  return res.redirect(redirectTo);
}

// Equivalent to auth_lock.php: guards a route so it can only be reached by a
// logged-in session. Any role is accepted; use requirePermission for more.
function requireAuth(req, res, next) {
  if (isLoggedIn(req)) return next();
  return deny(req, res, 401, 'Not authenticated', '/login.html');
}

// Logged in AND allowed to do `permission` (see lib/roles.js).
// Wrong role: 403 for the API, a redirect to the user's own home page for pages.
function requirePermission(permission) {
  return function (req, res, next) {
    if (!isLoggedIn(req)) return deny(req, res, 401, 'Not authenticated', '/login.html');
    if (can(req.session.role, permission)) return next();
    return deny(req, res, 403, 'You do not have access to this', homeFor(req.session.role));
  };
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.requirePermission = requirePermission;
module.exports.isLoggedIn = isLoggedIn;
