const test = require('node:test');
const assert = require('node:assert');

let L;
test.before(async () => {
  L = await import('../server/logic.js');
});

const TOKEN = 'a'.repeat(32);

test('parses valid client messages and rejects everything else', () => {
  assert.deepStrictEqual(L.parseClientMessage('{"type":"hello"}'), { type: 'hello', token: null });
  assert.deepStrictEqual(L.parseClientMessage(JSON.stringify({ type: 'hello', token: TOKEN })),
    { type: 'hello', token: TOKEN });
  // A malformed token is treated as no token rather than an error.
  assert.deepStrictEqual(L.parseClientMessage('{"type":"hello","token":"nope"}'), { type: 'hello', token: null });
  assert.deepStrictEqual(L.parseClientMessage('{"type":"move","g":0,"square":"d3"}'),
    { type: 'move', g: 0, square: 'd3' });
  assert.deepStrictEqual(L.parseClientMessage('{"type":"claim","side":"w"}'), { type: 'claim', side: 'w' });
  assert.deepStrictEqual(L.parseClientMessage('{"type":"newGame","extra":1}'), { type: 'newGame' });
  for (const bad of ['not json', 'null', '[]', '{"type":"move","g":0,"square":"z9"}',
    '{"type":"move","g":-1,"square":"d3"}', '{"type":"move","g":1.5,"square":"d3"}',
    '{"type":"claim","side":"x"}', '{"type":"ping"}', '{"type":"__proto__"}']) {
    assert.strictEqual(L.parseClientMessage(bad), null, bad);
  }
});

test('hands out Black, then White, then nothing; finds seats by token hash', () => {
  let game = L.createGame();
  assert.strictEqual(L.unassignedSeat(game), 'b');
  game = L.assignSeat(game, 'b', 'hash-b');
  assert.strictEqual(L.unassignedSeat(game), 'w');
  game = L.assignSeat(game, 'w', 'hash-w');
  assert.strictEqual(L.unassignedSeat(game), null);
  assert.strictEqual(L.seatForToken(game, 'hash-w'), 'w');
  assert.strictEqual(L.seatForToken(game, 'hash-x'), null);
  assert.strictEqual(L.seatForToken(game, null), null);
});

test('a seat can be claimed only when free or its player is offline', () => {
  const game = L.assignSeat(L.createGame(), 'b', 'hash-b');
  assert.strictEqual(L.canClaim(game, 'w', new Set(['b'])), true);
  assert.strictEqual(L.canClaim(game, 'b', new Set(['b'])), false);
  assert.strictEqual(L.canClaim(game, 'b', new Set()), true);
});

test('moves are checked for game number, turn and legality', () => {
  const game = L.createGame();
  assert.deepStrictEqual(L.applyMove(game, 'b', 0, 'd3').game.moves, 'd3');
  assert.match(L.applyMove(game, 'w', 0, 'd3').error, /your turn/);
  assert.match(L.applyMove(game, 'b', 0, 'a1').error, /legal/);
  assert.match(L.applyMove(game, 'b', 1, 'd3').error, /new game/);

  const after = L.applyMove(game, 'b', 0, 'd3').game;
  assert.strictEqual(L.applyMove(after, 'w', 0, 'c5').game.moves, 'd3c5');
});

test('turns follow passes, and a finished game takes no more moves', () => {
  // Play a whole game, always taking the first legal move, through the logic.
  const R = require('../docs/game.js');
  let game = L.createGame();
  for (let i = 0; i < 70; i++) {
    const state = R.replay(R.decodeMoves(game.moves));
    if (state.gameOver) break;
    const move = R.getValidMoves(state.board, state.current)[0];
    const result = L.applyMove(game, L.sideOf(state.current), 0, R.toNotation(move.row, move.col));
    assert.ok(result.game, result.error);
    game = result.game;
  }
  assert.ok(R.replay(R.decodeMoves(game.moves)).gameOver);
  assert.match(L.applyMove(game, 'b', 0, 'a1').error, /over/);
});

test('a new game keeps the seats and clears the moves', () => {
  const game = { g: 3, moves: 'd3c5', seats: { b: 'x', w: 'y' } };
  assert.deepStrictEqual(L.startNewGame(game), { g: 4, moves: '', seats: { b: 'x', w: 'y' } });
});

test('the public state never includes seat hashes', () => {
  const game = { g: 1, moves: 'd3', seats: { b: 'secret-b', w: null } };
  const state = L.publicState(game, new Set(['b']), 2);
  assert.deepStrictEqual(state, {
    type: 'state', g: 1, moves: 'd3',
    seats: { b: { taken: true, online: true }, w: { taken: false, online: false } },
    watchers: 2
  });
  assert.ok(!JSON.stringify(state).includes('secret'));
});
