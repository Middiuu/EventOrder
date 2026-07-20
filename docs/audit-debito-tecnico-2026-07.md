# EventOrder — Audit consolidato del debito tecnico

**Data:** 17 luglio 2026

**Baseline storica analizzata:** `645fe5f` (`main`, "Harden frontend and quality gates")

**Stato implementazione:** `6710180` (`main`, 18 luglio 2026)

**Ambito:** frontend, backend, database, backup/restore, sicurezza, test, dipendenze e CI

**Documento correlato:** [analisi-robustezza-2026-07.md](analisi-robustezza-2026-07.md)

## Stato corrente del backlog

Questa sezione sostituisce il verdetto operativo della baseline; le sezioni successive
restano come evidenza storica dei problemi originariamente rilevati.

| Area | Stato al `6710180` | Evidenza principale |
|---|---|---|
| P0.1–P0.4 | Chiuso | restore canonico, retry persistenti, idempotenza mutazioni, report 100.000 vendite |
| P1.1–P1.2 | Chiuso | lifecycle SPA e 10 flussi Playwright critici |
| P1.3 | Chiuso strutturalmente | `app.js` 1.215 righe; controller Cassa/Prodotti separati e ratchet automatici |
| P1.4–P1.5 | Chiuso | migrazioni esplicite con backup/recovery; backup e restore in streaming con lock e controllo spazio |
| P1.6–P1.8 | Chiuso | aggregazioni incrementali, cursor pagination, FTS trigram, CSV streaming e neutralizzazione formule |
| P1.9 | Differito per decisione prodotto | stampa mantenuta intenzionalmente come stub console fino alla scelta della stampante |
| P2.1 | Chiuso | router sottili e servizi di dominio; ratchet dimensionali backend |
| P2.2 | Chiuso per il modello locale | PIN LAN minimo, origin/Host verificati, proxy loopback esplicito, cookie Secure su HTTPS, sessioni/rate limit persistenti e singolo processo imposto |
| P2.3–P2.4 | Chiuso | live region, tab e riordino da tastiera; porta/retention/locale/codice valuta validati |
| P2.5 | Chiuso | request ID, health check, log JSON opzionali e audit trail SQLite senza payload sensibili |
| P2.6 | Chiuso | CI unit/coverage/E2E/scale/fault, smoke macOS e Dependabot |
| P2.7–P2.8 | Chiuso | toast condiviso, ratchet frontend/backend e `AGENTS.md` operativo |

### Gate verificati sullo stato corrente

- `npm test`: 94/94 test verdi;
- `npm run coverage`: 92,16% righe, 77,80% branch, 96,44% funzioni;
- `npm run test:e2e`: 10/10 flussi verdi dopo la separazione dei controller;
- `npm run test:scale`: aggregazione su 100.000 vendite e contesa WAL verdi;
- `npm run test:fault`: migrazioni/restore interrotti, backup preventivo e stampa pendente verdi.

Il solo elemento del backlog originario intenzionalmente non implementato e' P1.9. Non va
riaperto finche' non viene scelto il prodotto di stampa e definito il relativo protocollo
USB/LAN.

### Integrazione post-consolidamento — sicurezza HTTP

La prima tranche dei rilievi emersi dopo il consolidamento e' chiusa:

| Rilievo | Stato | Evidenza |
|---|---|---|
| Mutazioni cross-site possibili senza `APP_PIN` | Chiuso | guardia sulle mutazioni API con Fetch Metadata e verifica `Origin`; la riproduzione avversariale riceve 403 e non annulla la vendita |
| DNS rebinding / Host arbitrario | Chiuso | allowlist `ALLOWED_HOSTS`; richieste con Host non autorizzato ricevono 421 |
| Contratto reverse proxy incompleto | Chiuso per proxy sulla stessa macchina | `TRUST_PROXY=loopback`, cookie `Secure` quando HTTPS e' attestato dal proxy, `X-Forwarded-For` ignorato senza trust e usato per-client con trust |
| Form cross-site con content type semplice | Chiuso | i body delle mutazioni accettano JSON; il restore mantiene esclusivamente i MIME SQLite previsti |

Per l'esposizione LAN sono ora obbligatori `APP_PIN`, `ALLOWED_HOSTS` e `PUBLIC_ORIGIN`.
Se `PUBLIC_ORIGIN` usa HTTPS, il server richiede anche `TRUST_PROXY=loopback`; la
terminazione TLS resta responsabilita' del deployment.

