const test = require('node:test');
const assert = require('node:assert');
const R = require('../game.js');

test('initial board has four discs and four moves for black', () => {
  const board = R.createBoard();
  assert.deepStrictEqual(R.countDiscs(board), { black: 2, white: 2 });
  const moves = R.getValidMoves(board, R.BLACK).map((m) => [m.row, m.col]);
  assert.deepStrictEqual(moves, [[2, 3], [3, 2], [4, 5], [5, 4]]);
});

test('applyMove flips outflanked discs and rejects illegal moves', () => {
  const board = R.createBoard();
  assert.strictEqual(R.applyMove(board, 0, 0, R.BLACK), null);
  const flips = R.applyMove(board, 2, 3, R.BLACK);
  assert.deepStrictEqual(flips, [[3, 3]]);
  assert.strictEqual(board[3][3], R.BLACK);
  assert.deepStrictEqual(R.countDiscs(board), { black: 4, white: 1 });
});

test('flips in multiple directions at once', () => {
  const board = R.createBoard().map((row) => row.map(() => R.EMPTY));
  board[0][0] = R.BLACK;
  board[1][1] = R.WHITE;
  board[2][0] = R.BLACK;
  board[2][1] = R.WHITE;
  const flips = R.applyMove(board, 2, 2, R.BLACK);
  assert.strictEqual(flips.length, 2);
  assert.strictEqual(board[1][1], R.BLACK);
  assert.strictEqual(board[2][1], R.BLACK);
});

test('game over when neither player can move', () => {
  const board = R.createBoard().map((row) => row.map(() => R.BLACK));
  assert.ok(R.isGameOver(board));
  assert.ok(!R.isGameOver(R.createBoard()));
});

test('computer takes an available corner', () => {
  // Opening position plus an edge pair that lets white capture the a1 corner.
  const board = R.createBoard();
  board[0][1] = R.BLACK;
  board[0][2] = R.WHITE;
  for (const depth of [1, 3, 5]) {
    // chooseMove breaks ties randomly, so repeat to make sure it isn't luck.
    for (let i = 0; i < 20; i++) {
      assert.deepStrictEqual(R.chooseMove(board, R.WHITE, depth), { row: 0, col: 0 });
    }
  }
});

test('full computer-vs-computer games always end legally', () => {
  for (let g = 0; g < 5; g++) {
    const board = R.createBoard();
    let player = R.BLACK;
    let turns = 0;
    while (!R.isGameOver(board)) {
      const move = R.chooseMove(board, player, g % 2 ? 1 : 3);
      if (move) assert.ok(R.applyMove(board, move.row, move.col, player));
      player = R.opponent(player);
      assert.ok(++turns < 200);
    }
    const c = R.countDiscs(board);
    assert.ok(c.black + c.white <= 64);
  }
});
