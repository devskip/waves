#!/usr/bin/env python3
"""Crea waves-land.json: una maschera terra/mare a 0.02° (circa 2 km) attorno alla Sardegna,
per non disegnare le onde sulla terra. Si lancia una volta sola (workflow "Maschera terra").

Fonte: Natural Earth, "land" 1:10m (pubblico dominio). Facoltativo: un file geojson locale come argomento.
Formato: {"lat0","lon0","step","nlat","nlon","rows":[[mare,terra,mare,...], ...]}
ogni riga (da sud a nord) è l'elenco delle lunghezze delle strisce, partendo sempre da una striscia di mare.
"""
import json, math, os, sys, urllib.request

LAT0, LON0, STEP, NLAT, NLON = 37.5, 5.0, 0.02, 250, 250   # 37.5-42.5 N, 5.0-10.0 E
URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "waves-land.json")
LAT1, LON1 = LAT0 + NLAT * STEP, LON0 + NLON * STEP


def load():
    if len(sys.argv) > 1:
        return json.load(open(sys.argv[1]))
    req = urllib.request.Request(URL, headers={"User-Agent": "sinis-waves"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def main():
    data = load()
    grid = [bytearray(NLON) for _ in range(NLAT)]
    for feat in data["features"]:
        g = feat["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for rings in polys:
            xs = [p[0] for p in rings[0]]; ys = [p[1] for p in rings[0]]
            if max(xs) < LON0 or min(xs) > LON1 or max(ys) < LAT0 or min(ys) > LAT1:
                continue
            edges = []   # tutti gli anelli del poligono insieme: pari/dispari gestisce anche i buchi (laghi)
            for ring in rings:
                for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                    if y1 != y2 and max(y1, y2) >= LAT0 and min(y1, y2) <= LAT1:
                        edges.append((x1, y1, x2, y2))
            for j in range(NLAT):
                y = LAT0 + (j + .5) * STEP
                cross = sorted(x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                               for x1, y1, x2, y2 in edges if (y1 <= y < y2) or (y2 <= y < y1))
                for a, b in zip(cross[0::2], cross[1::2]):
                    i0 = max(0, math.ceil((a - LON0) / STEP - .5)); i1 = min(NLON - 1, math.floor((b - LON0) / STEP - .5))
                    if i1 >= i0:
                        grid[j][i0:i1 + 1] = b"\x01" * (i1 - i0 + 1)
    rows = []
    for row in grid:
        runs, cur, n = [], 0, 0
        for v in row:
            if v == cur:
                n += 1
            else:
                runs.append(n); cur ^= 1; n = 1
        runs.append(n)
        rows.append(runs)
    land = sum(sum(r[1::2]) for r in rows)
    if not 0.02 * NLAT * NLON < land < 0.9 * NLAT * NLON:
        sys.exit(f"maschera strana ({land} celle di terra): non scrivo il file")
    with open(OUT, "w") as f:
        json.dump({"lat0": LAT0, "lon0": LON0, "step": STEP, "nlat": NLAT, "nlon": NLON, "rows": rows}, f, separators=(",", ":"))
    print(f"ok: {land} celle di terra su {NLAT * NLON}, {os.path.getsize(OUT) // 1024} kB")


if __name__ == "__main__":
    main()