## Verdetto esecutivo

EventOrder ha una base tecnica migliore di quanto suggerisca la dimensione del progetto:
usa importi interi in centesimi, vincoli SQLite nel modello canonico, snapshot storici delle
righe vendute, transazioni, idempotenza server-side delle vendite, WAL, backup di sicurezza
prima del restore, sessioni casuali e una suite backend ampia.

Il progetto è adatto a un uso controllato e a basso volume, ma **non è ancora pronto per un
uso produttivo intenso o multi-tablet**. L'audit dinamico ha riprodotto quattro difetti ad
alta priorità e un blocco della SPA:

1. un restore accetta un database v8 non canonico e dati che violano gli invarianti;
2. l'idempotenza della vendita non sopravvive a crash o reload del browser;
3. movimenti di cassa identici possono essere registrati due volte;
4. i report vanno in errore oltre il limite SQLite di variabili bindate;
5. la navigazione SPA può lasciare l'app con sidebar inerte e scroll bloccato.

La precedente conclusione secondo cui il debito residuo fosse concentrato soltanto nel
frontend monolitico era quindi troppo ottimistica. Il monolite e l'assenza di test E2E
restano i principali hotspot di manutenzione, ma vengono **dopo** i problemi di integrità e
affidabilità elencati in P0.

## Metodo e perimetro verificato

L'analisi combina:

- lettura dell'intero applicativo e dello schema;
- misure di dimensione, churn e copertura;
- esecuzione dei gate locali;
- ispezione del database corrente in sola lettura;
- prove avversariali su database e server temporanei;
- prova manuale in browser reale della navigazione SPA e delle modali;
- analisi dei piani SQLite e dei limiti di volume.

### Stato misurato

| Verifica | Risultato |
|---|---|
| Branch / commit | `main` / `645fe5f` |
| `npm test` | 60/60 test verdi |
| Copertura backend `src/**` | 93,15% righe · 75,86% branch · 96,73% funzioni |
| `npm audit` e `npm audit --omit=dev` | 0 vulnerabilità note |
| `npm outdated` | nessuna dipendenza indietro |
| `npm ls --depth=0` | albero dipendenze coerente |
| Database corrente | `user_version=8`, `quick_check=ok`, 0 errori FK |
| Runtime della verifica locale | Node `26.5.0`; il progetto dichiara e la CI configura Node 24 |
| Workflow CI | lint/test/coverage su Ubuntu e Node 24; stato remoto non verificato in questo audit |

Il database reale ispezionato contiene pochi dati. Le prove di scala sono state quindi
eseguite su copie temporanee costruite appositamente, senza modificare il database utente.

## Lista consolidata dei problemi

### Sintesi ordinata per priorità

| ID | Problema | Evidenza | Impatto | Priorità |
|---|---|---|---|---|
| P0.1 | Restore accetta schema e dati non canonici | riprodotto | corruzione logica del DB | immediata |
| P0.2 | Idempotenza vendite persa dopo reload/crash | verificato nel flusso | vendita duplicata | immediata |
| P0.3 | Movimenti di cassa non idempotenti | riprodotto | saldo cassa errato | immediata |
| P0.4 | Report falliscono con oltre 32.766 vendite | riprodotto con 33.000 vendite | endpoint 500 | immediata |
| P1.1 | Stato modali non smontato dalla SPA | riprodotto in browser | interfaccia bloccata | alta |
| P1.2 | Nessun test comportamentale frontend | verificato | regressioni non intercettate | alta |
| P1.3 | `public/app.js` e `initCassa` monolitici | misurato | costo e rischio di modifica | alta |
| P1.4 | Migrazioni a rebuild con perdita silenziosa su rename | analisi statica | perdita dati futura | alta |
| P1.5 | Backup/restore usa buffer sincroni e gestione operativa fragile | analisi statica | blocco processo/memoria/disco | alta |
| P1.6 | Report con problemi di correttezza e query non scalabili | analisi statica + query plan | dati aggregati ambigui/lentezza | alta |
| P1.7 | Race asincrone, submit incompleti e draft non isolato | analisi statica | stato UI incoerente/duplicazioni | alta |
| P1.8 | CSV vulnerabile a formula injection | analisi statica | rischio all'apertura in Excel | alta |
| P1.9 | Stampa reale non implementata | verificato | funzionalità promessa assente | alta se richiesta in esercizio |
| P2.1 | Router backend troppo grandi e accoppiati | misurato | manutenzione difficile | media |
| P2.2 | Auth e deployment LAN con limiti operativi | analisi statica | sicurezza/disconnessioni | media |
| P2.3 | Accessibilità incompleta | ispezione DOM/codice | uso tastiera/screen reader | media |
| P2.4 | Configurazione e valuta solo parzialmente validate | analisi statica | errori di avvio/UI incoerente | media |
| P2.5 | Osservabilità e audit trail insufficienti | analisi architetturale | diagnosi e accountability | media |
| P2.6 | CI priva di E2E, carico, fault injection e matrice OS | ispezione workflow | difetti non coperti | media |
| P2.7 | Duplicazioni e assenza di ratchet di complessità | misurato | deriva del codice | media-bassa |
| P2.8 | Manca `AGENTS.md` con comandi e invarianti | verificato | onboarding fragile | bassa |

