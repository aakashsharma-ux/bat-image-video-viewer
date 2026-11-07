# Assets and licences

What ships with Bat-Viewer, and under what terms. Last reviewed 29 October 2026.

## Code

| Item | Licence |
| --- | --- |
| `app.js`, `chunks/`, `style.css`, `legal.css`, `legal.js`, HTML pages, `serve.js`, `build.js`, tests | MIT, see [`LICENSE`](LICENSE) |

The only third-party code involved is development tooling that is **not** part of the site: `esbuild` and `jsdom` (both MIT) and whatever they depend on. They are listed in `package.json` / `package-lock.json` and never copied into `dist/`.

## Fonts

None are shipped or downloaded. Text uses the visitor's own system font (`system-ui`, `Courier New` / monospace for numbers). The icons are emoji and Unicode symbols drawn by the visitor's operating system, plus a few text glyphs (↺ ✕ ✓). Nothing to license.

## Images

| File | What it is | Status |
| --- | --- | --- |
| `assets/source/batman-logo.png` | Bat emblem used as the header logo and favicon (full-size master) | **Third-party, trademarked artwork. Licence not established.** |
| `assets/source/background.png` | Grunge Batman-themed wallpaper (full-size master) | **Third-party artwork. Source and licence not established.** |
| `assets/logo-96.png` | 96 px version of the logo, made from the master | Same status as the master |
| `assets/bg-1280.avif` / `.webp`, `assets/bg-1920.avif` / `.webp` | Compressed copies of the wallpaper (about 105 KB and 215 KB as AVIF), made from the master | Same status as the master |

**This is the one open item that code cannot close.** The bat emblem is a trademark of DC / Warner Bros. Discovery, and nothing in the repository shows where the wallpaper came from or that it may be republished. The MIT licence covers the code only and says so (see the note at the end of `LICENSE`). The site's footer and terms page already state that the project is unofficial and that the artwork belongs to its owners.

To settle it, pick one:

1. **Replace the artwork** with something you made or that is licensed for reuse (CC0, CC BY with credit, or a paid licence). Put the new masters in `assets/source/`, then regenerate the derived files (commands below) and add a row to the table above with the author, licence and link.
2. **Get written permission** from the rights holder and record it here.
3. **Remove the images.** The page works without them: delete the `body::after` wallpaper rule and the two `<link rel="preload">` lines, and drop the `<img>` in the header.

If the artwork stays, expect that a rights holder can ask for it to be taken down at any time; the terms page already tells them how to ask.

## Regenerating the derived images

`assets/source/` holds the originals and is never deployed (`build.js` copies only the files directly inside `assets/`). Note that the two masters are really JPEG files that carry a `.png` extension (3840×2160 and 512×512); that is how they arrived in the original repository, and browsers and Pillow read them correctly anyway. The derived files were made with [Pillow](https://pypi.org/project/pillow/) (12.x, which reads and writes AVIF and WebP):

```python
# run from the repository root
from PIL import Image
src = Image.open('assets/source/background.png').convert('RGB')
for w in (1280, 1920):
    im = src.resize((w, round(w * 9 / 16)), Image.LANCZOS)
    im.save(f'assets/bg-{w}.avif', 'AVIF', quality=45, speed=4)
    im.save(f'assets/bg-{w}.webp', 'WEBP', quality=38, method=6)
logo = Image.open('assets/source/batman-logo.png').convert('L').resize((96, 96), Image.LANCZOS)
logo.save('assets/logo-96.png', 'PNG', optimize=True)
```

The wallpaper sits under a dark overlay, so it can be compressed much harder than a normal photo without a visible difference. The logo is a white bat on black that the stylesheet inverts for the Night theme, so it is stored as a 96 px greyscale image (it is shown at 28 px, so 96 px covers a 3× screen). Check any new artwork against both themes before shipping.
