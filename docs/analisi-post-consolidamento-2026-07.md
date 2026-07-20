# EventOrder — Analisi completa post-consolidamento

**Data:** 19 luglio 2026

**Commit analizzato:** `4afed5e` (`main`, "Aggiorna il backlog del debito tecnico")

**Ambito:** intero applicativo — frontend, backend, database, backup/restore, sicurezza, test, CI, dipendenze

**Documenti correlati:** [audit-debito-tecnico-2026-07.md](audit-debito-tecnico-2026-07.md) (backlog P0–P2), [analisi-robustezza-2026-07.md](analisi-robustezza-2026-07.md)

## Verdetto esecutivo

Il consolidamento è **reale e verificato**. Tutte le chiusure dichiarate nel backlog sono
state ricontrollate in modo indipendente — rieseguendo gli stessi script avversariali che
avevano riprodotto i difetti originali, non i test del progetto — e reggono. Il codice è
passato da un monolite con quattro difetti P0 a un'architettura a servizi di dominio con
idempotenza persistente end-to-end, migrazioni con backup e recovery, restore
canonicalizzato, report incrementali e una CI a quattro job con E2E, scala e fault
injection.

I problemi residui trovati da questa analisi sono **di manutenzione e igiene operativa,
non di integrità**: crescita illimitata di due tabelle di servizio, alcuni file a ridosso
dei loro ratchet dimensionali, punti ciechi minori di copertura e piccole lacune operative
sul ciclo di vita dei backup. Nessun rilievo tocca denaro, scorte o storico vendite.

## Metodo

- rilettura integrale del backend riscritto (~4.700 righe `src/`, tutti i moduli) e
  dell'intero frontend (shell, `cassa-controller.js`, `products-controller.js`, pagine,
  login/welcome/theme-init), più schema, CI, AGENTS.md e configurazione Playwright;
- esecuzione di tutti i gate: `npm test` (85/85), `coverage` (92,2% righe / 77,7% branch /
  96,3% funzioni), `test:e2e` (10/10 Playwright), `test:scale` (9/9, incluse 100.000
  vendite), `test:fault` (11/11);
- **ri-esecuzione degli script avversariali originali** dell'audit precedente contro il
  codice attuale (restore non canonico, doppio movimento, 33.000 vendite);
- riproduzione in browser reale dello scenario P1.1 (modale aperta + navigazione SPA);
- sonde nuove su superfici nuove: ricerca FTS (substring, apostrofi, minimo caratteri),
  replay dei movimenti con fingerprint diverso, contratto idempotente delle comande;
- `npm audit` (0 vulnerabilità), `npm outdated`, ispezione CI/Dependabot/AGENTS.md.

## Verifica indipendente delle chiusure

