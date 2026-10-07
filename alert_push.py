#!/usr/bin/env python3
"""Alert surf via notifiche push (blocca schermo + badge sull'icona dell'app).

Funziona come alert_telegram.py ma manda l'avviso alle persone che hanno attivato le notifiche
nell'app: ognuna riceve solo gli spot che segue, con la sua soglia e la sua correzione d'onda.
Gira su GitHub dopo lo script Telegram (vedi .github/workflows/alert.yml).

Variabili d'ambiente:
    SUPABASE_URL           indirizzo del progetto (default: quello dell'app)
    SUPABASE_SERVICE_KEY   chiave di servizio (segreta): serve a leggere iscrizioni e preferenze di tutti
    VAPID_PRIVATE_KEY      chiave privata delle notifiche (segreta)
    VAPID_SUBJECT          opzionale, contatto 'mailto:indirizzo@...' (default: indirizzo del bot GitHub)

Prova senza inviare:   python3 alert_push.py --prova
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://djicqanyclbrfzhxlsxm.supabase.co"
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT") or "mailto:onde-bot@users.noreply.github.com"   # contatto richiesto dalle notifiche push, deve iniziare con mailto:

TZ = "Europe/Rome"
DAY_START, DAY_END = 7, 19          # ore del giorno che contano per il punteggio
QUIET_FROM, QUIET_TO = 25, 0        # di notte non si disturba: l'avviso parte alla prima esecuzione utile
DAYS_AHEAD = 4
GIORNI = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]


# ---------- Database (Supabase REST) ----------
def db(method, path, body=None, params=None, prefer=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}" + (("?" + urllib.parse.urlencode(params)) if params else "")
    headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


# ---------- Calcolo del punteggio (stessa logica di alert_telegram.py e dell'app) ----------
def clamp(x, a, b):
    return max(a, min(b, x))


def ang_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def get_json(url, params):
    """Open-Meteo a volte non risponde subito (soprattutto dopo lo script Telegram): riprovo con attese crescenti."""
    q = urllib.parse.urlencode(params)
    attese = [20, 45, 90]
    for tentativo in range(len(attese) + 1):
        try:
            with urllib.request.urlopen(f"{url}?{q}", timeout=30) as r:
                data = json.load(r)
            return data if isinstance(data, list) else [data]
        except Exception as ex:
            if tentativo == len(attese):
                raise
            print(f"Open-Meteo non risponde ({ex}), riprovo tra {attese[tentativo]} s")
            time.sleep(attese[tentativo])


def evaluate(spot, s, i):
    hs, direction, T = s["hs"][i], s["dir"][i], s["per"][i]
    if hs is None or direction is None or T is None:
        return None
    sh, sd, sp = s["sh"][i], s["sd"][i], s["sp"][i]
    if sh is not None and sd is not None and sp is not None and sh >= 0.5 * hs:
        direction, T = sd, max(T, sp)
    d = ang_diff(direction, spot["facing"])
    w = spot["window"]
    dir_f = 1 if d <= w else 0 if d >= w + 35 else 1 - (d - w) / 35
    face = hs * dir_f * clamp(0.75 + (T - 6) * 0.06, 0.6, 1.3) * spot.get("gain", 1)
    if face < spot["min"]:
        h_score = 0.3 * face / spot["min"]
    elif face <= spot["max"]:
        h_score = 0.6 + 0.4 * min(1, (face - spot["min"]) / ((spot["max"] - spot["min"]) * 0.6))
    else:
        h_score = max(0, 1 - (face - spot["max"]) / spot["max"])
    period_f = 1 if T >= spot["minPeriod"] else clamp((T - 3) / (spot["minPeriod"] - 3), 0.2, 1)
    ws = s["ws"][i] or 0
    wd = s["wd"][i] or 0
    dw = ang_diff(wd, spot["offshore"])
    wind_type = "debole" if ws < 8 else "offshore" if dw <= 45 else "laterale" if dw <= 110 else "onshore"
    wind_f = {
        "debole": 1,
        "offshore": 1 if ws <= 35 else 0.7,
        "laterale": clamp(1 - (ws - 8) / 35, 0.35, 1),
        "onshore": clamp(1 - (ws - 8) / 22, 0.1, 1),
    }[wind_type]
    score = min(5, round(5 * h_score * period_f * wind_f * 2) / 2)
    return dict(score=score, face=face, T=T, ws=ws, wind_type=wind_type)


def fetch(spots):
    lat = ",".join(str(s["lat"]) for s in spots)
    lon = ",".join(str(s["lon"]) for s in spots)
    common = dict(latitude=lat, longitude=lon, timezone=TZ, forecast_days=7)
    marine = get_json("https://marine-api.open-meteo.com/v1/marine", dict(common, hourly=
        "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period"))
    wind = get_json("https://api.open-meteo.com/v1/forecast", dict(common, hourly=
        "wind_speed_10m,wind_direction_10m,wind_gusts_10m"))
    out = {}
    for k, spot in enumerate(spots):
        m, w = marine[k]["hourly"], wind[k]["hourly"]
        widx = {t: i for i, t in enumerate(w["time"])}
        pick = lambda arr, t: arr[widx[t]] if t in widx else None
        out[spot["id"]] = dict(
            time=m["time"], hs=m["wave_height"], dir=m["wave_direction"], per=m["wave_period"],
            sh=m["swell_wave_height"], sd=m["swell_wave_direction"], sp=m["swell_wave_period"],
            ws=[pick(w["wind_speed_10m"], t) for t in m["time"]],
            wd=[pick(w["wind_direction_10m"], t) for t in m["time"]],
        )
    return out


def best_days(spot, s, threshold):
    """Per ogni giorno futuro in cui lo spot arriva alla soglia: miglior punteggio e ore."""
    now_key = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%dT%H:00")
    best = {}
    for i, t in enumerate(s["time"]):
        if t < now_key:
            continue
        day, hour = t[:10], int(t[11:13])
        if not (DAY_START <= hour <= DAY_END):
            continue
        ev = evaluate(spot, s, i)
        if not ev or ev["score"] < threshold:
            continue
        cur = best.get(day)
        if cur is None:
            best[day] = dict(ev, first_hour=hour)
        elif ev["score"] > cur["score"]:
            best[day] = dict(ev, first_hour=cur["first_hour"])
    return {d: best[d] for d in sorted(best)[:DAYS_AHEAD]}


def to_spot(x, gain=None):
    return dict(id=x["id"], name=x["name"], lat=x["lat"], lon=x["lon"], facing=float(x["facing"]),
                window=float(x["window"]), offshore=float(x["offshore"]), min=float(x["min"]),
                max=float(x["max"]), minPeriod=float(x["min_period"]),
                gain=float(gain if gain is not None else (x.get("gain") or 1)))


# ---------- Programma ----------
def main():
    dry = "--prova" in sys.argv
    if not SERVICE_KEY:
        sys.exit("Manca SUPABASE_SERVICE_KEY")
    if not dry and not VAPID_PRIVATE:
        sys.exit("Manca VAPID_PRIVATE_KEY")

    hour = datetime.now(ZoneInfo(TZ)).hour
    if not dry and (hour >= QUIET_FROM or hour < QUIET_TO):
        print("Ore notturne: nessuna notifica, riprovo alla prossima esecuzione")
        return

    subs = db("GET", "push_subscriptions", params={"select": "user_id,endpoint,p256dh,auth"}) or []
    if not subs:
        print("Nessuna iscrizione alle notifiche")
        return
    users = sorted({s["user_id"] for s in subs})
    in_list = "in.(" + ",".join(users) + ")"

    profiles = {p["id"]: p for p in db("GET", "profiles", params={"select": "id,alert_threshold", "id": in_list}) or []}
    user_spots = db("GET", "user_spots", params={"select": "user_id,spot_id,alert,gain", "user_id": in_list}) or []
    all_spots = {x["id"]: x for x in db("GET", "spots", params={"select": "*"}) or []}

    # spot seguiti da ogni persona; chi non ha ancora scelte salvate usa gli spot con alert di default
    follows = {}
    for u in users:
        mine = [r for r in user_spots if r["user_id"] == u]
        if mine:
            follows[u] = {r["spot_id"]: r.get("gain") for r in mine if r["alert"] and r["spot_id"] in all_spots}
        else:
            follows[u] = {i: None for i, x in all_spots.items() if x.get("visibility") == "public" and x.get("alert_default")}

    needed = sorted({sid for f in follows.values() for sid in f})
    if not needed:
        print("Nessuno spot seguito")
        return
    base = [to_spot(all_spots[i]) for i in needed]
    data = fetch(base)

    sent_rows = db("GET", "push_sent", params={"select": "user_id,spot_id,day,score", "user_id": in_list}) or []
    sent = {(r["user_id"], r["spot_id"], r["day"]): float(r["score"]) for r in sent_rows}

    if not dry:
        from pywebpush import webpush, WebPushException

    today = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%d")
    total = 0
    for u in users:
        th = float((profiles.get(u) or {}).get("alert_threshold") or 3)
        lines, fresh = [], []
        for sid, gain in follows[u].items():
            spot = to_spot(all_spots[sid], gain)
            for day, ev in best_days(spot, data[sid], th).items():
                if sent.get((u, sid, day), -1) >= ev["score"]:
                    continue          # già avvisato, e il punteggio non è salito
                wd = GIORNI[datetime.strptime(day, "%Y-%m-%d").weekday()]
                lines.append(f"{spot['name']} {ev['score']:g}/5, {wd} {int(day[8:])} dalle {ev['first_hour']}:00, "
                             f"~{ev['face']:.1f} m, vento {ev['wind_type']}")
                fresh.append({"user_id": u, "spot_id": sid, "day": day, "score": ev["score"]})
        if not lines:
            continue
        payload = json.dumps({
            "title": "Onde in arrivo" if len(lines) > 1 else lines[0].split(",")[0],
            "body": "\n".join(lines[:4]) + (f"\n+ altri {len(lines) - 4}" if len(lines) > 4 else ""),
            "tag": "onde", "url": "./",
        })
        if dry:
            print(f"[{u[:8]}] soglia {th:g}\n{payload}\n")
            continue
        delivered = False
        for sub in [s for s in subs if s["user_id"] == u]:
            try:
                webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                        data=payload, vapid_private_key=VAPID_PRIVATE, vapid_claims={"sub": VAPID_SUBJECT}, ttl=6 * 3600)
                delivered = True
            except WebPushException as ex:
                code = getattr(ex.response, "status_code", None)
                if code in (404, 410):    # telefono che non esiste più: tolgo l'iscrizione
                    db("DELETE", "push_subscriptions", params={"user_id": f"eq.{u}", "endpoint": "eq." + sub["endpoint"]})
                else:
                    print(f"Invio non riuscito ({code}): {ex}")
        if delivered:
            total += 1
            db("POST", "push_sent", fresh, params={"on_conflict": "user_id,spot_id,day"},
               prefer="resolution=merge-duplicates,return=minimal")

    if not dry:
        # pulizia: avvisi di giorni ormai passati
        try:
            db("DELETE", "push_sent", params={"day": f"lt.{today}"})
        except Exception as ex:
            print(f"Pulizia non riuscita: {ex}")
    print(f"Notifiche inviate a {total} persone" if not dry else "Prova finita")


if __name__ == "__main__":
    main()
