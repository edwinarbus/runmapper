"""Deploy the engine API on Modal (https://modal.com) with one command:

    pip install modal
    modal setup                      # once, opens the browser to log in
    modal deploy engine/modal_app.py # prints the public URL of the API

Street data is cached on a persistent Modal volume so repeat requests near
the same spot skip the Overpass fetch.
"""
import modal

app = modal.App("runmapper")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "numpy>=1.26", "scipy>=1.11", "scikit-image>=0.22", "pillow>=10",
        "svgpathtools>=1.6", "fastapi>=0.110", "uvicorn>=0.29", "python-multipart>=0.0.9",
    )
    .add_local_python_source("runmapper_engine")
)

cache = modal.Volume.from_name("runmapper-cache", create_if_missing=True)


@app.function(image=image, volumes={"/cache": cache}, timeout=600, memory=2048,
              scaledown_window=300)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def api():
    from runmapper_engine.api import create_app
    return create_app(cache_dir="/cache")
