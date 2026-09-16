const pool = require('../db/pool');

// Equivalent to getVisitorIP() in logger.php / login.php
function getVisitorIP(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf;

  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();

  return req.socket.remoteAddress || 'UNKNOWN';
}

// Equivalent to the logging block that used to run on every page load
// via `include 'logger.php'`. Writes one row per request instead of
// appending to visitor_logs.txt.
module.exports = function requestLogger(req, res, next) {
  const ip = getVisitorIP(req);
  const port = req.socket.remotePort ? String(req.socket.remotePort) : 'Unknown';
  const protocol = `HTTP/${req.httpVersion || '1.1'}`;
  const method = req.method;
  const uri = req.originalUrl;
  const referer = req.headers['referer'] || 'Direct / No Referer';
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const lang = req.headers['accept-language'] || 'Unknown';
  const queryData = req.query && Object.keys(req.query).length ? req.query : null;

  // Only field NAMES are logged for POST bodies, never values
  // (mirrors the "never log password values" comment in login.php).
  const bodyKeys = req.body && Object.keys(req.body).length
    ? Object.keys(req.body).join(', ')
    : 'None';

  pool.query(
    `INSERT INTO request_logs
       (ip, port, protocol, method, uri, referer, user_agent, lang, query_data, body_keys)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ip, port, protocol, method, uri, referer, userAgent, lang, queryData, bodyKeys]
  ).catch((err) => console.error('Request log error:', err.message));

  next();
};
