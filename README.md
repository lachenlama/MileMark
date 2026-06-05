# MileMark

A Strava-but-quieter run app for **Not Another Cafe**. People sign up for a run on a
set date, and their name lands on the wall. No medals, no leaderboard flexing —
just the road and whoever shows up.

This is the **skeleton**. It works end-to-end but stores everything on-device for now.

## Run it locally

The service worker (what makes it installable + offline) only runs over `http://`,
not by double-clicking the file. So:

```bash
node server.js
# → http://localhost:4173
```

Open that on your laptop, or on your phone over the same Wi-Fi
(`http://<your-laptop-ip>:4173`).

## Install on a phone

- **Android / Chrome:** an `install` button appears in the top bar, or use
  the browser menu → "Install app".
- **iPhone / Safari:** tap **Share → Add to Home Screen**. It opens fullscreen
  like a native app.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app — profile/level card, featured run + map, run cards, register, wall |
| `admin.html` / `admin.js` | **Route builder.** Tap the map to draw a run's route, set details, save |
| `data.js` | Shared data layer — runs, runners, profiles, points/levels, route helpers |
| `app.js` | Main page logic |
| `styles.css` | Look & feel — dark / red / yellow palette |
| `manifest.webmanifest` | PWA install metadata |
| `sw.js` | Service worker (offline shell cache) |
| `server.js` | Tiny local static server |
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

## Roadmap (next prompts)

- [ ] **Real backend** — sign-ups, runs, and profiles live in each browser's
      localStorage, so phones don't share state yet. Wire it to a shared store
      (the NotACafeGG `server.js` + Upstash Redis pattern) so everyone sees the
      same wall and leaderboard.
- [ ] **Auth for admin** — anyone can open `/admin.html` right now.
- [ ] **Swap to Google Maps** once an API key exists (see above).
- [ ] **Leaderboard** — rank runners by points across runs.
- [ ] **Post-run log** — photos + a sentence each, the confessional feed.
- [ ] **Push reminders** — "we run in 12 hours."
```
