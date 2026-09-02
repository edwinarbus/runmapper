"""Search over drawing placements (centre, size, rotation) for the best street fit.

The proxy score is cheap: sample the ideal strokes and ask a KD-tree of
densified street points how far each sample is from the nearest street. That
runs thousands of placements per second; only the few best get the expensive
snap.

`aspect` scales the drawing's y axis relative to x (1.0 = keep proportions).
Text uses it to stretch letters to the local block spacing.
"""
import numpy as np


def transform(strokes, center_xy, width_ft, rot_deg, aspect=1.0):
    """Normalised drawing space -> local XY feet."""
    th = np.radians(rot_deg)
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
    S = np.array([width_ft, width_ft * aspect])
    return [((s.pts * S) @ R.T) + np.asarray(center_xy, float) for s in strokes]


def sample_strokes(polys, step=40.0):
    out = []
    for p in polys:
        p = np.asarray(p, float)
        if len(p) == 1:
            out.append(p)
            continue
        for a, b in zip(p[:-1], p[1:]):
            L = float(np.hypot(*(b - a)))
            n = max(2, int(L / step) + 1)
            t = np.linspace(0, 1, n)[:, None]
            out.append(a + t * (b - a))
    return np.vstack(out)


def fit_score(strokes, tree, center_xy, width_ft, rot_deg, aspect=1.0, step=45.0, dead=520.0):
    polys = transform(strokes, center_xy, width_ft, rot_deg, aspect)
    S = sample_strokes(polys, step)
    d, _ = tree.query(S)
    dead_frac = float((d > dead).mean())
    return dict(mean=float(d.mean()), p90=float(np.percentile(d, 90)),
                dead=dead_frac, n=len(S),
                score=float(d.mean() + 0.6 * np.percentile(d, 90) + 900.0 * dead_frac))


def scan(strokes, tree, center0, widths_ft, rots, radius_ft, grid_ft=200.0, aspect=1.0,
         step=75.0, dead=520.0, max_mean=320.0, max_dead=0.06):
    """Grid of centres around `center0` x sizes x rotations, scored by the proxy.

    Returns candidates sorted best-first as dicts(score, cx, cy, width_ft, rot,
    aspect, mean, dead)."""
    cx0, cy0 = float(center0[0]), float(center0[1])
    offs = np.arange(-radius_ft, radius_ft + 1e-6, grid_ft)
    out = []
    for wft in widths_ft:
        for r in rots:
            polys0 = transform(strokes, np.array([0.0, 0.0]), wft, r, aspect)
            S0 = sample_strokes(polys0, step)
            for dx in offs:
                for dy in offs:
                    S = S0 + np.array([cx0 + dx, cy0 + dy])
                    d, _ = tree.query(S)
                    md = float(d.mean())
                    if md > max_mean:
                        continue
                    deadf = float((d > dead).mean())
                    if deadf > max_dead:
                        continue
                    sc = md + 0.6 * float(np.percentile(d, 90)) + 900.0 * deadf
                    out.append(dict(score=sc, cx=cx0 + dx, cy=cy0 + dy, width_ft=float(wft),
                                    rot=float(r), aspect=float(aspect), mean=md, dead=deadf))
    out.sort(key=lambda c: c["score"])
    return out


def refine(strokes, tree, cand, width_bounds, rot_bounds, rounds=3, dead=520.0,
           dxy=(-90.0, 0.0, 90.0), dr=(-2.0, 0.0, 2.0), dw=(0.97, 1.0, 1.03)):
    """Local hill-climb on one candidate. Size and rotation stay inside the
    bounds the caller asked for, because the street fit always improves as a
    drawing shrinks; only position is truly free."""
    best = dict(cand)
    aspect = float(cand.get("aspect", 1.0))
    for _ in range(rounds):
        improved = False
        for ddx in dxy:
            for ddy in dxy:
                for ddr in dr:
                    for ddw in dw:
                        ww = float(np.clip(best["width_ft"] * ddw, *width_bounds))
                        rr = float(np.clip(best["rot"] + ddr, *rot_bounds))
                        c = np.array([best["cx"] + ddx, best["cy"] + ddy])
                        f = fit_score(strokes, tree, c, ww, rr, aspect, step=45.0, dead=dead)
                        if f["score"] < best["score"] - 1e-6:
                            best = dict(best, score=f["score"], cx=float(c[0]), cy=float(c[1]),
                                        width_ft=ww, rot=rr, mean=f["mean"], dead=f["dead"])
                            improved = True
        if not improved:
            break
    return best


def dedupe(cands, min_sep_ft):
    """Keep only spatially distinct placements (per size, aspect and rotation)."""
    keep = []
    for c in cands:
        if all(abs(c["width_ft"] - k["width_ft"]) > 1.0 or abs(c["rot"] - k["rot"]) > 0.5
               or abs(c.get("aspect", 1.0) - k.get("aspect", 1.0)) > 1e-6
               or np.hypot(c["cx"] - k["cx"], c["cy"] - k["cy"]) > min_sep_ft
               for k in keep):
            keep.append(c)
    return keep
