# drawmy.run

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
| `engine/runmapper_engine/api.py` | `POST /api/plan` streams progress then the result; `GET /api/plan/{job}` gives a page that lost the stream the lines it missed; `POST /api/estimate`; `GET /api/health` |
| `web/` | Next.js 16 app: the word on a split-flap board (each letter turns in through the letters before it; a long word takes a second row at a readable size; or a shape drawn on a pad by finger or mouse, or an uploaded image), the MapLibre map (night, day or satellite; the route drawn in start to finish with direction chevrons; replay, recenter, target and zoom keys, all one height; on the satellite map the replay is a flyover: the camera flies the course first person over the terrain, following the tip, then eases back up to the whole route), the Loop and MI/KM switches as rockers on a screwed plate, a real render of a paddle in its bezel baked to a strip of frames of its lean (Loop's with a lamp that lights as the contact passes centre), the start key a real render of a moulded cap (three.js; the scene is in `web/tools/toggle3d/`), a stopwatch while the engine searches, the answers as a pile of race bibs (distance as the bib number, the verdict stamped on, the GPX and GIF on the tear-off stub; the next answer is the whole bib just behind, so dragging the front one aside peeks at it and a throw either way brings it forward, or tap a band or use the arrow keys), the cue sheet as a wrist pace band, and a pin set by tap or link named after the nearest place |
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

Open http://localhost:3000, type `RUN` on the split-flap board (`POST /api/estimate` checks it fits the distance as you type, and returns the strokes for anyone who wants them), search a place (or click the map), pick 5K, and hit **Draw my run**. A URL can carry the setup (`?t=RUN&lat=…&lon=…&d=5k&loop=1&s=line`); opening it fills the form in, and nothing runs until **Draw my run**. **GIF** on the bib's stub renders the route drawing itself in on a hidden 1280 × 720 map of its own (16:9 for X and the like, with the word, the distance and the town large in a wash along the top, the site top right, and the bottom corners left clear for X's GIF badge; the line and its markers are drawn twice as thick as on screen, since the GIF is seen small on a phone), encodes it in the browser with gifenc and, on a desktop, downloads it; nothing on screen moves while it works. The finished frame holds, the line melts away leaving the start dot, and the drawing runs again, so the loop comes round smoothly. On a phone the key reads **Share GIF** and hands the file to the share sheet with nothing else attached (pick X or Messages there and the GIF is in the post); the sheet has to be asked for by the tap itself and a render outlasts a tap, so the first tap renders, the key then reads Ready, and the next tap opens the sheet; the render is kept, so the second tap never renders again. Page views go to Vercel Analytics (`@vercel/analytics`; turn it on for the project in the Vercel dashboard). Every frame after the first carries only the pixels that changed, so a file is a fraction of a megabyte per second, and it is kept under 5 MB (what X accepts from a phone; 15 MB from a browser) by rendering again smaller and shorter if it ever runs over. Files are named after the run, e.g. `RUN-3.40mi-San-Francisco.gpx` (the city from a reverse lookup of the start). The search runs at the engine, and a phone that switches apps puts the page to sleep and cuts the stream; the search carries on regardless, and every line it says is kept on record at the engine under a job id the page sent along (for a quarter of an hour after it ends; on Vercel the record is also put on the Runtime Cache, so whichever worker the page's next request lands on can hand it out), so when the page comes back it asks for the lines it missed and waits there for the rest: switching away costs nothing. If the record is not there (another worker answered, or too long has passed), the page keeps whatever had arrived, or restarts the search once on its own; otherwise it offers **Try again**. On the map, **Target** shows the shape the route is trying to draw and **Recenter** brings the whole route back on screen. The CLI takes the same options, e.g. `runmapper "RUN" --lat 37.752 --lon -122.492 --bucket 10k --style outline`. To use an engine running somewhere else, set `NEXT_PUBLIC_API_URL` in `web/.env.local` (see `.env.example`).

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

## Put it on the internet (drawmy.run)

One Vercel project runs both halves: the Next.js app, and the engine as a Python function behind `/api`. (Vercel allows Python functions a 500 MB bundle, streamed responses and 300 s per request, which is what the engine needs.)

1. In Vercel: **Add New → Project**, import this repo, set **Root Directory** to `web`. Nothing else to configure.
2. Deploy. Every push to `main` redeploys.
3. **Settings → Domains → add `drawmy.run`** and point the domain's DNS at Vercel as it instructs. The repository can be renamed to match at any time: the engine install step reads the repository name Vercel passes at build time.

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

- **Text** uses a purpose-built grid font: every letter lives on a 2×3 lattice, so on a street grid a letter is two blocks wide and two tall, with its middle bar on the street between; slanted letters (K, N, R, V, Y, Z, 7) have rectilinear forms because diagonals never survive a grid. Once the local block spacing is measured, each letter column and row is assigned to a real street line (so a grid that drifts still works), every corner is checked against a real intersection, and the route is snapped on street centrelines only. Both grid orientations are tried, which is how text on Manhattan's long blocks ends up running along the avenues. A phrase of four or more letters is also tried on two lines, split at the space that balances them best (or mid-word for a long single word): the drawing gets half as wide, fits inside one neighbourhood's grid, and the letters can be bigger; the engine ranks one- and two-line layouts together and prefers the bigger letters. Each letter is one continuous line that retraces itself where needed (Strava overdraws retraced streets, so repeats are invisible), and the letters are chained along the bottom into one underline. The few diagonals the font keeps (N, V, Z) become a staircase on the blocks, one step per block, so at the smallest size a Z runs as a single step; the map's Target shows the letters as designed, diagonals and all, bent to the same streets, while the route and its overlap score follow the staircase. When no lattice fits the streets at all, a free-floating placement is used and never called better than "rough". Max **12 characters**; A–Z, 0–9, space and `! ? - . ' +`.
- **Drawing style** (Auto · Line · Outline, below the distance keys for words and images; a drawing is always a line): for words, Line is the grid font above and Outline draws block letters from a dot-matrix font (5×7 when the distance allows, 3×5 otherwise), each letter traced as a closed outline whose cells are whole blocks, so every corner is a street corner; diagonal pixels are bridged so each letter is one solid shape. Block letters need two to three times the distance of line letters, and the app says how much before you run anything. For images, Auto picks whichever of the two tracings below matches the picture best, Line forces the centreline and Outline forces the edge.
- **Text that doesn't fit**: letters need whole blocks, so a phrase has a minimum length that depends on the local block size. When it exceeds the distance you picked, the app says how many miles it needs and offers the next distance up with one click.
- **Images** become either the filled outline (bold marks) or the skeleton centreline (thin marks and line drawings). The choice comes from the measured stroke thickness: two edges closer than about a block would land on the same street, so a thin mark is drawn as one line.
- **Size** comes from the distance bucket: the drawing is scaled as large as the cap allows (~5K ≤ 3.6 mi, ~10K ≤ 6.8 mi, longer ≤ 13.5 mi), never smaller than what stays readable after GPS wobble. If a phrase or image cannot fit at a readable size, the app says so before touching any street data.
- **Placement**: streets within about two miles of the pin come from Overpass. The drawing is tried at the pin first: the local grid angle and block spacing are measured, a few hundred placements (position × size × rotation, where a drawing, an image or a word off the lattice may turn up to about 36° either side of the grid angle when the streets fit it better that way, with a mild preference for upright; letters on the lattice keep the grid's angle) are scored by how close the ideal strokes lie to real streets, and the best few are snapped with a corridor-restricted Dijkstra that hugs each stroke, joined by connectors that retrace existing ink, and closed into a loop when asked. Then spots whose streets form a clearly more regular grid are tried in bands of distance: within about half a mile, then the most regular spots out to about 1.4 mi, and finally the most regular grids anywhere out to about 4 mi. That last search runs on a second, wider fetch of streets (up to an 8.8 × 8.8 mile box) that loads in the background once the first answer is out; if it has not arrived by the time half the budget is spent, the first fetch's outer ring is searched instead. The result offers up to three answers, nearest first: the best fit close to the pin, a better one a bit farther, and the best fit farther still (a farther answer is only offered when it is at least as good as a nearer one). Each is streamed the moment it is ready, so the first route is on the map while the search for the others continues, and the bibs switch the map between them. The very first fit at the pin is streamed before the rest of the near band is tried (marked `provisional`); a better fit nearby replaces it, and a great fit at the pin ends that band early. A run starts at the pin when the drawing is within a quarter mile by street and the walk-on fits the distance (it is built into the route); otherwise it starts at the drawing, with the distance from the pin reported.
- **Verdict**: the route and the target shape are rasterised as thick lines and compared (IoU). "Great", "good", "rough", or an honest "hm, try somewhere else". Small letters on coarse blocks and wandering (non-grid) streets are capped at "rough" because they never come out crisp; badly squashed letters and a grid that bends are capped at "good". When a cap holds a verdict below what the overlap alone would say, the answer says so and why (`message`, shown on the bib). A word laid along the north–south streets (the only way its stems land on streets on some long blocks) is as good a drawing as any, so it keeps its verdict; the answer just notes that it reads sideways with north up.
- **Numbers**: distance is great-circle along the route; climb comes from opentopodata (USGS 10 m in the US, EU-DEM in Europe, SRTM 30 m elsewhere) and is omitted if the lookup fails. The site shows kilometres and metres everywhere except US, Liberian and Myanmar locales, with a mi / km choice beside the loop switch; the API always returns both.

Typical run: the first route in about 7 s and all three in about 20 s once an area's streets are cached, plus the Overpass wait (10–30 s) the first time an area is used. The cache is written in the background as a pickle, so the plan never waits for it.

## Do I need an AI API?

No. Nothing in the pipeline is a language or vision model: the font is data, tracing is classical image processing (thresholding, contours, skeletonisation), placement is a search, snapping is Dijkstra, and the verdict is a pixel overlap. It runs the same every time and costs nothing per request beyond compute.

Where a model *could* help later, as an optional extra:

- Cleaning up messy uploads (a photo of a logo, a busy multi-colour mark) into a simple shape before tracing.
- Turning a prompt like "a cat" into a line drawing to run.

Neither is needed for words or for logos that are already clean shapes.

## Limits and honest notes

- Public Overpass mirrors are rate-limited and occasionally slow or down; the engine asks the next mirror when one is slow to answer, falls back on failure, and caches each area for 30 days. Every plan writes one-line timings to the server log (Vercel: the project's Logs tab), including which mirror answered. For serious traffic, self-host Overpass or point `RUNMAPPER_OVERPASS_MIRRORS` at a paid instance.
- The public opentopodata instance allows one call per second; the engine samples each route for a single call (every 110 ft on a 5K, wider on longer routes) with an 8 s timeout, so a slow elevation service costs a few seconds at most.
- On Vercel a request may take at most 300 s and carry at most 4.5 MB, so uploads are downscaled in the browser before they are sent, and a route that needs several slow Overpass mirrors in a row can time out; try again a minute later.
- Letters with diagonals (D N V X Z, the slashed 0, and / \) are staircased onto the grid and need bigger letters than rectilinear ones to read. A word full of them may need the next distance up.
- Cities without a grid (old European centres) rarely produce crisp text; the app will tell you.
- Map tiles are OpenFreeMap (`positron` by day, which is the default, and the `dark` style at night, which a phone set to dark gets until a basemap is picked by hand; override the styles with `NEXT_PUBLIC_MAP_STYLE_NIGHT` and `NEXT_PUBLIC_MAP_STYLE`); the satellite view is Esri World Imagery with Esri's road and place-name reference tiles, and its flyover stands the imagery on elevation from the AWS Terrain Tiles (Mapzen terrarium tiles; attribution shown on the map); street data © OpenStreetMap contributors (ODbL).
