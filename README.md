# Fana G2014 – Kampoversikt

Enkel webapp (mobil + nettleser) for å organisere kamper for Fana G2014 Hvit og Rød.

- **Hosting:** GitHub Pages (gratis, statiske filer – ingen server å drifte)
- **Database + innlogging:** Firebase (Firestore + Google-innlogging), gratisnivået holder godt
- **Ingen byggesteg:** ren HTML/CSS/JS. Endringer gjøres direkte i filene og pushes.

Appen kjører uavhengig av Claude – alt ligger i GitHub og Firebase under din konto.

## Funksjoner

- Kamper med lag, status, dato, avspark, oppmøte, type, motstander, hjemme/borte, bane, kontakt og notater
- Statusprosess: Planlagt internt → Forespørsel sendt → Avtalt → Klar (tropp + bane) → Spilt (eller Avlyst).
  Knappen «→ neste status» på hvert kampkort flytter kampen ett steg videre.
- Kamptropp velges fra spillerlisten (spillere fra eget lag vises først)
- Historikk per kamp (hvem endret hva og når)
- Filtrer på lag/status, vis tidligere kamper, eksport til CSV
- Tilgangsliste: bare Google-kontoer du legger inn får se og redigere
- Kan legges til på hjemskjermen på mobil

## Oppsett (én gang, ca. 15 min)

### 1. Firebase-prosjekt
1. Gå til <https://console.firebase.google.com> → **Legg til prosjekt** (f.eks. `fanakamper`). Google Analytics kan slås av.
2. **Build → Authentication → Kom i gang → Google** → aktiver, velg support-e-post, lagre.
3. **Build → Firestore Database → Opprett database** → velg region `eur3 (europe-west)` → start i *production mode*.
4. I Firestore, fanen **Regler**: lim inn innholdet i [firestore.rules](firestore.rules) og trykk **Publiser**.
5. **Prosjektinnstillinger (tannhjul) → Dine apper → Web (`</>`)** → registrer app → kopier `firebaseConfig`-verdiene inn i [js/config.js](js/config.js).
6. **Authentication → Settings → Authorized domains** → legg til `adrianrutle.github.io`.

### 2. GitHub Pages
1. Commit og push til `main`.
2. På GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
3. Appen blir tilgjengelig på <https://adrianrutle.github.io/Fanakamper/>.

### 3. Første innlogging
1. Logg inn med `adrian.rutle@gmail.com` (eieren, satt i `firestore.rules` og `js/config.js`).
2. **Innstillinger → Tilgang**: legg inn e-posten til andre trenere/lagledere.
3. **Innstillinger → Importer fra Excel**: velg vinterserie-arket. Kamper (arket «FANA»), spillere og tropper («Laguttak») og kontaktpersoner («Lag i serien») lastes inn i databasen.

## Import fra Excel

Importen leser arket direkte i nettleseren og skriver til Firebase – filen lastes ikke opp noe annet sted.
Kamper og spillere som allerede finnes blir ikke overskrevet, så importen kan trygt kjøres på nytt – men endringer i eksisterende
kamper (f.eks. nye tropper) må da gjøres i appen.
Spillere på nivå 1 blir «Hvit», nivå 2 «Rød», resten «Begge». Logikken ligger i [js/excel-import.js](js/excel-import.js).

**Personvern:** Repoet og GitHub Pages er offentlige. Legg aldri Excel-arket, spillerlister eller kontaktinfo i repoet –
`.gitignore` stopper `.xlsx`/`.csv`-filer. Alt slikt hører hjemme i databasen, som bare innloggede med tilgang kan lese.

## Lokal testing

```bash
python3 -m http.server 8080
```

Åpne <http://localhost:8080>. Uten Firebase-oppsett kjører appen i **demo-modus** (data lagres kun i nettleseren).

## Endre statuser, lag e.l.

Alt slikt ligger i [js/config.js](js/config.js). Endre, commit og push – GitHub Pages oppdaterer seg i løpet av et minutt.
