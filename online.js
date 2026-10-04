// Live online play over WebRTC. Peers find each other through public Nostr
// relays (via the bundled Trystero library); data then travels directly
// between browsers. There is no server of our own.
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
  var MAX_MOVES_LENGTH = 120; // 60 moves of two characters
  var SILENT_PEER_MS = 8000;

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
  // Resolves to { announce(), openSeat(), hasPlayers(), leave() }. Call
  // announce() whenever the local state (including the side) changes.
  //
  // A player's opponent is the first peer seen on the other side, and stays
  // the opponent until they leave, so nobody else can take over a game. Other
  // peers on that side wait; one takes over if the opponent leaves.
  function connect(roomId, handlers) {
    return import(LIBRARY_URL).then(function (trystero) {
      var room = null;
      var syncAction = null;
      var peers = {}; // peerId -> latest announcement
      var opponentId = null;
      var clashing = false;
      var failures = 0;
      var retryTimer = null;
      var left = false;

      function announcements() {
        return Object.keys(peers).map(function (id) { return peers[id]; });
      }

      function announcement() {
        var state = handlers.getState();
        return { side: state.side, g: state.g, moves: state.moves, opponent: opponentId !== null };
      }

      function broadcast() {
        syncAction.send(announcement());
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

      function hasConnectedPeers() {
        return Object.keys(room.getPeers()).length > 0;
      }

      // A failed connection attempt isn't retried quickly by Trystero, so
      // when we're connected to nobody, leave and join the room again. With
      // a working connection to someone, we stay put; whoever failed to reach
      // us retries from their side.
      function onJoinError(details) {
        if (left) return;
        failures += 1;
        if (failures >= 3) {
          handlers.onTrouble(details && details.error ? String(details.error) : 'Connection failed.');
        }
        if (retryTimer !== null || hasConnectedPeers()) return;
        retryTimer = setTimeout(function () {
          retryTimer = null;
          if (!left && !hasConnectedPeers()) rejoin();
        }, 1000 + Math.random() * 2000);
      }

      function rejoin() {
        clearTimeout(retryTimer);
        retryTimer = null;
        room.leave();
        peers = {};
        join();
        evaluate();
        handlers.onPeersChanged();
      }

      function join() {
        var thisRoom = trystero.joinRoom({ appId: APP_ID }, roomId, { onJoinError: onJoinError });
        var action = thisRoom.makeAction('sync');
        room = thisRoom;
        syncAction = action;

        // Trystero drops messages that arrive while the receiving side is
        // still finishing its handshake, so this greeting can be lost. The
        // reply to a peer's first message (below) makes up for that.
        //
        // Occasionally the handshake completes on our side only, leaving a
        // half-open connection that Trystero doesn't repair for minutes. A
        // healthy peer always sends us something right after connecting, so
        // a silent peer means a broken connection. Joining the room again
        // fixes it quickly but briefly drops everyone, so a player connected
        // to an opponent only closes the broken connection instead.
        thisRoom.onPeerJoin = function (peerId) {
          action.send(announcement(), { target: peerId });
          setTimeout(function () {
            if (room !== thisRoom || left || peers[peerId]) return;
            if (opponentId === null) {
              rejoin();
            } else {
              var connection = thisRoom.getPeers()[peerId];
              if (connection) connection.close();
            }
          }, SILENT_PEER_MS);
        };

        thisRoom.onPeerLeave = function (peerId) {
          if (room !== thisRoom || !peers[peerId]) return;
          delete peers[peerId];
          evaluate();
          handlers.onPeersChanged();
        };

        action.onMessage = function (data, meta) {
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
        leave: function () {
          left = true;
          clearTimeout(retryTimer);
          room.leave();
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
