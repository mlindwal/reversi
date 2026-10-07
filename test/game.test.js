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

test('notation round-trips and matches standard opening squares', () => {
  assert.strictEqual(R.toNotation(0, 0), 'a1');
  assert.strictEqual(R.toNotation(7, 7), 'h8');
  assert.deepStrictEqual(R.fromNotation('d3'), { row: 2, col: 3 });
  assert.strictEqual(R.fromNotation('i9'), null);
  const opening = R.getValidMoves(R.createBoard(), R.BLACK).map((m) => R.toNotation(m.row, m.col));
  assert.deepStrictEqual(opening.sort(), ['c4', 'd3', 'e6', 'f5']);
});

test('decodeMoves and encodeMoves', () => {
  assert.deepStrictEqual(R.decodeMoves('d3c5'), ['d3', 'c5']);
  assert.deepStrictEqual(R.decodeMoves(''), []);
  assert.strictEqual(R.decodeMoves('d3c'), null);
  assert.strictEqual(R.decodeMoves('d3z9'), null);
  assert.strictEqual(R.encodeMoves(['d3', 'c5']), 'd3c5');
});

test('replay tracks turns, players and illegal moves', () => {
  const game = R.replay(['d3', 'c5', 'f6']);
  assert.strictEqual(game.error, null);
  assert.deepStrictEqual(game.players, [R.BLACK, R.WHITE, R.BLACK]);
  assert.strictEqual(game.current, R.WHITE);
  assert.deepStrictEqual(game.lastMove, { row: 5, col: 5 });

  const bad = R.replay(['d3', 'a1', 'c5']);
  assert.match(bad.error, /Move 2 \(a1\)/);
  assert.deepStrictEqual(bad.moves, ['d3']);
});

test('replay of a full game matches playing it move by move, including passes', () => {
  for (let g = 0; g < 5; g++) {
    const board = R.createBoard();
    let player = R.BLACK;
    const moves = [];
    while (!R.isGameOver(board)) {
      const move = R.chooseMove(board, player, 1);
      if (move) {
        R.applyMove(board, move.row, move.col, player);
        moves.push(R.toNotation(move.row, move.col));
      }
      player = R.opponent(player);
    }
    const game = R.replay(moves);
    assert.strictEqual(game.error, null);
    assert.ok(game.gameOver);
    assert.deepStrictEqual(game.board, board);
  }
});

test('nextTurn passes when the opponent has no move', () => {
  const board = R.createBoard().map((row) => row.map(() => R.EMPTY));
  board[0][0] = R.WHITE;
  board[0][1] = R.BLACK;
  // Black cannot outflank anything, but white can play c1.
  assert.deepStrictEqual(R.nextTurn(board, R.WHITE), { current: R.WHITE, passed: R.BLACK, gameOver: false });
  board[0][2] = R.WHITE;
  board[0][1] = R.WHITE;
  assert.strictEqual(R.nextTurn(board, R.WHITE).gameOver, true);
});
