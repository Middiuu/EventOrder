# EventOrder — Verifica di chiusura dei residui (4° ciclo)

> Documento storico archiviato. Fotografa il commit `6668414`; per lo stato corrente
> fare riferimento a `docs/audit-debito-tecnico-2026-07.md`.

**Data:** 20 luglio 2026

**Commit analizzato:** `6668414` (`main`, "Chiudi i rilievi minori azionabili")

**Baseline precedente:** `4afed5e` — i residui R1–R7 di
[analisi-post-consolidamento-2026-07.md](../analisi-post-consolidamento-2026-07.md)

**Ambito:** frontend, backend, database, sicurezza HTTP, backup/restore, retention, test, CI

## Verdetto

Questo ciclo ha lavorato **esattamente sui residui** che il report precedente aveva
lasciato aperti, e li ha chiusi tutti — in diversi casi andando oltre. In più è stata
aggiunta un'intera area di sicurezza HTTP (allowlist host + anti-CSRF) che non era nel
backlog. Ho verificato le chiusure **empiricamente**, non solo per lettura: retention,
sicurezza HTTP e la non-regressione dei flussi legittimi sono state riprodotte con
script eseguibili; i difetti storici P0.1 e P0.3 restano chiusi.

Non ho trovato regressioni né nuovi difetti sostanziali. I rilievi rimasti sono minori e
per lo più decisioni consapevoli.

### Nota di ambiente (non è un difetto del progetto)

Al primo `npm test` 80 test fallivano con `ERR_DLOPEN_FAILED`: il binding nativo di
`better-sqlite3` era compilato per `NODE_MODULE_VERSION 137` (Node 24, quello che il
progetto dichiara in `.nvmrc`/`engines` e che usa la CI), mentre il mio runtime locale è
Node 26 (`147`). È un disallineamento del **mio** ambiente: l'installazione delle
dipendenze è corretta per la versione di Node dichiarata. Risolto con
`npm rebuild better-sqlite3` (ricompila il solo modulo nativo, non tocca lockfile né
versioni). Dopo il rebuild, tutti i gate passano.

### Gate verificati

| Gate | Esito |
|---|---|
| `npm test` (lint + unit/guardrail) | **114/114** verdi |
| `npm run coverage` (`src/**`) | **93,32%** righe · **78,95%** branch · **97,48%** funzioni |
| `npm run test:e2e` (Playwright) | **10/10** flussi verdi |
| `npm run test:scale` | **16/16** (aggregazioni 100k vendite, contesa WAL) |
| `npm run test:fault` | **18/18** (migrazioni/restore interrotti, stampa pendente) |

## Chiusura dei residui R1–R7

| ID | Residuo precedente | Stato | Come è stato chiuso | Verifica |
|---|---|---|---|---|
| **R1** | `audit_events` e `operation_requests` crescono senza limite | ✅ chiuso | Nuovo `src/service-data-retention.js`, invocato in `initDb`; env `AUDIT_RETENTION_DAYS` (90) e `OPERATION_REQUEST_RETENTION_DAYS` (30) | **empirica** |
| **R2** | Backup pre-migrazione non scaricabili e in competizione nella rotazione | ✅ chiuso | Nuovo `src/backup-files.js`: rotazione separata (`PRE_MIGRATION_BACKUP_KEEP`=3), scaricabili via `isDownloadableBackupName` | lettura |
| **R3** | `cassa-controller.js` prossimo al ratchet; carrello non isolato | ✅ chiuso | Estratto `public/cart-model.js` (modulo puro, storage iniettabile); controller 1419 → **1277** righe; ratchet **abbassato** 1500 → 1300 + nuovo ratchet su `db.js` (≤950) | lettura + test |
| **R4** | Copertura frontend/observability/streaming assente | ✅ chiuso | `observability.js` **38% → 87%**; backpressure streaming CSV testato (`exports.js` 98%); nuovi test per i moduli estratti | **misurata** |
| **R5** | Cookie di sessione senza flag `Secure` | ✅ chiuso | `auth.js`: `Secure` aggiunto quando `req.secure` (HTTPS) | lettura |
| **R6** | Audit trail senza l'attore dell'operazione | ⚠️ aperto (bassa) | Non affrontato; vedi Residui | — |
| **R7** | Regex `eventType` senza flag `g`; E2E solo Chromium | ◑ parziale | Regex corretta (`/\/+/g`); E2E resta Chromium | lettura |

## Bonus oltre il backlog — sicurezza HTTP (`src/request-security.js`)

Nuovo middleware, primo nella catena, non richiesto dal backlog:

- **Allowlist host** (`ALLOWED_HOSTS`): un `Host` non consentito riceve **421**;
- **Anti-CSRF**: mutazioni con `Sec-Fetch-Site: cross-site` o `Origin` estraneo → **403**;
- **Content-Type enforcement**: body con tipo non ammesso → **415** (JSON per le API,
  tipi SQLite per il restore);
