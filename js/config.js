// Firebase-oppsett. Lim inn verdiene fra Firebase-konsollen
// (Prosjektinnstillinger → Dine apper → Web-app → SDK-oppsett).
// Så lenge apiKey er tom kjører appen i DEMO-modus med lagring kun i nettleseren.
export const firebaseConfig = {
  apiKey: "AIzaSyCuOwz4tEK1u-zA6NRNfY5J6abXcTgOUpI",
  authDomain: "fanakamper.firebaseapp.com",
  projectId: "fanakamper",
  storageBucket: "fanakamper.firebasestorage.app",
  messagingSenderId: "986001360192",
  appId: "1:986001360192:web:0a8a9829eec414025ae6a5"
};

// Eieren har alltid tilgang og kan gi andre tilgang under «Innstillinger».
// Må være lik e-posten i firestore.rules.
export const OWNER_EMAIL = "adrian.rutle@gmail.com";

export const TEAMS = ["Hvit", "Rød", "Blå"];

// Posisjoner i kamp: enkel inndeling som velges per spiller når troppen settes.
export const MATCH_POSITIONS = [
  { id: "K", label: "Keeper" },
  { id: "F", label: "Forsvar" },
  { id: "M", label: "Midtbane" },
  { id: "A", label: "Angrep" }
];

// Spillerens mulige posisjoner (inntil tre, i prioritert rekkefølge).
// «group» kobler posisjonen til inndelingen over, og brukes som forslag når spilleren tas ut i en tropp.
export const POSITIONS = [
  { id: "K",  label: "Keeper",            group: "K" },
  { id: "MS", label: "Midtstopper",       group: "F" },
  { id: "VB", label: "Venstreback",       group: "F" },
  { id: "HB", label: "Høyreback",         group: "F" },
  { id: "DM", label: "Defensiv midtbane", group: "M" },
  { id: "SM", label: "Sentral midtbane",  group: "M" },
  { id: "OM", label: "Offensiv midtbane", group: "M" },
  { id: "VK", label: "Venstre kant",      group: "A" },
  { id: "HK", label: "Høyre kant",        group: "A" },
  { id: "S",  label: "Spiss",             group: "A" }
];

// Rekkefølgen her er prosessen en kamp går gjennom.
export const STATUSES = [
  { id: "ikkeplanlagt", label: "Ikke planlagt",     color: "#94a3b8" },
  { id: "planlagt",   label: "Planlagt internt",   color: "#64748b" },
  { id: "forespurt",  label: "Forespørsel sendt",  color: "#d97706" },
  { id: "avtalt",     label: "Avtalt",             color: "#2563eb" },
  { id: "klar",       label: "Klar (tropp + bane)", color: "#16a34a" },
  { id: "spilt",      label: "Spilt",              color: "#0f766e" },
  { id: "avlyst",     label: "Avlyst",             color: "#dc2626" }
];
