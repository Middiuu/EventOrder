# EventOrder — Analisi di robustezza

**Data:** 17 luglio 2026
**Commit analizzato:** `32805e3` (branch `codex/harden-restore-retries`)
**Ambito:** UX/UI, backend, database
**Obiettivo:** individuare punti deboli e problemi in vista di un consolidamento

## Metodo

Lettura integrale del sorgente (~7.900 righe: `src/`, `public/`, `test/`, `schema.sql`),
esecuzione della suite di test esistente e **verifica empirica** dei punti dubbi:
i problemi marcati *verificato* sono stati riprodotti con codice eseguibile, non
dedotti dalla lettura. Gli script di riproduzione sono in appendice.

Baseline: `npm test` → **39 test, 39 verdi** sul commit analizzato.

---

## Sintesi

Il progetto è in condizioni migliori della media per la sua taglia. Il modello dati è
solido e diverse scelte sono notevoli per un progetto di queste dimensioni:

- denaro sempre in centesimi interi, con `CHECK(typeof(...) = 'integer')` a livello di schema;
- storicizzazione degli snapshot prodotto (nome, categoria, costo, quantità scalata
  dalle scorte) nelle righe vendita: lo storico resta corretto anche se il catalogo cambia;
- indice unico parziale che garantisce **un solo turno di cassa aperto** a livello di DB;
- idempotenza degli incassi con chiave client + impronta della richiesta;
- restore con marker su disco e recupero automatico al boot di un ripristino interrotto.

I punti deboli **non sono diffusi**: sono quattro problemi circoscritti, di cui uno
produce un errore 500 su un'operazione di sicurezza dei dati. Il resto sono irrigidimenti
e un paio di lacune di prodotto.

---

## 1. Race condition backup/restore → 500 · VERIFICATO

**Gravità: alta** — area: backend
**File:** [`src/maintenance.js`](../src/maintenance.js), [`src/routes/reports.js`](../src/routes/reports.js), [`src/db.js`](../src/db.js)

`maintenanceMiddleware` lascia passare tutte le richieste `GET` durante un ripristino,
sulla base di questa assunzione:

```js
// Durante un restore le letture possono continuare, ma nessuna seconda
// operazione deve modificare il database che sta per essere sostituito.
if (!restoreInProgress || req.method === "GET" || req.method === "HEAD") {
  return next();
}
```

L'assunzione non regge, perché **`GET /api/reports/backup` non è una lettura**:

1. scrive un file su disco (`createDatabaseBackup`);
2. esegue la rotazione dei backup (`pruneBackups`);
3. soprattutto, **trattiene la connessione attraverso un `await db.backup(...)`**.

Nel frattempo `restoreDatabaseFromFile` esegue `connection.close()`. Il backup in volo
perde la connessione sotto i piedi.

### Riproduzione

Con un database piccolo il bug non si manifesta (il backup termina prima della `close()`).
Con un database di 33 MB si innesca in modo deterministico:

```
DB size: 33.0 MB
backup di partenza: 200 33.0 MB
Errore non gestito: TypeError: The database connection is not open
    at Immediate.step (node_modules/better-sqlite3/lib/methods/backup.js:43:29)
restore -> 200 {"ok":true,"restored":{"products":120004,...}}
backup  -> 500 {"error":"Errore interno del server"}
server dopo: 200
```

La primitiva sottostante, isolata:

```
chiudo la connessione mentre il backup è in volo…
close() OK
backup REJECT: The database connection is not open
```

### Impatto

Un utente che scarica il backup mentre parte un ripristino riceve un 500 e un download
fallito. Il server sopravvive e il restore va a buon fine, quindi **non c'è perdita di
dati** — ma è esattamente il momento in cui l'utente si aspetta massima affidabilità.

### Correzione proposta

- Sottoporre `/api/reports/backup` al lock di manutenzione (non basta il filtro sul metodo
  HTTP: la discriminante è "tocca il DB in modo asincrono", non "è una GET").
