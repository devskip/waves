"""Scarica le misure delle boe ondametriche vicine al Sinis e le salva in buoy.json.
Lo lancia GitHub Actions ogni ora (.github/workflows/buoy.yml); l'app legge poi buoy.json dal sito.

Fonte: EMODnet Physics (servizio europeo, gratuito, senza registrazione), che raccoglie in tempo quasi reale
le boe di tutta Europa, compresa la Rete Ondametrica Nazionale dell'ISPRA (boa di Alghero).
Il dataset e la boa non sono scritti a mano: lo script li cerca da solo, così continua a funzionare
anche se cambiano nomi o codici. Nel log di GitHub trovi cosa ha trovato e dove."""
import json, math, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

SERVERS = ["https://erddap.emodnet-physics.eu/erddap", "https://data-erddap.emodnet-physics.eu/erddap"]
HOME = (40.0, 8.35)                            # Sinis, davanti a Capo Mannu
BOX = dict(s=37.5, n=42.5, w=6.0, e=11.0)      # mari intorno alla Sardegna
MAX_KM = 300
HOURS = 48


def log(m):
    print(m, flush=True)


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "sinis-waves-buoy/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def table(j):
    t = j["table"]
    return [dict(zip(t["columnNames"], row)) for row in t["rows"]]


def km(a, b):
    r = math.pi / 180
    x = math.sin((b[0]-a[0])*r/2)**2 + math.cos(a[0]*r)*math.cos(b[0]*r)*math.sin((b[1]-a[1])*r/2)**2
    return 2 * 6371 * math.asin(math.sqrt(x))


def pick(names, *cands):
    low = {n.lower(): n for n in names}
    for c in cands:
        if c.lower() in low:
            return low[c.lower()]
    return None


def datasets(server):
    """Dataset tabellari che contengono l'altezza d'onda (VHM0)."""
    out = []
    for q in ("VHM0", "wave height"):
        try:
            rows = table(get(f"{server}/search/index.json?page=1&itemsPerPage=200&searchFor={urllib.parse.quote(q)}"))
        except Exception as ex:
            log(f"  ricerca '{q}' non riuscita: {ex}")
            continue
        for r in rows:
            did, tab = r.get("Dataset ID"), r.get("tabledap")
            if did and tab and did not in out:
                out.append(did)
    return out


def variables(server, did):
    rows = table(get(f"{server}/info/{did}/index.json"))
    return [r["Variable Name"] for r in rows if r.get("Row Type") == "variable"]


def query(server, did, names):
    hs = pick(names, "VHM0")
    if not hs:
        return None
    t, la, lo = pick(names, "time"), pick(names, "latitude"), pick(names, "longitude")
    pid = pick(names, "platform_code", "PLATFORMCODE", "platform_id", "station_id", "wmo_platform_code", "EP_PLATFORM_ID")
    name = pick(names, "platform_name", "station_name", "PLATFORMNAME")
    extra = [v for v in (pick(names, "VTPK"), pick(names, "VTM02"), pick(names, "VTM10"), pick(names, "VMDR"), pick(names, "VPED")) if v]
    if not (t and la and lo and pid):
        return None
    cols = [pid, t, la, lo, hs] + extra + ([name] if name else [])
    since = (datetime.now(timezone.utc) - timedelta(hours=HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cons = [f"{t}>={since}", f"{la}>={BOX['s']}", f"{la}<={BOX['n']}", f"{lo}>={BOX['w']}", f"{lo}<={BOX['e']}"]
    url = f"{server}/tabledap/{did}.json?" + ",".join(cols) + "&" + "&".join(urllib.parse.quote(c, safe="=") for c in cons)
    log(f"  interrogo {did}")
    rows = table(get(url, timeout=150))
    return [dict(id=str(r[pid]), name=(r.get(name) if name else None), time=r[t], lat=r[la], lon=r[lo], hs=r[hs],
                 tp=r.get(pick(names, "VTPK") or "") or r.get(pick(names, "VTM10") or "") or r.get(pick(names, "VTM02") or ""),
                 dir=r.get(pick(names, "VMDR") or "") or r.get(pick(names, "VPED") or "")) for r in rows if r[hs] is not None]


def main():
    rows, used = [], None
    for server in SERVERS:
        log(f"Server {server}")
        try:
            ids = datasets(server)
        except Exception as ex:
            log(f"  non raggiungibile: {ex}")
            continue
        log(f"  dataset candidati: {len(ids)}")
        for did in ids[:40]:
            try:
                got = query(server, did, variables(server, did))
            except Exception as ex:
                log(f"  {did}: {ex}")
                continue
            if got:
                log(f"  {did}: {len(got)} misure")
                rows += got
                used = used or f"{server} ({did})"
            time.sleep(1)
        if rows:
            break

    by = {}
    for r in rows:
        by.setdefault(r["id"], []).append(r)
    buoys = []
    for pid, rs in by.items():
        rs.sort(key=lambda r: r["time"])
        last = rs[-1]
        d = km(HOME, (last["lat"], last["lon"]))
        if d > MAX_KM:
            continue
        series, seen = [], set()
        for r in rs:                                 # una misura per ora
            k = r["time"][:13]
            if k in seen:
                series[-1] = r
                continue
            seen.add(k); series.append(r)
        buoys.append(dict(id=pid, name=last["name"], lat=round(last["lat"], 4), lon=round(last["lon"], 4), km=round(d),
                          last=dict(time=last["time"], hs=last["hs"], tp=last["tp"], dir=last["dir"]),
                          series=[dict(t=r["time"], hs=r["hs"], tp=r["tp"], dir=r["dir"]) for r in series[-HOURS:]]))
    buoys.sort(key=lambda b: b["km"])
    out = dict(updated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               source="EMODnet Physics / ISPRA RON" if buoys else None, via=used, buoys=buoys[:4])
    with open("buoy.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    if buoys:
        for b in buoys[:4]:
            log(f"Boa {b['id']} {b['name'] or ''} a {b['km']} km: {b['last']['hs']} m alle {b['last']['time']}")
    else:
        log("Nessuna boa con dati recenti trovata: buoy.json vuoto")


if __name__ == "__main__":
    main()
