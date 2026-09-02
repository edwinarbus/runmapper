"""Quick preview PNG for development: local streets in grey, the ideal drawing
dashed in blue, the route in Strava orange. No map tiles, no network."""
import numpy as np


def preview_png(path, g, result_nodes, ideal_polys, title="", pad_ft=600.0):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    X, Y = g.X, g.Y
    p = np.asarray(result_nodes)
    rx, ry = X[p], Y[p]
    allp = np.vstack([np.asarray(q) for q in ideal_polys] + [np.c_[rx, ry]])
    lo, hi = allp.min(0) - pad_ft, allp.max(0) + pad_ft
    span = max(hi[0] - lo[0], hi[1] - lo[1])
    cx, cy = (lo + hi) / 2
    lo = np.array([cx - span / 2, cy - span / 2])
    hi = np.array([cx + span / 2, cy + span / 2])

    segs = []
    for i, j, ln, mult, wid in g.edges(g.keep):
        if (lo[0] <= X[i] <= hi[0] and lo[1] <= Y[i] <= hi[1]) or (lo[0] <= X[j] <= hi[0] and lo[1] <= Y[j] <= hi[1]):
            segs.append([(X[i], Y[i]), (X[j], Y[j])])
    fig, ax = plt.subplots(figsize=(8, 8), dpi=110)
    ax.add_collection(LineCollection(segs, colors="#c9c9c9", linewidths=0.7))
    for q in ideal_polys:
        q = np.asarray(q)
        ax.plot(q[:, 0], q[:, 1], "--", color="#3b82f6", lw=1.0, alpha=0.8)
    ax.plot(rx, ry, color="white", lw=6.0, solid_capstyle="round", solid_joinstyle="round")
    ax.plot(rx, ry, color="#FC5200", lw=3.4, solid_capstyle="round", solid_joinstyle="round")
    ax.plot(rx[:1], ry[:1], "o", color="#12b886", ms=7, mec="white", mew=1.5)
    ax.set_xlim(lo[0], hi[0])
    ax.set_ylim(lo[1], hi[1])
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(title, fontsize=10)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path
