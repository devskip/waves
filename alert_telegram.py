#!/usr/bin/env python3
"""Alert surf su Telegram.

Scarica le previsioni Open-Meteo, calcola il punteggio degli spot (stessa logica
dell'app web) e invia un messaggio quando uno spot supera la soglia nei prossimi giorni.

Legge gli spot da spots.json (solo quelli con "alert": true) e salva in
alert_state.json cosa ha già inviato. Su GitHub gira con .github/workflows/alert.yml.

Uso in locale:
    export TELEGRAM_TOKEN="123:ABC"        # token del bot da @BotFather
    export TELEGRAM_CHAT_ID="123456789"    # la tua chat o un gruppo
    export SURF_THRESHOLD=3                # opzionale, default 3
    python3 alert_telegram.py              # aggiungi --prova per stampare senza inviare
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# Spot: prima dal database (quelli ufficiali con alert attivo), poi da spots.json per quelli non ancora migrati.
# La chiave "publishable" è pubblica: legge solo gli spot ufficiali.
SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://djicqanyclbrfzhxlsxm.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or "sb_publishable_YcNI9IPd7AyG5_EE-jc0Rw_BhsKkcMf"


def load_spots():
    db = []
    try:
        req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/spots?select=*&visibility=eq.public",
                                     headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            for x in json.load(r):
                db.append(dict(id=x["id"], name=x["name"], lat=x["lat"], lon=x["lon"], facing=float(x["facing"]),
                               window=float(x["window"]), offshore=float(x["offshore"]), min=float(x["min"]),
                               max=float(x["max"]), minPeriod=float(x["min_period"]), gain=float(x.get("gain") or 1),
                               alert=bool(x.get("alert_default"))))
        print(f"Spot dal database: {len(db)}")
    except Exception as ex:
        print(f"Database non raggiungibile ({ex}): uso solo spots.json")
    ids = {s["id"] for s in db}
    try:
        extra = [s for s in json.loads((ROOT / "spots.json").read_text(encoding="utf-8"))["spots"] if s["id"] not in ids]
    except Exception:
        extra = []
    return [s for s in db + extra if s.get("alert")]


SPOTS = load_spots()
TZ = "Europe/Rome"
DAY_START, DAY_END = 7, 19
DAYS_AHEAD = 4
STATE_FILE = ROOT / "alert_state.json"
GIORNI = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]


def clamp(x, a, b):
    return max(a, min(b, x))


def ang_diff(a, b):
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def cardinal(d):
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"][round((d % 360) / 22.5) % 16]


def get_json(url, params):
    q = urllib.parse.urlencode(params)
    with urllib.request.urlopen(f"{url}?{q}", timeout=30) as r:
        data = json.load(r)
    return data if isinstance(data, list) else [data]


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
    # "gain" è la correzione d'onda che nasce dalla taratura con le sessioni reali (1 = nessuna correzione)
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
    return dict(score=score, face=face, dir=direction, T=T, ws=ws, wind_type=wind_type)


def fetch():
    lat = ",".join(str(s["lat"]) for s in SPOTS)
    lon = ",".join(str(s["lon"]) for s in SPOTS)
    common = dict(latitude=lat, longitude=lon, timezone=TZ, forecast_days=7)
    marine = get_json("https://marine-api.open-meteo.com/v1/marine", dict(common, hourly=
        "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period"))
    wind = get_json("https://api.open-meteo.com/v1/forecast", dict(common, hourly=
        "wind_speed_10m,wind_direction_10m,wind_gusts_10m"))
    out = {}
    for k, spot in enumerate(SPOTS):
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


def find_hits(data, threshold):
    now_key = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%dT%H:00")
    hits = []
    for spot in SPOTS:
        s = data[spot["id"]]
        best_by_day = {}
        for i, t in enumerate(s["time"]):
            if t < now_key:
                continue
            day, hour = t[:10], int(t[11:13])
            if not (DAY_START <= hour <= DAY_END):
                continue
            ev = evaluate(spot, s, i)
            if not ev or ev["score"] < threshold:
                continue
            cur = best_by_day.get(day)
            if cur is None:
                best_by_day[day] = dict(ev, first_hour=hour, best_hour=hour)
            elif ev["score"] > cur["score"]:
                best_by_day[day] = dict(ev, first_hour=cur["first_hour"], best_hour=hour)
        days = sorted(best_by_day)[:DAYS_AHEAD]
        hits += [(spot, d, best_by_day[d]) for d in days]
    return hits


def send(token, chat_id, text):
    body = urllib.parse.urlencode(dict(chat_id=chat_id, text=text)).encode()
    urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=body, timeout=30)


def main():
    dry_run = "--prova" in sys.argv
    token = os.environ.get("TELEGRAM_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not dry_run and not (token and chat_id):
        sys.exit("Mancano TELEGRAM_TOKEN o TELEGRAM_CHAT_ID")
    threshold = float(os.environ.get("SURF_THRESHOLD") or 3)
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}

    hits = find_hits(fetch(), threshold)
    lines = []
    for spot, day, ev in hits:
        key = f"{spot['id']}|{day}"
        # nuovo avviso solo se è la prima volta o se il punteggio migliora
        if state.get(key, -1) >= ev["score"]:
            continue
        state[key] = ev["score"]
        weekday = GIORNI[datetime.strptime(day, "%Y-%m-%d").weekday()]
        lines.append(
            f"🌊 {spot['name']}: {ev['score']:g}/5 {weekday} {int(day[8:])} dalle {ev['first_hour']}:00 "
            f"(meglio verso le {ev['best_hour']}), ~{ev['face']:.1f} m, swell da {cardinal(ev['dir'])} "
            f"{round(ev['T'])} s, vento {ev['wind_type']} {round(ev['ws'])} km/h"
        )

    if lines:
        text = "Onde in arrivo\n\n" + "\n".join(lines)
        if dry_run:
            print(text)
            return
        send(token, chat_id, text)
    else:
        print("Nessun nuovo avviso")

    today = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%d")
    state = {k: v for k, v in state.items() if k.split("|")[1] >= today}
    STATE_FILE.write_text(json.dumps(state, indent=1))


if __name__ == "__main__":
    main()
