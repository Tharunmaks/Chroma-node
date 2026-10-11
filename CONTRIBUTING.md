# Contributing to Chroma

Thanks for helping! Chroma is plain JavaScript (ES modules, no build step) on Node 22.5+.

```sh
git clone https://github.com/Tharunmaks/Chroma-node && cd Chroma-node
npm install
npm run dev        # http://127.0.0.1:3000, restarts on change
npm test           # node:test, no extra tooling
```

## Where things live

| Path | What |
| --- | --- |
| `server/` | HTTP app, auth, deployments, database, analytics, functions (no framework) |
| `bin/chroma.js` | CLI |
| `web/` | Pages (`*.html` with `<!--#head-->`/`<!--#nav-->`/`<!--#footer-->` partials) and `assets/` |
| `web/assets/js/helix/` | Helix engine, model catalogue (`catalog.js`), 4D geometry (`four.js`) |
| `templates/` | Project templates (`template.json` + files) |
| `test/` | Tests — please add one with every change |

## Adding a model family

1. Add an object to `web/assets/js/helix/catalog.js` with `id`, `name`, `dims`, `count`,
   `description`, `params`, `fromIndex(i)`, `label(params)` and `build(params, quality)` (3D,
   returns a `BufferGeometry`) or `build4(params)` (4D, returns `{ verts, edges }`).
2. Register it in `FAMILIES`, add its id to `MODEL_FAMILIES` in `server/models.js` and a hue in
   `helix/thumbs.js`.
3. `npm test` checks that the first, middle and last model of every family build finite geometry.

## Ground rules

* Keep the strict CSP: no inline scripts or styles in pages, no `eval` outside the `*-worker.js` files.
* User-controlled text goes into the DOM with `textContent` (the `h()` helper), never `innerHTML`.
* Security-sensitive changes (auth, uploads, sandboxing) need a test that tries to break them.
* Small, focused pull requests are easiest to review.

By contributing you agree your work is released under the MIT license.
