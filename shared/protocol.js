// Multiplayer protocol constants shared by the browser client and the Node server.
// Transport: WebSocket, JSON messages of the form { t: '<type>', ...fields }.

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 20; // server snapshot / game-logic rate
export const SEND_HZ = 15; // client -> server state rate

export const LIMITS = {
  maxPlayers: 12,
  nameLen: 16,
  chatLen: 120,
  maxSpeed: 115, // m/s; anything faster is treated as a teleport
  reconnectGrace: 60, // seconds a disconnected player keeps their slot
  warpCooldown: 8,
  worldHalf: 1150,
};

export const TEAMS = {
  red: { name: 'Red', color: '#ff4f4f' },
  blue: { name: 'Blue', color: '#4fa3ff' },
};

// Game modes. `teams`: 'never' | 'optional' | 'always'.
export const MODES = {
  cruise: { name: 'Party Cruise', icon: '🎉', teams: 'never', desc: 'Free roam together. Group power-ups spawn around the crew. Warp to friends, challenge them to duels.' },
  race: { name: 'Circuit Race', icon: '🏁', teams: 'optional', desc: 'Race on a Motorpark layout. Optional item crates. Team mode adds up finishing points.' },
  derby: { name: 'Destruction Derby', icon: '💥', teams: 'optional', desc: 'Crunch Bowl brawl. Last car running wins; ram, don\'t get rammed.' },
  pursuit: { name: 'Cops & Robbers', icon: '🚓', teams: 'always', desc: 'Robbers run, cops chase. Busted robbers join the cops. Survive the clock to win.' },
  hotpotato: { name: 'Hot Potato', icon: '💣', teams: 'never', desc: 'Someone has the bomb. Bump a friend to pass it before it goes off!' },
};
export const EVENT_MODES = ['race', 'derby', 'pursuit', 'hotpotato'];

// Group power-ups ("friendslop"). scope: who is affected.
export const POWERUPS = {
  nitro: { name: 'Group Nitro', icon: '🚀', scope: 'all', duration: 4, desc: 'Everyone gets a full nitro tank and a boost.' },
  moon: { name: 'Moon Gravity', icon: '🌙', scope: 'all', duration: 15, desc: 'Low gravity for the whole crew.' },
  bounce: { name: 'Party Bounce', icon: '🎈', scope: 'all', duration: 0, desc: 'Launches every car into the air.' },
  disco: { name: 'Disco Paint', icon: '🪩', scope: 'all', duration: 20, desc: 'Every car cycles through the rainbow.' },
  magnet: { name: 'Rally Magnet', icon: '🧲', scope: 'all', duration: 0, desc: 'Warps the whole crew next to whoever grabbed it.' },
  swap: { name: 'Swaparoo', icon: '🔄', scope: 'pair', duration: 0, desc: 'Swap places with a random player.' },
  giant: { name: 'Giant Mode', icon: '🦖', scope: 'self', duration: 15, desc: 'Become huge, heavy and unstoppable.' },
  slowmo: { name: 'Snail Trail', icon: '🐌', scope: 'others', duration: 8, desc: 'Everyone else is slowed down. Mischief!' },
  shield: { name: 'Bumper Shield', icon: '🛡️', scope: 'self', duration: 10, desc: 'Takes no derby damage.' },
  repair: { name: 'Repair Kit', icon: '🔧', scope: 'self', duration: 0, desc: 'Restores 40 health in the derby.' },
  boost: { name: 'Turbo', icon: '⚡', scope: 'self', duration: 3, desc: 'A big burst of speed.' },
};
// which power-ups can appear in each mode
export const POWERUP_POOLS = {
  cruise: ['nitro', 'moon', 'bounce', 'disco', 'magnet', 'swap', 'giant', 'slowmo'],
  race: ['boost', 'boost', 'nitro', 'slowmo', 'giant', 'bounce'],
  derby: ['shield', 'repair', 'giant', 'boost', 'bounce'],
  pursuit: ['boost', 'nitro', 'disco'],
  hotpotato: ['boost', 'moon', 'bounce', 'swap'],
};

export const EMOTES = ['👋', '😂', '🔥', '😱', '👑', '🐢', '💨', 'GG'];

// state flags packed into one integer
export const FLAG = { drift: 1, nitro: 2, brake: 4, air: 8, giant: 16, shield: 32 };

// Room codes avoid ambiguous characters
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