## P0 — Problemi da chiudere prima dell'uso produttivo intenso

### P0.1 — Il restore non verifica lo schema canonico

**Dove:** `src/db.js`, `validateRestoreCandidate`, righe 494–565; `initDb`, righe 421–437.

La validazione controlla `integrity_check`, foreign key, assenza di trigger/view e un
sottoinsieme minimo di colonne per cinque tabelle. Non verifica invece:

- tutte le tabelle canoniche;
- tipo, `NOT NULL`, default e primary key delle colonne;
- vincoli `CHECK` e foreign key attesi;
- indici e unicità;
- coerenza semantica dei valori;
- equivalenza dello schema per un file che dichiara già `user_version=8`.

È stato creato un database SQLite temporaneo v8 con le sole colonne minime, senza i vincoli
canonici e con un prodotto a `price_cents=-500`. `integrity_check` e
`foreign_key_check` erano verdi; `POST /api/reports/restore` ha risposto HTTP 200 e
`GET /api/products` ha poi restituito il prezzo negativo. Poiché `initDb` ricostruisce lo
schema soltanto quando la versione è inferiore a 8, `CREATE TABLE IF NOT EXISTS` non
corregge un database v8 già esistente ma malformato.

**Rimedio:** confrontare il candidato con uno schema canonico generato da `schema.sql`;
validare tabelle, colonne, tipi, default, PK, FK, indici e vincoli; ricostruire sempre il
candidato in un database canonico isolato prima dello swap; eseguire controlli semantici
sui valori e solo dopo creare il backup di sicurezza e sostituire il DB.

**Criterio di accettazione:** il candidato avversariale viene rifiutato con 400; i backup
legacy supportati vengono migrati in una copia isolata; nessun dato non conforme può
diventare il database attivo.

### P0.2 — L'idempotenza della vendita non sopravvive al reload

**Dove:** `public/app.js`, righe 665 e 1630–1725; `src/routes/sales.js`, gestione
`Idempotency-Key`.

Il backend gestisce correttamente la ripetizione della stessa richiesta con la stessa
chiave e fingerprint. Il frontend però conserva `checkoutAttempt.requestId` e il payload
soltanto nella closure JavaScript. Il carrello viene salvato in `localStorage`, ma la
richiesta di incasso pendente no.

Sequenza critica:

1. il server registra la vendita;
2. la risposta si perde o il browser viene ricaricato;
3. il carrello viene recuperato dallo storage;
4. il nuovo processo frontend genera una chiave diversa;
5. lo stesso incasso può diventare una seconda vendita valida.

**Rimedio:** persistere prima dell'invio un record `pending_checkout` con chiave, payload e
stato; al caricamento interrogare o ripetere il backend con la stessa chiave; cancellarlo
solo dopo una risposta definitiva. Utile anche un endpoint di stato per chiave.

**Criterio di accettazione:** un test E2E interrompe la risposta dopo il commit, ricarica la
pagina e conferma che nel DB esista una sola vendita.

### P0.3 — Movimenti di cassa e comande sospese non hanno idempotenza end-to-end

**Dove:** `src/routes/sessions.js:204–244`, `public/app.js:999–1015`; route delle comande
sospese.

La stessa `POST /api/sessions/movements` è stata inviata due volte con payload identico:
sono state create due righe e il totale movimenti è raddoppiato. La UI non assegna un
request ID e non blocca in modo persistente il submit. Un timeout con esito incerto espone
quindi l'operatore a ripetere un versamento o un prelievo già registrato.

