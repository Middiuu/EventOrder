# EventOrder 🧾

**EventOrder** è un piccolo **registratore di cassa locale non fiscale**,
configurabile per qualsiasi attività o evento (sagre, mercatini, banchetti,
eventi privati, ecc.).

L'applicazione consente di:
- selezionare prodotti da un catalogo personalizzabile
- **aprire e chiudere il turno di cassa** con fondo iniziale e riconciliazione contanti
- incassare scegliendo il **metodo di pagamento** (contanti/carta/altro) con **calcolo del resto**
- stampare un ticket non fiscale e registrare automaticamente le vendite
- consultare lo **storico vendite** e annullare una vendita con motivo
- consultare incasso del giorno (per prodotto e per pagamento), con **export CSV**
  (aggregato e per-transazione) e backup del database

È pensata per l'uso locale: **veloce, minimale, zero burocrazia**. Nessun dato
esce dalla macchina su cui gira.

---

## Stack tecnologico

- **Node.js 20 LTS**
- **Express 5**
- **SQLite** (file locale, `better-sqlite3`)
- **HTML / CSS / JavaScript** (nessun build step)
- Stampa ticket: **ESC/POS** (USB / LAN – in arrivo, attualmente stub su console)

---

## Requisiti

- **Node.js 20** (consigliato tramite `nvm` — vedi `.nvmrc`)
- Git
- Browser moderno (Chrome, Firefox, Safari)

> `better-sqlite3` è un modulo nativo: usare la versione di Node indicata in
> `.nvmrc` evita problemi di compilazione.

### Uso con nvm (consigliato)

```bash
nvm use
```

## Avvio rapido

```bash
npm install
cp .env.example .env   # opzionale: personalizza branding/valuta
npm run dev
```

L'app si avvia di default su [http://localhost:3000](http://localhost:3000).

Alla prima esecuzione:
- viene creato il database locale `pos.sqlite`
- viene applicato lo schema
- vengono inseriti alcuni prodotti demo (disattivabile con `POS_SEED_DEMO=0`)

## Configurazione (generalizzazione)

Tutto il branding e la localizzazione sono guidati da variabili d'ambiente, così
lo stesso software si adatta a qualsiasi attività senza toccare il codice. Vedi
`.env.example` per l'elenco completo.

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `3000` | Porta HTTP del server |
| `APP_NAME` | `POS` | Nome mostrato nell'interfaccia (header, titoli pagina) |
| `BUSINESS_NAME` | = `APP_NAME` | Nome dell'attività stampato sul ticket |
| `APP_TAGLINE` | `Cassa locale` | Sottotitolo opzionale |
| `CURRENCY_SYMBOL` | `€` | Simbolo di valuta |
| `LOCALE` | `it-IT` | Locale per date e formattazione |
| `OPERATORS` | *(vuoto)* | Elenco operatori (`Anna,Luca`) scelti all'apertura del turno |
| `APP_PIN` | *(vuoto)* | PIN unico per proteggere l'accesso; vuoto = nessuna protezione |
| `POS_SEED_DEMO` | `1` | Prodotti demo al primo avvio (`0` per disattivare) |
| `BACKUP_KEEP` | `20` | Numero di backup da conservare (`0` = illimitato) |
| `POS_DB_PATH` | `./pos.sqlite` | Percorso del file database |

Esempio `.env` per un evento specifico:

```env
APP_NAME=Sagra del Paese
BUSINESS_NAME=Pro Loco 2026
CURRENCY_SYMBOL=€
LOCALE=it-IT
```

Il frontend legge questi valori a runtime da `GET /api/config`.

## Pagine disponibili

- `/` cassa principale (turno, carrello, pagamento con resto)
- `/products.html` gestione prodotti (con riordino drag-and-drop)
- `/sales.html` storico vendite e annullo con motivo
- `/reports.html` report del giorno, export CSV e backup DB
- `/login.html` accesso con PIN (solo se `APP_PIN` è impostato)

## Flusso d'uso a un evento

1. **Apri la cassa** inserendo il fondo iniziale (ed eventualmente l'operatore).
2. Vendi: aggiungi prodotti al carrello, premi **Incassa e stampa**, scegli il
   metodo di pagamento (per i contanti il resto è calcolato in automatico).
3. Correggi eventuali errori dalla pagina **Vendite** (annullo con motivo).
4. A fine serata **chiudi la cassa**: il sistema mostra i contanti attesi, tu
   inserisci quelli contati e vedi subito l'eventuale scostamento.
5. Esporta i CSV e fai il **backup** del database dalla pagina Report.

## Script

```bash
npm run dev    # sviluppo con reload (nodemon)
npm start      # avvio produzione
npm test       # controllo sintattico + suite di test
```

`npm test` esegue il controllo sintattico dei file JavaScript principali e una
suite di test su database e flussi applicativi (prodotti, vendite, report,
export, backup, config e riordino).

## Note operative

- Le vendite vengono salvate in `pos.sqlite` (percorso configurabile).
- Il backup usa la copia online consistente di SQLite (`db.backup()`), la salva
  in `backups/` con rotazione automatica e la scarica via browser.
- Gli importi sono gestiti in **centesimi interi** per evitare errori di
  arrotondamento.
- Il report "oggi" e l'export CSV usano l'ora **locale** per attribuire
  correttamente le vendite a cavallo della mezzanotte.
- La stampa ticket è ancora uno stub: per ora il ticket viene scritto su console
  in formato testuale. L'integrazione ESC/POS (USB/LAN) è il prossimo passo.
```
