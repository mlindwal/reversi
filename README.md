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

- Some networks (mobile data, many office, school and public networks, some routers and VPNs) block direct browser-to-browser connections. The debug log then shows `could not connect to peer … after exchanging SDP`. The fix is a TURN relay; see below.
- Trystero occasionally leaves a connection half-open: one side thinks it's connected, the other doesn't. The page detects this, because a healthy peer always sends something straight away, and reconnects by itself.
- If nothing happens for 15 seconds, the page offers a **Reconnect** button. Reloading the page works too, since the game is saved.
- To see what's going on, add `?debug` to the page URL (for example `…/index.html?debug#room=…`) and open the browser console. It logs peers connecting, messages and errors.

Trystero is bundled in `vendor/trystero-nostr.mjs` rather than loaded from a CDN, and only loads when you choose online play.

## TURN relay (optional)

When two browsers can't reach each other directly, a TURN server relays their traffic, still encrypted end to end. This project can use [Cloudflare's TURN service](https://developers.cloudflare.com/realtime/turn/). Cloudflare issues short-lived credentials from a secret API token, so a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) in `worker/` creates them. The token is stored in Cloudflare, never in this repository, so the repository can stay public.

Without TURN, the game uses direct connections only. If the Worker can't be reached, the page waits at most 5 seconds and then connects without TURN.

### Setup

You need a Cloudflare TURN key: its **key ID** and **API token**, from the Cloudflare dashboard under Realtime → TURN.

1. Install the Worker's tools and log in to Cloudflare:
   ```sh
   cd worker
   npm install
   npx wrangler login
   ```
2. In `worker/wrangler.toml`, check that `ALLOWED_ORIGINS` lists every address your game is served from: scheme and host only, no path. It currently allows `https://lindwall.info`, `https://reversi.lindwall.dev`, `https://mlindwal.github.io` (GitHub Pages) and `http://localhost:8000` (local testing). An origin covers every page on that host; for example, `https://lindwall.info` also covers `https://lindwall.info/reversi`.
3. Store the secrets in Cloudflare. Each command prompts for the value:
   ```sh
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
4. Deploy:
   ```sh
   npx wrangler deploy
   ```
   This serves the Worker at `https://turn.reversi.lindwall.dev`, set by `routes` in `worker/wrangler.toml`; the `lindwall.dev` domain must be in the same Cloudflare account. To use a different address, change `routes` there.
5. The game asks for credentials at the address in `TURN_CREDENTIALS_URL`, near the top of `online.js`. It's set to `https://turn.reversi.lindwall.dev/`, so it only needs changing if the Worker lives elsewhere. Set it to `''` to turn TURN off. The URL isn't secret.

To check it works, open the game with `?debug` and choose Online. The console should say `joining room … with TURN`.

To run the Worker locally, copy `worker/.dev.vars.example` to `worker/.dev.vars` (git ignores it), fill in the values, and run `npx wrangler dev`.

### How the Worker limits misuse

The Worker's URL is public, since every player's browser calls it. To limit misuse:

- It only answers requests whose `Origin` is in `ALLOWED_ORIGINS`. That stops other websites from using it through their visitors' browsers; a script can fake the header, so it's a speed bump, not a lock.
- It allows 10 requests per minute per IP address.
- Credentials expire after 2 hours (`CREDENTIAL_TTL`), so harvested ones stop working quickly.

TURN is only used when a direct connection fails, and a game sends very little data. Still, set up usage alerts in your Cloudflare account, so any abuse is noticed before it costs anything. If you suspect the API token has leaked, create a new one in the dashboard and run `npx wrangler secret put TURN_KEY_API_TOKEN` again.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Styling |
| `game.js` | Game rules, move notation, replaying a move list, and the computer player (no DOM; also loadable in Node) |
| `ui.js` | Board rendering, modes, saved games, seats and input handling |
| `online.js` | Online play: connecting through Trystero, finding free seats, and deciding whether to accept another player's game |
| `vendor/trystero-nostr.mjs` | Bundled Trystero library (generated, do not edit) |
| `worker/` | Optional Cloudflare Worker that hands out TURN credentials |
| `test/*.test.js` | Tests for the rules, notation, online sync and the Worker |

## Development

```sh
npm test         # Node's built-in test runner, Node 18+; no install needed (also tests the Worker)
npm install      # only needed to regenerate the bundled library
npm run vendor   # rebuilds vendor/trystero-nostr.mjs from package.json versions
```
