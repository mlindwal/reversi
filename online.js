// Live online play over WebRTC. Players find each other through public Nostr
// relays (via the bundled Trystero library); moves then travel directly
// between the two browsers. There is no server of our own.
//
// Both players repeatedly announce their whole game as
// { g: game number, moves: "d3c5...", side: "b" | "w" } and each side decides
// whether to adopt the other's version with resolveSync(). Sending the full
// list (at most 120 characters) instead of single moves means a player who
// reconnects or refreshes catches up automatically.
(function (root) {
  'use strict';

  var Reversi = root.Reversi || (typeof require === 'function' ? require('./game.js') : null);

  var APP_ID = 'github.com/mlindwal/reversi';
  var LIBRARY_URL = './vendor/trystero-nostr.mjs';
  var MAX_MOVES_LENGTH = 120; // 60 moves of two characters

  function isValidAnnouncement(data) {
    return !!data &&
      (data.side === 'b' || data.side === 'w') &&
      typeof data.g === 'number' && data.g >= 0 && Math.floor(data.g) === data.g &&
      typeof data.moves === 'string' && data.moves.length <= MAX_MOVES_LENGTH;
  }

  function isPrefix(shorter, longer) {
    if (shorter.length > longer.length) return false;
    for (var i = 0; i < shorter.length; i++) {
      if (shorter[i] !== longer[i]) return false;
    }
    return true;
  }

  // Compares our game ({ g, moves: [...] }) with an announcement from the
  // opponent, who plays `opponentColor`. Returns one of:
  //   { action: 'adopt', g, moves }  take the opponent's version
  //   { action: 'same' }             nothing to do
  //   { action: 'ahead' }            ours is newer; re-send it to them
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
        return { action: 'reject', reason: 'Your games have diverged.' };
      }
      base = local.moves;
    }

    var game = Reversi.replay(remoteMoves);
    if (game.error) return { action: 'reject', reason: game.error };
    for (var i = base.length; i < game.players.length; i++) {
      if (game.players[i] !== opponentColor) {
        return { action: 'reject', reason: 'Your opponent tried to move for you.' };
      }
    }
    return { action: 'adopt', g: remote.g, moves: remoteMoves };
  }

  // Joins the room for `roomId` as `side` ('b' or 'w'). `handlers` provides:
  //   getState()          -> current { g, moves: "d3c5..." } to send to peers
  //   onConnect()            an opponent connected (or a new one took over)
  //   onDisconnect()         the opponent left and nobody else can take over
  //   onSync(data)           the opponent announced their game
  //   onSideClash(active)    whether another peer claims the same colour as us
  //   onError(message)       connection failed
  // Resolves to { announce(), leave() }.
  //
  // The first peer with the other colour becomes the opponent, and stays the
  // opponent until they leave, so a third tab can't take over a game. Other
  // peers with that colour wait as candidates; one of them takes over when
  // the opponent leaves (for example, the opponent reloading the page).
  function connect(roomId, side, handlers) {
    return import(LIBRARY_URL).then(function (trystero) {
      var room = trystero.joinRoom({ appId: APP_ID }, roomId, {
        onJoinError: function (details) {
          handlers.onError(details && details.error ? String(details.error) : 'Connection failed.');
        }
      });
      var syncAction = room.makeAction('sync');
      var opponentId = null;
      var candidates = {}; // peerId -> latest announcement, other colour only
      var clashing = {};   // peerIds claiming our colour

      function announcement() {
        var state = handlers.getState();
        return { g: state.g, moves: state.moves, side: side };
      }

      function setOpponent(peerId) {
        opponentId = peerId;
        handlers.onConnect();
        handlers.onSync(candidates[peerId]);
      }

      room.onPeerJoin = function (peerId) {
        syncAction.send(announcement(), { target: peerId });
      };

      room.onPeerLeave = function (peerId) {
        if (clashing[peerId]) {
          delete clashing[peerId];
          handlers.onSideClash(Object.keys(clashing).length > 0);
        }
        delete candidates[peerId];
        if (peerId !== opponentId) return;
        opponentId = null;
        var next = Object.keys(candidates)[0];
        if (next) {
          setOpponent(next);
          syncAction.send(announcement(), { target: next });
        } else {
          handlers.onDisconnect();
        }
      };

      syncAction.onMessage = function (data, meta) {
        if (!isValidAnnouncement(data)) return;
        var peerId = meta.peerId;
        if (data.side === side) {
          if (!clashing[peerId]) {
            clashing[peerId] = true;
            handlers.onSideClash(true);
          }
          return;
        }
        candidates[peerId] = data;
        if (opponentId === null) setOpponent(peerId);
        else if (peerId === opponentId) handlers.onSync(data);
      };

      return {
        announce: function () {
          if (opponentId) syncAction.send(announcement(), { target: opponentId });
        },
        leave: function () {
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
    connect: connect,
    createRoomId: createRoomId
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReversiOnline;
  } else {
    root.ReversiOnline = ReversiOnline;
  }
})(this);
