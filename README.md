# MileMark

A Strava-but-quieter run app for **Not Another Cafe**. People sign up for a run on a
set date, and their name lands on the wall. No medals, no leaderboard flexing —
just the road and whoever shows up.

It now has a **shared backend**: every phone sees the same wall, counts, points and
"marks". Storage is one JSON blob in **Upstash Redis** (prod) or a local
`data/db.json` (dev) — the same zero-dependency pattern as the NotACafeGG server.

## Run it locally

The service worker (what makes it installable + offline) only runs over `http://`,
not by double-clicking the file. So:

```bash
cp .env.example .env   # set ADMIN_PASSWORD + SESSION_SECRET
node server.js         # → http://localhost:4173
```

Open that on your laptop, or on your phone over the same Wi-Fi
(`http://<your-laptop-ip>:4173`). With no Upstash vars set, state persists to a
local `data/db.json` (git-ignored) — fine for dev.

## Backend & deploy (Vercel + Upstash)

- `server.js` serves the static PWA **and** a small JSON API at `/api/*`, and
  exports `handleRequest`.
- `api/index.js` re-exports it as a **single Vercel serverless function**;
  `vercel.json` rewrites `/api/:path*` to it. Static files are served by Vercel.
- **Production needs Upstash** — Vercel's filesystem is ephemeral, so set
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (and `ADMIN_PASSWORD`,
  `SESSION_SECRET`) in the Vercel project settings. Without them the API falls
  back to a per-instance temp file that resets on cold starts.

### API

