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
| `engine/runmapper_engine/image.py`, `svgin.py`, `raster.py` | Image and SVG tracing: filled outline or single centreline, chosen by how bold the shape is (thinning and contour tracing in plain numpy) |
| `engine/runmapper_engine/pipeline.py` | The end-to-end plan: sizes from the distance bucket, street fetch, placement scan, snapping, verdict |
| `engine/runmapper_engine/api.py` | `POST /api/plan` streams progress then the result; `POST /api/estimate`; `GET /api/health` |
| `web/` | Next.js 16 app: the form, the MapLibre map (streets or satellite, with the route drawn in start to finish), progress, result card, GPX download |
| `web/api/index.py`, `web/scripts/vercel-install.sh`, `web/vercel.json` | The engine as a Vercel Python function inside the same project |
| `engine/Dockerfile`, `engine/modal_app.py` | Optional: host the engine somewhere else |

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
npm run dev                       # proxies /api to the engine on port 8000
```

Open http://localhost:3000, type `RUN`, search a place (or click the map), pick ~5K, and hit **Map my run**. The CLI takes the same options, e.g. `runmapper "RUN" --lat 37.752 --lon -122.492 --bucket 10k --style outline`. To use an engine running somewhere else, set `NEXT_PUBLIC_API_URL` in `web/.env.local` (see `.env.example`).

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

One Vercel project runs both halves: the Next.js app, and the engine as a Python function behind `/api`. (Vercel allows Python functions a 500 MB bundle, streamed responses and 300 s per request, which is what the engine needs.)

1. In Vercel: **Add New → Project**, import this repo, set **Root Directory** to `web`. Nothing else to configure.
2. Deploy. Every push to `main` redeploys.
3. **Settings → Domains → add `runmapper.run`** and point the domain's DNS at Vercel as it instructs.

What happens in the build: Vercel's Python step reads `web/pyproject.toml`, which runs `web/scripts/vercel-install.sh`; that script installs the engine package from this repository at the commit being built, so the function and the page always match. `web/vercel.json` sets the function's time limit. Street data is cached in the function's `/tmp` while an instance stays warm; the first request in a new area waits for Overpass.

The engine settings below can be set as environment variables on the Vercel project (**Settings → Environment Variables**, then redeploy).

| Variable | Default | Meaning |
|---|---|---|
| `RUNMAPPER_CORS_ORIGINS` | `*` | Comma-separated origins allowed to call the API (only matters when the API is on another host) |
| `RUNMAPPER_MAX_JOBS` | `2` | Routes computed at the same time per instance; extra requests wait |
| `RUNMAPPER_CACHE` | `.cache` (`/tmp/runmapper-cache` on Vercel) | Directory for cached street data |
| `RUNMAPPER_OVERPASS_MIRRORS` | four public mirrors | Comma-separated Overpass endpoints, asked in order |
| `RUNMAPPER_OVERPASS_STAGGER` | `12` | Seconds to wait for a mirror before also asking the next one; the first answer wins |
| `RUNMAPPER_ELEVATION` | `1` | Set `0` to skip the elevation lookup |

The web app accepts `NEXT_PUBLIC_MAP_STYLE` to swap the basemap (default: OpenFreeMap's Positron, no key) and `NEXT_PUBLIC_API_URL` to talk to an engine hosted elsewhere instead of its own function.

### Hosting the engine elsewhere (optional)

Useful for a bigger machine or a street cache that survives between requests. Either way, set `NEXT_PUBLIC_API_URL` on the Vercel project to the engine's URL and redeploy.

**Railway (Dockerfile, click-through)**: New Project → Deploy from GitHub repo → set **Root Directory** to `engine` (Railway builds `engine/Dockerfile`) → add a **Volume** at `/cache` → under **Networking** generate a public domain. Render and Fly.io work the same way with the same Dockerfile.

**Modal (scales to zero)**: `pip install modal && modal setup && modal deploy engine/modal_app.py` prints the URL. Or run the workflow in `.github/workflows/deploy-engine.yml` from the Actions tab after adding `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` as repository secrets.

## How it decides

- **Text** uses a purpose-built grid font: every letter lives on a 2×3 lattice, so on a street grid a letter is two blocks wide and two tall, with its middle bar on the street between; slanted letters (K, N, R, V, Y, Z, 7) have rectilinear forms because diagonals never survive a grid. Once the local block spacing is measured, each letter column and row is assigned to a real street line (so a grid that drifts still works), every corner is checked against a real intersection, and the route is snapped on street centrelines only. Both grid orientations are tried, which is how text on Manhattan's long blocks ends up running along the avenues. Each letter is one continuous line that retraces itself where needed (Strava overdraws retraced streets, so repeats are invisible), and the letters are chained along the bottom into one underline. When no lattice fits the streets at all, a free-floating placement is used and never called better than "rough". Max **12 characters**; A–Z, 0–9, space and `! ? - . ' +`.
- **Drawing style** (Auto · Line · Outline, under the input): for words, Line is the grid font above and Outline draws block letters, each letter a closed outline whose strokes are one cell of kx × ky blocks thick, laid on the same lattice so every corner is a street corner (block letters need roughly twice the distance of line letters, and the app says how much before you run anything). For images, Auto picks whichever of the two tracings below matches the picture best, Line forces the centreline and Outline forces the edge.
- **Text that doesn't fit**: letters need whole blocks, so a phrase has a minimum length that depends on the local block size. When it exceeds the distance you picked, the app says how many miles it needs and offers the next distance up with one click.
- **Images** become either the filled outline (bold marks) or the skeleton centreline (thin marks and line drawings). The choice comes from the measured stroke thickness: two edges closer than about a block would land on the same street, so a thin mark is drawn as one line.
- **Size** comes from the distance bucket: the drawing is scaled as large as the cap allows (~5K ≤ 3.6 mi, ~10K ≤ 6.8 mi, longer ≤ 13.5 mi), never smaller than what stays readable after GPS wobble. If a phrase or image cannot fit at a readable size, the app says so before touching any street data.
- **Placement**: streets within about a mile and a half of the pin come from Overpass. The drawing is tried at the pin first: the local grid angle and block spacing are measured, a few hundred placements (position × size × rotation) are scored by how close the ideal strokes lie to real streets, and the best few are snapped with a corridor-restricted Dijkstra that hugs each stroke, joined by connectors that retrace existing ink, and closed into a loop when asked. Then spots whose streets form a clearly more regular grid are tried in bands of distance: within about half a mile, out to about a mile, and the most regular grids out to about 1.6 mi. The result offers up to three answers, nearest first: the best fit close to the pin, a better one a bit farther, and the best fit farther still (a farther answer is only offered when it is at least as good as a nearer one). The card switches the map between them. A run starts at the pin when the drawing is within a quarter mile by street and the walk-on fits the distance (it is built into the route); otherwise it starts at the drawing, with the distance from the pin reported.
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

- Public Overpass mirrors are rate-limited and occasionally slow or down; the engine asks the next mirror when one is slow to answer, falls back on failure, and caches each area for 30 days. Every plan writes one-line timings to the server log (Vercel: the project's Logs tab), including which mirror answered. For serious traffic, self-host Overpass or point `RUNMAPPER_OVERPASS_MIRRORS` at a paid instance.
- The public opentopodata instance allows one call per second; the engine uses at most three per route.
- On Vercel a request may take at most 300 s and carry at most 4.5 MB, so uploads are downscaled in the browser before they are sent, and a route that needs several slow Overpass mirrors in a row can time out; try again a minute later.
- Diagonal letters (K N Q R V X Y Z 0 7) need bigger letters than rectilinear ones to read on a grid. A word full of them may need the next distance up.
- Cities without a grid (old European centres) rarely produce crisp text; the app will tell you.
- Map tiles are OpenFreeMap; the satellite view is Esri World Imagery with Esri's road and place-name reference tiles (attribution shown on the map); street data © OpenStreetMap contributors (ODbL).