Le comande sospese presentano un rischio analogo: se il server persiste la comanda ma la
risposta si perde, il carrello locale può restare disponibile e venire sospeso o incassato
di nuovo. Questo secondo scenario è un rischio dedotto dal flusso, non una riproduzione.

**Rimedio:** `request_id` univoco con indice `UNIQUE` per i movimenti e per le operazioni di
sospensione/ripresa; risposta deterministica ai replay; lock UI immediato; endpoint atomico
di ripresa che marca la comanda come consumata nella stessa transazione.

**Criterio di accettazione:** due richieste con lo stesso ID producono una sola mutazione e
la stessa risposta logica; una ripresa concorrente può riuscire una volta sola.

### P0.4 — I report falliscono oltre il limite delle variabili SQLite

**Dove:** `src/routes/reports.js:106–134`.

`loadScopedSales` carica tutte le vendite e costruisce una seconda query con un placeholder
per ogni ID: `WHERE sale_id IN (?, ?, ...)`. La build locale di SQLite espone
`MAX_VARIABLE_NUMBER=32766`. Con un database temporaneo canonico da 33.000 vendite,
`GET /api/reports/summary` ha risposto 500 con `SqliteError: too many SQL variables`.

Lo stesso schema è presente, con scala minore, nel caricamento delle righe dello storico
vendite.

**Rimedio:** usare una `JOIN` tra `sale_items` e il perimetro delle vendite, aggregare in SQL
dove possibile e fare streaming/paginazione degli export. Per elaborazioni che devono
restare in JavaScript, leggere a chunk con limite fisso.

**Criterio di accettazione:** report ed export completano su almeno 100.000 vendite con
tempo e memoria misurati e senza costruire liste di placeholder proporzionali ai record.

## P1 — Debito ad alto impatto

### P1.1 — La SPA non smonta lo stato globale delle modali

**Dove:** `public/app.js:210–245` e `301–406`.

Prova riprodotta: Cassa → apertura turno → vendita → Prodotti → apertura della modale
“Modifica prodotto” → Back del browser. La pagina torna alla Cassa, ma `body` resta con
`overflow:hidden`, la sidebar resta `inert` e non risulta alcuna modale visibile. L'app è
inutilizzabile fino al reload.

`clientNavigate` sostituisce `.main` senza chiudere le modali appartenenti alla pagina
uscente né ripristinare `managedInert`, stack, focus e scroll lock.

**Rimedio:** introdurre un lifecycle di pagina con `dispose`; prima di `replaceWith`,
chiudere tutte le modali, svuotare lo stack, ripristinare `inert` e `overflow`; aggiungere
un test E2E su link, Back/Forward e modale aperta.

### P1.2 — Il frontend non ha test comportamentali

La copertura include solo `src/**/*.js`. `test/frontend.test.js` legge i file come testo e
fa assert tramite regex. Questi test sono utili come guardrail statici, ma non verificano
click, stato, richieste, focus, reload o navigazione; per questo non hanno intercettato né
P0.2 né P1.1.

**Rimedio:** E2E con browser reale per apertura/chiusura turno, vendita e resto, sconto,
errore di stampa, retry con risposta persa, reload durante incasso, sospensione/ripresa,
restore, modali e Back/Forward. Rinominare i test regex come guardrail statici.

### P1.3 — Il frontend è un hotspot monolitico

| Metrica | Valore |
|---|---|
| `public/app.js` | 2.745 righe |
| `initCassa` | circa 1.260 righe |
| Funzioni annidate in `initCassa` | 44 |
| Variabili di stato condivise nella closure | circa 12 |
| `querySelector` in `initCassa` | 67 |
| Churn | file più modificato del repository |

Il file contiene router, modali, quattro pagine, carrello, incasso, turni, movimenti,
comande sospese, prodotti, report e grafici. Dimensione, churn e stato condiviso lo rendono
il principale moltiplicatore del costo di modifica.

**Rimedio:** dopo l'introduzione degli E2E, separare infrastruttura condivisa e controller
di pagina; estrarre dalla Cassa carrello, persistenza, pagamento e comande sospese; usare
funzioni pure per calcoli e riconciliazione; introdurre ratchet ESLint progressivi.

### P1.4 — Il motore di migrazione può perdere dati su una rinomina