| Rilievo del backlog | Verifica di questa analisi | Esito |
|---|---|---|
| P0.1 Restore accettava DB v8 non canonico | Stesso file avversariale di ieri (schema senza CHECK, prezzo −500) | ✅ **400** "schema o dati non compatibili"; il DB attivo resta pulito |
| P0.2 Idempotenza persa al reload | Lettura codice + E2E: 4 tentativi (checkout, movimento, sospensione, ripresa) persistiti in `localStorage` con `session_id` + `database_instance_id` | ✅ chiuso; E2E "risposta persa + reload → una sola vendita" verde |
| P0.3 Movimenti duplicabili | Replay stessa chiave → 1 riga + `idempotent_replay:true`; stessa chiave con payload diverso → 409 | ✅ chiuso; tabella `operation_requests` persistente |
| P0.4 Report in 500 oltre 32.766 variabili | 33.000 vendite → `/summary` **200** con totali corretti (16.500.000 cent) | ✅ chiuso; aggregazione incrementale con `iterate()` |
| P1.1 SPA lasciava `inert`/scroll bloccato | Stessa riproduzione browser di ieri | ✅ chiuso; `disposePageUi()` prima del `replaceWith` |
| P1.2 Zero test comportamentali | 10 flussi Playwright reali in CI (checkout, retry, Back con modale, paginazione, backup/restore) | ✅ chiuso |
| P1.3 Monolite frontend | `app.js` 2.745 → 1.215 righe; controller separati; ratchet dimensionali imposti da `test/architecture.test.js` | ✅ chiuso strutturalmente (vedi R3) |
| P1.4 Migrazioni con perdita silenziosa | Registro migrazioni validato all'avvio; colonna legacy popolata senza mappatura → **errore esplicito**; backup pre-migrazione con `VACUUM INTO` verificato + marker di recovery | ✅ chiuso |
| P1.5 Backup/restore sincroni | `POST /backup` + download in streaming (`pipeline`); upload in streaming con limite; controllo spazio disco (`statfs`); lock condiviso backup/restore | ✅ chiuso |
| P1.6 Report: identità/precisione/scala | Aggregazione per identità `product_id+nome+categoria`; resti maggiori in **BigInt**; query iterate | ✅ chiuso |
| P1.7 Race navigazione e draft | Token di sequenza + `AbortController`; draft e tentativi con `database_instance_id` ruotato al restore; `withFormSubmitLock` | ✅ chiuso |
| P1.8 CSV formula injection | `csvText` marca i campi testuali; prefissi `= + - @` neutralizzati sul primo carattere significativo | ✅ chiuso |
| P2.1–P2.8 | Router sottili + servizi; config validata (PIN LAN ≥4, guardia single-process); frecce ↑↓ per riordino, tab con frecce, `aria-live`; request-ID, `/api/health`, log JSON opzionali, audit su SQLite; CI 4 job + macOS smoke + Dependabot; `AGENTS.md` con vincoli e comandi | ✅ chiusi |
| P1.9 Stampante | Stub console **per decisione di prodotto esplicita** (registrata in AGENTS.md) | ⏸ rinviato, non riaperto |

Verifica extra sulle superfici nuove: la ricerca FTS trigram gestisce substring
(`amatri`), apostrofi (`all'ama`), maiuscole (`ARROST`) e rifiuta query sotto i 3
caratteri con messaggio chiaro; l'indice è aggiornato **dentro la transazione** di
vendita e ricostruito da zero in migrazioni e restore (mai fidato da file esterni).

## Problemi e punti deboli attuali

Ordinati per rilevanza. Nessuno è bloccante per l'uso in esercizio.

### R1 — `audit_events` e `operation_requests` crescono senza limite

**Rilevanza: media** · **Sforzo: basso** · **Dove:** `src/audit.js`, `src/idempotency.js`, `src/schema.sql`

Non esiste alcun percorso di pruning (verificato con grep su tutto `src/` e `test/`):

- `audit_events` riceve una riga per **ogni richiesta HTTP mutativa**, inclusi i tentativi
  respinti (login sbagliati compresi — utile, ma si accumula);
- `operation_requests` riceve una riga per ogni movimento, sospensione e ripresa, e
  `response_json` di una ripresa contiene **l'intera comanda serializzata**.

Entrambe hanno indici su `created_at` (predisposti per il pruning) ma nessuno li usa. A
volumi da sagra servono anni per diventare un problema di spazio, però ogni backup e ogni
restore trascinano l'intero registro, e `operation_requests` referenzia turni chiusi da
tempo per replay che non arriveranno mai più.

**Soluzione proposta:** pruning pigro all'avvio e alla chiusura del turno — ad esempio
`operation_requests` dei turni chiusi da più di 7 giorni e `audit_events` più vecchi di
`AUDIT_RETENTION_DAYS` (default 90, `0` = illimitato, documentato in `.env.example`).
Due DELETE con test dedicato; nessun impatto sul percorso di vendita.

### R2 — I backup pre-migrazione sono invisibili all'API e competono nella rotazione

**Rilevanza: media-bassa** · **Sforzo: basso** · **Dove:** `src/routes/database-maintenance.js:112`, `src/db.js:581`

