// Live online play over WebRTC. Peers find each other through public Nostr
// relays (via the bundled Trystero library); data then travels directly
// between browsers. When a TURN credentials URL is set below, browsers that
// can't reach each other directly relay through Cloudflare's TURN servers.
//
// Everyone in a room repeatedly announces
//   { side: 'b' | 'w' | null, g: game number, moves: "d3c5...", opponent: bool }
// where side is null for someone who is watching (or hasn't picked a seat
// yet) and `opponent` says whether that player currently has an opponent
// connected. Sending the whole move list (at most 120 characters) instead of
// single moves means anyone who reconnects catches up automatically.
(function (root) {
  'use strict';

  var Reversi = root.Reversi || (typeof require === 'function' ? require('./game.js') : null);

  var APP_ID = 'github.com/mlindwal/reversi';
  var LIBRARY_URL = './vendor/trystero-nostr.mjs';
  // URL of the Worker in worker/ that hands out TURN credentials (see the
  // README). Leave empty to play without TURN: direct connections only.
  var TURN_CREDENTIALS_URL = '';
  var TURN_FETCH_TIMEOUT_MS = 5000;
  var MAX_MOVES_LENGTH = 120; // 60 moves of two characters
  var SILENT_PEER_MS = 8000;
  // Trystero finishes leaving a room asynchronously, and that cleanup
  // cancels the relay subscription of a new join of the same room made in
  // the meantime, leaving it unable to find anyone. So a room is only joined
  // again once this long has passed since it was left.
  var REJOIN_DELAY_MS = 1000;
  var lastLeft = {}; // roomId -> time it was last left

  // Add ?debug to the page URL to log connection events to the console.
  var DEBUG = typeof location !== 'undefined' && /[?&]debug\b/.test(location.search);

  function debug() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[reversi ' + new Date().toISOString().slice(11, 23) + ']'].concat(args));
  }

  function isValidAnnouncement(data) {
    return !!data &&
      (data.side === 'b' || data.side === 'w' || data.side === null) &&
      typeof data.g === 'number' && data.g >= 0 && Math.floor(data.g) === data.g &&
      typeof data.moves === 'string' && data.moves.length <= MAX_MOVES_LENGTH &&
      (data.opponent === undefined || typeof data.opponent === 'boolean');
  }

  function isPrefix(shorter, longer) {
    if (shorter.length > longer.length) return false;
    for (var i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) return false;
    }
    return true;
  }

  // Compares our game ({ g, moves: [...] }) with another peer's announcement.
  // `opponentColor` is the colour that peer plays: any new moves must be
  // theirs, so nobody can move on our behalf. Pass null when watching, to
  // accept moves by either colour. Returns one of:
  //   { action: 'adopt', g, moves }  take their version
  //   { action: 'same' }             nothing to do
  //   { action: 'ahead' }            ours is newer
  //   { action: 'reject', reason }   invalid or not allowed; keep ours
  function resolveSync(local, remote, opponentColor) {
    if (!isValidAnnouncement(remote)) {
      return { action: 'reject', reason: 'Received a malformed update.' };
    }
    var remoteMoves = Reversi.decodeMoves(remote.moves);
    if (!remoteMoves) return { action: 'reject', reason: 'Received a malformed update.' };

    if (remote.g < local.g) return { action: 'ahead' };

    var base = [];
    if (remote.g === local.g) {
      if (isPrefix(remoteMoves, local.moves)) {
        return { action: remoteMoves.length === local.moves.length ? 'same' : 'ahead' };
      }
      if (!isPrefix(local.moves, remoteMoves)) {
        return { action: 'reject', reason: 'Your copies of the game have diverged.' };
      }
      base = local.moves;
    }

    var game = Reversi.replay(remoteMoves);
    if (game.error) return { action: 'reject', reason: game.error };
    if (opponentColor !== null) {
      for (var i = base.length; i < game.players.length; i++) {
        if (game.players[i] !== opponentColor) {
          return { action: 'reject', reason: 'It includes moves you didn\'t make here.' };
        }
      }
    }
    return { action: 'adopt', g: remote.g, moves: remoteMoves };
  }

  // Given the latest announcement from each peer, returns the seat someone
  // without a seat may take, as { side, state }, where `state` is the game
  // announced by the player already sitting opposite. A seat is open when
  // nobody announces it and the player opposite reports having no opponent;
  // the second condition covers an opponent we haven't heard from yet.
  // Returns null when no seat is open, including when no player is present.
  function findOpenSeat(announcements) {
    var bySide = {};
    announcements.forEach(function (data) {
      if (data.side) bySide[data.side] = data;
    });
    if (bySide.b && !bySide.w && !bySide.b.opponent) return { side: 'w', state: bySide.b };
    if (bySide.w && !bySide.b && !bySide.w.opponent) return { side: 'b', state: bySide.w };
    return null;
  }

  function hasPlayers(announcements) {
    return announcements.some(function (data) { return data.side !== null; });
  }

  // Fetches TURN servers from the credentials Worker. Resolves to a list of
  // ICE servers, or null when TURN isn't set up or the Worker can't be
  // reached, in which case the game connects without TURN.
  function fetchTurnServers() {
    if (!TURN_CREDENTIALS_URL || typeof fetch !== 'function') return Promise.resolve(null);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, TURN_FETCH_TIMEOUT_MS);
    return fetch(TURN_CREDENTIALS_URL, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var servers = data && Array.isArray(data.iceServers) ? data.iceServers : [];
        debug('got', servers.length, 'TURN server entries');
        return servers.length > 0 ? servers : null;
      }, function (error) {
        debug('continuing without TURN:', error && error.message);
        return null;
      })
      .then(function (servers) {
        clearTimeout(timer);
        return servers;
      });
  }

  function waitBeforeJoining(roomId) {
    var wait = (lastLeft[roomId] || 0) + REJOIN_DELAY_MS - Date.now();
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, wait)); });
  }

  function leaveRoom(roomId, room) {
    room.leave();
    lastLeft[roomId] = Date.now();
  }

  // Joins the room for `roomId`. `handlers` provides:
  //   getState()          -> { side: 'b' | 'w' | null, g, moves: "d3c5..." }
  //   onConnect()            an opponent connected (or a new one took over)
  //   onDisconnect()         the opponent left and nobody else can take over
  //   onSync(data)           the opponent announced their game (players only)
  //   onWatch(data)          a player announced their game (non-players only)
  //   onPeersChanged()       someone arrived, left or changed seat
  //   onSideClash(active)    whether another peer claims the same colour as us
  //   onTrouble(message)     connecting keeps failing (message), or works
  //                          again (null)
  // Resolves to { announce(), openSeat(), hasPlayers(), reconnect(), leave() }.
  // Call announce() whenever the local state (including the side) changes.
  // reconnect() leaves and rejoins the room, dropping all connections.
  //
  // A player's opponent is the first peer seen on the other side, and stays
  // the opponent until they leave, so nobody else can take over a game. Other
  // peers on that side wait; one takes over if the opponent leaves.
  function connect(roomId, handlers) {
    return Promise.all([
      import(LIBRARY_URL),
      fetchTurnServers(),
      waitBeforeJoining(roomId)
    ]).then(function (loaded) {
      var trystero = loaded[0];
      var turnServers = loaded[1];
      var room = null;
      var syncAction = null;
      var peers = {}; // peerId -> latest announcement
      var opponentId = null;
      var clashing = false;
      var failures = 0;
      var left = false;
      var reconnecting = false;

      function announcements() {
        return Object.keys(peers).map(function (id) { return peers[id]; });
      }

      function announcement() {
        var state = handlers.getState();
        return { side: state.side, g: state.g, moves: state.moves, opponent: opponentId !== null };
      }

      function broadcast() {
        if (!reconnecting) syncAction.send(announcement());
      }

      // Re-derives the opponent and clash state after anything changed.
      function evaluate() {
        var side = handlers.getState().side;
        var clash = side !== null && Object.keys(peers).some(function (id) {
          return peers[id].side === side;
        });
        if (clash !== clashing) {
          clashing = clash;
          handlers.onSideClash(clash);
        }

        var other = side === 'b' ? 'w' : side === 'w' ? 'b' : null;
        var previous = opponentId;
        if (opponentId !== null && (other === null || !peers[opponentId] ||
            peers[opponentId].side !== other)) {
          opponentId = null;
        }
        if (opponentId === null && other !== null) {
          opponentId = Object.keys(peers).filter(function (id) {
            return peers[id].side === other;
          })[0] || null;
        }
        if (opponentId === previous) return;
        if (opponentId !== null) {
          handlers.onConnect();
          handlers.onSync(peers[opponentId]);
        } else if (side !== null) {
          handlers.onDisconnect();
        }
        broadcast(); // Let everyone know whether we have an opponent.
      }

      // Trystero reports every failed connection attempt here, including
      // routine ones while it tries several routes at once, and keeps trying
      // by itself. So this only warns when failures pile up; reconnecting on
      // every error would keep interrupting attempts still in progress.
      function onJoinError(details) {
        debug('join error', details && details.error);
        if (left) return;
        failures += 1;
        if (failures >= 3) {
          handlers.onTrouble(details && details.error ? String(details.error) : 'Connection failed.');
        }
      }

      function reconnect() {
        if (reconnecting || left) return;
        debug('reconnecting');
        reconnecting = true;
        leaveRoom(roomId, room);
        peers = {};
        // Fetch fresh credentials too, in case the old ones have expired.
        Promise.all([fetchTurnServers(), waitBeforeJoining(roomId)]).then(function (loaded) {
          if (loaded[0]) turnServers = loaded[0];
          reconnecting = false;
          if (left) return;
          join();
          evaluate();
          handlers.onPeersChanged();
        });
      }

      function join() {
        debug('joining room', roomId, 'as peer', trystero.selfId, turnServers ? 'with TURN' : 'without TURN');
        var config = { appId: APP_ID };
        // Trystero uses these alongside its default STUN servers.
        if (turnServers) config.turnConfig = turnServers;
        var thisRoom = trystero.joinRoom(config, roomId, { onJoinError: onJoinError });
        var action = thisRoom.makeAction('sync');
        room = thisRoom;
        syncAction = action;

        // Trystero drops messages that arrive while the receiving side is
        // still finishing its handshake, so this greeting can be lost. The
        // reply to a peer's first message (below) makes up for that.
        thisRoom.onPeerJoin = function (peerId) {
          debug('peer connected', peerId);
          action.send(announcement(), { target: peerId });
          // Occasionally the handshake completes on our side only, and
          // Trystero never repairs that: the other side keeps retrying and
          // timing out. A healthy peer always sends something right after
          // connecting, so silence means a broken connection; only this side
          // can see it, so only this side reconnects. A player connected to
          // an opponent leaves it alone rather than drop the game.
          setTimeout(function () {
            if (room !== thisRoom || left || reconnecting || peers[peerId]) return;
            debug('peer stayed silent', peerId);
            if (opponentId === null) reconnect();
          }, SILENT_PEER_MS);
        };

        thisRoom.onPeerLeave = function (peerId) {
          debug('peer left', peerId);
          if (room !== thisRoom || !peers[peerId]) return;
          delete peers[peerId];
          evaluate();
          handlers.onPeersChanged();
        };

        action.onMessage = function (data, meta) {
          debug('message from', meta.peerId, data);
          if (room !== thisRoom || !isValidAnnouncement(data)) return;
          if (failures > 0) {
            failures = 0;
            handlers.onTrouble(null);
          }
          var peerId = meta.peerId;
          var wasOpponent = peerId === opponentId;
          var firstContact = !peers[peerId];
          peers[peerId] = data;
          if (firstContact) action.send(announcement(), { target: peerId });
          evaluate();
          if (handlers.getState().side === null) {
            if (data.side !== null) handlers.onWatch(data);
          } else if (wasOpponent && peerId === opponentId) {
            handlers.onSync(data);
          }
          handlers.onPeersChanged();
        };
      }

      join();

      return {
        announce: function () {
          evaluate();
          broadcast();
        },
        openSeat: function () {
          return findOpenSeat(announcements());
        },
        hasPlayers: function () {
          return hasPlayers(announcements());
        },
        reconnect: reconnect,
        leave: function () {
          left = true;
          if (!reconnecting) leaveRoom(roomId, room);
        }
      };
    });
  }

  function createRoomId() {
    var alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    var bytes = new Uint8Array(10);
    root.crypto.getRandomValues(bytes);
    var id = '';
    for (var i = 0; i < bytes.length; i++) id += alphabet.charAt(bytes[i] % alphabet.length);
    return id;
  }

  var ReversiOnline = {
    resolveSync: resolveSync,
    findOpenSeat: findOpenSeat,
    connect: connect,
    createRoomId: createRoomId
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReversiOnline;
  } else {
    root.ReversiOnline = ReversiOnline;
  }
})(this);
