// Browser UI for Reversi. Depends on game.js (window.Reversi) and online.js
// (window.ReversiOnline).
//
// The game is stored as its list of moves ("d3", "c5", ...) and the board is
// rebuilt from it with Reversi.replay(). Online players exchange that list,
// and it is saved in the browser so a live game can be resumed.
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
  var takeSeatBtn = document.getElementById('take-seat');
  var useTheirsBtn = document.getElementById('use-theirs');
  var inviteEl = document.getElementById('invite');
  var inviteTextEl = document.getElementById('invite-text');
  var inviteUrlEl = document.getElementById('invite-url');
  var resumePanelEl = document.getElementById('resume-panel');
  var resumeListEl = document.getElementById('resume-list');

  var mode = 'cpu';    // 'cpu' | 'human' | 'online'
  var moves = [];
  var game = R.replay(moves);
  var animate = false; // animate flipped discs on the next render
  var notice = '';     // one-off message shown in the status line
  var cells = [];
  var cpuTimer = null;

  // The live game, or null when not in a room. Fields:
  //   roomId, side (R.BLACK / R.WHITE, or null without a seat), g (game
  //   number, raised by "New game"), role ('joining' until we know whether a
  //   seat is free, then 'player' or 'spectator'), status (connection state),
  //   clash, trouble (connection warning), conflict, openSeat, error,
  //   connection, release (frees the seat lock), claiming.
  var online = null;

  // ---- Helpers ---------------------------------------------------------

  function colorName(player) {
    return player === R.BLACK ? 'Black' : 'White';
  }

  function sideCode(player) {
    return player === R.BLACK ? 'b' : 'w';
  }

  function colorFromCode(code) {
    return code === 'b' ? R.BLACK : R.WHITE;
  }

  function roomUrl(roomId) {
    return location.href.split('#')[0] + '#room=' + roomId;
  }

  // The colour this tab controls, or null when it controls both colours
  // (same-device play) or neither (watching).
  function localColor() {
    if (mode === 'cpu') return HUMAN_COLOR;
    if (mode === 'online') return online.side;
    return null;
  }

  function canMoveHere() {
    if (game.gameOver) return false;
    if (mode === 'online') return online.side !== null && game.current === online.side;
    var mine = localColor();
    return mine === null || game.current === mine;
  }

  function isCpuTurn() {
    return mode === 'cpu' && !game.gameOver && game.current !== HUMAN_COLOR;
  }

  function setMoves(list) {
    moves = list;
    game = R.replay(moves);
  }

  // ---- Saved live games ------------------------------------------------
  // localStorage keeps, per room, the seats this browser has played and the
  // latest game, so a closed tab can be resumed. sessionStorage remembers
  // which seat this particular tab had, so a reload keeps the same seat when
  // two tabs of the browser play each other.

  var STORAGE_KEY = 'reversi:rooms';
  var MAX_SAVED_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  function isSavedGame(entry) {
    return !!entry && Array.isArray(entry.sides) && entry.sides.length > 0 &&
      entry.sides.every(function (s) { return s === 'b' || s === 'w'; }) &&
      typeof entry.g === 'number' && typeof entry.updated === 'number' &&
      typeof entry.moves === 'string' && R.decodeMoves(entry.moves) !== null;
  }

  function loadRooms() {
    var rooms = {};
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      Object.keys(data).forEach(function (id) {
        if (isSavedGame(data[id]) && Date.now() - data[id].updated < MAX_SAVED_AGE_MS) {
          rooms[id] = data[id];
        }
      });
    } catch (e) {
      // Storage unavailable or corrupt: behave as if nothing is saved.
    }
    return rooms;
  }

  function saveRooms(rooms) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
    } catch (e) {
      // Storage unavailable: the game still works, it just can't be resumed.
    }
  }

  function rememberGame(session) {
    var rooms = loadRooms();
    var entry = rooms[session.roomId] || { sides: [] };
    var code = sideCode(session.side);
    if (entry.sides.indexOf(code) === -1) entry.sides.push(code);
    entry.g = session.g;
    entry.moves = R.encodeMoves(moves);
    entry.updated = Date.now();
    rooms[session.roomId] = entry;
    saveRooms(rooms);
    try {
      sessionStorage.setItem('reversi:side:' + session.roomId, code);
    } catch (e) {
      // Only used to prefer the same seat after a reload.
    }
  }

  function forgetGame(roomId) {
    var rooms = loadRooms();
    delete rooms[roomId];
    saveRooms(rooms);
  }

  // Seat locks stop two tabs of this browser from taking the same seat.
  // Resolves to a function that releases the lock, or null if another tab
  // holds it.
  function tryLock(roomId, code) {
    if (!navigator.locks) return Promise.resolve(function () {});
    return new Promise(function (resolve) {
      navigator.locks.request('reversi:' + roomId + ':' + code, { ifAvailable: true }, function (lock) {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise(function (release) { resolve(release); });
      });
    });
  }

  // Picks a seat this browser played before and no other tab holds,
  // preferring the one this tab had. Resolves to { code, release } or null.
  function chooseSavedSeat(roomId, sides) {
    var preferred = null;
    try {
      preferred = sessionStorage.getItem('reversi:side:' + roomId);
    } catch (e) {
      // Fall back to the saved order.
    }
    var order = sides.slice().sort(function (a, b) {
      return (b === preferred) - (a === preferred);
    });
    function attempt(i) {
      if (i >= order.length) return Promise.resolve(null);
      return tryLock(roomId, order[i]).then(function (release) {
        return release ? { code: order[i], release: release } : attempt(i + 1);
      });
    }
    return attempt(0);
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
    if (mode === 'online') {
      rememberGame(online);
      if (online.connection) online.connection.announce();
    }
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

  // Switches mode and starts a fresh game in it. Choosing online play
  // creates a new room.
  function startMode(newMode) {
    if (newMode === 'online') {
      openRoom(Online.createRoomId(), true);
      return;
    }
    clearTimeout(cpuTimer);
    leaveRoom();
    mode = newMode;
    modeEl.value = mode;
    notice = '';
    setMoves([]);
    history.replaceState(null, '', location.pathname + location.search);
    render();
    scheduleCpu();
  }

  function newGame() {
    if (mode !== 'online') {
      startMode(mode);
      return;
    }
    if (online.role !== 'player') return;
    online.g += 1;
    setMoves([]);
    notice = 'You started a new game.';
    rememberGame(online);
    if (online.connection) online.connection.announce();
    render();
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
    render();
    scheduleCpu();
  }

  function roomFromHash() {
    var room = new URLSearchParams(location.hash.slice(1)).get('room');
    return room && /^[a-z0-9]{4,32}$/.test(room) ? room : null;
  }

  // ---- Online ----------------------------------------------------------

  function leaveRoom() {
    if (!online) return;
    if (online.connection) online.connection.leave();
    if (online.release) online.release();
    online = null;
  }

  function openRoom(roomId, isNew) {
    clearTimeout(cpuTimer);
    leaveRoom();
    mode = 'online';
    modeEl.value = mode;
    notice = '';
    setMoves([]);
    var session = {
      roomId: roomId,
      side: null,
      g: 0,
      role: 'joining',
      status: 'connecting',
      clash: false,
      trouble: null,
      conflict: null,
      openSeat: null,
      error: '',
      connection: null,
      release: null,
      claiming: false
    };
    online = session;
    history.replaceState(null, '', '#room=' + roomId);
    render();

    if (location.protocol === 'file:') {
      session.status = 'error';
      session.error = 'Online play needs the page to be served from a web server ' +
        '(for example GitHub Pages, or "python3 -m http.server" locally). ' +
        'Opened as a file, the browser blocks it.';
      render();
      return;
    }

    // The creator plays Black. Otherwise use a seat this browser had before.
    var saved = isNew ? { sides: ['b'], g: 0, moves: '' } : loadRooms()[roomId];
    chooseSavedSeat(roomId, saved ? saved.sides : []).then(function (seat) {
      if (online !== session) {
        if (seat) seat.release();
        return;
      }
      if (seat) {
        var restored = R.replay(R.decodeMoves(saved.moves) || []);
        takeSeat(session, seat.code, seat.release, saved.g, restored.moves);
      }
      connectRoom(session);
    });
  }

  function takeSeat(session, code, release, g, list) {
    session.side = colorFromCode(code);
    session.release = release;
    session.role = 'player';
    session.openSeat = null;
    session.g = g;
    setMoves(list);
    rememberGame(session);
  }

  // Takes a free seat, adopting the game from the player opposite. Used both
  // by the first person to open an invite and by a player returning without
  // a saved game (another device, a private window).
  function claimSeat(session, seat) {
    if (session.claiming) return;
    var replayed = R.replay(R.decodeMoves(seat.state.moves) || []);
    if (replayed.error) return;
    session.claiming = true;
    tryLock(session.roomId, seat.side).then(function (release) {
      session.claiming = false;
      if (online !== session || session.role === 'player') {
        if (release) release();
        return;
      }
      if (!release) {
        session.role = 'spectator';
        notice = 'Another tab in this browser is already playing ' +
          colorName(colorFromCode(seat.side)) + '.';
        render();
        return;
      }
      var color = colorFromCode(seat.side);
      takeSeat(session, seat.side, release, seat.state.g, replayed.moves);
      session.status = 'waiting';
      notice = replayed.players.indexOf(color) !== -1 ? 'Game restored from your opponent.' : '';
      animate = true;
      session.connection.announce();
      render();
    });
  }

  // For someone without a seat: take a free seat if this is our first look
  // at the room, otherwise keep watching and offer the seat.
  function updateSeats(session) {
    var seat = session.connection.openSeat();
    if (session.role === 'joining') {
      if (seat) {
        claimSeat(session, seat);
        return;
      }
      if (session.connection.hasPlayers()) session.role = 'spectator';
    }
    session.openSeat = session.role === 'spectator' ? seat : null;
    render();
  }

  function adopt(session, g, list) {
    if (session.role === 'player' && g !== session.g) notice = 'Your opponent started a new game.';
    else if (session.role === 'player') notice = '';
    session.g = g;
    setMoves(list);
    animate = true;
    if (session.role === 'player') rememberGame(session);
    render();
  }

  function connectRoom(session) {
    function current() {
      return online === session;
    }

    Online.connect(session.roomId, {
      getState: function () {
        return {
          side: session.side === null ? null : sideCode(session.side),
          g: session.g,
          moves: current() ? R.encodeMoves(moves) : ''
        };
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
          R.opponent(session.side));
        if (result.action === 'reject') {
          session.conflict = { state: data, reason: result.reason };
          render();
          return;
        }
        if (session.conflict) {
          session.conflict = null;
          render();
        }
        if (result.action === 'adopt') adopt(session, result.g, result.moves);
        else if (result.action === 'ahead' && session.connection) session.connection.announce();
      },
      onWatch: function (data) {
        if (!current()) return;
        var result = Online.resolveSync({ g: session.g, moves: moves }, data, null);
        if (result.action === 'adopt') adopt(session, result.g, result.moves);
      },
      onPeersChanged: function () {
        if (!current() || session.role === 'player' || !session.connection) return;
        updateSeats(session);
      },
      onTrouble: function (message) {
        if (!current()) return;
        session.trouble = message;
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

  // Replaces our game with the opponent's after a conflict, when the player
  // decides their copy is the right one (for example after playing on
  // another device).
  function useTheirVersion() {
    if (!online || !online.conflict) return;
    var state = online.conflict.state;
    var replayed = R.replay(R.decodeMoves(state.moves) || []);
    online.conflict = null;
    if (!replayed.error) {
      notice = '';
      adopt(online, state.g, replayed.moves);
    }
    render();
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
    undoBtn.disabled = mode === 'online' || moves.length === 0;
    newGameBtn.disabled = mode === 'online' && online.role !== 'player';
    difficultyLabelEl.hidden = mode !== 'cpu';
    renderOnlinePanel();
    renderResumePanel();
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
    var session = online;
    var text;
    if (session.status === 'error') {
      text = session.error;
    } else if (session.status === 'connecting') {
      text = 'Connecting…';
    } else if (session.role === 'joining') {
      text = 'Looking for the players in this game… If nobody shows up, they may not ' +
        'have the game open right now.';
    } else if (session.role === 'spectator') {
      text = 'You\'re watching this game.';
      if (session.openSeat) {
        text += ' The ' + colorName(colorFromCode(session.openSeat.side)) + ' player isn\'t ' +
          'here. If that\'s you, you can take the seat.';
      }
    } else {
      text = {
        waiting: 'Waiting for your opponent to open the link…',
        connected: 'Connected to your opponent.',
        disconnected: 'Your opponent disconnected. Waiting for them to come back…'
      }[session.status];
    }
    if (session.trouble && session.status !== 'error') {
      text += ' Having trouble connecting (' + session.trouble + '); still trying. ' +
        'Some networks block direct browser-to-browser connections.';
    }
    if (session.clash && session.status !== 'error') {
      text += ' Someone else in this game is also playing ' + colorName(session.side) +
        '. If that isn\'t you in another browser, your opponent should open the game link.';
    }
    if (session.conflict) {
      text += ' Your opponent\'s copy of the game doesn\'t match yours. ' +
        session.conflict.reason;
    }
    onlineStatusEl.textContent = text;
    onlineStatusEl.classList.toggle('error',
      session.status === 'error' || !!session.trouble || session.clash || !!session.conflict);

    takeSeatBtn.hidden = !(session.role === 'spectator' && session.openSeat);
    if (session.openSeat) {
      takeSeatBtn.textContent = 'Play as ' + colorName(colorFromCode(session.openSeat.side));
    }
    useTheirsBtn.hidden = !session.conflict;

    inviteEl.hidden = session.status === 'error';
    inviteTextEl.textContent = session.role === 'player' && session.status === 'waiting' ?
      'Send this link to your opponent. You can also use it to come back to this game.' :
      'Game link. Anyone else who opens it can watch.';
    inviteUrlEl.value = roomUrl(session.roomId);
  }

  function timeAgo(timestamp) {
    var minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function renderResumePanel() {
    var rooms = mode === 'online' ? {} : loadRooms();
    var ids = Object.keys(rooms).sort(function (a, b) {
      return rooms[b].updated - rooms[a].updated;
    }).slice(0, 3);
    resumePanelEl.hidden = ids.length === 0;
    resumeListEl.innerHTML = '';
    ids.forEach(function (id) {
      var entry = rooms[id];
      var replayed = R.replay(R.decodeMoves(entry.moves));
      var sides = entry.sides.map(function (code) { return colorName(colorFromCode(code)); });
      var item = document.createElement('li');
      var label = document.createElement('span');
      label.textContent = 'You played ' + sides.join(' and ') + ' · ' +
        (replayed.gameOver ? 'game over' : replayed.moves.length + ' moves') +
        ' · ' + timeAgo(entry.updated);
      var resume = document.createElement('button');
      resume.type = 'button';
      resume.textContent = 'Resume';
      resume.addEventListener('click', function () { openRoom(id, false); });
      var forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = 'Forget';
      forget.addEventListener('click', function () {
        forgetGame(id);
        render();
      });
      item.appendChild(label);
      item.appendChild(resume);
      item.appendChild(forget);
      resumeListEl.appendChild(item);
    });
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
  takeSeatBtn.addEventListener('click', function () {
    if (online && online.openSeat) claimSeat(online, online.openSeat);
  });
  useTheirsBtn.addEventListener('click', useTheirVersion);
  modeEl.addEventListener('change', function () { startMode(modeEl.value); });
  hintsEl.addEventListener('change', render);
  window.addEventListener('hashchange', function () {
    var room = roomFromHash();
    if (room) {
      if (!online || online.roomId !== room) openRoom(room, false);
    } else if (mode === 'online') {
      startMode('cpu');
    }
  });

  buildBoard();
  var initialRoom = roomFromHash();
  if (initialRoom) openRoom(initialRoom, false);
  else startMode('cpu');
})();
