# 🏴‍☠️ Pirate Token Chest Tracker

Press a Stream Deck button and the chest count goes up by one, live, on a website hosted free on Cloudflare.

- **`/`** shows the stats dashboard: chests per session and all-time, chests per hour and per match, droughts, a crew leaderboard, charts by day, hour and weekday, token odds, sessions and recent activity.
- **`/control.html`** has big buttons for your phone, settings, and ready-to-copy Companion URLs.
- **`/popout.html`** is the in-game overlay: a small always-on-top counter window that floats over Fortnite on your PC. It needs Chrome or Edge, and Fortnite set to Windowed Fullscreen.
- **`/overlay.html`** is an OBS browser source that animates on each new chest.

**Live at https://chests.studioprompt.net** (backup address: https://chest-tracker.mtcantrell16.workers.dev)

Every press is stored in a Cloudflare Durable Object, so presses never get lost, even when several friends press at the same moment.

## Deploy (about 5 minutes, free plan works)

You need [Node.js](https://nodejs.org) and a free Cloudflare account.

```bash
npm install
npx wrangler login          # opens your browser to sign in to Cloudflare
npx wrangler deploy         # prints your URL, e.g. https://chest-tracker.<you>.workers.dev
npx wrangler secret put ADMIN_KEY   # choose a password that your buttons will use
```

Open the URL. You're live.

### Custom domain
`wrangler.jsonc` routes the site to `chests.studioprompt.net`. Change the hostname there to any domain on your Cloudflare account and deploy again. Cloudflare creates the DNS record and certificate for you.

### How the site files are served
On every deploy, `scripts/build-assets.mjs` bundles `public/` into the Worker, so the whole site is one script. Just edit files in `public/` and deploy again.

## Stream Deck setup (Bitfocus Companion)

1. In Companion, go to **Connections** and add **Generic: HTTP Requests**.
2. Create a button and give it the press action **HTTP Requests: GET**.
3. Paste a URL. The easiest way to get one is to open `/control.html`, type your key and name, and click a URL to copy it.

| Button | URL |
|---|---|
| +1 chest | `https://YOUR-SITE/api/chest?key=KEY&player=Max` |
| +1 rare chest | `https://YOUR-SITE/api/rare?key=KEY&player=Max` |
| +1 match | `https://YOUR-SITE/api/match?key=KEY` |
| Undo last | `https://YOUR-SITE/api/undo?key=KEY` |
| Found the token! | `https://YOUR-SITE/api/token?key=KEY&player=Max` |
| New session | `https://YOUR-SITE/api/session/new?key=KEY&name=Friday` |

- `player=` is optional. Give each friend their own button for the leaderboard.
- `n=3` adds 3 at once, up to 50.
- `undo?type=chests` undoes only the last chest, and `&player=Max` undoes only Max's.
- `&format=text` makes the reply just the number, which Companion can store in a variable and show on the button.
- `GET /api/summary.txt?show=session|total|rare|matches` is a read-only plain-text count.

A session starts automatically with the first chest. Press **New session** at the start of each stream to get per-night stats.

## OBS overlay
Add a **Browser Source** with URL `https://YOUR-SITE/overlay.html`. The background is transparent.
Options: `?show=total` (all-time instead of this session), `&size=150`, `&label=LOOT`, `&bg=1`.

## Token odds
The real drop rate isn't public, so the dashboard shows the chance a crew would have found the token by now at several possible rates (1 in 50 up to 1 in 5000). Set your own guess on the control page and it gets highlighted.

## API reference
Read-only (public): `GET /api/summary`, `/api/data`, `/api/summary.txt`, `/api/export.csv`.
Write actions need `?key=` or an `x-key` header: `chest`, `rare`, `match`, `token`, `add?type=`, `undo`, `delete?id=`, `session/new`, `session/end`, `settings` (title, dropRate, goal), `reset?confirm=RESET`. Both GET and POST work.

## Local development
```bash
echo 'ADMIN_KEY=dev-key' > .dev.vars
npm run dev    # http://localhost:8787
```
