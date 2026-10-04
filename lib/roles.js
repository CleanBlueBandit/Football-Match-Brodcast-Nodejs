// Single source of truth for who may do what. Everything that enforces access
// (HTTP routes, page guards and the WebSocket command handler) reads from here.
//
//   admin        everything
//   broadcaster  /control: the live broadcast (graphics, clock, events, start/end match)
//   statistician /stats:   live + past/future match and player stats, Excel export
//   viewer       the broadcast output (/tv.html) only
const ROLES = ['admin', 'broadcaster', 'statistician', 'viewer'];

// Permissions, each granted to a set of roles. admin is added to every set by can().
const PERMISSIONS = {
  'broadcast:control': ['broadcaster'], // operate the live broadcast
  'stats:manage': ['statistician'], // correct stats, schedule matches, export Excel
  'matches:read': ['broadcaster', 'statistician'], // list fixtures (broadcaster needs it to start one)
};

function isRole(role) {
  return ROLES.includes(role);
}

function can(role, permission) {
  if (!isRole(role)) return false;
  if (role === 'admin') return true;
  return (PERMISSIONS[permission] || []).includes(role);
}

// Where each role lands after login / on "/".
function homeFor(role) {
  switch (role) {
    case 'admin':
    case 'broadcaster':
      return '/control';
    case 'statistician':
      return '/stats';
    default:
      return '/tv.html';
  }
}

// WebSocket commands -> permission needed. A command that isn't listed here is
// rejected, so a new command is locked down until someone decides who may use it.
const COMMAND_PERMISSIONS = {
  // Broadcast operation
  startMatch: 'broadcast:control',
  endMatch: 'broadcast:control',
  toggleTimer: 'broadcast:control',
  resetTimer: 'broadcast:control',
  updateStat: 'broadcast:control', // added time + formations only
  setTeamName: 'broadcast:control',
  addPlayer: 'broadcast:control',
  removePlayer: 'broadcast:control',
  triggerGoal: 'broadcast:control',
  triggerCard: 'broadcast:control',
  triggerSub: 'broadcast:control',
  hideOverlay: 'broadcast:control',
  toggleOverlay: 'broadcast:control',
  triggerVarCheck: 'broadcast:control',
  showVarVerdict: 'broadcast:control',
  clearVarGraphic: 'broadcast:control',
  quickRefCall: 'broadcast:control',
  // Statistics (live match)
  modScore: 'stats:manage',
  setTeamStat: 'stats:manage', // team fouls
  updatePossession: 'stats:manage',
  adjustPlayerStat: 'stats:manage',
};

function canRunCommand(role, action) {
  const permission = COMMAND_PERMISSIONS[action];
  return !!permission && can(role, permission);
}

module.exports = { ROLES, PERMISSIONS, COMMAND_PERMISSIONS, isRole, can, canRunCommand, homeFor };
