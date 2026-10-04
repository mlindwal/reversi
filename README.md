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
- **Online**: real-time play with a friend. Choosing it creates a game and a link such as `…/#room=k7m2x9pqae`; send it to your opponent. You play Black and the first person to open the link plays White. Anyone else who opens it watches.

Also: move hints (can be turned off), automatic passes, undo (not in online games), live score and a game-over result.

## Hosting

Online play needs the page at a public URL so your opponent can open it. Any static host works, for example GitHub Pages: in the repository's **Settings → Pages**, choose "Deploy from a branch", pick the default branch and the root folder, and share the URL it gives you.

It also needs a secure page (`https://`, or `http://localhost` for testing), because browsers only allow the encryption it uses there.

## How online play works without a backend

The browsers connect directly to each other with WebRTC, using the [Trystero](https://github.com/dmotz/trystero) library.

- To find each other, they post short, encrypted connection messages on public [Nostr](https://nostr.com/) relays, which are servers run by other people. After that, everything travels directly between the browsers.
- The game link only holds the room ID. Every player keeps the moves and sends the whole move list to the others after each change, so anyone who reconnects catches up.

### Coming back to a game

Each browser saves its online games (room, colour and moves) in local storage for 30 days.

- **Same browser:** open the game link again, or use **Resume** on the start page, which lists recent online games.
- **Another device or a private window:** open the game link. If your seat is free, you take it and the game is copied from your opponent. While you're away, anyone watching sees a **Play as …** button for your seat (it is never taken automatically), so it's best to come back promptly.
- **Two tabs in one browser:** each tab gets its own seat, so you can test a game against yourself.

Your opponent must have the game open for you to reconnect. Nothing is stored on a server, so if both players lose their saved copies, the game is gone.

### Fair play

Each browser checks every move it receives against the rules, and refuses moves that would be made on its player's behalf.

If your saved copy is out of date (for example, you continued the game on another device), the page says your copies don't match and offers **Use their version**. If you rejoin without a saved copy, you accept your opponent's version of the game, so in that one case you rely on their honesty.

### Connection problems

- Some strict networks (certain corporate, school or mobile networks) block direct browser-to-browser connections. Fixing that requires a TURN relay server, which this project does not include.
- Trystero occasionally leaves a connection half-open: one side thinks it's connected, the other doesn't. The page detects this, because a healthy peer always sends something straight away, and reconnects. That usually takes under 20 seconds.

Trystero is bundled in `vendor/trystero-nostr.mjs` rather than loaded from a CDN, and only loads when you choose online play.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Styling |
| `game.js` | Game rules, move notation, replaying a move list, and the computer player (no DOM; also loadable in Node) |
| `ui.js` | Board rendering, modes, saved games, seats and input handling |
| `online.js` | Online play: connecting through Trystero, finding free seats, and deciding whether to accept another player's game |
| `vendor/trystero-nostr.mjs` | Bundled Trystero library (generated, do not edit) |
| `test/*.test.js` | Tests for the rules, notation and online sync |

## Development

```sh
npm test         # Node's built-in test runner, Node 18+; no install needed
npm install      # only needed to regenerate the bundled library
npm run vendor   # rebuilds vendor/trystero-nostr.mjs from package.json versions
```
