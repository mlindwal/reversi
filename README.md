# Reversi

A playable Reversi (Othello) game written in plain JavaScript, HTML and CSS. There is no build step and no backend.

## Play

Open `index.html` in a browser for computer or same-device games. Online play needs the page served from a web server:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Opponents:

- **Computer**: Easy, Medium or Hard. You play Black.
- **Human (same device)**: two players take turns on one screen.
- **Online (live)**: you get an invite link to send to a friend. When they open it, you play in real time. You are Black, they are White.
- **Online (send links)**: turn-based play through any chat app. Make your move, send the link, and your opponent opens it, moves, and sends a link back. Whoever opens a link plays the side to move.

Also: move hints (can be turned off), automatic passes, undo (not in live games), live score and a game-over result.

## Hosting

Both online modes need the page at a public URL so your opponent can open it. Any static host works, for example GitHub Pages: in the repository's **Settings → Pages**, choose "Deploy from a branch", pick the default branch and the root folder, and share the URL it gives you.

Live play also needs a secure page (`https://`, or `http://localhost` for testing), because browsers only allow the encryption it uses there.

## How online play works without a backend

**Send links:** the whole game is the list of moves in the URL, for example `#moves=d3c5f6`. The board is rebuilt by replaying the moves, so nothing is stored anywhere else. This works on the honour system: anyone with a link can play the next move.

**Live:** the browsers connect directly to each other with WebRTC, using the [Trystero](https://github.com/dmotz/trystero) library.

- To find each other, both browsers post short connection messages on public [Nostr](https://nostr.com/) relays, which are servers run by other people. Those messages are encrypted.
- After that, moves travel directly between the two browsers.
- Each player's URL keeps the room, their colour and the moves (`#room=…&side=b&g=0&moves=…`), so a refresh or a dropped connection resumes the game.
- Each browser checks every move it receives with the game rules, and refuses moves made on its player's behalf.
- Some strict networks (certain corporate, school or mobile networks) block direct browser-to-browser connections. Fixing that requires a TURN relay server, which this project does not include.

Trystero is bundled in `vendor/trystero-nostr.mjs` rather than loaded from a CDN, and only loads when you choose live play.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Styling |
| `game.js` | Game rules, move notation, replaying a move list, and the computer player (no DOM; also loadable in Node) |
| `ui.js` | Board rendering, modes, links and input handling |
| `online.js` | Live play: connecting through Trystero and deciding whether to accept the opponent's game state |
| `vendor/trystero-nostr.mjs` | Bundled Trystero library (generated, do not edit) |
| `test/*.test.js` | Tests for the rules, notation and online sync |

## Development

```sh
npm test         # Node's built-in test runner, Node 18+; no install needed
npm install      # only needed to regenerate the bundled library
npm run vendor   # rebuilds vendor/trystero-nostr.mjs from package.json versions
```
