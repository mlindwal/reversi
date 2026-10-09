# Reversi

A playable Reversi (Othello) game written in plain JavaScript, HTML and CSS, with no build step. Online games run on a small Cloudflare Worker.

## Play

The game is the `docs/` folder. Open `docs/index.html` in a browser for computer or same-device games.

To run everything locally, online play included:

```sh
npm install
npm run dev     # then visit http://localhost:8787
```

Opponents:

- **Computer**: Easy, Medium or Hard. You play Black.
- **Human (same device)**: two players take turns on one screen.
- **Online**: real-time play with a friend. Choosing it creates a game and a link such as `…/#room=k7m2x9pqae`; send it to your opponent. You play Black and the first person to open the link plays White. Anyone else who opens it watches.

Also: move hints (can be turned off), automatic passes, undo (not in online games), live score and a game-over result.

## Hosting

The `reversi` Cloudflare Worker, configured in `wrangler.jsonc`, does two jobs: it serves the game from `docs/` on reversi.lindwall.dev, and it runs online games (`server/`). Only the `docs/` folder is published as files.

- **Cloudflare** (reversi.lindwall.dev): in the Worker's build settings, leave the root directory as the repository root; the deploy command is `npx wrangler deploy`. To deploy from your own machine, run `npm install`, `npx wrangler login` and `npm run deploy`.
- **GitHub Pages** (lindwall.info/reversi): in the repository's **Settings → Pages**, choose "Deploy from a branch", then the default branch and the `/docs` folder. This copy connects to reversi.lindwall.dev for online games.

The game server's address is `SERVER_URL` near the top of `docs/online.js`. Pages served from that address, or from `localhost`, use their own address instead.

## How online play works

Each browser opens a WebSocket to the Worker at `/rooms/<room id>`. Every room is a [Durable Object](https://developers.cloudflare.com/durable-objects/), a small piece of Cloudflare that keeps one game:

- **It stores the game:** the moves, the game number (raised by **New game**) and who holds each seat. The game survives everyone closing their tabs. A room is deleted once nothing has happened in it (no moves, new games or seat changes) for 30 days and nobody is connected.
- **It checks every move** with the same rules (`docs/game.js`) the page uses. Only the player whose turn it is can move, and illegal moves are refused.
- **It assigns seats:** the first person in a room plays Black, the next White, and everyone else watches.
- **It sends the full game to everyone in the room after every change.**

The message format is described at the top of `server/index.js`.

### Seats and coming back to a game

Taking a seat gives your browser a secret token, saved in local storage for 30 days. The server keeps only a hash of it. The token is what puts you back in your seat:

- **Same browser:** open the game link again, or use **Resume** on the start page, which lists recent online games.
- **Another device or a private window:** open the game link, and you'll be watching. If your seat's player isn't connected, a **Play as …** button lets you take the seat; the old browser's token then stops working. Anyone watching sees the same button while a player is away, so it's best to come back promptly.
- **Two tabs in one browser:** each tab gets its own seat, so you can test a game against yourself.

### Connection problems

- If the connection drops, the page says so and reconnects by itself, with growing delays up to 15 seconds. It reconnects straight away when the network or the tab comes back. Every 25 seconds it checks that the connection is still alive.
- To see what's going on, add `?debug` to the page URL (for example `…/?debug#room=…`) and open the browser console. It logs connecting, messages and disconnects.

### How the server limits misuse

- WebSocket connections are only accepted from the Worker's own address and from the sites in `ALLOWED_ORIGINS` (`wrangler.jsonc`). That stops other websites from using the server through their visitors' browsers; a script can fake the header, so it's a speed bump, not a lock.
- Each room accepts at most 20 connections, messages of at most 1 KB, and 30 messages per connection per 10 seconds.
- Room IDs are 10 random characters, and seat tokens 128 random bits.

A game is a few dozen small messages, and idle rooms sleep without costing anything (Cloudflare's WebSocket hibernation). Still, set up usage alerts in your Cloudflare account, so any abuse is noticed before it costs anything.

## Files

| File | Purpose |
| --- | --- |
| `docs/` | The game: everything in it is published, nothing else |
| `docs/index.html` | Page layout |
| `docs/style.css` | Styling |
| `docs/game.js` | Game rules, move notation, replaying a move list, and the computer player (no DOM; also used by the server) |
| `docs/ui.js` | Board rendering, modes, saved games, seats and input handling |
| `docs/online.js` | Online play: the WebSocket connection to the server |
| `server/index.js` | The Worker and the `Room` Durable Object: connections, storage, limits |
| `server/logic.js` | Room rules: seats, moves and new games (no Cloudflare APIs; tested in Node) |
| `wrangler.jsonc` | Cloudflare config for the `reversi` Worker |
| `test/*.test.js` | Tests for the rules and the room logic |

## Development

```sh
npm test         # Node's built-in test runner, Node 18+; no install needed
npm install      # installs wrangler, for the two commands below
npm run dev      # runs the Worker locally on http://localhost:8787, game state included
npm run deploy   # deploys the reversi Worker
```
