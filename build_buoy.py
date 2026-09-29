"""Scarica le misure delle boe ondametriche vicine al Sinis e le salva in buoy.json.
Lo lancia GitHub Actions ogni ora (.github/workflows/buoy.yml); l'app legge poi buoy.json dal sito.

Fonte: Copernicus Marine, prodotto In Situ del Mediterraneo in tempo quasi reale
(cmems_obs-ins_med_phybgcwav_mynrt_na_irr). Serve un account gratuito: nome utente e password
vanno nei segreti del repository COPERNICUSMARINE_SERVICE_USERNAME e COPERNICUSMARINE_SERVICE_PASSWORD.

Le boe non sono scritte a mano: lo script legge l'indice dei file "latest" e tiene le piattaforme
con misure d'onda recenti nei mari intorno alla Sardegna (per esempio la boa Météo-France "Sardaigne",
al largo della costa ovest).

Tiene anche buoy_history.csv: lo storico ora per ora di ogni boa, misura contro modello Open-Meteo
nello stesso punto. Ogni run aggiunge le ore nuove e aggiorna quelle già presenti, senza cancellare niente."""
import csv, glob, io, json, math, os, sys, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

DATASETS = ["cmems_obs-ins_med_phybgcwav_mynrt_na_irr"]
DATASET = DATASETS[0]
HOME = (40.0, 8.35)                                   # Sinis, davanti a Capo Mannu
BOX = dict(s=37.5, n=42.8, w=5.5, e=11.0)
MAX_KM = 300
HOURS = 48
# tutte le sigle Copernicus per l'altezza d'onda significativa
HS_CODES = ("VHM0", "VAVH", "VTDH", "VGHS", "VCAR", "VHZA")
NAMES = {"6101035": "Boa Sardegna (Météo-France)", "6101031": "Boa Ajaccio", "6101032": "Boa Vecchio",
         "6100023": "Boa Bonifacio", "6100295": "Boa Alistro", "6101033": "Boa Calvi"}
HISTORY = "buoy_history.csv"
HCOLS = ["buoy_id", "name", "lat", "lon", "time", "obs_hs", "obs_tp", "obs_dir", "mod_hs", "mod_tp", "mod_dir"]


def log(m):
    print(m, flush=True)


def km(a, b):
    r = math.pi / 180
    x = math.sin((b[0]-a[0])*r/2)**2 + math.cos(a[0]*r)*math.cos(b[0]*r)*math.sin((b[1]-a[1])*r/2)**2
    return 2 * 6371 * math.asin(math.sqrt(x))


