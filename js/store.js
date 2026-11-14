// Firestore access for holdings.
//   users/{uid}/holdings/{id}  → { isin, name, type, quantity, buyPrice (EUR), buyDate, currency, createdAt, updatedAt }
//   symbols/{ISIN}             → { symbol: ISIN, type, name, addedAt }  (public list the price job reads)
import { getDb } from "./firebase.js?v=25";

export async function watchHoldings(uid, callback, onError) {
  const { db, collection, onSnapshot } = await getDb();
  return onSnapshot(
    collection(db, "users", uid, "holdings"),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export async function saveHolding(uid, id, h) {
  const { db, collection, doc, addDoc, updateDoc, serverTimestamp, deleteField } = await getDb();
  const data = {
    isin: h.isin,
    name: h.name || "",
    type: h.type,
    quantity: h.quantity,
    buyPrice: h.buyPrice,
    currency: "EUR",
    buyDate: h.buyDate || "",
    updatedAt: serverTimestamp(),
  };
  if (id) await updateDoc(doc(db, "users", uid, "holdings", id), { ...data, symbol: deleteField() });
  else await addDoc(collection(db, "users", uid, "holdings"), { ...data, createdAt: serverTimestamp() });
  registerIsin(h).catch((e) => console.warn("Couldn't register ISIN for price updates", e));
}

export async function deleteHolding(uid, id) {
  const { db, doc, deleteDoc } = await getDb();
  await deleteDoc(doc(db, "users", uid, "holdings", id));
}

// Adds the ISIN to the public list so the GitHub Action starts fetching its price.
async function registerIsin(h) {
  if (h.type === "crypto") return; // all known coins are priced on every run anyway
  const { db, doc, setDoc, serverTimestamp } = await getDb();
  await setDoc(doc(db, "symbols", h.isin), {
    symbol: h.isin,
    type: h.type,
    name: (h.name || "").slice(0, 60),
    addedAt: serverTimestamp(),
  });
}

// Your own names for positions, one doc per ISIN: users/{uid}/names/{ISIN} → { name }
export async function watchNames(uid, callback) {
  const { db, collection, onSnapshot } = await getDb();
  return onSnapshot(collection(db, "users", uid, "names"), (snap) => {
    const out = {};
    snap.docs.forEach((d) => { if (d.data().name) out[d.id] = d.data().name; });
    callback(out);
  }, (e) => console.warn("Names listener failed", e));
}

export async function setName(uid, key, name) {
  const { db, doc, setDoc, deleteDoc, serverTimestamp } = await getDb();
  const ref = doc(db, "users", uid, "names", key);
  const clean = (name || "").trim().slice(0, 60);
  if (clean) await setDoc(ref, { name: clean, updatedAt: serverTimestamp() });
  else await deleteDoc(ref);
}