La whitelist del download ammette solo `(?:backup|pre-restore)`:

```js
const allowedName = new RegExp(
  `^${config.SLUG}-(?:backup|pre-restore)-\\d{8}-\\d{6}(?:-\\d+)?\\.sqlite$`
);
```

I file `*-pre-migration-vX-to-vY-*.sqlite` (creati da `createPreMigrationBackup`, con
formato timestamp diverso) **non sono scaricabili** dall'interfaccia: per recuperarli
serve accedere al filesystem. Inoltre partecipano alla stessa rotazione `BACKUP_KEEP`
dei backup ordinari: una serie di backup manuali può spingere fuori l'unico backup
pre-migrazione esistente. Il rischio pratico è basso (la rotazione non gira durante la
migrazione, il marker di recovery viene consumato al primo avvio riuscito), ma il backup
più importante del ciclo di vita del database è il meno accessibile.

**Soluzione proposta:** estendere la whitelist di download ai nomi `pre-migration` e
proteggerli dalla rotazione (o riservare loro una quota separata, es. conservane sempre
gli ultimi 3).

### R3 — Cinque file sono a ridosso del proprio ratchet dimensionale

**Rilevanza: media (sorvegliata)** · **Sforzo: pianificazione** · **Dove:** `test/architecture.test.js`

I ratchet funzionano — ed è il punto: la prossima feature li farà scattare.

| File | Righe | Limite | Saturazione |
|---|---|---|---|
| `public/cassa-controller.js` | 1.419 | 1.500 | **95%** |
| `src/routes/carts.js` | 234 | 250 | 94% |
| `public/app.js` | 1.215 | 1.300 | 93% |
| `src/routes/products.js` | 227 | 250 | 91% |
| `src/routes/database-maintenance.js` | 271 | 300 | 90% |