def write(buoys, via):
    out = dict(updated=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               source="Copernicus Marine In Situ" if buoys else None, via=via, buoys=buoys)
    with open("buoy.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))


def model_at(lat, lon):
    """Onda del modello Open-Meteo nel punto della boa, ora per ora (chiave: 'AAAA-MM-GGTHH')."""
    q = urllib.parse.urlencode(dict(latitude=lat, longitude=lon, cell_selection="sea", timezone="GMT",
                                    past_days=3, forecast_days=1, hourly="wave_height,wave_period,wave_direction"))
    req = urllib.request.Request(f"https://marine-api.open-meteo.com/v1/marine?{q}",
                                 headers={"User-Agent": "sinis-waves-buoy/1.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        h = json.load(r)["hourly"]
    return {t[:13]: (h["wave_height"][i], h["wave_period"][i], h["wave_direction"][i]) for i, t in enumerate(h["time"])}


def save_history(buoys):
    """Aggiunge a buoy_history.csv le ore misurate, con accanto il valore del modello."""
    rows = {}
    if os.path.exists(HISTORY):
        with open(HISTORY, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows[(r["buoy_id"], r["time"])] = r
    before = len(rows)
    blank = lambda x: "" if x is None else x
    for b in buoys:
        try:
            mod = model_at(b["lat"], b["lon"])
        except Exception as ex:
            log(f"  modello per la boa {b['id']} non disponibile ({ex}): salvo solo le misure")
            mod = {}
        for p in b["series"]:
            old = rows.get((b["id"], p["t"]), {})
            m = mod.get(p["t"][:13])
            rows[(b["id"], p["t"])] = dict(
                buoy_id=b["id"], name=b["name"] or "", lat=b["lat"], lon=b["lon"], time=p["t"],
                obs_hs=blank(p["hs"]), obs_tp=blank(p["tp"]), obs_dir=blank(p["dir"]),
                # se il modello ora non risponde, tengo il valore salvato da un run precedente
                mod_hs=blank(m[0]) if m else old.get("mod_hs", ""),
                mod_tp=blank(m[1]) if m else old.get("mod_tp", ""),
                mod_dir=blank(m[2]) if m else old.get("mod_dir", ""))
    with open(HISTORY, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=HCOLS)
        w.writeheader()
        for k in sorted(rows, key=lambda k: (k[1], k[0])):
            w.writerow({c: rows[k].get(c, "") for c in HCOLS})
    log(f"{HISTORY}: {len(rows)} righe ({len(rows) - before} nuove)")


def read_index(path):
    """L'intestazione sta in una riga di commento (# ...). Se non la trovo, riconosco il formato
    dal numero di colonne: 10 (ultima posizione della boa) o 12 (riquadro min/max)."""
    header, data = None, []
    for l in open(path, encoding="utf-8", errors="replace"):
        if l.startswith("#"):
            if "file_name" in l:
                header = [h.strip() for h in l.lstrip("#").split(",")]
            continue
        if l.strip():
            data.append(l)
    rows = list(csv.reader(io.StringIO("".join(data))))
    out = []
    for r in rows:
        r = [x.strip() for x in r]
        if header and len(header) == len(r):
            d = dict(zip(header, r))
        elif len(r) >= 12:
            d = dict(zip(["catalog_id", "file_name", "geospatial_lat_min", "geospatial_lat_max", "geospatial_lon_min",
                          "geospatial_lon_max", "time_coverage_start", "time_coverage_end", "provider", "date_update",
                          "data_mode", "parameters"], r))
        elif len(r) >= 10:
            d = dict(zip(["catalog_id", "file_name", "last_latitude_observation", "last_longitude_observation",
                          "time_coverage_start", "time_coverage_end", "provider", "date_update", "data_mode", "parameters"], r))
        else:
            continue
        # posizione unica, comunque sia scritta
        la = d.get("last_latitude_observation") or d.get("geospatial_lat_max")
        lo = d.get("last_longitude_observation") or d.get("geospatial_lon_max")
        d["lat"], d["lon"] = la, lo
        out.append(d)
    return out


def _inbox(r):
    try:
        return BOX["s"] <= float(r["lat"]) <= BOX["n"] and BOX["w"] <= float(r["lon"]) <= BOX["e"]
    except (TypeError, ValueError):
        return False


def parse_time(s):
    return datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def main():
    if not (os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME") and os.environ.get("COPERNICUSMARINE_SERVICE_PASSWORD")):
        log("Mancano i segreti COPERNICUSMARINE_SERVICE_USERNAME / COPERNICUSMARINE_SERVICE_PASSWORD")
        write([], None)
        return
    import copernicusmarine as cm
    import netCDF4
    global np
    import numpy as np

    # 1) indici dei file: quali piattaforme hanno misure d'onda recenti nella zona
    since = datetime.now(timezone.utc) - timedelta(hours=HOURS + 24)
    files, seen = [], set()
    for ds in DATASETS:
        out = f"idx/{ds}"
        try:
            cm.get(dataset_id=ds, index_parts=True, output_directory=out, overwrite=True, disable_progress_bar=True)
        except Exception as ex:
            log(f"{ds}: indice non disponibile ({ex})"); continue
        idx = [p for p in glob.glob(f"{out}/**/*.txt", recursive=True) if "latest" in os.path.basename(p).lower()]
        if not idx:
            log(f"{ds}: indice 'latest' non trovato"); continue
        rows = read_index(idx[0])
        log(f"{ds}: {len(rows)} file nell'indice")
        zone = sorted({os.path.basename(r["file_name"]).rsplit("_", 1)[0] for r in rows if _inbox(r) and "_TS_" in r["file_name"]})
        log(f"  piattaforme fisse nella zona: {zone[:25]}")
        last = {}
        for r in rows:
            if _inbox(r) and "_TS_MO_" in r["file_name"]:
                k = os.path.basename(r["file_name"]).rsplit("_", 1)[0]
                if k not in last or r["time_coverage_end"] > last[k]["time_coverage_end"]:
                    last[k] = r
        for k, r in sorted(last.items()):
            log(f"    {k}: fino a {r['time_coverage_end']}, a {round(km(HOME, (float(r['lat']), float(r['lon']))))} km, parametri: {r.get('parameters','').strip()}")
        for r in rows:
            try:
                lat, lon = float(r["lat"]), float(r["lon"])
                end = parse_time(r["time_coverage_end"])
            except (KeyError, ValueError, TypeError):
                continue
            params = r.get("parameters", "")
            if not any(c in params for c in HS_CODES):
                continue
            if not _inbox(r) or end < since or km(HOME, (lat, lon)) > MAX_KM:
                continue
            fn = os.path.basename(r["file_name"])
            if fn not in seen:
                seen.add(fn); files.append((ds, fn))
    log(f"File utili: {[f for _, f in files]}")
    if not files:
        write([], None); log("Nessuna boa con dati recenti trovata: buoy.json vuoto"); return

    # 2) scarico i file e leggo altezza, periodo e direzione
    by = {}
    for ds, fn in files[:24]:
        try:
            cm.get(dataset_id=ds, dataset_part="latest", filter=f"*{fn}", output_directory="dl",
                   no_directories=True, overwrite=True, disable_progress_bar=True)
        except Exception as ex:
            log(f"  {fn}: download non riuscito ({ex})"); continue
        path = os.path.join("dl", fn)
        if not os.path.exists(path):
            cands = glob.glob(f"dl/**/{fn}", recursive=True)
            if not cands:
                log(f"  {fn}: file non trovato dopo il download"); continue
            path = cands[0]
        with netCDF4.Dataset(path) as nc:
            v = nc.variables
            hs = next((c for c in HS_CODES if c in v), None)
            if not hs:
                log(f"  {fn}: niente altezza d'onda"); continue
            t = netCDF4.num2date(v["TIME"][:], v["TIME"].units, only_use_cftime_datetimes=False)
            lat, lon = float(v["LATITUDE"][:].ravel()[-1]), float(v["LONGITUDE"][:].ravel()[-1])
            pid = str(getattr(nc, "platform_code", "") or fn.split("_")[-2])
            name = NAMES.get(pid) or getattr(nc, "platform_name", "") or None
            def col(*codes):
                code = next((c for c in codes if c in v), None)
                if not code: return None
                arr = np.ma.filled(np.ma.masked_invalid(np.ma.asarray(v[code][:]).astype(float)), np.nan)
                if arr.ndim > 1:  # più profondità: prendo il primo valore valido di ogni istante
                    with np.errstate(all="ignore"):
                        arr = np.array([next((x for x in row if not np.isnan(x)), np.nan) for row in arr.reshape(arr.shape[0], -1)])
                return arr
            H, tp, dr = col(hs), col("VTPK", "VTM10", "VTM02", "VGTA", "VAVT"), col("VMDR", "VPED", "VDIR")
            b = by.setdefault(pid, dict(name=name, lat=lat, lon=lon, pts={}))
            for i, ti in enumerate(t):
                val = H[i]
                if np.isnan(val) or not (0 <= val < 25):
                    continue
                b["pts"][ti.strftime("%Y-%m-%dT%H:00:00Z")] = dict(
                    hs=round(float(val), 2),
                    tp=None if tp is None or np.isnan(tp[i]) else round(float(tp[i]), 1),
                    dir=None if dr is None or np.isnan(dr[i]) else int(round(float(dr[i]))))
            pts = [p["hs"] for p in b["pts"].values()]
            log(f"  {fn}: {hs}, forma {v[hs].shape}, valori validi {int(np.sum(~np.isnan(H)))}/{len(H)}"
                + (f", da {min(pts)} a {max(pts)} m" if pts else f", esempio grezzo {np.ma.asarray(v[hs][:]).ravel()[:5].tolist()}"))

    buoys = []
    for pid, b in by.items():
        keys = sorted(b["pts"])[-HOURS:]
        if not keys:
            continue
        series = [dict(t=k, **b["pts"][k]) for k in keys]
        last = series[-1]
        buoys.append(dict(id=pid, name=b["name"], lat=round(b["lat"], 4), lon=round(b["lon"], 4),
                          km=round(km(HOME, (b["lat"], b["lon"]))),
                          last=dict(time=last["t"], hs=last["hs"], tp=last["tp"], dir=last["dir"]), series=series))
    buoys.sort(key=lambda b: b["km"])
    write(buoys[:4], ", ".join(DATASETS))
    for b in buoys[:4]:
        log(f"Boa {b['id']} {b['name'] or ''} a {b['km']} km: {b['last']['hs']} m alle {b['last']['time']}")
    if not buoys:
        log("Nessuna misura valida nei file scaricati")
        return
    # 3) storico: un errore qui non deve mai compromettere buoy.json, già salvato sopra
    try:
        save_history(buoys[:4])
    except Exception as ex:
        log(f"{HISTORY} non aggiornato ({ex})")


if __name__ == "__main__":
    main()
