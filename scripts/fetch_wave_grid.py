#!/usr/bin/env python3
"""Scarica da Open-Meteo la griglia di onde e vento attorno alla Sardegna
e la salva in waves-grid.json (la legge la mappa "Onde in arrivo" dell'app).

Formato (ogni lista ha nlat*nlon valori, riga per riga da sud a nord, null = terra):
  {"generated", "tz", "lat0", "lon0", "step", "nlat", "nlon", "times": [...],
   "hs": [[...]], "dir": [[...]], "per": [[...]], "ws": [[...]], "wd": [[...]]}
Un passo ogni 3 ore, da poco prima di adesso a 5 giorni.
"""
import json, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

LAT0, LON0, STEP, NLAT, NLON = 38.25, 5.0, 0.25, 13, 19   # 38.25-41.25 N, 5.0-9.5 E
TZ, DAYS, CHUNK = "Europe/Rome", 5, 40
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "waves-grid.json")
MARINE = "https://marine-api.open-meteo.com/v1/marine"
WIND = "https://api.open-meteo.com/v1/forecast"


def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sinis-waves"}), timeout=40) as r:
                return json.load(r)
        except Exception as e:
            if k == tries - 1:
                raise
            time.sleep(5 * (k + 1))
            print("retry:", e, file=sys.stderr)


def fetch(base, hourly, pts):
    out = []
    for i in range(0, len(pts), CHUNK):
        part = pts[i:i + CHUNK]
        q = urllib.parse.urlencode({
            "latitude": ",".join(f"{p[0]:.2f}" for p in part), "longitude": ",".join(f"{p[1]:.2f}" for p in part),
            "hourly": hourly, "timezone": TZ, "forecast_days": DAYS})
        r = get(f"{base}?{q}")
        out += r if isinstance(r, list) else [r]
        time.sleep(1.5)
    return out


def main():
    pts = [(round(LAT0 + j * STEP, 2), round(LON0 + i * STEP, 2)) for j in range(NLAT) for i in range(NLON)]
    marine = fetch(MARINE, "wave_height,wave_direction,wave_period", pts)
    wind = fetch(WIND, "wind_speed_10m,wind_direction_10m", pts)
    if len(marine) != len(pts) or len(wind) != len(pts):
        sys.exit("risposta incompleta")
    times_all = marine[0]["hourly"]["time"]
    now = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%dT%H:00")
    keep = [k for k, t in enumerate(times_all) if int(t[11:13]) % 3 == 0]
    start = max([k for k in keep if times_all[k] <= now] or [keep[0]])
    keep = [k for k in keep if k >= start]
    wmap = {t: k for k, t in enumerate(wind[0]["hourly"]["time"])}

    def num(v, nd=0):
        return None if v is None else (round(v, nd) if nd else int(round(v)))

    g = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tz": TZ,
         "lat0": LAT0, "lon0": LON0, "step": STEP, "nlat": NLAT, "nlon": NLON,
         "times": [times_all[k] for k in keep], "hs": [], "dir": [], "per": [], "ws": [], "wd": []}
    for k in keep:
        wk = wmap.get(times_all[k])
        g["hs"].append([num(m["hourly"]["wave_height"][k], 1) for m in marine])
        g["dir"].append([num(m["hourly"]["wave_direction"][k]) for m in marine])
        g["per"].append([num(m["hourly"]["wave_period"][k]) for m in marine])
        g["ws"].append([None if wk is None else num(w["hourly"]["wind_speed_10m"][wk]) for w in wind])
        g["wd"].append([None if wk is None else num(w["hourly"]["wind_direction_10m"][wk]) for w in wind])
    sea = sum(v is not None for v in g["hs"][0])
    if sea < 0.2 * len(pts):   # troppo pochi punti di mare: meglio tenere il file precedente
        sys.exit(f"solo {sea} punti di mare su {len(pts)}: non aggiorno")
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(g, f, separators=(",", ":"))
    os.replace(tmp, OUT)
    print(f"ok: {len(g['times'])} passi, {sea} punti di mare, {os.path.getsize(OUT) // 1024} kB")


if __name__ == "__main__":
    main()
