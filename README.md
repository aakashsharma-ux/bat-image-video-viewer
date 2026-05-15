# Bat-Viewer

A Batman-themed image gallery viewer. Paste up to 1,000 image URLs, view them in a responsive grid, and adjust image size dynamically — all in the browser with no backend.

**Live demo:** `https://aakashsharma-ux.github.io/bat-image-viewer/`

---

## Features

- Bulk load up to 1,000 image URLs at once (one per line or comma-separated)
- Auto-replaces previous images on each new load (no manual clearing needed)
- Dynamic image size slider — Tiny to Full-screen (10 presets)
- `object-fit: contain` — images never crop, always shown in full
- Image dimensions shown after load
- Copy Link / Remove buttons per card
- Frosted-glass UI over Batman grunge background
- Back-to-top button
- Append mode to accumulate across multiple loads
- Fully responsive (5 → 4 → 3 → 2 → 1 columns)

---

## File Structure:

```
bat-viewer/
├── index.html        ← Main page
├── style.css         ← All styles
├── app.js            ← All JavaScript
├── batman-logo.png   ← Batman logo (header icon)
├── background.png    ← Grunge background image
└── README.md
```

---



## Local Development

No build step needed. Just open `index.html` directly in any browser:

```bash
# Option 1 — open directly
open index.html

# Option 2 — simple local server (avoids any file:// quirks)
npx serve .
# or
python3 -m http.server 8080
```

---

## Usage

1. Paste one or more image URLs into the text area (one per line or comma-separated)
2. Click **Load Images** — previous images are automatically cleared
3. Use the **Image Size** slider (top-right) to resize all cards at once
4. Check **Append to existing** if you want to add to the current gallery instead of replacing it
5. Click **Copy Link** on any card to copy its URL
6. Click **Remove** to delete a single card

---

## License

MIT — free to use and modify.