- Validazioni di configurazione incrociate e fail-closed in `config.js`: fuori dal
  loopback diventano obbligatori `ALLOWED_HOSTS`, `PUBLIC_ORIGIN` (il cui host deve stare
  in `ALLOWED_HOSTS`) e `TRUST_PROXY=loopback` con HTTPS.

## Verifiche empiriche eseguite

Riprodotte su database e server temporanei, senza toccare `pos.sqlite`.

### R1 — retention con protezione dei turni aperti

```
prima: { audit: 2, ops: 2 } | pruned: { auditEvents: 1, operationRequests: 1 }
dopo   audit: 1                 (resta il record recente)
dopo   op turno CHIUSO: 0       (cancellato)
dopo   op turno APERTO: 1       (PROTETTO)
```

Dettaglio non ovvio e corretto: `operation_requests` viene prunato **solo per turni
chiusi** (`session_id IN (… closed_at IS NOT NULL)`). L'idempotenza di un turno ancora
aperto non può essere cancellata da una retention che scatta durante il servizio.

### Sicurezza HTTP — blocco delle minacce e non-regressione dei flussi legittimi

```
Host evil.example.com (raw http.request)   -> 421   blocco allowlist
POST Sec-Fetch-Site: cross-site            -> 403   anti-CSRF
POST Origin estraneo                       -> 403   anti-CSRF
POST Content-Type text/plain (con body)    -> 415   content-type
POST same-origin legittima                 -> 200   NON regredito
POST senza Origin né Sec-Fetch-Site        -> 200   NON regredito (client non-browser)
GET host valido                            -> 200   NON regredito
```

Nota di metodo: il primo tentativo di test dell'host usava `fetch`, che tratta `Host`
come header vietato e lo sovrascrive — dava un falso "200". Ripetuto con `http.request`
nativo, l'allowlist blocca correttamente con **421**. È il motivo per cui questi punti
vanno riprodotti e non dedotti.

### Difetti storici — ancora chiusi

```
P0.1  POST /restore (schema v11 non canonico, prezzo -500)  -> 400
P0.3  doppio movimento con stessa Idempotency-Key           -> 1 riga, 5000 cent
```

Il restore ora applica una **doppia difesa**: ricostruzione canonica del candidato in un
DB isolato *e* `validateCanonicalDatabase(..., { fullIntegrity: true })`. La stessa
validazione canonica blocca ora anche l'**avvio** se il DB attivo non è canonico
(`initDb`, ramo `previousVersion === DB_SCHEMA_VERSION`): fail-closed sul dato più
prezioso.

## Residui rimasti (minori — con soluzione)

| # | Rilievo | Impatto | Soluzione proposta |
|---|---|---|---|
| 1 | **Retention solo in `initDb`** (avvio + post-restore): un'installazione accesa per settimane senza riavvii non pota le tabelle di servizio finché non riparte | Basso — coerente col caso d'uso (basso volume, riavvii tra eventi) | Opzionale: un tick di retention anche alla chiusura turno, o una soglia per numero di righe |
| 2 | **Validazione canonica all'avvio fail-closed**: `normalizeSchemaSql` confronta il DDL normalizzato; un futuro upgrade di SQLite che cambi la resa del DDL in `sqlite_master` potrebbe impedire l'avvio di un DB per il resto valido | Molto basso / teorico | Fissare la versione di SQLite (già implicito nel lockfile) e coprire l'upgrade con un test dedicato quando si aggiornerà `better-sqlite3` |
| 3 | **R6 — l'audit non registra l'attore** (solo tipo, esito, stato, request-id) | Basso | Aggiungere l'operatore del turno / IP a `audit_events` se serve accountability per postazione |
| 4 | **E2E solo Chromium** | Basso | Aggiungere WebKit/Firefox alla matrice Playwright se si prevede uso su iPad/Safari |
| 5 | `observability.js` copertura funzioni 75% (righe 38–43) | Cosmetico | Un test su `errorFields` con input non-Error |

Restano **deliberatamente aperti** e non vanno riaperti come bug: la stampante come stub
console (decisione di prodotto registrata in `AGENTS.md`, P1.9) e il TLS come confine di
deployment.

## Conclusione

Il quarto ciclo chiude il backlog dei residui e aggiunge una difesa HTTP non richiesta,
mantenendo la disciplina architetturale (ratchet abbassati anziché alzati, moduli puri
testabili, retention che protegge gli invarianti di cassa). Le verifiche empiriche
confermano sia le chiusure sia l'assenza di regressioni sui flussi legittimi. Il progetto
è in stato solido: i rilievi rimasti sono rifiniture opzionali, non ostacoli all'uso.
