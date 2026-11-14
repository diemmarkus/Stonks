// Firestore access for holdings.
//   users/{uid}/holdings/{id}  → { symbol, name, type, quantity, buyPrice, buyDate, createdAt, updatedAt }
//   symbols/{SYMBOL}           → { symbol, type, name, addedAt }  (public list the price job reads)
import { getDb } from "./firebase.js";

export async function watchHoldings(uid, callback, onError) {
  const { db, collection, onSnapshot } = await getDb();
  return onSnapshot(
    collection(db, "users", uid, "holdings"),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

export async function saveHolding(uid, id, h) {
  const { db, collection, doc, addDoc, updateDoc, serverTimestamp } = await getDb();
  const data = {
    symbol: h.symbol,
    name: h.name || "",
    type: h.type,
    quantity: h.quantity,
    buyPrice: h.buyPrice,
    buyDate: h.buyDate || "",
    updatedAt: serverTimestamp(),
  };
  if (id) await updateDoc(doc(db, "users", uid, "holdings", id), data);
  else await addDoc(collection(db, "users", uid, "holdings"), { ...data, createdAt: serverTimestamp() });
  registerSymbol(h).catch((e) => console.warn("Couldn't register symbol for price updates", e));
}

export async function deleteHolding(uid, id) {
  const { db, doc, deleteDoc } = await getDb();
  await deleteDoc(doc(db, "users", uid, "holdings", id));
}

// Adds the ticker to the public list so the GitHub Action starts fetching its price.
async function registerSymbol(h) {
  const { db, doc, setDoc, serverTimestamp } = await getDb();
  await setDoc(doc(db, "symbols", h.symbol), {
    symbol: h.symbol,
    type: h.type,
    name: h.name || "",
    addedAt: serverTimestamp(),
  });
}
