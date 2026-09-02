"""GPX 1.1 output that Strava, Garmin, WorkOutDoors and friends accept."""
import datetime as dt
from xml.sax.saxutils import escape

import numpy as np

from .geo import FT_PER_M


def gpx_string(latlon, elev_ft=None, name="Route", desc=""):
    """Strava's route importer reads <trk>; elevations are metres."""
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<gpx version="1.1" creator="runmapper.run" xmlns="http://www.topografix.com/GPX/1/1" '
         'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
         'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 '
         'http://www.topografix.com/GPX/1/1/gpx.xsd">',
         '  <metadata>', f'    <name>{escape(name)}</name>',
         f'    <desc>{escape(desc)}</desc>', f'    <time>{now}</time>', '  </metadata>',
         '  <trk>', f'    <name>{escape(name)}</name>', '    <trkseg>']
    for i, (la, lo) in enumerate(latlon):
        if elev_ft is not None and not np.isnan(elev_ft[i]):
            L.append(f'      <trkpt lat="{la:.7f}" lon="{lo:.7f}">'
                     f'<ele>{elev_ft[i] / FT_PER_M:.1f}</ele></trkpt>')
        else:
            L.append(f'      <trkpt lat="{la:.7f}" lon="{lo:.7f}"></trkpt>')
    L += ['    </trkseg>', '  </trk>', '</gpx>', '']
    return "\n".join(L)


def dedupe(latlon, xy, min_ft=3.0):
    """Drop near-duplicate consecutive points (keeps files small and clean).
    Returns the indices kept."""
    x, y = xy
    keep = [0]
    for i in range(1, len(latlon)):
        if np.hypot(x[i] - x[keep[-1]], y[i] - y[keep[-1]]) >= min_ft:
            keep.append(i)
    if keep[-1] != len(latlon) - 1:
        keep.append(len(latlon) - 1)
    return np.array(keep)
