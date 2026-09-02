"""The route engine as a Vercel Python function.

Vercel serves this file at /api; the rewrite in next.config.ts sends every
/api/* request here, and FastAPI routes them (see runmapper_engine/api.py).
The engine package itself is installed from this repository by
scripts/vercel-install.sh (wired up in pyproject.toml). Street data is cached
in /tmp, the only writable place in a function, so a warm instance skips the
Overpass fetch for areas it has seen.
"""
import os

from runmapper_engine.api import create_app

app = create_app(cache_dir=os.environ.get("RUNMAPPER_CACHE", "/tmp/runmapper-cache"))
