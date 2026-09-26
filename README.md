# Onde

App di previsioni surf per gli spot della Sardegna, con alert su Telegram. Tutto gratuito: dati Open-Meteo, hosting GitHub Pages, alert con GitHub Actions, mappa Windy incorporata.

## Cosa c'è nel repository

| File | A cosa serve |
|---|---|
| `index.html` | L'app: schede Spot, Mappa e Alert, dettaglio di ogni spot a 7 giorni |
| `spots.json` | Gli spot e i loro parametri, letti sia dall'app sia dagli alert |
| `alert_telegram.py` | Controlla le previsioni e invia i messaggi Telegram |
| `.github/workflows/alert.yml` | Esegue lo script ogni 3 ore |
| `sessioni.csv` | Diario delle sessioni reali, per tarare gli spot |
| `alert_state.json` | Creato in automatico: ricorda gli avvisi già inviati |

## 1. Crea il repository

1. Su github.com crea un nuovo repository, per esempio `onde`. Pubblico va bene: dati e codice non sono riservati, e i segreti stanno altrove.
2. Carica tutti i file di questa cartella, compresa `.github/workflows/alert.yml` (con "Add file › Upload files" trascina la cartella intera, oppure usa git).

## 2. Crea il bot Telegram

1. In Telegram apri **@BotFather**, scrivi `/newbot` e scegli nome e username. Ti dà un **token** tipo `123456:ABC...`.
2. Apri la chat con il tuo nuovo bot e scrivigli un messaggio qualsiasi.
3. Nel browser apri `https://api.telegram.org/bot<TOKEN>/getUpdates` sostituendo il token. Nel testo cerca `"chat":{"id":` e copia il numero: è il **chat ID**.
   Per mandare gli alert a un gruppo, aggiungi il bot al gruppo, scrivi un messaggio e ripeti: l'ID del gruppo inizia con `-`.

## 3. Collega Telegram al repository

In GitHub, nel repository: **Settings › Secrets and variables › Actions**.

- Scheda *Secrets*, "New repository secret":
  - `TELEGRAM_TOKEN` = il token del bot
  - `TELEGRAM_CHAT_ID` = il chat ID
- Scheda *Variables* (facoltativo): `SURF_THRESHOLD` = soglia di punteggio, per esempio `3` o `3.5`. Se manca vale 3.

Il token non va mai scritto nei file del repository.

## 4. Prova gli alert

1. Scheda **Actions**: se chiede di abilitare i workflow, conferma.
2. Apri "Alert onde" › **Run workflow**.
3. Dopo circa un minuto il job diventa verde. Se ci sono onde sopra soglia arriva il messaggio su Telegram, altrimenti nel log trovi "Nessun nuovo avviso".

Da qui in poi parte da solo ogni 3 ore. Ricevi un messaggio solo per un giorno nuovo sopra soglia o quando il punteggio di un giorno già segnalato migliora.

Nota: GitHub sospende i workflow programmati dopo 60 giorni senza attività nel repository. I commit di `alert_state.json` di solito bastano a tenerlo attivo; se ricevi una mail di sospensione, riattivalo dalla scheda Actions.

## 5. Pubblica l'app

1. **Settings › Pages**: in "Source" scegli *Deploy from a branch*, branch `main`, cartella `/ (root)`, Save.
2. Dopo un paio di minuti l'app è su `https://<tuo-utente>.github.io/onde/`.
3. Dal telefono aprila e usa "Aggiungi a schermata Home" per averla come un'app.

Le notifiche del browser funzionano solo con l'app aperta: per gli avvisi veri c'è Telegram.

## 6. Taratura degli spot

La precisione dipende dai parametri in `spots.json`, che per ora sono indicativi.

| Campo | Significato |
|---|---|
| `lat`, `lon` | Un punto **in mare** davanti allo spot, qualche centinaio di metri al largo. Se l'app dice "Nessun dato", spostalo più al largo |
| `facing` | Direzione da cui arriva lo swell ideale (0 = N, 90 = E, 180 = S, 270 = O) |
| `window` | Quanti gradi di scarto dallo swell ideale lo spot accetta ancora |
| `offshore` | Direzione da cui soffia il vento offshore ideale |
| `min`, `max` | Onda surfabile a riva, in metri |
| `minPeriod` | Periodo minimo, in secondi, perché lo spot lavori bene |
| `alert` | `true` se lo spot deve comparire negli alert Telegram |

Come procedere, per 3-4 settimane:

1. Dopo ogni sessione, o anche solo guardando lo spot, aggiungi una riga a `sessioni.csv`: cosa diceva l'app e com'era davvero.
2. Ogni settimana guarda le differenze:
   - l'app sovrastima sempre l'onda → alza `min` e `max` oppure restringi `window`
   - lo spot funzionava ma l'app lo dava piatto → allarga `window` o correggi `facing`
   - era rovinato dal vento ma l'app lo dava buono → correggi `offshore`
3. Modifica `spots.json` direttamente da GitHub (icona matita): app e alert usano subito i nuovi valori.

Il punteggio è calcolato in modo identico in `index.html` (funzione `evaluate`) e in `alert_telegram.py`: se cambi la formula, cambiala in entrambi.

## Aggiungere uno spot

Copia una riga in `spots.json`, dai un `id` unico senza spazi e compila i campi. Dall'app puoi anche creare spot personali, ma restano solo sul dispositivo e non ricevono gli alert Telegram.

## Mappa Windy

Il widget è gratuito e si configura su windy.com/-Embed-widget-on-page/widgets. Se vuoi cambiare zoom, zona o livello mostrato, copia il nuovo indirizzo dell'iframe nella costante `WINDY_URL` in `index.html`.

## Prova in locale

```
python3 -m http.server 8000     # poi apri http://localhost:8000
python3 alert_telegram.py --prova   # stampa gli alert senza inviarli
```

L'app va aperta tramite un server (anche quello qui sopra), non con doppio clic sul file, perché deve leggere `spots.json`.
