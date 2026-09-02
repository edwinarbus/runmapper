# runmapper

Type a word or upload a logo, drop a pin anywhere in the world, pick a distance, and get a running route whose GPS trace draws it. Load the GPX into Strava, Garmin or your watch, run the line, and the orange map in your activity is the drawing.

```
  words / image  +  a spot on the map  +  ~5K / ~10K / longer
                          │
                          ▼
   strokes → sized to the local blocks → laid onto real streets → scored → GPX
```

Everything is plain geometry and graph search on OpenStreetMap data. **No AI API is needed** (see [Do I need an AI API?](#do-i-need-an-ai-api)).

## What's in the repo

| Path | What it is |
|---|---|
| `engine/` | Python package `runmapper_engine`: the route engine, a CLI, and a FastAPI service |
| `engine/runmapper_engine/font.py` | The grid font for typed phrases and the walk optimiser that draws each letter as one retraced line |
| `engine/runmapper_engine/image.py`, `svgin.py` | Image and SVG tracing: filled outline or single centreline, chosen by how bold the shape is |
| `engine/runmapper_engine/pipeline.py` | The end-to-end plan: sizes from the distance bucket, street fetch, placement scan, snapping, verdict |
| `engine/runmapper_engine/api.py` | `POST /api/plan` streams progress then the result; `POST /api/estimate`; `GET /api/health` |
| `engine/Dockerfile`, `engine/modal_app.py` | Two ways to host the engine |
| `web/` | Next.js 16 app: the form, the MapLibre map, progress, result card, GPX download |

## Run it on your computer

You need Python 3.11+ and Node 20+.

**1. The engine (API) — terminal one**

```bash
cd engine
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn runmapper_engine.api:app --reload --port 8000
```

Check it: open http://localhost:8000/api/health.

**2. The web app — terminal two**

```bash
cd web
npm install
cp .env.example .env.local        # points the app at http://localhost:8000
npm run dev
```

Open http://localhost:3000, type `RUN`, search a place (or click the map), pick ~5K, and hit **Map my run**.

**Command line, no web app**

```bash
cd engine
runmapper "HELLO" --lat 40.7410 --lon -73.9897 --bucket 10k --out out/     # Flatiron, New York
runmapper logo.png --lat 51.5220 --lon -0.1250 --bucket 10k --out out/    # Bloomsbury, London
runmapper "SF" --lat 37.7647 --lon -122.4270 --bucket 5k --out out/        # Dolores Park, San Francisco
```

Writes `out/<name>-<bucket>.gpx`, a `.json` with the stats and cue sheet, and a `.png` preview (streets grey, target dashed blue, route Strava orange).

**Tests**

```bash
cd engine && pytest          # offline: synthetic street grid, font, tracing
cd web && npm run lint && npx tsc --noEmit && npm run build
```

## Put it on the internet (runmapper.run)

Two pieces: the Python engine on a host that allows a request to run for a couple of minutes, and the Next.js app on Vercel. Pick **one** of the engine options.

### Engine, option A: Railway (Dockerfile, click-through)

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, choose the repo.
3. In the service settings set **Root Directory** to `engine`. Railway builds `engine/Dockerfile`.
4. Add a **Volume** mounted at `/cache` (keeps fetched street data between requests).
5. Under **Networking**, generate a public domain. That URL is your `API_URL`, e.g. `https://runmapper-engine.up.railway.app`.

Render and Fly.io work the same way with the same Dockerfile (Fly: `fly launch` inside `engine/`).

### Engine, option B: Modal (one command, scales to zero)

```bash
pip install modal
modal setup                          # once; logs you in
modal deploy engine/modal_app.py     # prints the URL, ends in .modal.run
```

That URL is your `API_URL`.

No laptop needed: the workflow in `.github/workflows/deploy-engine.yml` runs the same command on every push that touches `engine/`. Create a token at modal.com → Settings → API tokens, add it to the GitHub repo as the secrets `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, then run the workflow once from the Actions tab; the URL is in the job summary.

### Why the engine isn't a Vercel function

Its Python dependencies (numpy, scipy, scikit-image, Pillow) unpack to about 320 MB, above Vercel's 250 MB limit for a function, and a route can take a minute of CPU with a street cache that should outlive one request. Hence a separate host. The Next.js app itself is a normal Vercel project.

### Web app on Vercel

1. In Vercel: **Add New → Project**, import the repo, set **Root Directory** to `web`.
2. Environment variable: `NEXT_PUBLIC_API_URL` = your `API_URL` (no trailing slash).
3. Deploy. Then **Settings → Domains → add `runmapper.run`** and point the domain's DNS at Vercel as it instructs.

Deployed the web app before the engine? The page shows an amber notice saying no engine is configured. `NEXT_PUBLIC_API_URL` is baked in at build time, so after adding it under **Settings → Environment Variables** trigger a new deployment (**Deployments → ⋯ → Redeploy**); a saved variable alone changes nothing.

Optional engine environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `RUNMAPPER_CORS_ORIGINS` | `*` | Comma-separated origins allowed to call the API; set to `https://runmapper.run` once live |
| `RUNMAPPER_MAX_JOBS` | `2` | Routes computed at the same time per instance; extra requests wait |
| `RUNMAPPER_CACHE` | `.cache` | Directory for cached street data |
| `RUNMAPPER_OVERPASS_MIRRORS` | four public mirrors | Comma-separated Overpass endpoints, tried in order |
| `RUNMAPPER_ELEVATION` | `1` | Set `0` to skip the elevation lookup |

The web app accepts `NEXT_PUBLIC_MAP_STYLE` to swap the basemap (default: OpenFreeMap's Positron, no key).

## How it decides

- **Text** uses a purpose-built grid font: every letter lives on a 2×3 lattice, so on a street grid a letter is two blocks wide and two tall, with its middle bar on the street between; slanted letters (K, N, R, V, Y, Z, 7) have rectilinear forms because diagonals never survive a grid. Once the local block spacing is measured, each letter column and row is assigned to a real street line (so a grid that drifts still works), every corner is checked against a real intersection, and the route is snapped on street centrelines only. Both grid orientations are tried, which is how text on Manhattan's long blocks ends up running along the avenues. Each letter is one continuous line that retraces itself where needed (Strava overdraws retraced streets, so repeats are invisible), and the letters are chained along the bottom into one underline. When no lattice fits the streets at all, a free-floating placement is used and never called better than "rough". Max **12 characters**; A–Z, 0–9, space and `! ? - . ' +`.
- **Text that doesn't fit**: letters need whole blocks, so a phrase has a minimum length that depends on the local block size. When it exceeds the distance you picked, the app says how many miles it needs and offers the next distance up with one click.
- **Images** become either the filled outline (bold marks) or the skeleton centreline (thin marks and line drawings). The choice comes from the measured stroke thickness: two edges closer than about a block would land on the same street, so a thin mark is drawn as one line.
- **Size** comes from the distance bucket: the drawing is scaled as large as the cap allows (~5K ≤ 3.6 mi, ~10K ≤ 6.8 mi, longer ≤ 13.5 mi), never smaller than what stays readable after GPS wobble. If a phrase or image cannot fit at a readable size, the app says so before touching any street data.
- **Placement**: streets within about a mile of the pin come from Overpass, the dominant grid angle and block spacing are measured, and a few hundred placements (position × size × rotation) are scored by how close the ideal strokes lie to real streets. The best few are snapped with a corridor-restricted Dijkstra that hugs each stroke, joined by connectors that retrace existing ink, and closed into a loop when asked.
- **Verdict**: the route and the target shape are rasterised as thick lines and compared (IoU). "Great", "good", "rough", or an honest "hm, try somewhere else". Small letters on coarse blocks and wandering (non-grid) streets are capped at "rough" because they never come out crisp.
- **Numbers**: distance is great-circle along the route; climb comes from opentopodata (USGS 10 m in the US, EU-DEM in Europe, SRTM 30 m elsewhere) and is omitted if the lookup fails. The site shows kilometres and metres everywhere except US, Liberian and Myanmar locales, with a mi/km toggle in the header; the API always returns both.

Typical run: 3–30 s, most of it waiting for Overpass the first time an area is used.

## Do I need an AI API?

No. Nothing in the pipeline is a language or vision model: the font is data, tracing is classical image processing (thresholding, contours, skeletonisation), placement is a search, snapping is Dijkstra, and the verdict is a pixel overlap. It runs the same every time and costs nothing per request beyond compute.

Where a model *could* help later, as an optional extra:

- Cleaning up messy uploads (a photo of a logo, a busy multi-colour mark) into a simple shape before tracing.
- Turning a prompt like "a cat" into a line drawing to run.

Neither is needed for words or for logos that are already clean shapes.

## Limits and honest notes

- Public Overpass mirrors are rate-limited and occasionally slow or down; the engine retries across mirrors and caches each area for 30 days. For serious traffic, self-host Overpass or point `RUNMAPPER_OVERPASS_MIRRORS` at a paid instance.
- The public opentopodata instance allows one call per second; the engine uses at most three per route.
- Diagonal letters (K N Q R V X Y Z 0 7) need bigger letters than rectilinear ones to read on a grid. A word full of them may need the next distance up.
- Cities without a grid (old European centres) rarely produce crisp text; the app will tell you.
- Map tiles are OpenFreeMap; street data © OpenStreetMap contributors (ODbL).
