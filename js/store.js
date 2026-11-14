// Firestore access for holdings.
//   users/{uid}/holdings/{id}  → { isin, name, type, quantity, buyPrice (EUR), buyDate, currency, createdAt, updatedAt }
import { getDb } from "./firebase.js?v=27";

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
}

export async function deleteHolding(uid, id) {
  const { db, doc, deleteDoc } = await getDb();
  await deleteDoc(doc(db, "users", uid, "holdings", id));
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
