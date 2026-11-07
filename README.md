# Bat-Viewer

A Batman-themed viewer for image and video links. Paste up to 1,000 links, browse them in a grid, zoom, adjust brightness, contrast and rotation, take session notes. Everything runs in the browser: no backend, no account, no tracking.

**Live demo:** `https://aakashsharma-ux.github.io/bat-image-viewer/`

---

## Features

- Bulk-load up to 1,000 image or video links (one per line or comma-separated); **Append** adds to the current gallery instead of replacing it
- Image and video cards, with automatic image ⇄ video fallback when a link's type guess is wrong
- Size slider (10 presets, Tiny to Max) and keyboard/slider-controlled auto-scroll
- Scroll-wheel zoom and drag-to-pan (toggle with `Z`)
- Edit panel per card (a bar along the bottom of the window): brightness, contrast, 90° and free rotation (this session only). A turned image or video always stays whole inside its card, at every size, and the card's Copy Link / Edit / Note / Remove buttons stay reachable
- Video player: play/pause, frame step, seek, per-video and global speed, mute, volume, fullscreen, capture frame as an image
- Per-card notes and a global **Common Notes** scratchpad (both cleared on reload)
- Night and Moon themes
- **Retry** for every failed item; **Copy Link** and **Remove** per card
- Long lists load in pages of 100 as you scroll (or with **Load more / Load all**); only the cards near the viewport hold live media

## Quick start

```bash
node serve.js            # serve the source files, http://localhost:3000, nothing to install
```

Any static file server works too (`python3 -m http.server 8080`), and so does opening `index.html` directly.

### Production build

```bash
npm install              # once: esbuild (build) and jsdom (tests)
npm run build            # minified, content-hashed copy of the site in dist/
npm run serve:dist       # serve it the way a host would (compression, caching headers)
```

`dist/` is what gets deployed. Rebuilding changes a file's name only when its content changed, so browsers and CDNs can cache every hashed file for a year.

### Deploying to GitHub Pages

`.github/workflows/static.yml` installs, tests, builds and publishes `dist/` on every push to `main`. In the repository settings, set **Pages → Source** to **GitHub Actions**. Any other static host works the same way: upload the contents of `dist/`. Behind a CDN, keep the default headers from `serve.js` (or copy them): hashed files are `immutable`, everything else is revalidated.

## Keyboard shortcuts

Press the ⌨ button in the top bar for the same list.

| Keys | Action |
| --- | --- |
| `W` `S` or arrow keys | Scroll (hold to speed up) |
| `Z` | Toggle zoom |
| `+` `-` | Image size |
| `F` | Fullscreen |
| `Space` | Play / pause the video you are hovering or have focused (on a focused button it presses the button) |
| `,` `.` | Previous / next frame |
| `J` `L` | Seek −5 s / +5 s |
| `M` | Mute |
| `Esc` | Close Help, the Edit panel or Common Notes |
| `Ctrl/Cmd` + `R` | Reset edits (only while the Edit panel is open) |

## Project layout

```
index.html            the app
style.css             all app styles (Night and Moon themes as colour tokens)
app.js                the core: gallery, paging, zoom, image cards, keyboard, consent
chunks/               code fetched only when first needed
  video-card.js         the video player
  edit-mode.js          the Edit panel
  common-notes.js       the Common Notes dialog
  retry-failed.js       "Retry all failed"
privacy.html  terms.html  cookies.html  404.html  legal.css  legal.js
assets/               compressed wallpaper and logo (assets/source/ = untouched originals, not deployed)
serve.js              zero-dependency static server (compression, ETag, caching, security headers)
build.js              esbuild: minify, content-hash, rewrite references -> dist/
tests/                npm test
ASSETS.md             what each image and font is, and its licence status
docs/CHECKLIST.md     what was changed for each audit item, and what is left for you
LICENSE               MIT (code only; see ASSETS.md for the artwork)
```

Without a build, `app.js` loads `chunks/<name>.js`; the build writes the hashed file names into `<script data-chunks="…">`, which `app.js` reads.

## Privacy and security in short

- No cookies, accounts, analytics, ads or third-party scripts, fonts or SDKs. A Content-Security-Policy (`script-src 'self'; style-src 'self'`) makes the browser enforce that.
- Your links, notes and edits stay in memory and vanish on reload. The theme is stored in `localStorage` only if you press **Allow** on the banner. **Privacy settings** and **Delete my data** are in the footer.
- Media is fetched by your browser straight from the host of each link; that host sees your IP address. See `privacy.html`.

## Tests

```bash
npm test                 # logic tests (jsdom), server, build
npm run test:browser     # optional end-to-end run in real Chromium
```

The browser test needs Playwright, which is deliberately not a dependency: `npm i --no-save playwright && npx playwright install chromium`.

## Maintaining the legal pages and operator details

The operator is named in `index.html` (footer), `privacy.html`, `terms.html`, `cookies.html`, `404.html` and `LICENSE`. They currently give only the public GitHub profile **aakashsharma-ux** as the way to get in touch. To add a business name, postal address or contact email, search those files for `aakashsharma-ux` and edit each place, then update the "Last updated" line in the three policy pages. The policies describe what the code does today; if you add anything that stores or sends data, change them in the same commit.

## Licence

Code: MIT, see [`LICENSE`](LICENSE). The Batman-style logo and wallpaper are **not** covered by it; see [`ASSETS.md`](ASSETS.md) before publishing the site.
