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

export const TEAMS = ["Hvit", "Rød"];

// Rekkefølgen her er prosessen en kamp går gjennom.
export const STATUSES = [
  { id: "planlagt",   label: "Planlagt internt",   color: "#64748b" },
  { id: "forespurt",  label: "Forespørsel sendt",  color: "#d97706" },
  { id: "avtalt",     label: "Avtalt",             color: "#2563eb" },
  { id: "klar",       label: "Klar (tropp + bane)", color: "#16a34a" },
  { id: "spilt",      label: "Spilt",              color: "#0f766e" },
  { id: "avlyst",     label: "Avlyst",             color: "#dc2626" }
];
