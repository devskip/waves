"""Scarica da OpenStreetMap gli spot di surf e li salva in catalog.json.
Lo lancia GitHub Actions una volta al mese: l'app poi legge il file dal sito, senza interrogare Overpass dal telefono.

Prima prova con una sola richiesta per tutto il mondo (è la più veloce per Overpass, perché usa l'indice dei tag).
Se non riesce, ripiega su riquadri da 10 gradi di Europa, Canarie e Marocco."""
import json, sys, time, urllib.parse, urllib.request

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
FILTER = 'nwr["sport"~"(^|;)surfing(;|$)"][!"shop"][!"amenity"][!"building"]'


def log(msg):
    print(msg, flush=True)


def ask(q, timeout):
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for url in MIRRORS:
        t0 = time.time()
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "sinis-waves-catalog/1.1"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                els = json.load(r)["elements"]
            log(f"  {url}: {len(els)} elementi in {time.time()-t0:.0f}s")
            return els
        except Exception as ex:
            last = ex
            log(f"  {url}: errore dopo {time.time()-t0:.0f}s ({ex})")
            time.sleep(5)
    raise RuntimeError(last)


def world():
    log("Richiesta unica per tutto il mondo…")
    return ask(f"[out:json][timeout:900];{FILTER};out center tags;", 960)


def tiles():
    out = []
    for lat in range(27, 71, 10):
        for lon in range(-26, 45, 10):
            bbox = (lat, lon, min(lat + 10, 71), min(lon + 10, 45))
            log(f"Riquadro {bbox}")
            try:
                out += ask(f"[out:json][timeout:120];{FILTER}({','.join(map(str, bbox))});out center tags;", 150)
            except Exception as ex:
                log(f"  saltato: {ex}")
            time.sleep(2)
    return out


def kind(t):
    if t.get("natural") == "reef" or any(k in (t.get("surfing") or "").lower() for k in ("reef", "point")):
        return "reef"
    if t.get("natural") == "beach":
        return "beach"
    return None


def main():
    try:
        els = world()
    except Exception as ex:
        log(f"Richiesta unica non riuscita ({ex}), passo ai riquadri")
        els = tiles()
    spots, seen = [], set()
    for el in els:
        sid = f"{el['type']}/{el['id']}"
        la = el.get("lat", el.get("center", {}).get("lat"))
        lo = el.get("lon", el.get("center", {}).get("lon"))
        if sid in seen or la is None or lo is None:
            continue
        seen.add(sid)
        t = el.get("tags", {})
        spots.append({"id": sid, "lat": round(la, 4), "lon": round(lo, 4),
                      "name": t.get("name") or t.get("loc_name") or t.get("name:it") or t.get("name:en"),
                      "kind": kind(t)})
    if not spots:
        log("Nessuno spot scaricato: catalog.json non viene toccato")
        sys.exit(1)
    with open("catalog.json", "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d"), "source": "© OpenStreetMap contributors (ODbL)", "spots": spots},
                  f, ensure_ascii=False, separators=(",", ":"))
    log(f"Salvati {len(spots)} spot in catalog.json")


if __name__ == "__main__":
    main()
