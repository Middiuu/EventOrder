# Runbook operativo essenziale

## Prerequisiti e avvio

1. Usa Node.js 24 e una checkout pulita: `node --version` deve iniziare con `v24.`.
2. Esegui `npm ci` e configura `.env` partendo da `.env.example`.
3. Mantieni `HOST=127.0.0.1` per l'uso sulla stessa macchina. Per la LAN sono obbligatori
   `APP_PIN`, `ALLOWED_HOSTS` e `PUBLIC_ORIGIN`; termina HTTPS su nginx/Caddy nella stessa
   macchina e usa `TRUST_PROXY=loopback` su reti non fidate.
4. Avvia con `npm start`. Non lanciare due processi sullo stesso database.
5. Verifica:

   ```bash
   curl --fail http://127.0.0.1:3000/api/health/live
   curl --fail http://127.0.0.1:3000/api/health/ready
   ```

La liveness conferma che il processo risponde. La readiness richiede avvio completato,
database accessibile, nessun restore, e almeno `MIN_FREE_DISK_MB` liberi. Durante un
backup online resta pronta e segnala `maintenance: "backup"`; durante restore o shutdown
risponde 503.

## Aggiornamento

1. Chiudi il turno di cassa e crea un backup dall'interfaccia Report.
2. Scarica il backup anche su un supporto o host diverso dalla macchina POS.
3. Arresta con `SIGTERM`/Ctrl-C e attendi l'uscita. Dopo `SHUTDOWN_TIMEOUT_MS` il processo
   forza la chiusura e termina con codice 1; al riavvio controlla recovery e readiness.
4. Conserva commit/release precedente, relativo `package-lock.json` e backup.
5. Aggiorna il codice, esegui `npm ci`, quindi almeno `npm test` e
   `npm run test:restore-drill` prima dell'avvio operativo.
6. Avvia e verifica readiness, storico recente e numero del prossimo ticket.

## Backup e verifica

- Crea il backup con il pulsante in Report o `POST /api/reports/backup`, poi scarica il
  `download_url` restituito. Una GET non crea nuovi backup.
- Non usare link simbolici: il download apre file regolari con `O_NOFOLLOW` e rifiuta
  symlink o nomi fuori whitelist.
- Conserva separatamente backup operativi e pre-migrazione. La rotazione non deve essere
  l'unica copia.
- Esegui regolarmente `npm run test:restore-drill`: usa soltanto file temporanei e
  verifica schema, integrità, foreign key, WAL, snapshot e identità DB dopo il riavvio.
- Per verificare un backup specifico senza modificarlo:

  ```bash
  node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true,fileMustExist:true});console.log(d.pragma("user_version",{simple:true}),d.pragma("integrity_check"),d.pragma("foreign_key_check"));d.close()' /percorso/backup.sqlite
  ```

## Restore

1. Ferma gli incassi, chiudi il turno e crea/scarica un ultimo backup dello stato attivo.
2. In Report scegli il file e conferma il restore. Non interrompere il processo.
3. È normale che readiness risponda 503 durante l'operazione.
4. EventOrder verifica il candidato, crea un backup pre-restore, canonicalizza lo schema,
   ricostruisce FTS, ruota l'identità DB e invalida i cookie precedenti.
5. Dopo la risposta positiva riavvia il processo e controlla readiness, ultimo turno,
   storico, catalogo e numero ticket.

Non copiare manualmente un file `.sqlite` sopra il database mentre il processo è attivo e
non spostare WAL/SHM fra database diversi.

## Recupero da crash

1. Non cancellare marker `restore-state`/`migration-state` né file `restore-original`.
2. Riavvia una volta: il bootstrap recupera automaticamente le finestre di rename note.
3. Se readiness non torna 200, conserva una copia dell'intera directory dati e consulta
   l'errore di avvio. Errori di schema, `quick_check`, foreign key o FTS sono fail-closed.
4. Libera spazio se il check disco è `low`; non cancellare backup senza averne copiato
   almeno uno fuori macchina.
5. Se la recovery automatica fallisce, avvia la release compatibile e ripristina un
   backup verificato. Non tentare riparazioni SQL sul database operativo originale.

## Rollback

- **Solo codice, stesso schema:** arresta, conserva il DB corrente, torna alla release
  precedente con il suo lockfile, esegui `npm ci`, avvia e verifica readiness.
- **Dopo una migrazione schema:** non esiste downgrade automatico. Usa insieme la release
  precedente e il relativo backup pre-migrazione, lasciando intatto il database più
  recente per analisi o roll-forward.
- Registra commit, backup scelto, ora e motivo del rollback.

## Diagnostica e sicurezza

- `X-Request-ID` correla risposta, audit SQLite e log. Con `LOG_REQUESTS=1` i log HTTP sono
  JSON e non includono body, cookie o PIN.
- Non pubblicare direttamente la porta HTTP su Internet. In LAN non fidata usa TLS al
  confine di deployment; l'app non gestisce certificati o PKI.
- L'audit è un registro operativo best-effort, non una prova forense tamper-evident.
- La stampa resta lo stub console. Nessuna procedura operativa richiede hardware,
  ESC/POS, USB o LAN printer.