- Serializzare backup e restore su un lock condiviso.
- In alternativa/in aggiunta: rendere `maintenanceMiddleware` esplicito su un elenco di
  rotte protette, invece di dedurlo dal verbo HTTP.

---

## 2. Il cookie di autenticazione rivela il PIN offline

**Gravità: alta** — area: backend / sicurezza
**File:** [`src/auth.js`](../src/auth.js)

Il token di sessione è derivato **esclusivamente dal PIN**, con un messaggio costante:

```js
function expectedToken() {
  return crypto.createHmac("sha256", config.APP_PIN).update("pos-auth-v1").digest("hex");
}
```

Il PIN è vincolato a 1–8 cifre (`/^\d{1,8}$/`). Chi ottiene il cookie — log, backup del
browser, tablet smarrito, sniffing su WiFi in chiaro — può ricavare il PIN **offline**,
calcolando `HMAC("0000")`, `HMAC("0001")`, … fino a trovare corrispondenza. Con 4 cifre è
istantaneo; con 8 cifre sono secondi su hardware comune.

Il punto critico: **questo aggira completamente il rate limiter**. La protezione
anti-brute-force esiste ed è ben fatta…

```js
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
```

…ma protegge solo l'endpoint `POST /api/auth/login`. L'attacco offline non ci passa.

### Problemi correlati sullo stesso meccanismo

