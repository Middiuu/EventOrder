<div align="center">

# 🎟️ EventOrder

### Il registratore di cassa per le tue feste.

**Veloce al banco. Tutto in locale. Zero burocrazia.**

Pensato per sagre, mercatini, banchetti, feste di paese e Pro Loco:
apri la cassa, tocca i prodotti, incassi e stampi il ticket. Fine.

![Licenza MIT](https://img.shields.io/badge/licenza-MIT-5B4BF0)
![Node 20](https://img.shields.io/badge/Node-20_LTS-16A34A)
![Non fiscale](https://img.shields.io/badge/documento-non_fiscale-52525B)
![Offline](https://img.shields.io/badge/dati-100%25_locali-7D6FFF)

<br>

<img src="docs/screenshots/welcome.png" alt="EventOrder — schermata di benvenuto" width="860">

</div>

<br>

## Perché EventOrder

Alle feste non serve un gestionale: serve **battere una comanda in due secondi**,
sapere quanto c'è in cassa a fine serata e non perdere un incasso. EventOrder fa
esattamente questo, girando in locale sul tuo computer o tablet — **nessun account,
nessun canone, nessun dato che esce dalla macchina**.

- ⚡ **Veloce** — catalogo a griglia, un tap per aggiungere, totale sempre in vista.
- 💶 **Pensato per i contanti** — calcolo del resto, tasti rapidi (€20, €50, €100…).
- 🌙 **Chiaro e scuro** — interfaccia curata con tema scuro di default e tema chiaro per il giorno.
- 🔌 **Autonomo** — un file database locale, backup con un clic.

<br>

## Cosa puoi fare

### 🛒 La cassa, in due tap

Tocca i prodotti dal catalogo, la **comanda** si compone a lato con il totale
sempre in vista. Layout pensato per il banco: bottoni grandi, numeri leggibili
in monospazio, tema scuro o chiaro.

<div align="center">
<img src="docs/screenshots/cassa.png" alt="EventOrder — la schermata cassa" width="860">
</div>

### 💶 Incassi in un lampo — con resto, sconti e omaggi

Scegli **contanti, carta o altro**. Per i contanti inserisci quanto ti danno e il
**resto è calcolato al volo**. Applichi al volo uno **sconto in percentuale o in
euro**, oppure segni un **omaggio** ("offerto della casa").

<div align="center">
<img src="docs/screenshots/pagamento.png" alt="Schermata di pagamento con sconto e calcolo del resto" width="560">
</div>

### 🧾 Turni di cassa e chiusura

Apri il turno con il **fondo cassa** iniziale, vendi, e a fine serata **chiudi la
cassa**: EventOrder ti dice quanti contanti dovrebbero esserci, tu li conti e vedi
subito l'eventuale **scostamento**. Come un vero registratore (ma non fiscale).

### 📜 Storico vendite e storni

Ogni vendita finisce nel registro. Hai sbagliato una comanda? **Annullala** con un
motivo finché il turno è aperto: resta nello storico ma esce dai conti. Dopo la
chiusura il turno è immutabile, così quadratura e storico restano coerenti.

<div align="center">
<img src="docs/screenshots/vendite.png" alt="Storico delle vendite con storno" width="820">
</div>

### 📊 Numeri chiari e report del giorno

Incasso del giorno, **suddivisione per prodotto e per metodo di pagamento**,
sconti e omaggi erogati, con grafici a colpo d'occhio. Esporti tutto in **CSV**
(aggregato o riga-per-vendita) e fai il **backup del database**.

<div align="center">
<img src="docs/screenshots/report.png" alt="Report del giorno con grafici" width="860">
</div>

### 🌗 Giorno e notte

Interfaccia **touch-first** (bottoni grandi, numeri in monospazio, niente fronzoli)
con **tema scuro e chiaro**: lo scuro riposa la vista di sera, il chiaro è perfetto
di giorno. Cambia con un tocco, la scelta viene ricordata.

<div align="center">
<img src="docs/screenshots/cassa-chiaro.png" alt="EventOrder in tema chiaro" width="860">
</div>

<br>

## Provalo in 1 minuto

```bash
npm install
cp .env.example .env      # opzionale: personalizza nome, valuta, operatori
npm run dev
```

Apri **http://localhost:3000**: parti dalla schermata di benvenuto, premi
**Inizia il servizio** e sei in cassa. Al primo avvio trovi qualche prodotto demo
(disattivabile): entra nella pagina **Prodotti** e crea i tuoi.

> Serve **Node.js 20** (vedi `.nvmrc`). Con `nvm`: `nvm use`.

<br>

## Lo fai tuo in un attimo

Nome, valuta, operatori e accesso si impostano da `.env` — **stesso software,
qualsiasi evento**, senza toccare il codice.

```env
APP_NAME=Sagra del Paese
BUSINESS_NAME=Pro Loco 2026
CURRENCY_SYMBOL=€
OPERATORS=Anna,Luca,Marco
# APP_PIN=1234        # opzionale: PIN numerico di massimo 8 cifre
```

| Variabile | Cosa fa |
|---|---|
| `APP_NAME` / `BUSINESS_NAME` | Nome nell'app / nome stampato sul ticket |
| `CURRENCY_SYMBOL` / `LOCALE` | Valuta e formato di date e numeri |
| `OPERATORS` | Operatori selezionabili all'apertura del turno |
| `APP_PIN` | PIN d'accesso (vuoto = nessuna protezione) |
| `HOST` | Interfaccia di rete (`127.0.0.1` di default; `0.0.0.0` per la LAN) |
| `POS_SEED_DEMO` | Prodotti demo al primo avvio (`0` per disattivare) |
| `BACKUP_KEEP` | Quanti backup conservare |

Con `APP_PIN` impostato, l'accesso è protetto da un **PIN-pad** touch:

<div align="center">
<img src="docs/screenshots/login.png" alt="EventOrder — accesso con PIN" width="360">
</div>

> **Accesso da tablet in LAN:** imposta `HOST=0.0.0.0` e configura sempre
> `APP_PIN`. Il server usa HTTP: su reti non fidate va pubblicato dietro HTTPS.

<br>

## Le pagine

| | |
|---|---|
| **Benvenuto** (`/`) | Schermata iniziale, si entra col pulsante "Inizia il servizio" |
| **Cassa** (`/cassa.html`) | Vendita: catalogo, comanda, incasso |
| **Prodotti** | Catalogo con riordino drag-and-drop |
| **Vendite** | Storico e storni |
| **Report** | Numeri del giorno, export CSV, backup |

<br>

<details>
<summary><b>Sotto il cofano</b> (per chi sviluppa)</summary>

<br>

- **Node.js 20 + Express 5**, **SQLite** (`better-sqlite3`), frontend **vanilla JS** (nessun build step).
- Importi gestiti in **centesimi interi** (niente errori di arrotondamento).
- Nome e categoria dei prodotti salvati nella vendita: le rinomine future non alterano lo storico.
- Report e chiusura usano l'**ora locale** per attribuire correttamente le vendite a cavallo della mezzanotte.
- Backup con la copia **online consistente** di SQLite e rotazione automatica.
- Branding/valuta esposti al frontend via `GET /api/config`.
- Suite di test con `node:test` su database e flussi applicativi.

```bash
npm run dev    # sviluppo con reload
npm start      # avvio
npm test       # controllo sintattico + test
```

**Stampa ticket**: attualmente il ticket viene scritto su console (stub); l'integrazione
ESC/POS (USB/LAN) è il prossimo passo.

</details>

<br>

<div align="center">
<sub>EventOrder — cassa locale non fiscale · Licenza MIT</sub>
</div>
