#!/bin/sh
# Installs the route engine (engine/ in this repository) into the virtualenv
# Vercel bundles with api/index.py. Vercel runs this from pyproject.toml's
# [tool.vercel.scripts] with the venv's bin directory first on PATH and
# VERCEL_GIT_COMMIT_SHA set to the commit being built, so the function always
# carries the engine from the same commit as the page.
set -eu
REF="${VERCEL_GIT_COMMIT_SHA:-main}"
SPEC="runmapper-engine @ git+https://github.com/edwinarbus/runmapper@${REF}#subdirectory=engine"
echo "Installing the route engine from commit ${REF}"
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$(command -v python)" "$SPEC"
else
  python -m ensurepip --upgrade >/dev/null 2>&1 || true
  python -m pip install --disable-pip-version-check --no-cache-dir "$SPEC"
fi
python -c "import runmapper_engine, numpy, scipy; print('runmapper engine', runmapper_engine.__version__, 'installed')"
