// Reversi game logic. No DOM access here so it can be reused and tested in Node.
(function (root) {
  'use strict';

  var SIZE = 8;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;

  var DIRECTIONS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1]
  ];

  // Positional weights used by the computer player: corners are valuable,
  // squares next to corners are risky.
  var WEIGHTS = [
    [100, -20, 10,  5,  5, 10, -20, 100],
    [-20, -50, -2, -2, -2, -2, -50, -20],
    [ 10,  -2,  1,  1,  1,  1,  -2,  10],
    [  5,  -2,  1,  0,  0,  1,  -2,   5],
    [  5,  -2,  1,  0,  0,  1,  -2,   5],
    [ 10,  -2,  1,  1,  1,  1,  -2,  10],
    [-20, -50, -2, -2, -2, -2, -50, -20],
    [100, -20, 10,  5,  5, 10, -20, 100]
  ];

  function opponent(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  function createBoard() {
    var board = [];
    for (var r = 0; r < SIZE; r++) {
      var row = [];
      for (var c = 0; c < SIZE; c++) row.push(EMPTY);
      board.push(row);
    }
    board[3][3] = WHITE;
    board[3][4] = BLACK;
    board[4][3] = BLACK;
    board[4][4] = WHITE;
    return board;
  }

  function cloneBoard(board) {
    return board.map(function (row) { return row.slice(); });
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  // Returns the list of [row, col] discs that would be flipped if `player`
  // placed a disc at (row, col). An empty list means the move is illegal.
  function getFlips(board, row, col, player) {
    if (!inBounds(row, col) || board[row][col] !== EMPTY) return [];
    var other = opponent(player);
    var flips = [];
    for (var d = 0; d < DIRECTIONS.length; d++) {
      var dr = DIRECTIONS[d][0];
      var dc = DIRECTIONS[d][1];
      var r = row + dr;
      var c = col + dc;
      var line = [];
      while (inBounds(r, c) && board[r][c] === other) {
        line.push([r, c]);
        r += dr;
        c += dc;
      }
      if (line.length > 0 && inBounds(r, c) && board[r][c] === player) {
        flips = flips.concat(line);
      }
    }
    return flips;
  }

  function getValidMoves(board, player) {
    var moves = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var flips = getFlips(board, r, c, player);
        if (flips.length > 0) moves.push({ row: r, col: c, flips: flips });
      }
    }
    return moves;
  }

  // Places a disc and flips captured discs in place. Returns the flipped
  // discs, or null if the move is illegal.
  function applyMove(board, row, col, player) {
    var flips = getFlips(board, row, col, player);
    if (flips.length === 0) return null;
    board[row][col] = player;
    for (var i = 0; i < flips.length; i++) {
      board[flips[i][0]][flips[i][1]] = player;
    }
    return flips;
  }

  function countDiscs(board) {
    var counts = { black: 0, white: 0 };
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (board[r][c] === BLACK) counts.black++;
        else if (board[r][c] === WHITE) counts.white++;
      }
    }
    return counts;
  }

  function isGameOver(board) {
    return getValidMoves(board, BLACK).length === 0 &&
      getValidMoves(board, WHITE).length === 0;
  }

  // ---- Computer player -------------------------------------------------

  function evaluate(board, player) {
    var other = opponent(player);
    if (isGameOver(board)) {
      var counts = countDiscs(board);
      var mine = player === BLACK ? counts.black : counts.white;
      var theirs = player === BLACK ? counts.white : counts.black;
      return (mine - theirs) * 1000;
    }
    var score = 0;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (board[r][c] === player) score += WEIGHTS[r][c];
        else if (board[r][c] === other) score -= WEIGHTS[r][c];
      }
    }
    var mobility = getValidMoves(board, player).length -
      getValidMoves(board, other).length;
    return score + mobility * 5;
  }

  // Negamax with alpha-beta pruning. Scores are from `player`'s perspective.
  function negamax(board, player, depth, alpha, beta) {
    if (depth === 0 || isGameOver(board)) return evaluate(board, player);
    var moves = getValidMoves(board, player);
    if (moves.length === 0) {
      return -negamax(board, opponent(player), depth - 1, -beta, -alpha);
    }
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var next = cloneBoard(board);
      applyMove(next, moves[i].row, moves[i].col, player);
      var score = -negamax(next, opponent(player), depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // Picks a move for `player`. `depth` controls strength (1 = easy).
  // Returns null if the player has no legal move.
  function chooseMove(board, player, depth) {
    var moves = getValidMoves(board, player);
    if (moves.length === 0) return null;
    var best = null;
    var bestScore = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var next = cloneBoard(board);
      applyMove(next, moves[i].row, moves[i].col, player);
      var score = -negamax(next, opponent(player), depth - 1, -Infinity, Infinity);
      // Small random tie-breaker so games don't always play out identically.
      score += Math.random() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = moves[i];
      }
    }
    return { row: best.row, col: best.col };
  }

  var Reversi = {
    SIZE: SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    opponent: opponent,
    createBoard: createBoard,
    cloneBoard: cloneBoard,
    getFlips: getFlips,
    getValidMoves: getValidMoves,
    applyMove: applyMove,
    countDiscs: countDiscs,
    isGameOver: isGameOver,
    chooseMove: chooseMove
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Reversi;
  } else {
    root.Reversi = Reversi;
  }
})(this);
