// Browser UI for Reversi. Depends on game.js (window.Reversi) and online.js
// (window.ReversiOnline).
//
// The game is stored as its list of moves ("d3", "c5", ...) and the board is
// rebuilt from it with Reversi.replay(). That list is also what goes into
// shareable links and what online players exchange.
(function () {
  'use strict';

  var R = window.Reversi;
  var Online = window.ReversiOnline;
  var CPU_DELAY_MS = 450;
  var HUMAN_COLOR = R.BLACK; // In computer mode the human plays black.

  var boardEl = document.getElementById('board');
  var statusEl = document.getElementById('status');
  var countBlackEl = document.getElementById('count-black');
  var countWhiteEl = document.getElementById('count-white');
  var scoreBlackEl = document.getElementById('score-black');
  var scoreWhiteEl = document.getElementById('score-white');
  var nameBlackEl = document.getElementById('name-black');
  var nameWhiteEl = document.getElementById('name-white');
  var modeEl = document.getElementById('mode');
  var difficultyEl = document.getElementById('difficulty');
  var difficultyLabelEl = document.getElementById('difficulty-label');
  var hintsEl = document.getElementById('show-hints');
  var newGameBtn = document.getElementById('new-game');
  var undoBtn = document.getElementById('undo');
  var onlinePanelEl = document.getElementById('online-panel');
  var onlineStatusEl = document.getElementById('online-status');
  var inviteEl = document.getElementById('invite');
  var inviteUrlEl = document.getElementById('invite-url');
  var inviteColorEl = document.getElementById('invite-color');
  var linkPanelEl = document.getElementById('link-panel');
  var linkStatusEl = document.getElementById('link-status');
  var linkShareEl = document.getElementById('link-share');
  var linkUrlEl = document.getElementById('link-url');

  var mode = 'cpu';    // 'cpu' | 'human' | 'online' | 'link'
  var moves = [];
  var game = R.replay(moves);
  var animate = false; // animate flipped discs on the next render
  var notice = '';     // one-off message shown in the status line
  var cells = [];
  var cpuTimer = null;

  // Online (send links): the colour played in this tab, and how many moves
  // arrived in the link (those can't be undone).
  var link = { side: R.BLACK, start: 0 };

  // Online (live): null when not in a room.
  var online = null;

  // ---- Helpers ---------------------------------------------------------

  function colorName(player) {
    return player === R.BLACK ? 'Black' : 'White';
  }

  function sideCode(player) {
    return player === R.BLACK ? 'b' : 'w';
  }

  function baseUrl() {
    return location.href.split('#')[0];
  }

  // The colour this tab controls, or null when both colours are played here.
  function localColor() {
    if (mode === 'cpu') return HUMAN_COLOR;
    if (mode === 'link') return link.side;
    if (mode === 'online') return online.side;
    return null;
  }

  function canMoveHere() {
    var mine = localColor();
    return !game.gameOver && (mine === null || game.current === mine);
  }

  function isCpuTurn() {
    return mode === 'cpu' && !game.gameOver && game.current !== HUMAN_COLOR;
  }

  function setMoves(list) {
    moves = list;
    game = R.replay(moves);
  }

  function writeHash() {
    var hash = '';
    if (mode === 'link') {
      hash = '#moves=' + R.encodeMoves(moves);
    } else if (mode === 'online') {
      hash = '#room=' + online.roomId + '&side=' + sideCode(online.side) +
        '&g=' + online.g + '&moves=' + R.encodeMoves(moves);
    }
    history.replaceState(null, '', hash || location.pathname + location.search);
  }

  // ---- Board -----------------------------------------------------------

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
        cell.setAttribute('aria-label', R.toNotation(r, c));
        cell.addEventListener('click', onCellClick);
        boardEl.appendChild(cell);
        rowCells.push(cell);
      }
      cells.push(rowCells);
    }
  }

  function onCellClick(event) {
    if (!canMoveHere()) return;
    var row = Number(event.currentTarget.dataset.row);
    var col = Number(event.currentTarget.dataset.col);
    var next = R.replay(moves.concat(R.toNotation(row, col)));
    if (next.error) return;
    moves = next.moves;
    game = next;
    animate = true;
    notice = '';
    if (mode === 'link' || mode === 'online') writeHash();
    if (mode === 'online' && online.connection) online.connection.announce();
    render();
    scheduleCpu();
  }

  function scheduleCpu() {
    clearTimeout(cpuTimer);
    if (!isCpuTurn()) return;
    cpuTimer = setTimeout(function () {
      var move = R.chooseMove(game.board, game.current, Number(difficultyEl.value));
      if (move) {
        setMoves(moves.concat(R.toNotation(move.row, move.col)));
        animate = true;
      }
      render();
      scheduleCpu(); // The computer moves again if the human had to pass.
    }, CPU_DELAY_MS);
  }

  // ---- Modes -----------------------------------------------------------

  function leaveOnline() {
    if (!online) return;
    if (online.connection) online.connection.leave();
    online = null;
  }

  // Switches mode and starts a fresh game in it.
  function startMode(newMode) {
    clearTimeout(cpuTimer);
    leaveOnline();
    mode = newMode;
    modeEl.value = mode;
    notice = '';
    setMoves([]);
    link = { side: R.BLACK, start: 0 };
    if (mode === 'online') {
      joinRoom(Online.createRoomId(), R.BLACK, 0);
    }
    writeHash();
    render();
    scheduleCpu();
  }

  function newGame() {
    if (mode === 'online') {
      online.g += 1;
      setMoves([]);
      notice = 'You started a new game.';
      writeHash();
      if (online.connection) online.connection.announce();
      render();
    } else {
      startMode(mode);
    }
  }

  function undo() {
    if (undoBtn.disabled) return;
    clearTimeout(cpuTimer);
    notice = '';
    setMoves(moves.slice(0, -1));
    // Against the computer, rewind to the human's most recent turn.
    while (mode === 'cpu' && game.current !== HUMAN_COLOR && moves.length > 0) {
      setMoves(moves.slice(0, -1));
    }
    if (mode === 'link') writeHash();
    render();
    scheduleCpu();
  }

  function canUndo() {
    if (mode === 'online') return false;
    if (mode === 'link') return moves.length > link.start;
    return moves.length > 0;
  }

  // Loads the game described by the URL hash, if any. Returns false when
  // the hash doesn't describe a game.
  function startFromHash() {
    var params = new URLSearchParams(location.hash.slice(1));
    var room = params.get('room');
    var movesParam = params.get('moves');
    if (!room && movesParam === null) return false;

    clearTimeout(cpuTimer);
    leaveOnline();
    notice = '';
    var list = R.decodeMoves(movesParam || '') || [];
    var loaded = R.replay(list);
    if (loaded.error) {
      notice = 'This link contains an illegal move, so the game is shown up to move ' +
        loaded.moves.length + '.';
    }
    setMoves(loaded.moves);

    if (room && /^[a-z0-9]{4,32}$/.test(room)) {
      mode = 'online';
      var g = Number(params.get('g')) || 0;
      joinRoom(room, params.get('side') === 'b' ? R.BLACK : R.WHITE, g);
    } else if (room) {
      return false;
    } else {
      mode = 'link';
      // Whoever opens the link plays the side to move.
      link = { side: game.current, start: moves.length };
    }
    modeEl.value = mode;
    writeHash();
    render();
    return true;
  }

  // ---- Online (live) ---------------------------------------------------

  function joinRoom(roomId, side, g) {
    var session = {
      roomId: roomId,
      side: side,
      g: g,
      connection: null,
      status: 'connecting',
      clash: false,
      error: ''
    };
    online = session;

    if (location.protocol === 'file:') {
      session.status = 'error';
      session.error = 'Online play needs the page to be served from a web server ' +
        '(for example GitHub Pages, or "python3 -m http.server" locally). ' +
        'Opened as a file, the browser blocks it.';
      return;
    }

    function current() {
      return online === session;
    }

    Online.connect(roomId, sideCode(side), {
      getState: function () {
        return { g: session.g, moves: R.encodeMoves(moves) };
      },
      onConnect: function () {
        if (!current()) return;
        session.status = 'connected';
        render();
      },
      onDisconnect: function () {
        if (!current()) return;
        session.status = 'disconnected';
        render();
      },
      onSideClash: function (active) {
        if (!current()) return;
        session.clash = active;
        render();
      },
      onSync: function (data) {
        if (!current()) return;
        var result = Online.resolveSync({ g: session.g, moves: moves }, data,
          R.opponent(side));
        if (result.action === 'adopt') {
          if (result.g !== session.g) notice = 'Your opponent started a new game.';
          else notice = '';
          session.g = result.g;
          setMoves(result.moves);
          animate = true;
          writeHash();
          render();
        } else if (result.action === 'ahead') {
          if (session.connection) session.connection.announce();
        } else if (result.action === 'reject') {
          notice = 'Ignored an update from your opponent: ' + result.reason;
          render();
        }
      },
      onError: function (message) {
        if (!current()) return;
        session.status = 'error';
        session.error = 'Could not connect to your opponent (' + message + '). ' +
          'Some networks block direct browser-to-browser connections.';
        render();
      }
    }).then(function (connection) {
      if (!current()) {
        connection.leave();
        return;
      }
      session.connection = connection;
      if (session.status === 'connecting') session.status = 'waiting';
      render();
    }, function () {
      if (!current()) return;
      session.status = 'error';
      session.error = 'Could not load the online play library.';
      render();
    });
  }

  // ---- Rendering -------------------------------------------------------

  function render() {
    var myTurn = canMoveHere();
    var validSet = {};
    if (myTurn) {
      R.getValidMoves(game.board, game.current).forEach(function (m) {
        validSet[m.row + ',' + m.col] = true;
      });
    }
    var flippedSet = {};
    if (animate) {
      game.flipped.forEach(function (f) { flippedSet[f[0] + ',' + f[1]] = true; });
    }
    animate = false;

    for (var r = 0; r < R.SIZE; r++) {
      for (var c = 0; c < R.SIZE; c++) {
        var cell = cells[r][c];
        var value = game.board[r][c];
        var key = r + ',' + c;
        var isValid = !!validSet[key];

        cell.classList.toggle('valid', isValid);
        cell.classList.toggle('hint', isValid && hintsEl.checked);
        cell.classList.toggle('last', !!game.lastMove &&
          game.lastMove.row === r && game.lastMove.col === c);

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

    var counts = R.countDiscs(game.board);
    countBlackEl.textContent = counts.black;
    countWhiteEl.textContent = counts.white;
    scoreBlackEl.classList.toggle('active', !game.gameOver && game.current === R.BLACK);
    scoreWhiteEl.classList.toggle('active', !game.gameOver && game.current === R.WHITE);
    nameBlackEl.textContent = 'Black' + playerLabel(R.BLACK);
    nameWhiteEl.textContent = 'White' + playerLabel(R.WHITE);

    statusEl.textContent = statusText(counts);
    undoBtn.disabled = !canUndo();
    difficultyLabelEl.hidden = mode !== 'cpu';
    renderOnlinePanel();
    renderLinkPanel();
  }

  function playerLabel(player) {
    var mine = localColor();
    if (mine === null) return '';
    if (player === mine) return ' (you)';
    return mode === 'cpu' ? ' (computer)' : ' (opponent)';
  }

  function statusText(counts) {
    var mine = localColor();
    var text;
    if (game.gameOver) {
      if (counts.black === counts.white) {
        text = 'Game over: it\'s a draw!';
      } else {
        var winner = counts.black > counts.white ? R.BLACK : R.WHITE;
        if (mine === null) text = 'Game over: ' + colorName(winner) + ' wins!';
        else if (winner === mine) text = 'Game over: you win!';
        else text = mode === 'cpu' ? 'Game over: the computer wins.' : 'Game over: your opponent wins.';
      }
    } else if (mine === null) {
      text = colorName(game.current) + ' to move.';
    } else if (game.current === mine) {
      text = 'Your turn (' + colorName(mine) + ').';
    } else if (mode === 'cpu') {
      text = 'Computer is thinking…';
    } else {
      text = 'Waiting for ' + colorName(game.current) + '…';
    }
    if (game.passed !== null && !game.gameOver) {
      text = colorName(game.passed) + ' has no valid moves and passes. ' + text;
    }
    return notice ? notice + ' ' + text : text;
  }

  function renderOnlinePanel() {
    onlinePanelEl.hidden = mode !== 'online';
    if (mode !== 'online') return;
    var messages = {
      connecting: 'Connecting…',
      waiting: 'Waiting for your opponent to open the invite link…',
      connected: 'Connected to your opponent.',
      disconnected: 'Your opponent disconnected. Waiting for them to come back…',
      error: online.error
    };
    var text = messages[online.status];
    if (online.clash && online.status !== 'error') {
      text += ' Someone else in this room is also playing ' + colorName(online.side) +
        '. If that isn\'t you in another tab, your opponent should open the invite link.';
    }
    onlineStatusEl.textContent = text;
    onlineStatusEl.classList.toggle('error', online.status === 'error' || online.clash);
    var showInvite = online.status === 'waiting' || online.status === 'connecting';
    inviteEl.hidden = !showInvite;
    inviteColorEl.textContent = colorName(R.opponent(online.side));
    inviteUrlEl.value = baseUrl() + '#room=' + online.roomId +
      '&side=' + sideCode(R.opponent(online.side));
  }

  function renderLinkPanel() {
    linkPanelEl.hidden = mode !== 'link';
    if (mode !== 'link') return;
    var opponentName = colorName(R.opponent(link.side));
    var text;
    var showLink = true;
    if (game.gameOver) {
      text = 'Send this link so your opponent can see the final position:';
    } else if (game.current === link.side) {
      showLink = false;
      text = moves.length === 0 ?
        'Make the first move, then send the link to your opponent.' :
        'Make your move, then send the new link to your opponent.';
    } else {
      text = 'Send this link to your opponent (' + opponentName + '), then wait for them ' +
        'to send you a link back:';
    }
    if (location.protocol === 'file:') {
      text += ' (This page is opened as a file, so the link only works on this computer. ' +
        'Host the game online to share it.)';
    }
    linkStatusEl.textContent = text;
    linkShareEl.hidden = !showLink;
    linkUrlEl.value = baseUrl() + '#moves=' + R.encodeMoves(moves);
  }

  // ---- Copy and share buttons ------------------------------------------

  function copyText(input, button) {
    function done() {
      var label = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(function () { button.textContent = label; }, 1500);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(input.value).then(done, function () {
        input.select();
      });
    } else {
      input.select();
      if (document.execCommand('copy')) done();
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('.copy'), function (button) {
    button.addEventListener('click', function () {
      copyText(document.getElementById(button.dataset.target), button);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.share'), function (button) {
    if (!navigator.share) return;
    button.hidden = false;
    button.addEventListener('click', function () {
      var url = document.getElementById(button.dataset.target).value;
      navigator.share({ title: 'Reversi', url: url }).catch(function () {});
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.share-row input'), function (input) {
    input.addEventListener('focus', function () { input.select(); });
  });

  // ---- Start -----------------------------------------------------------

  newGameBtn.addEventListener('click', newGame);
  undoBtn.addEventListener('click', undo);
  modeEl.addEventListener('change', function () { startMode(modeEl.value); });
  hintsEl.addEventListener('change', render);
  window.addEventListener('hashchange', function () {
    if (!startFromHash()) startMode(mode);
  });

  buildBoard();
  if (!startFromHash()) startMode('cpu');
})();
