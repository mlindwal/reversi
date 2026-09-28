# Reversi

A playable Reversi (Othello) game written in plain JavaScript, HTML and CSS. It has no dependencies and no build step.

## Play

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Features:

- Play against the computer (Easy / Medium / Hard) or another person on the same device
- Valid moves are highlighted (you can turn this off)
- Turns pass automatically when a player has no legal move
- Undo, live score, and a game-over result

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Styling |
| `game.js` | Game rules and computer player (no DOM; also loadable in Node) |
| `ui.js` | Board rendering and input handling |
| `test/game.test.js` | Rule and AI tests |

## Tests

```sh
npm test   # uses Node's built-in test runner, Node 18+
```
