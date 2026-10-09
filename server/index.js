// The "reversi" Cloudflare Worker. Cloudflare serves the game's files from
// docs/ directly; this code only sees other requests. Online games connect
// with a WebSocket to /rooms/<room id>, which is handed to a Durable Object:
// one per room, holding the game, the seats and every connection to it.
//
// Message protocol (JSON text frames):
//   browser -> server
//     { type: 'hello', token? }          first message; a token reclaims a seat
//     { type: 'move', g, square }        play `square` (e.g. "d3") in game `g`
//     { type: 'claim', side }            a watcher takes a free seat
//     { type: 'newGame' }                seated players only
//     { type: 'ping' }                   keep-alive, answered with { type: 'pong' }
//   server -> browser
//     { type: 'welcome', side, token? }  your seat ('b', 'w' or null when
//                                        watching), with a new token to save
//     { type: 'state', g, moves, seats, watchers }   after every change
//     { type: 'error', message }

import { DurableObject } from 'cloudflare:workers';
import * as Logic from './logic.js';

const ROOM_PATH = /^\/rooms\/([a-z0-9]{4,32})$/;
const MAX_MESSAGE_LENGTH = 1024;
const MAX_CONNECTIONS = 20;
const RATE_WINDOW_MS = 10000;
const RATE_LIMIT = 30; // messages per connection per window
const IDLE_ROOM_MS = 30 * 24 * 60 * 60 * 1000; // rooms unused this long are deleted

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    if (!match) return new Response('Not found', { status: 404 });

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket connection.', { status: 426 });
    }
    // Browsers always send Origin with a WebSocket request. The page's own
    // address is always allowed; other sites only if listed. A script can
    // fake the header, so this only stops other websites using the server.
    const origin = request.headers.get('Origin');
    if (!origin || (origin !== url.origin && !allowedOrigins(env).includes(origin))) {
      return new Response('Origin not allowed.', { status: 403 });
    }

    const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    return room.fetch(request);
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rates = new Map(); // connection -> { start, count }
    // Answered by Cloudflare without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get('game')) || Logic.createGame();
    });
  }

  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response('This game has too many connections.', { status: 429 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    // Hibernatable: the room can sleep while connections stay open.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ side: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, text) {
    if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH || this.overLimit(ws)) {
      ws.close(1008, 'Message rejected.');
      return;
    }
    const message = Logic.parseClientMessage(text);
    if (!message) {
      this.send(ws, { type: 'error', message: 'Unknown message.' });
      return;
    }
    const side = (ws.deserializeAttachment() || {}).side || null;
    if (message.type === 'hello') await this.hello(ws, message.token);
    else if (message.type === 'claim') await this.claim(ws, side, message.side);
    else if (message.type === 'move') await this.move(ws, side, message);
    else if (message.type === 'newGame') await this.newGame(ws, side);
  }

  async webSocketClose(ws, code, reason) {
    this.rates.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.broadcastState(ws);
  }

  async webSocketError(ws) {
    this.rates.delete(ws);
    this.broadcastState(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
    } else {
      await this.ctx.storage.deleteAll();
    }
  }

  // Puts the connection in its seat (by token), in a free seat, or among the
  // watchers. All awaiting happens before deciding, so two connections
  // arriving together can't both be given the same seat.
  async hello(ws, token) {
    const tokenHash = token ? await hashToken(token) : null;
    const newToken = createToken();
    const newTokenHash = await hashToken(newToken);

    let side = Logic.seatForToken(this.game, tokenHash);
    let issued = null;
    if (!side) {
      side = Logic.unassignedSeat(this.game);
      if (side) {
        this.game = Logic.assignSeat(this.game, side, newTokenHash);
        issued = newToken;
      }
    }
    ws.serializeAttachment({ side });
    if (issued) await this.save();
    this.send(ws, { type: 'welcome', side, token: issued });
    this.broadcastState();
  }

  async claim(ws, currentSide, side) {
    const newToken = createToken();
    const newTokenHash = await hashToken(newToken);
    if (currentSide) return this.send(ws, { type: 'error', message: 'You already have a seat.' });
    if (!Logic.canClaim(this.game, side, this.onlineSides())) {
      return this.send(ws, { type: 'error', message: 'That seat is taken.' });
    }
    // Any other connection still holding the old token loses the seat.
    this.game = Logic.assignSeat(this.game, side, newTokenHash);
    ws.serializeAttachment({ side });
    await this.save();
    this.send(ws, { type: 'welcome', side, token: newToken });
    this.broadcastState();
  }

  async move(ws, side, message) {
    if (!side) return this.send(ws, { type: 'error', message: 'Only players can move.' });
    const result = Logic.applyMove(this.game, side, message.g, message.square);
    if (result.error) {
      this.send(ws, { type: 'error', message: result.error });
      this.send(ws, this.state());
      return;
    }
    this.game = result.game;
    await this.save();
    this.broadcastState();
  }

  async newGame(ws, side) {
    if (!side) return this.send(ws, { type: 'error', message: 'Only players can start a new game.' });
    this.game = Logic.startNewGame(this.game);
    await this.save();
    this.broadcastState();
  }

  async save() {
    await this.ctx.storage.put('game', this.game);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
  }

  // Connections that are open, except `excluding` (one that is closing).
  openConnections(excluding) {
    return this.ctx.getWebSockets().filter((ws) => ws !== excluding && ws.readyState === WebSocket.OPEN);
  }

  onlineSides(excluding) {
    const sides = new Set();
    for (const ws of this.openConnections(excluding)) {
      const side = (ws.deserializeAttachment() || {}).side;
      if (side) sides.add(side);
    }
    return sides;
  }

  state(excluding) {
    const connections = this.openConnections(excluding);
    const watchers = connections.filter((ws) => !(ws.deserializeAttachment() || {}).side).length;
    return Logic.publicState(this.game, this.onlineSides(excluding), watchers);
  }

  broadcastState(excluding) {
    const message = this.state(excluding);
    for (const ws of this.openConnections(excluding)) this.send(ws, message);
  }

  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The connection closed meanwhile; its close handler tidies up.
    }
  }

  overLimit(ws) {
    const now = Date.now();
    let rate = this.rates.get(ws);
    if (!rate || now - rate.start > RATE_WINDOW_MS) {
      rate = { start: now, count: 0 };
      this.rates.set(ws, rate);
    }
    rate.count += 1;
    return rate.count > RATE_LIMIT;
  }
}

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
