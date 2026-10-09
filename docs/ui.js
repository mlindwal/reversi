// Browser UI for Reversi. Depends on game.js (window.Reversi) and online.js
// (window.ReversiOnline).
//
// The game is stored as its list of moves ("d3", "c5", ...) and the board is
// rebuilt from it with Reversi.replay(). In online games the server keeps the
// game and sends that list after every change.
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

  // The online game, or null when not in a room. Fields:
  //   roomId; side (R.BLACK / R.WHITE, or null when watching); token (the
  //   secret that proves our seat to the server); tokenSide (the seat that
  //   token was saved for); status ('connecting', 'connected', 'reconnecting'
  //   or 'error'); seats (from the server: who is seated and online); g (game
  //   number); synced (a state has arrived); pending (a move or request is
  //   waiting for the server); startedNewGame; error; connection; release
  //   and lockedSide (this tab's seat lock).
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
    if (mode === 'online') {
      return online.side !== null && online.status === 'connected' && online.synced &&
        !online.pending && game.current === online.side;
    }
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

  // ---- Saved online games ----------------------------------------------
  // localStorage keeps, per room, the seat tokens this browser holds and the
  // latest moves (for the Resume list), so a closed tab can rejoin its seat.
  // sessionStorage remembers which seat this particular tab had, so a reload
  // keeps the same seat when two tabs of the browser play each other.

  var STORAGE_KEY = 'reversi:games';
  var MAX_SAVED_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  var TOKEN_PATTERN = /^[0-9a-f]{32}$/;

  function isSavedGame(entry) {
    if (!entry || !entry.tokens || typeof entry.tokens !== 'object') return false;
    var codes = Object.keys(entry.tokens);
    return codes.length > 0 &&
      codes.every(function (code) {
        return (code === 'b' || code === 'w') && TOKEN_PATTERN.test(entry.tokens[code]);
      }) &&
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

  // Saves our seat's token and the current game, while we hold a seat.
  function rememberGame(session) {
    if (session.side === null || !session.token) return;
    var rooms = loadRooms();
    var entry = rooms[session.roomId] || { tokens: {} };
    var code = sideCode(session.side);
    entry.tokens[code] = session.token;
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

  // Drops a token the server no longer accepts (its seat was taken over).
  function forgetSeat(roomId, code) {
    var rooms = loadRooms();
    var entry = rooms[roomId];
    if (!entry) return;
    delete entry.tokens[code];
    if (Object.keys(entry.tokens).length === 0) delete rooms[roomId];
    saveRooms(rooms);
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
    var square = R.toNotation(row, col);
    var next = R.replay(moves.concat(square));
    if (next.error) return;
    notice = '';
    if (mode === 'online') {
      // The server checks the move and sends the new state to everyone.
      online.pending = online.connection.send({ type: 'move', g: online.g, square: square });
      render();
      return;
    }
    moves = next.moves;
    game = next;
    animate = true;
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
      // The first person in a new room gets Black.
      openRoom(Online.createRoomId());
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
    if (online.side === null || online.pending) return;
    online.startedNewGame = true;
    online.pending = online.connection.send({ type: 'newGame' });
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
    if (online.connection) online.connection.close();
    if (online.release) online.release();
    online = null;
  }

  function openRoom(roomId) {
    clearTimeout(cpuTimer);
    leaveRoom();
    mode = 'online';
    modeEl.value = mode;
    notice = '';
    var saved = loadRooms()[roomId];
    // Show the saved position until the server sends the current one.
    setMoves(saved ? R.decodeMoves(saved.moves) || [] : []);
    var session = {
      roomId: roomId,
      side: null,
      token: null,
      tokenSide: null,
      status: 'connecting',
      seats: null,
      g: saved ? saved.g : 0,
      synced: false,
      pending: false,
      startedNewGame: false,
      error: '',
      connection: null,
      release: null,
      lockedSide: null
    };
    online = session;
    history.replaceState(null, '', '#room=' + roomId);
    render();

    if (location.protocol === 'file:') {
      session.status = 'error';
      session.error = 'Online play needs the page to be served from a web server ' +
        '(for example "npm run dev" locally). Opened as a file, the browser blocks it.';
      render();
      return;
    }

    // Use a seat this browser had before, unless another tab is using it.
    chooseSavedSeat(roomId, saved ? Object.keys(saved.tokens) : []).then(function (seat) {
      if (online !== session) {
        if (seat) seat.release();
        return;
      }
      if (seat) {
        session.token = saved.tokens[seat.code];
        session.tokenSide = seat.code;
        session.release = seat.release;
        session.lockedSide = seat.code;
      }
      connectRoom(session);
    });
  }

  function connectRoom(session) {
    function current() {
      return online === session;
    }

    session.connection = Online.connect(session.roomId, {
      hello: function () {
        return { type: 'hello', token: session.token };
      },
      onOpen: function () {
        if (!current()) return;
        session.status = 'connected';
        render();
      },
      onClose: function () {
        if (!current()) return;
        session.status = 'reconnecting';
        session.pending = false;
        render();
      },
      onMessage: function (message) {
        if (current()) handleMessage(session, message);
      }
    });
  }

  function handleMessage(session, message) {
    if (message.type === 'welcome') {
      if (message.side === 'b' || message.side === 'w') {
        if (message.token) {
          session.token = message.token;
          session.tokenSide = message.side;
        }
        session.side = colorFromCode(message.side);
        holdSeatLock(session, message.side);
        rememberGame(session);
      } else {
        // Our token was refused: someone took over the seat on another device.
        if (session.tokenSide) forgetSeat(session.roomId, session.tokenSide);
        session.token = null;
        session.tokenSide = null;
        session.side = null;
        if (session.release) session.release();
        session.release = null;
        session.lockedSide = null;
      }
      render();
    } else if (message.type === 'state') {
      var list = R.decodeMoves(typeof message.moves === 'string' ? message.moves : '');
      if (!list || typeof message.g !== 'number' || !message.seats) return;
      var newGame = session.synced && message.g > session.g;
      var changed = message.g !== session.g || message.moves !== R.encodeMoves(moves);
      if (newGame) {
        notice = session.startedNewGame ? 'You started a new game.' : 'A new game has started.';
      } else if (changed) {
        notice = '';
      }
      if (changed) {
        setMoves(list);
        animate = true;
      }
      session.startedNewGame = false;
      session.g = message.g;
      session.seats = message.seats;
      session.synced = true;
      session.pending = false;
      rememberGame(session);
      render();
    } else if (message.type === 'error') {
      notice = String(message.message || 'Something went wrong.');
      session.pending = false;
      session.startedNewGame = false;
      render();
    }
  }

  function holdSeatLock(session, code) {
    if (session.lockedSide === code) return;
    if (session.release) session.release();
    session.release = null;
    session.lockedSide = code;
    tryLock(session.roomId, code).then(function (release) {
      if (online !== session || session.lockedSide !== code) {
        if (release) release();
        return;
      }
      session.release = release;
    });
  }

  // A seat a watcher may take: one whose player isn't connected.
  function seatOnOffer(session) {
    if (session.side !== null || !session.seats) return null;
    return ['b', 'w'].filter(function (code) {
      return !session.seats[code].taken || !session.seats[code].online;
    })[0] || null;
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
    newGameBtn.disabled = mode === 'online' && (online.side === null || !online.synced);
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
    var opponent = session.side === null ? null : R.opponent(session.side);
    var opponentSeat = opponent !== null && session.seats ? session.seats[sideCode(opponent)] : null;
    var offer = seatOnOffer(session);
    var text;

    if (session.status === 'error') {
      text = session.error;
    } else if (session.status === 'reconnecting') {
      text = 'Connection lost. Reconnecting…';
    } else if (session.status === 'connecting' || !session.synced) {
      text = 'Connecting…';
    } else if (session.side === null) {
      text = 'You\'re watching this game.';
      if (offer) {
        text += ' The ' + colorName(colorFromCode(offer)) + ' player isn\'t here. ' +
          'If that\'s you, you can take the seat.';
      }
    } else if (!opponentSeat.taken) {
      text = 'Waiting for your opponent to open the link…';
    } else if (!opponentSeat.online) {
      text = 'Your opponent is offline. Waiting for them to come back…';
    } else {
      text = 'Connected to your opponent.';
    }
    onlineStatusEl.textContent = text;
    onlineStatusEl.classList.toggle('error', session.status === 'error');

    takeSeatBtn.hidden = !(offer && session.status === 'connected');
    if (offer) takeSeatBtn.textContent = 'Play as ' + colorName(colorFromCode(offer));

    inviteEl.hidden = session.status === 'error';
    inviteTextEl.textContent = opponentSeat && !opponentSeat.taken ?
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
      var sides = Object.keys(entry.tokens).sort().map(function (code) {
        return colorName(colorFromCode(code));
      });
      var item = document.createElement('li');
      var label = document.createElement('span');
      label.textContent = 'You played ' + sides.join(' and ') + ' · ' +
        (replayed.gameOver ? 'game over' : replayed.moves.length + ' moves') +
        ' · ' + timeAgo(entry.updated);
      var resume = document.createElement('button');
      resume.type = 'button';
      resume.textContent = 'Resume';
      resume.addEventListener('click', function () { openRoom(id); });
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
    var offer = online && seatOnOffer(online);
    if (offer && !online.pending) {
      online.pending = online.connection.send({ type: 'claim', side: offer });
      render();
    }
  });
  modeEl.addEventListener('change', function () { startMode(modeEl.value); });
  hintsEl.addEventListener('change', render);
  window.addEventListener('hashchange', function () {
    var room = roomFromHash();
    if (room) {
      if (!online || online.roomId !== room) openRoom(room);
    } else if (mode === 'online') {
      startMode('cpu');
    }
  });

  buildBoard();
  var initialRoom = roomFromHash();
  if (initialRoom) openRoom(initialRoom);
  else startMode('cpu');
})();
