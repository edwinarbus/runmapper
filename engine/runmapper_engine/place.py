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
    """Points along each polyline, every `step` feet or so, vertices included
    (each segment gets max(2, L/step + 1) evenly spaced samples)."""
    out = []
    for p in polys:
        p = np.asarray(p, float)
        if len(p) == 1:
            out.append(p)
            continue
        a, b = p[:-1], p[1:]
        L = np.hypot(*(b - a).T)
        n = np.maximum(2, (L / step).astype(int) + 1)
        seg = np.repeat(np.arange(len(n)), n)
        j = np.arange(int(n.sum())) - np.repeat(np.cumsum(n) - n, n)
        t = (j / (np.repeat(n, n) - 1))[:, None]
        out.append(a[seg] + t * (b[seg] - a[seg]))
    return np.vstack(out)


def p90(d, axis=None):
    """The 90th percentile the way numpy's default interpolates it, without
    a full sort: a partition on the two ranks it sits between."""
    d = np.asarray(d, float)
    n = d.shape[-1] if axis is not None else d.size
    if n == 0:
        return 0.0 if axis is None else np.zeros(d.shape[:-1])
    pos = 0.9 * (n - 1)
    i = int(pos)
    f = pos - i
    if i + 1 >= n:
        return d.max(axis=axis)
    part = np.partition(d, [i, i + 1], axis=-1 if axis is not None else None)
    lo, hi = (part[..., i], part[..., i + 1]) if axis is not None else (part[i], part[i + 1])
    return lo + f * (hi - lo)


def fit_score(strokes, tree, center_xy, width_ft, rot_deg, aspect=1.0, step=45.0, dead=520.0):
    polys = transform(strokes, center_xy, width_ft, rot_deg, aspect)
    S = sample_strokes(polys, step)
    d, _ = tree.query(S)
    dead_frac = float((d > dead).mean())
    q = float(p90(d))
    return dict(mean=float(d.mean()), p90=q, dead=dead_frac, n=len(S),
                score=float(d.mean() + 0.6 * q + 900.0 * dead_frac))


def scan(strokes, tree, center0, widths_ft, rots, radius_ft, grid_ft=200.0, aspect=1.0,
         step=75.0, dead=520.0, max_mean=320.0, max_dead=0.06):
    """Grid of centres around `center0` x sizes x rotations, scored by the proxy.

    Returns candidates sorted best-first as dicts(score, cx, cy, width_ft, rot,
    aspect, mean, dead)."""
    cx0, cy0 = float(center0[0]), float(center0[1])
    offs = np.arange(-radius_ft, radius_ft + 1e-6, grid_ft)
    OX, OY = np.meshgrid(offs, offs, indexing="ij")
    O = np.c_[OX.ravel() + cx0, OY.ravel() + cy0]     # every centre, dx-major like the loops it replaces
    out = []
    for wft in widths_ft:
        for r in rots:
            polys0 = transform(strokes, np.array([0.0, 0.0]), wft, r, aspect)
            S0 = sample_strokes(polys0, step)
            n = len(S0)
            # All the centres in one tree query instead of one per centre.
            d, _ = tree.query((S0[None, :, :] + O[:, None, :]).reshape(-1, 2))
            d = d.reshape(len(O), n)
            md = d.mean(axis=1)
            deadf = (d > dead).mean(axis=1)
            ok = np.flatnonzero((md <= max_mean) & (deadf <= max_dead))
            if not len(ok):
                continue
            sc = md[ok] + 0.6 * p90(d[ok], axis=1) + 900.0 * deadf[ok]
            for j, s in zip(ok, sc):
                out.append(dict(score=float(s), cx=float(O[j, 0]), cy=float(O[j, 1]), width_ft=float(wft),
                                rot=float(r), aspect=float(aspect), mean=float(md[j]), dead=float(deadf[j])))
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
