# Audit checklist: what was done

Bat-Viewer is a static, client-only site (no server code, no database, no accounts, no emails, nothing for sale). So each item is one of:

- **Done**: changed in this repository.
- **N/A**: there is nothing for it to apply to. Where a real equivalent exists in a static app, it is listed instead.
- **You**: needs a decision or a fact that only you can supply.

## Measured result

Lighthouse 13.5, run against `npm run build` output served by `serve.js dist` (mobile = Lighthouse's simulated slow-4G phone, empty gallery):

| | Before (mobile) | After (mobile) | Before (desktop) | After (desktop) |
| --- | --- | --- | --- | --- |
| Performance | 75 | **100** | 90 | **100** |
| Accessibility | 86 | **100** | 86 | **100** |
| Best practices | 100 | **100** | 100 | **100** |
| SEO | 91 | **100** | 91 | **100** |
| Largest Contentful Paint | 12.6 s | **1.0–1.2 s** | 2.1 s | **0.3 s** |
| Layout shift (CLS) | 0.038 | **0** | 0.001 | **0** |
| Page weight | 2,295 KB | **132 KB** | 2,295 KB | **242 KB** |

Beyond Lighthouse: an axe-core sweep of 44 page states (both themes, phone and desktop: first visit with the banner, empty, loaded with a failed item, 260 links, Edit panel, Common Notes, Help, banner reopened, Delete-my-data armed, plus the three policy pages and the 404 page) finds 0 violations. Each state is checked twice, on the darkest and on the brightest backdrop the wallpaper can produce, because axe cannot see through a photo (88 runs). `npm test` runs 296 checks (your original 22 fallback checks pass unchanged); `npm run test:browser` adds 46 in real Chromium.

## Edit mode: cut-off pictures and hidden buttons (fixed after your feedback)

**What was wrong.** A turned picture or video kept the room of the *un-turned* one, so in Edit mode it stuck out of its card: it overlapped the header and covered the Edit and Note buttons. The Edit panel was also a side panel that covered part of the page.

**What changed.**

- A turned image or video is fitted inside its card as a picture of its new shape, at every Image Size and every angle, while editing and after **Done** (`RotateFit` in `app.js`; the picture box no longer clips or overflows).
- The Edit panel is now a bar along the bottom of the window (compact on a phone). The page keeps its width, so nothing reflows. The card being edited is scrolled above the bar and, if the window is short, its picture is shown a little smaller so the whole card (header, picture, link, **Copy Link / Edit / Note / Remove**) stays visible. **Done**, **Cancel** and `Esc` put everything back.
- On a phone the top bar scrolls away while the bar is open, so the picture keeps most of the screen. The back-to-top button is hidden meanwhile.

**Checked.** A matrix of 600 cases (3 window sizes × 5 Image Sizes × 5 angles × 4 pictures and videos, each while editing and after Done) finds nothing cut off, overflowing or covered; the browser test has 10 new checks for it.

## The 38 items

| # | Item | Status | What / where |
| --- | --- | --- | --- |
| 1 | Cache API responses | N/A | There is no API. The nearest thing, the optional `HEAD` request that guesses whether a link is an image or a video, is remembered per link (`ProbeCache`) and sent with `cache: 'force-cache'`. |
| 2 | Load balancer | N/A | Static files, no server to balance. GitHub Pages (or any CDN) already spreads the load. |
| 3 | Index the database | N/A | No database. |
| 4 | Compress images | Done | Wallpaper 2.1 MB → 105 KB (phones) / 215 KB (desktop) as AVIF, with WebP fallback, picked by screen width (`assets/`). Logo 8.3 KB → 1.3 KB. Regeneration recipe in `ASSETS.md`. Your pasted media is not touched. |
| 5 | Loading skeletons | Done | Every card slot shows a shimmer skeleton with reserved height while its media loads, and while a lazily loaded chunk (e.g. the video player) is on its way. Stops for `prefers-reduced-motion`. |
| 6 | Cache expensive queries | Done | Link-type detection is memoized (bounded, cleared with Clear) and probe results are cached per link. |
| 7 | N+1 database queries | N/A | No database. The same trap in a browser is one network request per card, so type probes run at most 4 at a time, once per link, and are dropped when a card scrolls away. |
| 8 | Debounce input handlers | Done | Link counter in the textarea (150 ms debounce); the size and global-speed sliders and the back-to-top button are animation-frame throttled. |
| 9 | Split code into chunks | Done | The original was one 101 KB script. Now: a core `app.js` (40 KB minified, 12.5 KB brotli) plus four on-demand chunks in `chunks/` (video player, Edit panel, Common Notes, Retry all; 18 KB minified together). Chunks are prefetched on hover/focus; a failed fetch shows a message and can be retried. |
| 10 | Add CDN | N/A | GitHub Pages already serves the site through its CDN. Hashed files are `immutable`, so any CDN in front works as is. No third-party CDN is used for scripts or fonts, on purpose (see item 28). |
| 11 | Server-side caching | Done | `serve.js`: ETag/304, one-year `immutable` for hashed files, revalidation for the rest, bounded in-memory cache of files and their compressed forms. GitHub Pages does the equivalent itself. |
| 12 | Paginate large lists | Done | 100 cards per page. Scrolling near the end loads the next 100; **Load more** and **Load all** buttons and a "Showing X of Y" line cover keyboard and screen-reader users. |
| 13 | Lighthouse audit | Done | See the table above. |
| 14 | Compress API payloads | N/A | No API. Text files are served as brotli/gzip by `serve.js` (GitHub Pages gzips on its own); the critical path is 21.5 KB brotli. |
| 15 | Unnecessary re-renders | Done | The size slider writes CSS variables once instead of touching every card; a card is rebuilt only when its type or state changes; one `IntersectionObserver` for the whole gallery; `will-change` only while zooming. |
| 16 | Minify JS and CSS | Done | `build.js` (esbuild) → `dist/` with content-hashed file names. All JavaScript (core and chunks) is 58 KB minified, against 101 KB shipped raw before; CSS is 36 KB minified (6 KB brotli), against 43 KB raw. |
| 17 | Add lazy loading | Done | Images and videos exist only for cards near the viewport and are released when scrolled far away; code chunks load on first use; the wallpaper size is chosen by viewport. |
| 18 | Defer non-critical scripts | Done | `app.js` loads with `defer`; everything else arrives on demand; there are no third-party scripts. |
| 19 | Unused dependencies | Done | Runtime has none (it had none before). Dev-only: `esbuild` and `jsdom` (MIT), never copied to `dist/`. Dead CSS rules that never applied were removed. |
| 20 | Database connection pooling | N/A | No database. |
| 21 | Privacy policy | Done | `privacy.html`, written from what the code does and checked against it. |
| 22 | Terms of service | Done | `terms.html`. |
| 23 | Refund policy | N/A | Nothing is sold; `terms.html` §4 says so. Add one only if you add paid features. |
| 24 | Cookie policy | Done | `cookies.html`: the site sets no cookies; it lists the two `localStorage` items. |
| 25 | Cookie consent banner | Done | Asks before the theme is saved. **No thanks** and **Allow** look the same; nothing is stored before an answer; **Privacy settings** in the footer reopens it. |
| 26 | Check form consents | Done | The only input is the link box. It collects no personal data, has no pre-ticked boxes, and carries a one-line disclosure (your browser fetches each link from its host; nothing is uploaded). Storage consent is its own choice, not bundled. |
| 27 | No unnecessary data | Done | Nothing is collected or sent. At most the theme and the banner answer are stored, on your device only. |
| 28 | Audit third-party SDK | Done | There were none and none were added. A Content-Security-Policy (`script-src 'self'; style-src 'self'`) makes the browser refuse any script or stylesheet from elsewhere; the browser test fails on any CSP violation. Media and probe requests are open to any host because loading arbitrary links is the app's purpose. |
| 29 | Remove dark patterns | Done | None found in the original. The new banner has equal-weight choices, no nagging and no hidden opt-out. **Delete my data** asks for a second click only to prevent accidents. |
| 30 | Remove fake reviews | N/A | The app has no reviews, ratings, testimonials or counters (checked). |
| 31 | Remove unsupported claims | Done | The README said "Fully responsive (5 → 4 → 3 → 2 → 1 columns)"; the column count is set by the size slider, not by screen width, so the claim is gone. The new README, page text and policies avoid claims the code does not back up. |
| 32 | Accessibility alt text | Done | Every loaded image gets alt text (file name or host) and every video an `aria-label`. The header logo is decorative (empty alt) because the "Bat-Viewer" heading beside it says the same; other decorative glyphs are `aria-hidden`; the wallpaper is CSS. |
| 33 | Fix color contrast | Done | Text and controls meet WCAG AA in both themes, including over the wallpaper (colour tokens in `style.css`; axe sweep above reports 0 contrast violations). |
| 34 | Keyboard navigation | Done | Skip link, visible focus ring, every control labelled and reachable, `Esc` closes Help / Edit / Common Notes and returns focus, Common Notes is a native dialog (focus stays inside), `Space` presses a focused button (and still plays the hovered video otherwise), focus moves to the next card after Remove. |
| 35 | Add business details | You | The operator is named as the GitHub user `aakashsharma-ux` with the profile as the contact route, in the footer, all policies and `LICENSE`. No postal address or email was added: you did not give one, and these pages are public. How to add them: README, "Maintaining the legal pages". |
| 36 | Unsubscribe link in emails | N/A | The site sends no email. |
| 37 | License fonts/images | You | Fonts: none shipped (system fonts). Code: MIT (`LICENSE`). **The bat logo and the Batman wallpaper are third-party artwork whose licence nobody can show**; code cannot fix that. `ASSETS.md` lists the options (replace, get permission, or remove). |
| 38 | Data deletion request | Done | **Delete my data** in the footer wipes the gallery, notes, edits, Common Notes text, saved theme and banner answer. Nothing is held on a server, and `privacy.html` explains that. |

## Left for you

1. **Artwork** (item 37). Decide what to do with the logo and wallpaper before publishing widely.
2. **Operator details** (item 35). Add a name, address or email if you want them shown, and if your situation requires them.
3. **LICENSE** names `aakashsharma-ux` as the copyright holder; change it if it should be someone else.
4. **Legal pages** are plain-language texts matched to the code, not legal advice. If Bat-Viewer ever becomes commercial or starts storing or sending anything, update them in the same commit and have them reviewed.
5. **Pages setting**: Settings → Pages → Source = **GitHub Actions** (the workflow builds and deploys `dist/`).
6. **404 page**: on GitHub Pages it is served for any missing address; one level deep it is styled correctly, deeper paths show it unstyled because its CSS is linked relatively.
