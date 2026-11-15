// Firestore access for holdings.
//   users/{uid}/holdings/{id}  → { isin, name, type, quantity, buyPrice (EUR), buyDate, currency, createdAt, updatedAt }
import { getDb } from "./firebase.js?v=69";

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
  // sells are stored like buys with side "sell" (buyPrice = the sell price)
  if (h.side === "sell") data.side = "sell";
  else if (id) data.side = deleteField();
  if (id) await updateDoc(doc(db, "users", uid, "holdings", id), { ...data, symbol: deleteField() });
  else await addDoc(collection(db, "users", uid, "holdings"), { ...data, createdAt: serverTimestamp() });
}

export async function deleteHolding(uid, id) {
  const { db, doc, deleteDoc } = await getDb();
  await deleteDoc(doc(db, "users", uid, "holdings", id));
}


// Your settings per position, one doc per ISIN: users/{uid}/names/{ISIN} → { name, venue }
// name: your own name for it; venue: the exchange to value it with (like your broker does)
export async function watchNames(uid, callback) {
  const { db, collection, onSnapshot } = await getDb();
  return onSnapshot(collection(db, "users", uid, "names"), (snap) => {
    const names = {}, venues = {};
    snap.docs.forEach((d) => {
      const v = d.data();
      if (v.name) names[d.id] = v.name;
      if (v.venue) venues[d.id] = v.venue;
    });
    callback(names, venues);
  }, (e) => console.warn("Names listener failed", e));
}

async function setPositionField(uid, key, field, value) {
  const { db, doc, setDoc, deleteField, serverTimestamp } = await getDb();
  const clean = (value || "").trim().slice(0, 60);
  await setDoc(doc(db, "users", uid, "names", key), { [field]: clean || deleteField(), updatedAt: serverTimestamp() }, { merge: true });
}
export const setName = (uid, key, name) => setPositionField(uid, key, "name", name);
export const setVenue = (uid, key, venue) => setPositionField(uid, key, "venue", venue);