**Dove:** `src/db.js:243–260` e `290–404`.

A ogni bump di versione vengono ricostruite tutte le tabelle e `copyCommonColumns` copia
solo le colonne con lo stesso nome. Una futura rinomina può quindi far “riuscire” la
migrazione perdendo i valori della colonna vecchia. Inoltre il normale avvio con migrazione
non crea automaticamente un backup pre-migrazione equivalente a quello del restore.

**Rimedio:** migrazioni esplicite e versionate; mappa obbligatoria `vecchio → nuovo`;
fallimento se una colonna legacy popolata resta senza destinazione; backup atomico prima
del bump; test forward e rollback/recovery per ogni versione.

### P1.5 — Backup e restore non scalano in modo sicuro

**Dove:** `src/routes/reports.js:469–595`.

- `GET /api/reports/backup` crea un nuovo backup: una GET ha effetti collaterali;
- dopo `db.backup`, `fs.readFileSync` carica l'intero file nel processo e blocca l'event loop;
- il restore usa `express.raw(limit: 100mb)` e mantiene tutto l'upload in RAM, poi lo
  riscrive sincronicamente;
- non viene verificato lo spazio libero prima di candidato + backup di sicurezza + swap;
- gli errori della rotazione vengono ignorati completamente;
- il commento “il database è piccolo” è un'ipotesi non imposta dal sistema.

**Rimedio:** `POST` per creare il backup e download separato; streaming del file; upload
verso file temporaneo con limite; controllo spazio; logging e metriche della rotazione;
retention testata; gestione esplicita della disconnessione client.

### P1.6 — Report: correttezza storica, precisione e query

Problemi distinti:

- `productBreakdown` usa solo `product_name` come chiave: prodotti diversi o un nome
  riutilizzato possono essere fusi nello stesso aggregato;
- la ripartizione sconti calcola `line_total_cents * target` con `Number`: agli estremi
  ammessi il prodotto può oltrepassare la precisione intera sicura;
- il filtro storico per prodotto richiede una scansione/correlazione non adatta a grandi
  volumi;
- la UI dello storico usa un limite fisso di 100 senza paginazione;
- alcuni aggregati di sessione possono beneficiare di un indice composito coerente con
  `session_id`, `voided` e metodo di pagamento;
- report ed export materializzano grandi collezioni in memoria.

**Rimedio:** aggregare per identità storica stabile (`product_id` più snapshot, oppure ID
snapshot esplicito); usare aritmetica intera sicura/BigInt o SQL; paginare; rivedere query
con `EXPLAIN QUERY PLAN`; aggiungere indici solo dopo misure; streaming degli export.

### P1.7 — Race frontend, submit e persistenza locale

- navigazioni rapide possono completare fuori ordine perché `clientNavigate` non associa
  fetch e commit DOM a un token di navigazione;
- `ensureScript` risolve anche su `onerror`, quindi Chart.js/Sortable possono mancare senza
  un errore operativo;
- non tutti i submit mutativi hanno un lock robusto contro il doppio click;
- il draft del carrello non è identificato da database/evento e si affida soprattutto
  all'ID turno: dopo un restore con ID riutilizzati può recuperare stato appartenente a un
  contesto precedente.

**Rimedio:** `AbortController`/sequence ID anche per la fetch di navigazione; reject e UI
esplicita per gli script; primitive condivise per submit `pending`; namespace del draft
con un `database_instance_id` persistente e invalidazione dopo restore.

### P1.8 — Formula injection negli export CSV

**Dove:** `src/routes/reports.js:47–51`.

`csvEscape` quota separatori e doppi apici, ma non neutralizza celle che iniziano con
`=`, `+`, `-` o `@`. Campi controllabili come nome prodotto, operatore o note possono essere
interpretati come formule quando il CSV viene aperto in Excel o software compatibile.

**Rimedio:** anteporre un apostrofo ai valori testuali pericolosi o produrre un formato
destinato esplicitamente a import sicuro; aggiungere test per tutti i prefissi e per spazi/
caratteri di controllo iniziali.

### P1.9 — La stampante è ancora uno stub

**Dove:** `src/printer.js:72–76`.

`printTicket` scrive su console. Stato persistente, retry e ristampa sono implementati, ma
la funzione promessa all'utente non raggiunge una stampante. Quando verrà integrato il
driver serviranno anche timeout, abort, gestione offline, encoding, larghezza, taglio e
apertura cassetto.