`cassa-controller.js` è il caso serio: è il nuovo hotspot (checkout, carrello, opzioni,
comande sospese, movimenti e turni in un'unica closure). Il ratchet impedirà di
ingrandirlo, ma senza un piano la tentazione sarà alzare il limite.

**Soluzione proposta:** decidere **ora** la prossima estrazione, prima della prossima
feature di cassa: il candidato naturale è il modulo carrello (stato, persistenza,
riconciliazione — già oggi ben delimitato da `CART_DRAFT_KEY`/`recoverCurrentCart`),
seguito dal blocco pagamento. Regola di ingaggio da annotare in AGENTS.md: i limiti dei
ratchet non si alzano, si estrae.

### R4 — Punti ciechi di copertura nei percorsi d'errore

**Rilevanza: bassa** · **Sforzo: basso** · **Dove:** report `npm run coverage`

Tre moduli restano sensibilmente sotto la media (92% righe complessive):

- `observability.js` — 37,8% righe: il logging con `LOG_REQUESTS=1` non è mai esercitato
  nei test;
- `printer.js` — 78,5% righe / 47,1% branch: invariato, coerente con il rinvio P1.9;
- `reporting/exports.js` — 58,3% branch: i rami di backpressure/disconnessione
  (`waitForDrainOrClose`) non sono coperti da test automatici.

**Soluzione proposta:** un test con `LOG_REQUESTS=1` che verifichi il JSON emesso; un
test dello streaming CSV che chiuda la risposta a metà e verifichi l'interruzione pulita.
`printer.js` resta com'è finché vale la decisione di prodotto.

### R5 — Parametri di sessione auth cablati nel codice

**Rilevanza: bassa** · **Sforzo: basso** · **Dove:** `src/auth.js:6-7`, `89-90`

`SESSION_TTL_MS` (24h), `MAX_SESSIONS` (1024), `MAX_ATTEMPTS` (5) e `LOCK_MS` (5 min)
sono costanti. Per l'uso tipico vanno bene; per un evento di più giorni con tablet
condivisi, un TTL configurabile (es. `AUTH_SESSION_HOURS`) eviterebbe il re-login a metà
servizio del secondo giorno. Da fare solo se emerge il bisogno reale — è il tipo di
configurabilità che si paga in superficie di test.

### R6 — L'audit trail non registra l'operatore

**Rilevanza: bassa** · **Sforzo: basso-medio** · **Dove:** `src/audit.js`, `src/schema.sql:180-187`

`audit_events` registra `event_type` (che include l'ID dell'entità via URL, es.
`post:sales/123/void`), esito, status e request-ID — ma **non chi** ha eseguito
l'operazione. Con più operatori sullo stesso turno, storni e prelievi restano anonimi nel
registro. È una scelta prudente (niente payload), però limita l'accountability che un
registro del genere promette. Nota di onestà già implicita nel design: l'audit è
best-effort (scritto su `res.finish`, fallimenti solo loggati) e non è tamper-evident —
va presentato come registro operativo, non come prova forense.

**Soluzione proposta:** colonna `operator TEXT` valorizzata dal turno aperto al momento
della scrittura; eventuale `entity_id INTEGER` estratto dalla route per query più comode.

### R7 — Rilievi minori

| # | Rilievo | Dove | Nota |
|---|---|---|---|
| 1 | `eventType` normalizza solo la **prima** sequenza di slash (`replace(/\/+/, "/")` senza flag `g`) | `src/audit.js:7` | Cosmetico: `post:sales//x//void` produce chiavi di evento leggermente diverse |
| 2 | Due `@fontsource` minor indietro (5.2 → 5.3) | `package.json` | Dependabot settimanale li proporrà da solo |
| 3 | `pruneSessions` esegue un `DELETE` a ogni richiesta autenticata | `src/auth.js:62` | Innocuo (DELETE vuoto in WAL non tocca disco); se mai comparisse nel profiling, spostarlo su timer |
| 4 | `GET /api/reports/export.csv` materializza le righe in memoria, a differenza degli altri due export | `src/routes/reports.js:39` | Accettabile: è l'aggregato per prodotto, limitato dal catalogo, non dalle vendite |
| 5 | E2E solo su Chromium; smoke macOS senza E2E | `.github/workflows/ci.yml` | Compromesso ragionevole per un'app locale; da rivedere solo se compaiono bug browser-specifici |

## Cosa resta deliberatamente aperto

- **P1.9 — stampa reale**: stub console per decisione registrata in AGENTS.md ("non
  aggiungere stampa hardware implicitamente"). Quando verrà scelta la stampante, i
  requisiti già individuati restano validi: interfaccia `PrinterAdapter`, timeout
  obbligatorio, gestione offline/encoding/taglio, adapter fake nei test. Fino ad allora
  la macchina a stati `print_status` + ristampa dallo storico copre il flusso.
- **HTTPS/TLS in LAN**: fuori perimetro applicativo per scelta documentata (AGENTS.md:
  "use HTTPS at the deployment boundary"). Resta vero che il PIN viaggia in chiaro sulla
  WiFi dell'evento: se l'installazione diventa multi-tablet stabile, un reverse proxy con
  TLS è il primo intervento infrastrutturale da fare.

## Piano d'azione consigliato

Interventi piccoli, in quest'ordine — nessuno urgente:

1. **R1** Retention per `audit_events` e `operation_requests` (poche righe + 2 test).
2. **R2** Download e protezione dalla rotazione per i backup pre-migrazione.
3. **R3** Pianificare l'estrazione del modulo carrello da `cassa-controller.js` prima
   della prossima feature di cassa; annotare in AGENTS.md la regola "i ratchet non si
   alzano".
4. **R4** I due test di copertura (logging JSON, disconnessione durante lo streaming CSV).
5. **R6** Colonna `operator` nell'audit, alla prima occasione di bump di schema (v12),
   così viaggia con una migrazione già dovuta ad altro.

## Appendice — gate e verifiche eseguite

```bash
npm test           # 85/85 verdi (lint incluso)
npm run coverage   # 92,15% righe · 77,69% branch · 96,31% funzioni (src/**)
npm run test:e2e   # 10/10 Playwright (Chromium)
npm run test:scale # 9/9 — inclusi 100.000 vendite e lettore WAL esterno
npm run test:fault # 11/11 — migrazioni/restore interrotti, backup preventivo
npm audit          # 0 vulnerabilità
npm outdated       # 2 minor @fontsource

# Riproduzioni avversariali indipendenti (script della sessione di audit precedente,
# rieseguiti senza modifiche di sostanza contro il codice attuale):
#  - restore file v8 senza CHECK + prezzo negativo  -> 400 (prima: 200 + dato corrotto)
#  - doppio POST /movements stessa chiave           -> 1 riga, replay deterministico
#  - stessa chiave, payload diverso                 -> 409
#  - 33.000 vendite, /reports/summary?session=      -> 200, totali corretti (prima: 500)
#  - modale aperta + clientNavigate                 -> stato ripulito (prima: app bloccata)
#  - FTS: "amatri" / "all'ama" / "ARROST" / "zz"    -> 1/1/1 risultati, 400 sotto 3 caratteri
```

## Addendum — stato al 20 luglio 2026

Questo addendum aggiorna lo stato operativo senza riscrivere l'analisi storica del
19 luglio. Le tranche successive hanno chiuso R1 e R2 nel commit `c6febe2`: retention
separata per audit e replay, download dei backup pre-migrazione e quote di rotazione
distinte. Anche il controllo di coerenza dell'indice FTS e' ora obbligatorio all'avvio.

R3 e' stato ridotto con un'estrazione mirata del modello carrello:

- `public/cart-model.js` contiene costruzione delle righe, quantità, totale,
  persistenza/recovery del draft e riconciliazione con catalogo e stock;
- `public/cassa-controller.js` resta responsabile dell'orchestrazione UI ed e' sceso da
  1.419 a 1.277 righe;
- il ratchet del controller e' stato abbassato da 1.500 a 1.300 righe, il modello ha un
  limite di 260 righe e `src/db.js` un limite dedicato di 950 righe;
- tre test comportamentali isolati proteggono calcoli, recovery, isolamento per database
  e turno, variazioni prezzo, stock insufficiente e prodotti rimossi.

Verifiche della tranche: `npm test` 111/111, coverage `src/**` 92,62% linee / 78,70%
rami / 96,60% funzioni, E2E 10/10, scale 14/14 e fault 16/16, tutte con Node 24.

Restano aperti R4 (copertura di logging JSON e disconnessione durante CSV streaming), R5
(parametri auth configurabili solo su esigenza reale) e R6 (operatore nell'audit, da
accorpare a un futuro bump dello schema). R7 resta un elenco di rilievi minori. Stampa
hardware e terminazione TLS restano deliberatamente fuori perimetro secondo le decisioni
di progetto gia' documentate.

### Completamento R4 — 20 luglio 2026

R4 e' chiuso con tre test mirati e nessuna modifica al comportamento applicativo:

- il middleware con `LOG_REQUESTS=1` emette al `finish` un record JSON verificato campo
  per campo, inclusi request ID, metodo, path, status e durata;
- lo streaming CSV sotto backpressure riprende dopo `drain`, rimuove i listener e termina
  normalmente;
- se il client emette `close`, lo stream interrompe subito il generatore, non legge righe
  successive, rimuove i listener e non chiama `res.end()`.

La copertura complessiva `src/**` e' ora 93,28% linee / 78,88% rami / 97,48% funzioni;
`observability.js` passa dal 37,78% all'86,67% delle linee e
`reporting/exports.js` raggiunge il 98,11% delle linee. La suite conta 114/114 test verdi;
scale e fault restano verdi rispettivamente 16/16 e 18/18.

Restano quindi R5, subordinato a un bisogno reale di configurare la durata delle sessioni,
R6, da accorpare a un futuro bump dello schema, e i rilievi minori R7. Questo paragrafo
sostituisce lo stato di R4 riportato nell'addendum immediatamente precedente.
