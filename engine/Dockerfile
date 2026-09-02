# runmapper engine: FastAPI + the route pipeline.
# Build:  docker build -t runmapper-engine engine/
# Run:    docker run -p 8000:8000 -v runmapper-cache:/cache runmapper-engine
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    RUNMAPPER_CACHE=/cache PORT=8000

WORKDIR /app
COPY pyproject.toml ./
COPY runmapper_engine ./runmapper_engine
RUN pip install --no-cache-dir ".[serve]" && mkdir -p /cache

EXPOSE 8000
# One request can take a minute or two; keep the worker timeout generous.
CMD ["sh", "-c", "uvicorn runmapper_engine.api:app --host 0.0.0.0 --port ${PORT} --timeout-keep-alive 120"]
