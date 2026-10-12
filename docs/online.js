// Online play: a WebSocket connection to the game server (server/ in this
// repository, running as the "reversi" Cloudflare Worker). The server keeps
// each game, its seats and the rules; this file only connects, keeps the
// connection alive, reconnects and passes messages along. The message
// protocol is described at the top of server/index.js.
(function (root) {
  'use strict';

  // Where the game server runs. Pages served by the server itself, or locally
  // by `npm run dev`, connect to their own address instead.
  var SERVER_URL = 'https://reversi.lindwall.dev';
  var PING_INTERVAL_MS = 25000;
  var PONG_TIMEOUT_MS = 10000;
  var MAX_RETRY_MS = 15000;

  // Add ?debug to the page URL to log connection events to the console.
  var DEBUG = /[?&]debug\b/.test(location.search);

  function debug() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[reversi ' + new Date().toISOString().slice(11, 23) + ']'].concat(args));
  }

  function serverUrl() {
    var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return local || location.origin === SERVER_URL ? location.origin : SERVER_URL;
  }

  // Connects to a game room and keeps the connection open, reconnecting with
  // growing delays when it drops. `handlers` provides:
  //   hello()            -> the first message to send on every connection
  //   onOpen()              connected
  //   onMessage(message)    a message from the server
  //   onClose()             connection lost; reconnecting
  // Returns { send(message) -> whether it was sent, close() }.
  function connect(roomId, handlers) {
    var url = serverUrl().replace(/^http/, 'ws') + '/rooms/' + roomId;
    var socket = null;
    var stopped = false;
    var retryDelay = 1000;
    var retryTimer = null;
    var pingTimer = null;
    var pongTimer = null;

    function open() {
      clearTimeout(retryTimer);
      debug('connecting to', url);
      var ws = new WebSocket(url);
      socket = ws;
      ws.onopen = function () {
        if (socket !== ws) return;
        debug('connected');
        retryDelay = 1000;
        ws.send(JSON.stringify(handlers.hello()));
        pingTimer = setInterval(ping, PING_INTERVAL_MS);
        handlers.onOpen();
      };
      ws.onmessage = function (event) {
        if (socket !== ws) return;
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (message.type === 'pong') {
          clearTimeout(pongTimer);
          return;
        }
        debug('received', message);
        handlers.onMessage(message);
      };
      // An error is always followed by a close event.
      ws.onclose = function (event) {
        if (socket !== ws) return;
        debug('connection closed', event.code, event.reason);
        dropped();
      };
    }

    function dropped() {
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      socket = null;
      if (stopped) return;
      handlers.onClose();
      debug('reconnecting in', retryDelay, 'ms');
      retryTimer = setTimeout(open, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    }

    // A connection can die without the browser noticing (a phone switching
    // networks, a router dropping it), so check it regularly.
    function ping() {
      if (!send({ type: 'ping' })) return;
      clearTimeout(pongTimer);
      pongTimer = setTimeout(function () {
        debug('no answer to ping');
        var ws = socket;
        dropped();
        if (ws) ws.close();
      }, PONG_TIMEOUT_MS);
    }

    function send(message) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    }

    // Don't wait for the next retry when the network or the tab comes back.
    function retryNow() {
      if (stopped || socket || document.visibilityState === 'hidden') return;
      retryDelay = 1000;
      open();
    }

    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', retryNow);
    open();

    return {
      send: send,
      close: function () {
        stopped = true;
        clearTimeout(retryTimer);
        clearInterval(pingTimer);
        clearTimeout(pongTimer);
        window.removeEventListener('online', retryNow);
        document.removeEventListener('visibilitychange', retryNow);
        if (socket) {
          var ws = socket;
          socket = null;
          ws.close(1000);
        }
      }
    };
  }

  function createRoomId() {
    var alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    var bytes = new Uint8Array(10);
    root.crypto.getRandomValues(bytes);
    var id = '';
    for (var i = 0; i < bytes.length; i++) id += alphabet.charAt(bytes[i] % alphabet.length);
    return id;
  }

  root.ReversiOnline = {
    connect: connect,
    createRoomId: createRoomId
  };
})(this);