**Rimedio:** interfaccia `PrinterAdapter`, driver ESC/POS USB/LAN scelto per hardware reale,
timeout obbligatorio e adapter fake per test. Se la stampa non è parte del prodotto,
README e UI devono dirlo chiaramente.

## P2 — Debito strutturale e operativo

### P2.1 — Backend accoppiato

`src/routes/sales.js` supera 800 righe e `src/routes/reports.js` circa 600. I router
mescolano parsing HTTP, validazione, SQL, regole di dominio, aggregazione e serializzazione.
Questo aumenta il costo dei test e rende più difficile riusare transazioni e idempotenza.

**Miglioria:** separare service di dominio e repository/query; mantenere nei router solo
protocollo HTTP, autorizzazione e mapping errori.

### P2.2 — Auth e deployment LAN

- `APP_PIN` accetta anche una sola cifra;
- sessioni e contatori brute-force sono mappe in memoria e si azzerano al riavvio;
- in LAN il traffico resta HTTP in chiaro;
- il modello a processo singolo è assunto da lock e registri in memoria, ma non è imposto;
- non esiste un audit log persistente delle operazioni sensibili.

**Miglioria:** minimo PIN più forte per LAN, sessioni/limiti persistenti o proxy auth,
documentazione TLS/reverse proxy, guardia che impedisca più worker, audit append-only di
login, restore, storni, movimenti e chiusure.

### P2.3 — Accessibilità incompleta

Sono presenti focus trap, `inert` e alcuni `aria-pressed`, ma restano lacune: toast senza
regione `aria-live`, stati pagamento/sconto/movimento non sempre esposti semanticamente,
tab report senza completa navigazione da tastiera, riordino drag-only senza alternativa,
feedback PIN migliorabile per screen reader.

**Miglioria:** test axe più test tastiera reali; pattern ARIA completi; alternativa “Sposta
su/giù” al drag; annunci non invasivi per esiti operativi.

### P2.4 — Configurazione e valuta parziali

`PORT`, `LOCALE`, simbolo valuta e retention non hanno una validazione completa. Il frontend
usa ancora etichette e valori iniziali con `€`; gli header CSV terminano in `_eur` e il
parsing assume separatore decimale italiano. La configurabilità dichiarata è quindi solo
parziale.

**Miglioria:** schema di configurazione validato all'avvio; `Intl.NumberFormat`; codice
valuta ISO oltre al simbolo; etichette HTML dinamiche; metadati export coerenti.

### P2.5 — Osservabilità e audit insufficienti

I log sono principalmente `console.*`; mancano request ID, log strutturati, health/version
endpoint, metriche di latenza/errore, dimensione DB, spazio disco, esito backup e audit
persistente. In caso di incidente locale è difficile ricostruire cosa sia successo.

**Miglioria:** logging JSON con redazione dati sensibili, correlation ID, `/health` e
`/version`, metriche essenziali e audit trail separato dai log tecnici.

### P2.6 — CI e strategia di test incomplete

La CI esegue lint, test e coverage solo su Ubuntu/Node 24. Mancano browser E2E, prova su
macOS per SQLite/file system, test di carico, crash/fault injection, restore avversariali e
verifica del driver stampante. Il workflow non dichiara `permissions: contents: read` e non
risulta una configurazione Dependabot/Renovate.

**Miglioria:** matrice minima Ubuntu/macOS per i test DB, job E2E, suite di scala separata,
fault injection per risposta persa e crash, permessi espliciti e aggiornamenti automatici
con PR controllate.

### P2.7 — Duplicazioni e complessità senza ratchet

Inventario principale:

| Duplicato | Occorrenze |
|---|---|
| `showToast` | 4 |
| etichette metodi di pagamento | 3 implementazioni frontend/backend |
| `money` / alias `euro` | 2 nomi per la stessa logica |
| formattazione valuta | frontend e stampante |
| utility date | frontend e report backend |

**Miglioria:** consolidare durante lo split, non con un refactoring isolato ad alto churn;
aggiungere ratchet ESLint per lunghezza funzione, complessità e dimensione file, inizialmente
come warning e poi bloccanti.

### P2.8 — Documentazione per manutentori incompleta

Manca un `AGENTS.md`/guida tecnica che raccolga comandi, runtime supportato, invarianti DB,
regole di migrazione, semantica dell'idempotenza, assunzione single-process e procedure di
backup/restore. Oggi molte decisioni corrette vivono solo nei commenti del codice.

