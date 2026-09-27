"""Scarica da OpenStreetMap gli spot di surf di Europa, Canarie e Marocco e li salva in catalog.json.
Lo lancia GitHub Actions una volta al mese: l'app poi legge il file dal sito, senza interrogare Overpass dal telefono."""
import json, time, urllib.parse, urllib.request

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# Europa + Canarie + Marocco, a riquadri da 10 gradi per non chiedere troppo in una volta sola
SOUTH, NORTH, WEST, EAST, STEP = 27, 71, -26, 45, 10


def query(bbox):
    s, w, n, e = bbox
    q = ('[out:json][timeout:180];'
         'nwr["sport"~"(^|;)surfing(;|$)"][!"shop"][!"amenity"][!"building"]'
         f'({s},{w},{n},{e});out center tags;')
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "sinis-waves-catalog/1.0"})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.load(r)["elements"]
            except Exception as ex:  # server occupato o lento: riprova con un altro mirror
                last = ex
                time.sleep(10)
    raise RuntimeError(f"Overpass non risponde per {bbox}: {last}")


def kind(t):
    if t.get("natural") == "reef" or any(k in (t.get("surfing") or "").lower() for k in ("reef", "point")):
        return "reef"
    if t.get("natural") == "beach":
        return "beach"
    return None


def main():
    spots, seen = [], set()
    lat = SOUTH
    while lat < NORTH:
        lon = WEST
        while lon < EAST:
            bbox = (lat, lon, min(lat + STEP, NORTH), min(lon + STEP, EAST))
            for el in query(bbox):
                sid = f"{el['type']}/{el['id']}"
                if sid in seen:
                    continue
                t = el.get("tags", {})
                la = el.get("lat", el.get("center", {}).get("lat"))
                lo = el.get("lon", el.get("center", {}).get("lon"))
                if la is None or lo is None:
                    continue
                seen.add(sid)
                spots.append({"id": sid, "lat": round(la, 4), "lon": round(lo, 4),
                              "name": t.get("name") or t.get("loc_name") or t.get("name:it") or t.get("name:en"),
                              "kind": kind(t)})
            print(f"{bbox}: {len(spots)} spot finora", flush=True)
            time.sleep(3)
            lon += STEP
        lat += STEP
    with open("catalog.json", "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d"), "source": "© OpenStreetMap contributors (ODbL)", "spots": spots},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"Salvati {len(spots)} spot in catalog.json")


if __name__ == "__main__":
    main()
