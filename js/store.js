// Datalag: Firebase (Firestore + Google-innlogging) eller lokal demo-modus.
import { firebaseConfig, OWNER_EMAIL } from "./config.js";

export const demoMode = !firebaseConfig.apiKey;

const FB = "https://www.gstatic.com/firebasejs/10.12.2";
let fb = null;     // lastede Firebase-moduler
let db = null;
let auth = null;

export async function init(onUser) {
  if (demoMode) {
    const u = JSON.parse(localStorage.getItem("fk_demo_user") || "null");
    onUser(u);
    return;
  }
  const [app, authMod, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`)
  ]);
  fb = { ...authMod, ...fs };
  const firebaseApp = app.initializeApp(firebaseConfig);
  auth = authMod.getAuth(firebaseApp);
  db = fs.initializeFirestore(firebaseApp, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
  });
  authMod.onAuthStateChanged(auth, (u) =>
    onUser(u ? { email: u.email, name: u.displayName, photo: u.photoURL } : null));
}

export async function signIn() {
  if (demoMode) {
    const u = { email: OWNER_EMAIL, name: "Demo-bruker" };
    localStorage.setItem("fk_demo_user", JSON.stringify(u));
    location.reload();
    return;
  }
  await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
}

export async function signOut() {
  if (demoMode) {
    localStorage.removeItem("fk_demo_user");
    location.reload();
    return;
  }
  await fb.signOut(auth);
}

// ---- Demo-lagring (localStorage) ----
const listeners = {};
const loadLocal = (c) => JSON.parse(localStorage.getItem("fk_" + c) || "{}");
function saveLocal(c, data) {
  localStorage.setItem("fk_" + c, JSON.stringify(data));
  (listeners[c] || []).forEach((cb) => cb(toList(data)));
}
const toList = (obj) => Object.entries(obj).map(([id, v]) => ({ id, ...v }));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- Felles API ----
export function subscribe(coll, cb, onError) {
  if (demoMode) {
    (listeners[coll] ||= []).push(cb);
    cb(toList(loadLocal(coll)));
    return;
  }
  fb.onSnapshot(fb.collection(db, coll),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError);
}

export async function add(coll, data, id) {
  if (demoMode) {
    const all = loadLocal(coll);
    id ||= newId();
    all[id] = data;
    saveLocal(coll, all);
    return id;
  }
  if (id) {
    await fb.setDoc(fb.doc(db, coll, id), data);
    return id;
  }
  const ref = await fb.addDoc(fb.collection(db, coll), data);
  return ref.id;
}

export async function update(coll, id, data) {
  if (demoMode) {
    const all = loadLocal(coll);
    all[id] = { ...all[id], ...data };
    saveLocal(coll, all);
    return;
  }
  await fb.setDoc(fb.doc(db, coll, id), data, { merge: true });
}

export async function remove(coll, id) {
  if (demoMode) {
    const all = loadLocal(coll);
    delete all[id];
    saveLocal(coll, all);
    return;
  }
  await fb.deleteDoc(fb.doc(db, coll, id));
}

export async function get(coll, id) {
  if (demoMode) return loadLocal(coll)[id] || null;
  const snap = await fb.getDoc(fb.doc(db, coll, id));
  return snap.exists() ? snap.data() : null;
}