- **Token costante**: non ruota mai. Chi lo ottiene ha accesso finché il PIN non cambia.
- **Nessun logout**: non esiste endpoint né UI per invalidare la sessione.
- **Nessuna revoca**: se si perde un tablet bisogna cambiare `APP_PIN` **e riavviare il
  server** (la config è letta all'avvio), disconnettendo tutti gli altri operatori.
- Cookie senza flag `Secure` (accettabile su HTTP locale, ma da rivedere se si espone in LAN).

### Correzione proposta

Il PIN non deve essere materiale crittografico. Generare un segreto casuale lato server
(`crypto.randomBytes(32)`, persistito o rigenerato al boot) e usarlo come chiave, oppure
emettere un identificatore di sessione casuale conservato server-side. Il PIN resta solo
la credenziale che *sblocca* l'emissione del token. Aggiungere un endpoint di logout.

---

## 3. Nessun focus trap nelle modali · VERIFICATO

**Gravità: media** — area: UX/accessibilità
**File:** [`public/app.js`](../public/app.js), [`public/cassa.html`](../public/cassa.html)

Le modali dichiarano `role="dialog" aria-modal="true"`, promettendo una modalità che non
è implementata. Con la modale di pagamento aperta:

```json
{
  "modaleAperta": true,
  "elementiFocalizzabiliFuoriDallaModale": 16,
  "primi": ["Cassa", "Prodotti", "Vendite", "Report", "themeToggle", "movementBtn"],
  "ariaHiddenSulloSfondo": null,
  "inert": false
}
```

Da tastiera si esce dalla modale di pagamento e si raggiunge la navigazione di sfondo,
incluso **"Chiudi cassa"**. Per gli screen reader `aria-modal="true"` è una dichiarazione
non veritiera.

### Correzione proposta

Applicare `inert` (o `aria-hidden`) al contenitore di sfondo all'apertura, ciclare il
focus fra il primo e l'ultimo elemento focalizzabile della modale, e ripristinare il focus
sull'elemento che l'ha aperta alla chiusura.

---

## 4. Le modali annidate rompono il blocco dello scroll · VERIFICATO

**Gravità: media** — area: UX
**File:** [`public/app.js`](../public/app.js)

`openModal`/`closeModal` gestiscono il blocco dello scroll con un flag booleano condiviso
invece che con un contatore:

```js
function openModal(el)  { el.hidden = false; document.body.style.overflow = "hidden"; }
function closeModal(el) { el.hidden = true;  document.body.style.overflow = ""; }
```

Con due modali sovrapposte, chiudere quella superiore sblocca lo scroll anche se quella
sotto è ancora aperta:

```
apro modale A         -> overflow=hidden
apro dialog B sopra A -> overflow=hidden
chiudo SOLO il dialog B -> overflow=(vuoto)
modale A ancora aperta? true  => lo sfondo torna scrollabile con A aperta
```

**Percorso reale:** Prodotti → *Modifica* (apre `#editProductModal`) → *Elimina* (apre
`uiConfirm`) → *Annulla*. La modale di modifica resta aperta e lo sfondo torna a scorrere
sotto il dito — su tablet è particolarmente fastidioso.

### Correzione proposta

Sostituire il flag con un contatore delle modali aperte; sbloccare solo quando torna a zero.

---

## 5. Configurazione SQLite non adatta a una cassa · VERIFICATO

**Gravità: media** — area: database
**File:** [`src/db.js`](../src/db.js)

Stato effettivo del database in esercizio:

```
journal_mode : delete
synchronous  : 2
user_version : 4
foreign_keys : 1
```

Nessuna occorrenza di `WAL` o `busy_timeout` nel sorgente. `journal_mode=delete` è il
default di SQLite: le letture bloccano le scritture, e la crash-safety è inferiore a WAL.
Per un software di cassa — dove un'interruzione di corrente a metà serata è uno scenario
concreto, non teorico — WAL è la configurazione attesa.

### Correzione proposta

In `openConnection()`:

```js
next.pragma("journal_mode = WAL");
next.pragma("synchronous = NORMAL");   // sicuro in WAL
next.pragma("busy_timeout = 5000");
```

Nota: il restore sostituisce il file con `rename`. Con WAL vanno gestiti anche i file
collaterali `-wal` e `-shm` (checkpoint + rimozione prima della sostituzione), altrimenti
il database ripristinato può ritrovarsi accanto un WAL orfano del file precedente.
**Questo va coordinato con la correzione #1.**

---

## 6. 329 KB per navigazione per calcolare due badge · VERIFICATO

**Gravità: media** — area: performance / UX
**File:** [`public/app.js`](../public/app.js)

`refreshShellData()` viene invocata a **ogni navigazione** e a ogni incasso:

```js
const products = await api("/api/products/all");
setCount("prodotti", products.filter(p => p.active).length);
const sales = await api("/api/sales?limit=500");
setCount("vendite", sales.filter(s => !s.voided).length);
```

`GET /api/sales?limit=500` restituisce le vendite **con tutte le righe di dettaglio**.
Misurato su 400 vendite da 3 righe (una serata realistica):

```
GET /api/sales?limit=500  ->  329 KB, 7 ms
```

329 KB scaricati e deserializzati per ottenere **un numero**: il contatore "Vendite" nella
sidebar. I 7 ms sono in locale; su un tablet in WiFi a una sagra il costo è reale, e cresce
fino al tetto di 500 vendite.

### Correzione proposta

Endpoint dedicato che restituisce i soli conteggi (`SELECT COUNT(*) …`), oppure parametro
per escludere le righe dalla lista vendite.

---

## 7. Lacune di prodotto (UX)

**Gravità: media** — area: UX/UI

### 7.1 Manca il filtro per categoria in Cassa

Le categorie esistono nel modello dati, nella pagina Prodotti e nei report — ma in Cassa
c'è **solo la ricerca testuale** su una griglia piatta ordinata per `sort_order`. Con i 4
prodotti demo non si nota; con 40 prodotti a una sagra l'operatore deve scorrere o digitare,
cioè esattamente ciò che il prodotto promette di evitare ("battere una comanda in due
secondi"). È il singolo intervento con il maggior guadagno percepito al banco.

### 7.2 Tutti gli errori usano `alert()` nativo

Il progetto ha costruito `uiConfirm`/`uiPrompt` con una motivazione esplicita nel codice:

```js
// Dialog a tema (sostituisce i nativi confirm/prompt, non ottimizzati per il touch)
```

…ma poi **ogni `catch` chiama `alert(err.message)`**. Gli errori — cioè i momenti di
maggiore stress, con le mani occupate e la fila al banco — usano l'unica UI che era stata
giudicata inadatta al touch. Da convogliare su toast/dialog a tema.

### 7.3 Long-press non individuabile

Segnare un prodotto come esaurito richiede una pressione lunga di 650 ms sulla card, senza
alcun indicatore visivo. È una funzione utile e completamente invisibile.

---

## 8. Rilievi minori

| Area | Rilievo | Nota |
|---|---|---|
| Sicurezza | `/api/config` espone la lista `operators` **prima dell'autenticazione** | `PUBLIC_PATHS` include `/api/config`: i nomi del personale sono leggibili da chiunque raggiunga la porta |
| Sicurezza | Nessun `Content-Security-Policy` | Presenti `nosniff`, `X-Frame-Options`, `Referrer-Policy`; manca CSP a fronte di un uso massiccio di `innerHTML` |
| Backend | `LIKE '%' || ? || '%'` non fa escape di `%` e `_` | Non è SQL injection (query parametrizzate), ma wildcard injection nei filtri `operator` e `product` |
| Database | Manca l'indice su `sale_items.product_id` | Usato da `DELETE /api/products/:id` e dalle migrazioni; impatto contenuto ai volumi attesi |
| Backend | Nessun handler `SIGTERM`/`SIGINT` che chiuda la connessione | Chiusura non pulita del database allo spegnimento |
| Frontend | `runPageInits()` esegue gli init in sequenza con `await` | Se il primo lancia un'eccezione, i successivi non vengono eseguiti |
| Frontend | I prezzi nel carrello vengono dal catalogo caricato all'avvio | Il server ricalcola dal DB (corretto), ma se un prezzo cambia a metà serata la cassa mostra il vecchio e addebita il nuovo |
| Qualità | Nessun linter, nessuna misura di copertura | La CI esegue `node --check` + `node --test` |

---

## Cosa **non** è rotto

Verificato esplicitamente, perché erano i sospetti naturali:

- **Nessun TOCTOU sulle scorte.** Fra il controllo disponibilità e la transazione di
  vendita non esiste alcun `await`, e `better-sqlite3` è sincrono: non c'è finestra di
  interleaving. La costruzione è fragile rispetto a un refactoring futuro (basterebbe
  introdurre un `await`), ma **oggi è corretta**.
- **`voidSale(..., protectExpectedCash = false)` sul fallimento stampa è sicuro.** Il
  commento nel codice regge: durante la stampa `hasPendingSaleForSession` blocca movimenti,
  chiusura e storni manuali, quindi lo storno automatico non può rendere negativi i
  contanti attesi né lasciare il turno non chiudibile.
- **Igiene del repository corretta.** `pos.sqlite`, `*.sqlite`, `backups/` e `.env` sono
  tutti in `.gitignore`: nessun dato di vendita reale finisce sotto version control.
- **XSS gestito con disciplina.** `escapeHtml` è applicato con costanza su tutti i dati
  utente, nonostante l'uso estensivo di `innerHTML`.
- **CSS solido.** Touch target a 52px su `pointer: coarse`, `:focus-visible`,
  `prefers-reduced-motion`, breakpoint curati, vista mobile con barra comanda fissa.

---

## Priorità consigliata

| # | Intervento | Gravità | Sforzo | Perché prima |
|---|---|---|---|---|
| 1 | Race backup/restore (#1) | Alta | Medio | Unico bug che produce un 500, proprio su un'operazione di tutela dei dati |
| 2 | Auth: segreto random + logout (#2) | Alta | Medio | Errore strutturale, non un dettaglio: il PIN non deve essere una chiave HMAC |
| 3 | WAL + `busy_timeout` (#5) | Media | Basso* | Poche righe, molto guadagno in crash-safety. *Da coordinare con #1 per i file `-wal`/`-shm` |
| 4 | Focus trap + contatore scroll lock (#3, #4) | Media | Basso | Piccoli, ben delimitati, migliorano subito l'uso da tablet |
| 5 | Endpoint di conteggio (#6) | Media | Basso | Toglie 329 KB per navigazione |
| 6 | Filtro categorie in Cassa (#7.1) | Media | Medio | Il maggior guadagno di prodotto al banco |
| 7 | Errori su toast/dialog a tema (#7.2) | Media | Basso | Coerenza con una scelta di design già presa |

I primi tre sono tutti backend e ricadono su codice già coperto dai 39 test esistenti.

---

## Appendice — riproduzione

Script usati per le verifiche. I `require` sono relativi al file, quindi gli script Node
vanno **salvati nella radice del progetto** (non solo lanciati da lì).

### A. Race backup/restore (#1)

Serve un database abbastanza grande da rendere il backup multi-step (~33 MB). Salvare come
`repro-A.js` nella radice ed eseguire con `node repro-A.js`; usa un database temporaneo e
non tocca `pos.sqlite`:

```js
const os=require("os"), path=require("path"), fs=require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(),"eo-race-"));
const dbPath = path.join(dir,"pos.sqlite");
process.env.POS_DB_PATH = dbPath; process.env.POS_SEED_DEMO = "1";

const { createApp } = require("./src/app.js");
const app = createApp({ printTicket: async () => {} });

// gonfia il DB così il backup dura più step
const D = require("better-sqlite3");
const raw = new D(dbPath);
const ins = raw.prepare("INSERT INTO products (name,price_cents,category,sort_order) VALUES (?,?,?,?)");
raw.transaction(() => { for (let i=0;i<120000;i++) ins.run("Prodotto "+i+" "+"x".repeat(80), 500, "Cat", i); })();
raw.close();

app.listen(0, "127.0.0.1", async function () {
  const base = `http://127.0.0.1:${this.address().port}`;
  const bk = await fetch(`${base}/api/reports/backup`);
  const bytes = Buffer.from(await bk.arrayBuffer());

  const restore = fetch(`${base}/api/reports/restore`, { method:"POST",
    headers:{"Content-Type":"application/octet-stream","X-EventOrder-Restore":"RESTORE"},
    body: bytes }).then(async r => `restore -> ${r.status}`);
  await new Promise(r => setTimeout(r, 15));           // entra nella finestra di await
  const dl = fetch(`${base}/api/reports/backup`)
    .then(async r => `backup  -> ${r.status} ${r.ok ? "<ok>" : await r.text()}`);

  for (const s of await Promise.allSettled([restore, dl])) console.log(s.value);
  process.exit(0);
});
```

Atteso (bug presente): `backup -> 500` e `TypeError: The database connection is not open`.

### B. Focus trap e modali annidate (#3, #4)

Da console del browser, con la modale di pagamento aperta:

```js
// #3 — quanti elementi restano raggiungibili dietro una modale aria-modal="true"?
const modal = document.querySelector("#paymentModal");
const f = document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
console.log([...f].filter(el => !modal.contains(el) && el.offsetParent !== null).length); // atteso: 0 — reale: 16

// #4 — il blocco dello scroll non conta le modali annidate
openModal(modal);            console.log(document.body.style.overflow); // hidden
const dlg = ensureDialog();
openModal(dlg);              console.log(document.body.style.overflow); // hidden
closeModal(dlg);             console.log(document.body.style.overflow); // "" ← modal è ancora aperta
```

### C. Costo di `refreshShellData` (#6)

Aprire la cassa, registrare ~400 vendite da 3 righe, poi misurare:

```js
const r = await fetch(`${base}/api/sales?limit=500`);
const body = await r.text();
console.log(`${(body.length/1024).toFixed(0)} KB`);   // ~329 KB
```

### D. Stato SQLite (#5)

```js
const db = require("better-sqlite3")("pos.sqlite", { readonly: true });
console.log(db.pragma("journal_mode", { simple: true }));  // delete
console.log(db.pragma("synchronous",  { simple: true }));  // 2
```
