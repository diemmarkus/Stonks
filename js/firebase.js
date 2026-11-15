// Firebase setup shared by every page.
// To upgrade the SDK, change FIREBASE_VERSION (see https://firebase.google.com/support/release-notes/js).
import { firebaseConfig } from "./firebase-config.js?v=47";

const FIREBASE_VERSION = "13.3.0";
const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let authApi = null; // lazily loaded so the landing page renders even without Firebase

async function load() {
  if (authApi) return authApi;
  if (!isConfigured) throw new Error("not-configured");
  const [{ initializeApp }, authMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  authApi = { app, auth, ...authMod };
  return authApi;
}

export async function signIn() {
  const { auth, GoogleAuthProvider, signInWithPopup } = await load();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider);
}

export async function signOutUser() {
  const { auth, signOut } = await load();
  return signOut(auth);
}

export async function onUser(callback) {
  if (!isConfigured) { callback(null); return () => {}; }
  const { auth, onAuthStateChanged } = await load();
  return onAuthStateChanged(auth, callback);
}

// Firestore is loaded only on pages that need it (portfolio).
export async function getDb() {
  const { app } = await load();
  const fs = await import(`${base}/firebase-firestore.js`);
  return { db: fs.getFirestore(app), ...fs };
}
