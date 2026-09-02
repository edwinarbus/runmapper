"""A synthetic street grid in Overpass element form, for offline tests."""
import math


def grid_elements(proj, nx=40, ny=40, bx=400.0, by=300.0, rot_deg=0.0):
    """Manhattan-style grid: nx x ny blocks of bx by by feet, rotated by rot_deg."""
    els = []
    nid = 1
    ids = {}
    th = math.radians(rot_deg)
    for i in range(nx + 1):
        for j in range(ny + 1):
            x = (i - nx / 2) * bx
            y = (j - ny / 2) * by
            xr = x * math.cos(th) - y * math.sin(th)
            yr = x * math.sin(th) + y * math.cos(th)
            lat, lon = proj.to_ll(xr, yr)
            ids[(i, j)] = nid
            els.append(dict(type="node", id=nid, lat=float(lat), lon=float(lon)))
            nid += 1
    wid = 1
    for j in range(ny + 1):
        els.append(dict(type="way", id=wid, nodes=[ids[(i, j)] for i in range(nx + 1)],
                        tags={"highway": "residential", "name": f"{j} St"}))
        wid += 1
    for i in range(nx + 1):
        els.append(dict(type="way", id=wid, nodes=[ids[(i, j)] for j in range(ny + 1)],
                        tags={"highway": "residential", "name": f"{i} Ave"}))
        wid += 1
    return els