| Method | Route | Who | What |
| --- | --- | --- | --- |
| GET | `/api/state` | public | All runs + each run's wall (marks the current member with `you`) |
| GET | `/api/me` | member | Your profile, points, level, earned badge ids (via cookie) |
| POST | `/api/join` | public | Sign up for a run; awards points, computes badges, sets your member cookie |
| POST | `/api/log` | member | Honor-system: log time/distance/note/Strava for a run you did (only after it's started) |
| GET | `/api/leaderboard` | public | "the regulars" — profiles by points (no UI yet; brand stays anti-flex) |
| POST | `/api/admin/login` · `/logout` · GET `/me` | — | Password-gated admin session |
| POST | `/api/runs` · DELETE `/api/runs/:id` | admin | Create/update/delete runs |

**Identity** is *claim-by-contact*: the insta @ / phone you type at signup is
normalized into your key and remembered with a signed cookie — no login screen.
**Admin** (`/admin.html`) is gated by `ADMIN_PASSWORD`; unauthenticated visits
redirect to `/admin-login.html`.

## Install on a phone

- **Android / Chrome:** an `install` button appears in the top bar, or use
  the browser menu → "Install app".
- **iPhone / Safari:** tap **Share → Add to Home Screen**. It opens fullscreen
  like a native app.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app — profile/level card, featured run + map, run cards, register, wall, "your marks" |
| `admin.html` / `admin.js` | **Route builder** (password-gated). Tap the map to draw a run's route, set details, save |
| `admin-login.html` | Admin password screen (redirected here when not logged in) |
| `data.js` | Client data layer — async API client over `/api`, cached state, badge catalog, route helpers |
| `app.js` | Main page logic |
| `share.js` | Story-card generator (`MMShare`) for shareable "marks" + "i'm in" cards |
| `styles.css` | Look & feel — dark / red / yellow palette, excalidraw-vibe marks |
| `manifest.webmanifest` | PWA install metadata |
| `sw.js` | Service worker (caches the public shell; bypasses `/api/` + admin pages) |
| `server.js` | Static server **+ `/api/*` backend** (Upstash-or-local), exports `handleRequest` |
| `api/index.js` | Vercel serverless entrypoint → `handleRequest` |
| `vercel.json` | Vercel config — rewrites `/api/*` to the function, sets PWA headers |
| `generate-icons.js` | Regenerates the app icons (`node generate-icons.js`) |
| `icons/` | Generated PNG app icons |

## Making a run (admin)

Go to **`/admin.html`** (or tap "admin" in the top bar):

1. **Tap the map** to drop route points — the red line + distance update live.
2. **Drag** a point to move it; **right-click / long-press** a point to delete it.
3. Fill in title, date/time, where; tick "featured" to make it this week's run.
4. **Save**. It shows up on the home page immediately.

## Maps: why Leaflet, not Google (yet)

The map uses **Leaflet + OpenStreetMap** (dark CARTO tiles) so the skeleton runs
with **zero setup**. Google Maps' JS API needs an API key with billing enabled
before it renders anything. When you're ready, swapping to Google Maps is a
contained change in `renderMap()` (app.js) and the builder in `admin.js` — the
route data format (`[[lat,lng], ...]`) stays the same.

## Points & levels

Signing up for a run gives **+50 pts** (once per run). Levels are derived from
total points — edit the `LEVELS` and `POINTS_PER_RUN` config at the top of
`data.js`. Your card at the top of the home page shows level, points, and
progress to the next one.

## Marks (shareable achievements) & the attention layer

The point of MileMark isn't the leaderboard — it's making the runner feel *seen*,
in the cafe's quiet voice. Two directions:

- **The app notices you.** A handwritten "noted" line under your card
  (`you came back — that's the rare part`), and your own name lit up on the wall
  as **← this is you**.
- **You get noticed.** Signing up earns **marks** — small confessional badges
  (`first mark`, `dawn patrol`, `the climb`, `three deep`…). Each renders to a
  hand-drawn, Instagram-Story-sized card (1080×1920) you can **share straight to
  your story** (Web Share API) or save. Earning a new mark pops the card the
  moment you sign up.
- **You finished it.** After a run happens, signed-up runners can **log** what
  they did — time, distance, a one-line confession, an optional Strava link (no
  GPS, honor system). The wall turns into a confessional feed (`ran it · 5.2 km ·
  28:30` + the one-liner), and logging earns the *finish* marks (`first finish`,
  `the long way` ≥10km, `the distance` ≥42km total) — each with its own share card.

The route map shows handwritten **start** / **finish line** labels (a single
**start / finish** for loops), on both the admin builder and the public map.

Where things live (note the **client/server split** — the server decides who's
earned what; the client only holds the copy + the card):

| Concern | File |
| --- | --- |
| Badge **logic** (`ACHIEVEMENT_CHECKS` + `achievementIdsFor`) — server-authored | `server.js` |
| Badge **presentation** (`ACHIEVEMENTS`: name/note/glyph/tone/hint) | `data.js` |
| Story-card generator (excalidraw vibe) + share/download + modal | `share.js` (`MMShare`) |
| "noted" line, "your marks" grid, "this is you" wall highlight | `app.js` |

To add/edit a badge: add its **check** to `ACHIEVEMENT_CHECKS` + `ACHIEVEMENT_ORDER`
in `server.js` (the `ctx` is `{ count, points, titles, hours, bestPos }`, where
`bestPos` = your best position on any wall — so "first 3 to sign up" works), and
its **copy** to the matching `ACHIEVEMENTS` entry in `data.js` (same `id`).
The share card's look lives in `renderCard()` in `share.js`.

> Sharing files via the Web Share API needs **HTTPS** (or `localhost`) — it works
> on the deployed PWA and on `localhost:4173`, then falls back to a PNG download
> on desktop / unsupported browsers.

## Roadmap (next prompts)

- [x] **Real backend** — shared wall, runs, profiles, points & marks via
      `server.js` + Upstash Redis (NotACafeGG pattern). Every phone sees the same state.
- [x] **Auth for admin** — `/admin.html` is password-gated (`ADMIN_PASSWORD`).
- [x] **Leaderboard** — `GET /api/leaderboard` ("the regulars"). Endpoint only;
      no home-page UI yet, on purpose — the brand is anti-leaderboard-flexing.
- [x] **Post-run log** — honor-system: after a run, signed-up runners log time /
      distance / a one-line confession / Strava link (`POST /api/log`). No GPS.
      The wall turns into a confessional feed; logging earns the "finish" marks.
- [ ] **Swap to Google Maps** once an API key exists (see above).
- [ ] **Post-run photos** — attach an image to a log (next step on the confessional feed).
- [ ] **Push reminders** — "we run in 12 hours."
- [ ] **Concurrency** — the whole-DB read-modify-write can race if two people sign
      up in the same instant (fine at cafe-run-club volume; revisit if it grows).
```
