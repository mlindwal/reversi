// Rules for an online game room, kept free of Cloudflare APIs so they can be
// tested in Node. The Durable Object in index.js stores the game and handles
// the connections; everything it decides comes from here.
//
// A room's stored game looks like
//   { g: game number, moves: "d3c5...", seats: { b: tokenHash | null, w: ... } }
// where a seat holds the SHA-256 hash of the secret token given to the player
// in it, so the server never stores the tokens themselves.

import Reversi from '../docs/game.js';

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const SQUARE_PATTERN = /^[a-h][1-8]$/;
const SIDES = ['b', 'w'];

export function createGame() {
  return { g: 0, moves: '', seats: { b: null, w: null } };
}

export function colorOf(side) {
  return side === 'b' ? Reversi.BLACK : Reversi.WHITE;
}

export function sideOf(color) {
  return color === Reversi.BLACK ? 'b' : 'w';
}

// Validates a message from a browser. Returns a clean copy, or null.
export function parseClientMessage(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  switch (data.type) {
    case 'hello':
      if (data.token === undefined || data.token === null) return { type: 'hello', token: null };
      return typeof data.token === 'string' && TOKEN_PATTERN.test(data.token)
        ? { type: 'hello', token: data.token }
        : { type: 'hello', token: null };
    case 'move':
      return Number.isInteger(data.g) && data.g >= 0 &&
        typeof data.square === 'string' && SQUARE_PATTERN.test(data.square)
        ? { type: 'move', g: data.g, square: data.square }
        : null;
    case 'claim':
      return SIDES.includes(data.side) ? { type: 'claim', side: data.side } : null;
    case 'newGame':
      return { type: 'newGame' };
    default:
      return null;
  }
}

// The seat a token (by its hash) belongs to, or null.
export function seatForToken(game, tokenHash) {
  if (!tokenHash) return null;
  return SIDES.find((side) => game.seats[side] === tokenHash) || null;
}

// The seat a newcomer gets: Black first (the player who created the room),
// then White. Seats that were ever taken are never handed out automatically.
export function unassignedSeat(game) {
  return SIDES.find((side) => !game.seats[side]) || null;
}

// A watcher may take a seat that nobody holds, or whose player is offline
// (for example, a player coming back on another device).
export function canClaim(game, side, onlineSides) {
  return !game.seats[side] || !onlineSides.has(side);
}

export function assignSeat(game, side, tokenHash) {
  return { ...game, seats: { ...game.seats, [side]: tokenHash } };
}

// Plays `square` for the player in `side`. Returns { game } or { error }.
export function applyMove(game, side, g, square) {
  if (g !== game.g) return { error: 'A new game has started.' };
  const current = Reversi.replay(Reversi.decodeMoves(game.moves) || []);
  if (current.gameOver) return { error: 'The game is over.' };
  if (sideOf(current.current) !== side) return { error: 'It isn\'t your turn.' };
  const next = Reversi.replay(current.moves.concat(square));
  if (next.error) return { error: 'That move isn\'t legal.' };
  return { game: { ...game, moves: Reversi.encodeMoves(next.moves) } };
}

export function startNewGame(game) {
  return { ...game, g: game.g + 1, moves: '' };
}

// What every browser in the room is told after each change.
export function publicState(game, onlineSides, watchers) {
  const seat = (side) => ({ taken: Boolean(game.seats[side]), online: onlineSides.has(side) });
  return {
    type: 'state',
    g: game.g,
    moves: game.moves,
    seats: { b: seat('b'), w: seat('w') },
    watchers
  };
}