## Cosa funziona bene e va preservato

- importi monetari in centesimi e vincoli `CHECK` nello schema canonico;
- snapshot di nome, categoria, costo, opzioni e quantità di stock decrementata;
- una sola sessione di cassa aperta imposta da indice univoco;
- idempotenza backend delle vendite con fingerprint della richiesta;
- storno idempotente e ripristino scorte basato sullo snapshot della vendita;
- blocchi sulle mutazioni mentre una stampa è in corso;
- WAL, `synchronous=FULL`, `busy_timeout`, checkpoint e shutdown ordinato;
- marker di recovery e backup obbligatorio pre-restore;
- token auth casuali, logout, SameSite Strict, rate limit e CSP;
- query data con limiti UTC precomputati, senza funzioni sulla colonna indicizzata;
- 60 test backend e copertura alta;
- dipendenze contenute, aggiornate e senza vulnerabilità note al momento dell'audit.

Questi punti non annullano P0.1: lo **schema canonico** è rigoroso, ma l'attuale percorso di
restore può sostituirlo con uno schema non canonico che dichiara già la versione corrente.

## Piano di rientro proposto

### Fase 0 — integrità e operatività, prima di nuove feature

1. Correggere P0.1 con canonicalizzazione del restore e test avversariali.
2. Rendere persistente l'idempotenza di vendite, movimenti e comande (P0.2–P0.3).
3. Riscrivere `loadScopedSales` senza placeholder proporzionali e aggiungere test a
   100.000 vendite (P0.4).
4. Aggiungere test di regressione backend e browser per ogni scenario.

### Fase 1 — rete di sicurezza e difetti frontend

5. Introdurre gli E2E critici (P1.2).
6. Correggere teardown modali, race di navigazione, submit e draft (P1.1, P1.7).
7. Neutralizzare CSV injection (P1.8).
8. Rendere backup/restore streaming e osservabile (P1.5).

### Fase 2 — riduzione del costo di modifica

9. Spezzare `public/app.js` e poi `initCassa`, protetti dagli E2E (P1.3).
10. Introdurre migrazioni versionate e backup pre-migrazione (P1.4).
11. Separare router, servizi e query; paginare storico/report (P1.6, P2.1).
12. Consolidare duplicazioni e attivare ratchet di complessità (P2.7).

### Fase 3 — prodotto e gestione in esercizio

13. Integrare il driver stampante reale con timeout, oppure correggere le promesse di
    prodotto (P1.9).
14. Rafforzare auth/TLS/audit per uso LAN e rendere esplicito il single-process (P2.2).
15. Aggiungere health, version, log strutturati e controlli disco (P2.5).
16. Chiudere accessibilità, configurabilità e matrice CI (P2.3, P2.4, P2.6).

## Definition of done della Fase 0

La Fase 0 è conclusa soltanto quando:

- un DB v8 non canonico e valori semanticamente invalidi vengono rifiutati;
- un backup legacy valido viene migrato senza perdita in un file isolato;
- una vendita con risposta persa e reload produce una sola riga;
- replay di movimento e sospensione con lo stesso request ID produce una sola mutazione;
- ripresa concorrente della stessa comanda può riuscire una volta sola;
- report ed export superano il test a 100.000 vendite;
- tutti gli scenari hanno test automatici ripetibili in CI;
- `npm test`, coverage, audit e `git diff --check` restano verdi su Node 24.

## Appendice — riferimenti e comandi di baseline

```bash
# Stato e gate
git branch --show-current
git rev-parse --short HEAD
git status --short
npm test
npm run coverage
npm audit
npm audit --omit=dev
npm outdated
npm ls --depth=0

# Hotspot
wc -l public/app.js src/routes/sales.js src/routes/reports.js src/db.js
rg -n "function showToast" public/app.js

# Piani query e limiti SQLite
# Eseguire su una copia temporanea, mai sul DB utente.
sqlite3 <db-temporaneo> 'PRAGMA compile_options;'
sqlite3 <db-temporaneo> 'EXPLAIN QUERY PLAN SELECT ...;'
```

Le riproduzioni di restore, idempotenza e carico devono essere trasformate in fixture e
test automatici prima di iniziare i refactoring strutturali: sono evidenza utile, ma finché
restano prove manuali possono regredire senza che la CI se ne accorga.
