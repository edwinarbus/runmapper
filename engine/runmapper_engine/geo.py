"""Local planar projection (feet) and spherical distances.

Everything in the engine works in a small local frame centred on the spot the
user picked: an equirectangular projection is accurate to well under 0.1 %
over the few miles a route covers, and it keeps all the geometry in plain
numpy without a heavyweight GIS dependency.
"""
import math

import numpy as np

FT_PER_M = 3.280839895
FT_PER_MI = 5280.0
M_PER_MI = 1609.344
EARTH_R_FT = 20902231.0


class Projection:
    """Equirectangular projection centred on (lat0, lon0), units are feet."""

    def __init__(self, lat0, lon0):
        self.lat0 = float(lat0)
        self.lon0 = float(lon0)
        self.kx = 111320.0 * math.cos(math.radians(self.lat0)) * FT_PER_M
        self.ky = 110574.0 * FT_PER_M

    def to_xy(self, lat, lon):
        x = (np.asarray(lon, float) - self.lon0) * self.kx
        y = (np.asarray(lat, float) - self.lat0) * self.ky
        return x, y

    def to_ll(self, x, y):
        lon = np.asarray(x, float) / self.kx + self.lon0
        lat = np.asarray(y, float) / self.ky + self.lat0
        return lat, lon

    def bbox_around(self, half_x_ft, half_y_ft):
        """(south, west, north, east) of a box centred on the origin."""
        dlat = half_y_ft / self.ky
        dlon = half_x_ft / self.kx
        return (self.lat0 - dlat, self.lon0 - dlon, self.lat0 + dlat, self.lon0 + dlon)


def haversine_segments_ft(latlon):
    """Great-circle length of each segment of a lat/lon polyline, in feet."""
    ll = np.asarray(latlon, float)
    if len(ll) < 2:
        return np.zeros(0)
    la = np.radians(ll[:, 0])
    lo = np.radians(ll[:, 1])
    dla = np.diff(la)
    dlo = np.diff(lo)
    h = np.sin(dla / 2) ** 2 + np.cos(la[:-1]) * np.cos(la[1:]) * np.sin(dlo / 2) ** 2
    return 2 * EARTH_R_FT * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


def polyline_len(pts):
    p = np.asarray(pts, float)
    if len(p) < 2:
        return 0.0
    return float(np.sum(np.hypot(*np.diff(p, axis=0).T)))
