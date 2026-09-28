// Browser UI for Reversi. Depends on game.js (window.Reversi).
(function () {
  'use strict';

  var R = window.Reversi;
  var CPU_DELAY_MS = 450;

  var boardEl = document.getElementById('board');
  var statusEl = document.getElementById('status');
  var countBlackEl = document.getElementById('count-black');
  var countWhiteEl = document.getElementById('count-white');
  var scoreBlackEl = document.getElementById('score-black');
  var scoreWhiteEl = document.getElementById('score-white');
  var modeEl = document.getElementById('mode');
  var difficultyEl = document.getElementById('difficulty');
  var difficultyLabelEl = document.getElementById('difficulty-label');
  var hintsEl = document.getElementById('show-hints');
  var newGameBtn = document.getElementById('new-game');
  var undoBtn = document.getElementById('undo');

  var HUMAN_COLOR = R.BLACK; // In computer mode the human plays black.

  var state;
  var history;
  var cells = [];
  var cpuTimer = null;

  function colorName(player) {
    return player === R.BLACK ? 'Black' : 'White';
  }

  function isCpuGame() {
    return modeEl.value === 'cpu';
  }

  function isCpuTurn() {
    return isCpuGame() && !state.gameOver && state.current !== HUMAN_COLOR;
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    cells = [];
    for (var r = 0; r < R.SIZE; r++) {
      var rowCells = [];
      for (var c = 0; c < R.SIZE; c++) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', 'Row ' + (r + 1) + ', column ' + (c + 1));
        cell.addEventListener('click', onCellClick);
        boardEl.appendChild(cell);
        rowCells.push(cell);
      }
      cells.push(rowCells);
    }
  }

  function newGame() {
    clearTimeout(cpuTimer);
    state = {
      board: R.createBoard(),
      current: R.BLACK,
      lastMove: null,
      flipped: [],
      message: '',
      gameOver: false
    };
    history = [];
    difficultyLabelEl.hidden = !isCpuGame();
    render();
    scheduleCpu();
  }

  function snapshot() {
    return {
      board: R.cloneBoard(state.board),
      current: state.current,
      lastMove: state.lastMove,
      flipped: state.flipped,
      message: state.message,
      gameOver: state.gameOver
    };
  }

  function playMove(row, col) {
    var before = snapshot();
    var flipped = R.applyMove(state.board, row, col, state.current);
    if (!flipped) return false;

    history.push(before);
    state.lastMove = { row: row, col: col };
    state.flipped = flipped;
    state.message = '';

    var next = R.opponent(state.current);
    if (R.getValidMoves(state.board, next).length > 0) {
      state.current = next;
    } else if (R.getValidMoves(state.board, state.current).length > 0) {
      state.message = colorName(next) + ' has no valid moves and passes.';
    } else {
      state.gameOver = true;
    }
    return true;
  }

  function onCellClick(event) {
    if (state.gameOver || isCpuTurn()) return;
    var row = Number(event.currentTarget.dataset.row);
    var col = Number(event.currentTarget.dataset.col);
    if (playMove(row, col)) {
      render();
      scheduleCpu();
    }
  }

  function scheduleCpu() {
    clearTimeout(cpuTimer);
    if (!isCpuTurn()) return;
    cpuTimer = setTimeout(function () {
      var depth = Number(difficultyEl.value);
      var move = R.chooseMove(state.board, state.current, depth);
      if (move) playMove(move.row, move.col);
      render();
      scheduleCpu(); // The CPU moves again if the human had to pass.
    }, CPU_DELAY_MS);
  }

  function undo() {
    if (history.length === 0) return;
    clearTimeout(cpuTimer);
    state = history.pop();
    // Against the computer, rewind to the human's most recent turn.
    while (isCpuGame() && state.current !== HUMAN_COLOR && history.length > 0) {
      state = history.pop();
    }
    render();
    scheduleCpu();
  }

  function render() {
    var moves = state.gameOver ? [] : R.getValidMoves(state.board, state.current);
    var showHints = hintsEl.checked && !isCpuTurn();
    var validSet = {};
    moves.forEach(function (m) { validSet[m.row + ',' + m.col] = true; });
    var flippedSet = {};
    state.flipped.forEach(function (f) { flippedSet[f[0] + ',' + f[1]] = true; });

    for (var r = 0; r < R.SIZE; r++) {
      for (var c = 0; c < R.SIZE; c++) {
        var cell = cells[r][c];
        var value = state.board[r][c];
        var key = r + ',' + c;
        var isValid = !!validSet[key];

        cell.classList.toggle('valid', isValid && !isCpuTurn());
        cell.classList.toggle('hint', isValid && showHints);
        cell.classList.toggle('last', !!state.lastMove &&
          state.lastMove.row === r && state.lastMove.col === c);

        var disc = cell.firstChild;
        if (value === R.EMPTY) {
          if (disc) cell.removeChild(disc);
        } else {
          var color = value === R.BLACK ? 'black' : 'white';
          // Replace a disc that changed colour so its flip animation restarts.
          if (disc && !disc.classList.contains(color)) {
            cell.removeChild(disc);
            disc = null;
          }
          if (!disc) {
            disc = document.createElement('span');
            cell.appendChild(disc);
          }
          disc.className = 'disc ' + color + (flippedSet[key] ? ' flip' : '');
        }
      }
    }

    var counts = R.countDiscs(state.board);
    countBlackEl.textContent = counts.black;
    countWhiteEl.textContent = counts.white;
    scoreBlackEl.classList.toggle('active', !state.gameOver && state.current === R.BLACK);
    scoreWhiteEl.classList.toggle('active', !state.gameOver && state.current === R.WHITE);

    statusEl.textContent = statusText(counts);
    undoBtn.disabled = history.length === 0;
  }

  function statusText(counts) {
    if (state.gameOver) {
      if (counts.black === counts.white) return 'Game over: it\'s a draw!';
      var winner = counts.black > counts.white ? R.BLACK : R.WHITE;
      if (isCpuGame()) {
        return winner === HUMAN_COLOR ? 'Game over: you win!' : 'Game over: the computer wins.';
      }
      return 'Game over: ' + colorName(winner) + ' wins!';
    }
    var turn;
    if (isCpuGame()) {
      turn = state.current === HUMAN_COLOR ? 'Your turn (Black).' : 'Computer is thinking…';
    } else {
      turn = colorName(state.current) + ' to move.';
    }
    return state.message ? state.message + ' ' + turn : turn;
  }

  newGameBtn.addEventListener('click', newGame);
  undoBtn.addEventListener('click', undo);
  modeEl.addEventListener('change', newGame);
  hintsEl.addEventListener('change', render);

  buildBoard();
  newGame();
})();
