const test = require('node:test');
const assert = require('node:assert');
const R = require('../docs/game.js');
const { resolveSync, findOpenSeat } = require('../docs/online.js');

// Local player is White; the opponent is Black.
const local = (g, moves) => ({ g, moves });
const remote = (g, moves) => ({ g, moves, side: 'b' });

test('adopts the opponent\'s new move', () => {
  const result = resolveSync(local(0, ['d3', 'c5']), remote(0, 'd3c5f6'), R.BLACK);
  assert.deepStrictEqual(result, { action: 'adopt', g: 0, moves: ['d3', 'c5', 'f6'] });
});

test('identical games need nothing; a stale opponent gets our version', () => {
  assert.strictEqual(resolveSync(local(0, ['d3']), remote(0, 'd3'), R.BLACK).action, 'same');
  assert.strictEqual(resolveSync(local(0, ['d3', 'c5']), remote(0, 'd3'), R.BLACK).action, 'ahead');
  assert.strictEqual(resolveSync(local(2, []), remote(1, 'd3c5f6'), R.BLACK).action, 'ahead');
});

test('rejects moves made on our behalf', () => {
  // d3 (black) then c5 would be white's move, but the opponent is black.
  const result = resolveSync(local(0, ['d3']), remote(0, 'd3c5'), R.BLACK);
  assert.strictEqual(result.action, 'reject');
  assert.match(result.reason, /moves you didn't make/);
});

test('catches up a player who joins late, as long as the opponent never moved for them', () => {
  // A fresh White player only accepts a game where black made all new moves.
  assert.strictEqual(resolveSync(local(0, []), remote(0, 'd3'), R.BLACK).action, 'adopt');
  assert.strictEqual(resolveSync(local(0, []), remote(0, 'd3c5f6'), R.BLACK).action, 'reject');
  // But someone reconnecting with the early moves already known catches up.
  assert.strictEqual(resolveSync(local(0, ['d3', 'c5']), remote(0, 'd3c5f6'), R.BLACK).action, 'adopt');
});

test('rejects illegal, malformed and diverged games', () => {
  assert.strictEqual(resolveSync(local(0, []), remote(0, 'a1'), R.BLACK).action, 'reject');
  assert.strictEqual(resolveSync(local(0, []), remote(0, 'zz'), R.BLACK).action, 'reject');
  assert.strictEqual(resolveSync(local(0, []), { g: -1, moves: '', side: 'b' }, R.BLACK).action, 'reject');
  assert.strictEqual(resolveSync(local(0, []), { g: 0, moves: 'd3', side: 'x' }, R.BLACK).action, 'reject');
  assert.strictEqual(resolveSync(local(0, []), null, R.BLACK).action, 'reject');
  const diverged = resolveSync(local(0, ['d3', 'c5']), remote(0, 'd3e3'), R.BLACK);
  assert.strictEqual(diverged.action, 'reject');
  assert.match(diverged.reason, /diverged/);
});

test('a new game from the opponent replaces ours', () => {
  const result = resolveSync(local(0, ['d3', 'c5', 'f6']), remote(1, ''), R.BLACK);
  assert.deepStrictEqual(result, { action: 'adopt', g: 1, moves: [] });
  // Black may already have made the first move of the new game.
  assert.strictEqual(resolveSync(local(0, ['d3', 'c5']), remote(1, 'f5'), R.BLACK).action, 'adopt');
});

test('a spectator accepts moves by either colour, but nothing illegal or older', () => {
  const spectator = local(0, ['d3']);
  assert.deepStrictEqual(resolveSync(spectator, remote(0, 'd3c5f6'), null),
    { action: 'adopt', g: 0, moves: ['d3', 'c5', 'f6'] });
  assert.strictEqual(resolveSync(spectator, remote(0, 'd3a1'), null).action, 'reject');
  assert.strictEqual(resolveSync(local(2, []), remote(1, 'd3'), null).action, 'ahead');
});

test('announcements from someone without a seat are valid', () => {
  const watcher = { side: null, g: 0, moves: '', opponent: false };
  assert.strictEqual(resolveSync(local(0, []), watcher, null).action, 'same');
  assert.strictEqual(resolveSync(local(0, []), { ...watcher, opponent: 'yes' }, null).action, 'reject');
});

test('findOpenSeat offers the free seat opposite a player without an opponent', () => {
  const black = { side: 'b', g: 0, moves: 'd3', opponent: false };
  const white = { side: 'w', g: 0, moves: 'd3', opponent: false };
  const watcher = { side: null, g: 0, moves: '', opponent: false };
  assert.deepStrictEqual(findOpenSeat([black]), { side: 'w', state: black });
  assert.deepStrictEqual(findOpenSeat([watcher, white]), { side: 'b', state: white });
});

test('findOpenSeat offers nothing when both seats are taken or nobody is playing', () => {
  const black = { side: 'b', g: 0, moves: '', opponent: true };
  const white = { side: 'w', g: 0, moves: '', opponent: true };
  assert.strictEqual(findOpenSeat([black, white]), null);
  // White is connected to black but we haven't heard from them yet.
  assert.strictEqual(findOpenSeat([black]), null);
  assert.strictEqual(findOpenSeat([{ side: null, g: 0, moves: '', opponent: false }]), null);
  assert.strictEqual(findOpenSeat([]), null);
});
