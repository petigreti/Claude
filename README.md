# Weigh It Up

A weighted decision matrix that runs in the browser. Options go across the top as columns and criteria go down the side as rows. Give each criterion a weight from 1 to 5, score every option from 0 to 10, and the app totals and ranks the options as you type.

## Use it

Open `index.html` in a browser. It needs no build step or server. To serve it locally instead:

```sh
npm start        # runs `npx serve .`
```

The first time it opens, it shows an example ("Which apartment should we rent?") so you can see how it works. Use **Start blank** for a fresh matrix, or **Load example** to bring the sample back. Both can be undone.

- **Add option**: adds a column. **Add criterion**: adds a row. The × next to a name removes it, and the toast that appears lets you undo.
- **Weight**: click one of the five stepped blocks under a criterion (1 is minor, 5 is critical). The radio buttons also work with the arrow keys.
- **Scores**: type 0–10 in each cell. Decimals like `7.5` or `7,5` work. Values outside the range are clamped, and a blank cell counts as 0 and is flagged as blank in the ranking.
- **Keyboard**: in a score cell, Enter moves down the column and Shift+Enter moves up. Enter in a name jumps to its first score.

The matrix saves to `localStorage` in the browser you use, so it's still there when you come back.

## How the score works

For each option:

```
total   = Σ (score × weight)          over every criterion
max     = 10 × Σ weight
percent = total / max
```

Options are ranked by total, highest first. Equal totals share a rank (1, 1, 3), and the ranking shows the tie.

Every score is "higher is better", so rate a criterion like price by how good the option is (cheaper gets a higher score).

## Project layout

```
index.html          page markup
css/styles.css      styles, light and dark themes
js/matrix.js        data model and scoring (pure functions, no DOM)
js/app.js           rendering and event handling
test/               unit tests for js/matrix.js
```

## Tests

```sh
npm test         # node --test, needs Node 18+
```
