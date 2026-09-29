# Sinis Waves

App web per previsioni surf e alert sugli spot del Sinis (Sardegna). Calcola un punteggio da 0 a 5 per ogni spot combinando onda a riva, periodo e vento. Si installa sulla Home dell'iPhone da Safari.

**App:** https://devskip.github.io/waves/

Tutto gira su servizi gratuiti: GitHub Pages (hosting), GitHub Actions (automazioni), Supabase (account e dati), Brevo (email di accesso), Open-Meteo e Copernicus Marine (dati).

## Come funziona

- **L'app** (`index.html`) legge previsioni e meteo da Open-Meteo, le misure delle boe da `buoy.json` e il catalogo degli spot noti da `catalog.json`. I dati personali restano sul telefono (IndexedDB) e, con l'account, si sincronizzano su Supabase.
- **Le automazioni** su GitHub Actions aggiornano i file delle boe e del catalogo e inviano gli alert Telegram.
- **Supabase** conserva profili, spot, preferenze e sessioni, con regole che limitano ogni utente ai propri dati. L'accesso avviene con un codice di 6 cifre inviato via email tramite Brevo.

## File del repository

I file marcati *generato* li scrivono le automazioni: non vanno modificati a mano.

| File | Tipo | Contenuto |
| --- | --- | --- |
| `index.html` | App | Interfaccia, calcoli, mappa, accesso e sincronizzazione |
| `spots.json` | Dati di riserva | Spot ufficiali di partenza, usati se il database non risponde |
| `apple-touch-icon.png` | Immagine | Icona dell'app sulla Home (180×180) |
| `sinis-waves-logo.svg` | Immagine | Logo vettoriale |
| `supabase_schema.sql` | Database | Struttura completa del database, rieseguibile |
| `alert_telegram.py` | Script | Calcola i punteggi e invia gli alert Telegram |
| `alert_state.json` | Generato | Alert già inviati, per non ripeterli |
| `build_catalog.py` | Script | Scarica da OpenStreetMap gli spot di surf noti |
| `catalog.json` | Generato | Catalogo degli spot noti mostrato sulla mappa |
| `build_buoy.py` | Script | Scarica da Copernicus le misure delle boe intorno alla Sardegna |
| `buoy.json` | Generato | Ultime 48 ore delle boe entro 300 km dal Sinis |
| `buoy_history.csv` | Generato | Storico orario: misura della boa contro modello |
| `sessioni.csv` | Dati | Vecchio registro sessioni (ora le sessioni stanno nel database) |

## Automazioni

Si lanciano anche a mano da **Actions › nome › Run workflow**.

| Automazione | Quando gira | Cosa fa |
| --- | --- | --- |
| Boe | Ogni ora al minuto 20 | `build_buoy.py` → `buoy.json`, `buoy_history.csv` |
| Catalogo spot | Giorno 1 del mese, 04:00 UTC | `build_catalog.py` → `catalog.json` |
| Alert Telegram | Secondo l'orario nel workflow | `alert_telegram.py` → messaggi e `alert_state.json` |

Se un'automazione fallisce sul "push": **Settings › Actions › General › Workflow permissions › Read and write**.

GitHub sospende i workflow programmati dopo 60 giorni senza attività nel repository; i commit automatici di solito bastano, altrimenti si riattivano dalla scheda Actions.

## Segreti

Nessun segreto sta nel codice. In **Settings › Secrets and variables › Actions**:

- `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`: bot e chat degli alert
- `COPERNICUSMARINE_SERVICE_USERNAME`, `COPERNICUSMARINE_SERVICE_PASSWORD`: dati delle boe
- `SURF_THRESHOLD` (facoltativo): soglia degli alert, di serie 3

Nell'app c'è solo la chiave pubblica di Supabase (`sb_publishable_…`), protetta dalle regole del database. La chiave segreta (`sb_secret_…`) non va mai messa nel repository.

## Ripartire da zero

1. Crea un repository pubblico e carica tutti i file, compresa `.github/workflows/`.
2. **Settings › Pages**: Deploy from a branch, `main`, `/ (root)`.
3. **Settings › Actions › General**: Workflow permissions su Read and write.
4. Aggiungi i segreti elencati sopra.
5. Su Supabase crea un progetto Free (Central EU) ed esegui `supabase_schema.sql` nel SQL Editor.
6. Se il progetto Supabase è nuovo, aggiorna indirizzo e chiave pubblica in `index.html` (`SUPA_URL`, `SUPA_KEY`) e in `alert_telegram.py` (`SUPABASE_URL`, `SUPABASE_KEY`).
7. Supabase › Authentication › URL Configuration: Site URL e Redirect URL con l'indirizzo dell'app (`…/waves/` e `…/waves/**`).
8. Brevo: verifica il mittente e genera una chiave SMTP; in Supabase attiva il custom SMTP (`smtp-relay.brevo.com`, porta 587) e usa `{{ .Token }}` nei modelli "Magic Link" e "Confirm sign up".
9. Lancia a mano Catalogo spot e Boe e controlla che compaiano `catalog.json` e `buoy.json`.
10. Accedi dall'app (Alert › Account) e rendi il tuo profilo amministratore:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'LA-TUA-EMAIL');
```

## Fonti e crediti

- Previsioni onde, vento, meteo e marea: [Open-Meteo](https://open-meteo.com) (gratuito per uso non commerciale)
- Misure delle boe: [Copernicus Marine Service](https://marine.copernicus.eu)
- Spot noti: © contributori [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL)
- Sfondo mappa: Esri World Light Gray
- Onde animate: embed [Windy](https://www.windy.com)
- Librerie: Leaflet, Leaflet.markercluster, supabase-js
