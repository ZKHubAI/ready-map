#!/usr/bin/env python3
"""Rebuild ./contours/ (Ready Map 1.5.2 depth lines) from the GEBCO_2026 Grid.

Data: GEBCO Compilation Group (2026) GEBCO 2026 Grid, doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa
(public domain; see https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use). Not for navigation.

Steps (needs: pip install numpy contourpy shapely scipy; about 1 GB download, 1 GB disk):
  1. Every 4th cell (1 arc-minute) of the 15 arc-second grid via CEDA OPeNDAP, in 27 row chunks:
     https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026/ice_surface_elevation/netcdf/GEBCO_2026.nc.dods?elevation.elevation[s:4:e][0:4:86399]
  2. Detail files contours/d/{lat}_{lon}.json: 10 by 10 degree cells, 5x5 box smoothing, levels
     20, 50, 100, 200, 500, 1000, 2000 m, Douglas-Peucker 0.01 degrees, lines shorter than 0.2 degrees dropped.
     Sea mask first: below-sea-level areas smaller than 20,000 one-minute cells (about 68,000 km2) that do not
     join the open sea are treated as land, so places like Death Valley or the Qattara Depression get no lines.
  3. contours/overview.json: 4 arc-minute block mean, levels 50 to 2000 m, 0.03 degree simplification.
  Encoding: {"v":2,"scale":S,"lines":[[depth, x0, y0, dx1, dy1, ...]]}, integers = degrees * S, deltas after the first point.
"""
import glob, json, os, subprocess, sys
import numpy as np, contourpy
from scipy import ndimage
from shapely.geometry import LineString

DAP = 'https://dap.ceda.ac.uk/thredds/dodsC/bodc/gebco/global/gebco_2026/ice_surface_elevation/netcdf/GEBCO_2026.nc'
DETAIL_LEVELS = [20, 50, 100, 200, 500, 1000, 2000]
OVERVIEW_LEVELS = [50, 100, 200, 500, 1000, 2000]

def fetch(work):
    os.makedirs(work, exist_ok=True)
    for s in range(0, 43200, 1600):
        e = min(s + 1596, 43196)
        f = os.path.join(work, 'chunk_%05d.dods' % s)
        if not os.path.exists(f):
            subprocess.check_call(['curl', '-g', '-s', '-f', '-o', f, DAP + '.dods?elevation.elevation[%d:4:%d][0:4:86399]' % (s, e)])
    rows = []
    for f in sorted(glob.glob(os.path.join(work, 'chunk_*.dods'))):
        b = open(f, 'rb').read(); i = b.index(b'Data:\n') + 6
        rows.append(np.frombuffer(b[i + 8:], '>i4').reshape(-1, 21600).astype(np.float32))
    return np.vstack(rows)  # row 0 = south

def smooth(a, k):
    p = k // 2
    b = np.pad(a, ((p, p), (0, 0)), mode='edge'); b = np.concatenate([b[:, -p:], b, b[:, :p]], axis=1)
    c = np.pad(b.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)

def encode(L, coords, scale):
    q = np.round(coords * scale).astype(np.int64)
    d = np.vstack([q[:1], np.diff(q, axis=0)])
    return [int(L)] + d.flatten().tolist()

def lines(lon, lat, depth, levels, tol, minlen, scale):
    cg = contourpy.contour_generator(lon, lat, depth, line_type='Separate')
    out = []
    for L in levels:
        for seg in cg.lines(L):
            if len(seg) < 3 or np.sum(np.hypot(*np.diff(seg, axis=0).T)) < minlen: continue
            c = np.round(np.asarray(LineString(seg).simplify(tol).coords), 3)
            keep = np.ones(len(c), bool); keep[1:] = np.any(np.diff(c, axis=0) != 0, axis=1); c = c[keep]
            if len(c) >= 2: out.append(encode(L, c, scale))
    return out

def sea_only(g, min_cells=20000):
    lab, n = ndimage.label(g < 0)
    sizes = np.bincount(lab.ravel()); keep = sizes >= min_cells; keep[0] = False
    out = g.copy(); out[(g < 0) & ~keep[lab]] = 1
    return out

def main(out_dir, work):
    g = sea_only(fetch(work)); H, W = g.shape; step = 1 / 60
    os.makedirs(os.path.join(out_dir, 'd'), exist_ok=True)
    sm = smooth(g, 5); sm[g > 0] = np.maximum(sm[g > 0], 1)  # smoothing must not pull land below sea level
    n = int(10 / step); names = []
    for ty in range(0, 180, 10):
        for tx in range(0, 360, 10):
            r0, c0 = int(ty / step), int(tx / step)
            r1, c1 = max(r0 - 1, 0), max(c0 - 1, 0)
            sub = sm[r1:min(r0 + n + 1, H), c1:min(c0 + n + 1, W)]
            if sub.min() > -10: continue
            lat = -90 + (r1 + 0.5) * step + np.arange(sub.shape[0]) * step
            lon = -180 + (c1 + 0.5) * step + np.arange(sub.shape[1]) * step
            ls = lines(lon, lat, -sub, DETAIL_LEVELS, 0.01, 0.2, 1000)
            if not ls: continue
            name = '%d_%d' % (-90 + ty, -180 + tx); names.append(name)
            json.dump({'v': 2, 'scale': 1000, 'lines': ls}, open(os.path.join(out_dir, 'd', name + '.json'), 'w'), separators=(',', ':'))
    ov = g.reshape(H // 4, 4, W // 4, 4).mean(axis=(1, 3)); s4 = 1 / 15
    land4 = (g > 0).reshape(H // 4, 4, W // 4, 4).mean(axis=(1, 3)) > 0.5; ov[land4] = np.maximum(ov[land4], 1)
    lat = -90 + (np.arange(ov.shape[0]) + 0.5) * s4; lon = -180 + (np.arange(ov.shape[1]) + 0.5) * s4
    json.dump({'v': 2, 'scale': 100, 'lines': lines(lon, lat, -ov, OVERVIEW_LEVELS, 0.03, 0.5, 100)},
              open(os.path.join(out_dir, 'overview.json'), 'w'), separators=(',', ':'))
    json.dump({'v': 1, 'tile_deg': 10, 'detail': sorted(names), 'levels_detail': DETAIL_LEVELS, 'levels_overview': OVERVIEW_LEVELS,
               'source': 'GEBCO_2026 Grid, GEBCO Compilation Group (2026), doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa'},
              open(os.path.join(out_dir, 'index.json'), 'w'), separators=(',', ':'))

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'contours', sys.argv[2] if len(sys.argv) > 2 else '/tmp/gebco-work')
