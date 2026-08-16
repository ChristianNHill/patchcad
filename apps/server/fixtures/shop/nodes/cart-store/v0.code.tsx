import { useSyncExternalStore } from "react";

export interface CartItem {
  id: string;
  name: string;
  price: number;
  qty: number;
}

export interface Cart {
  items: CartItem[];
  count: number;
  total: number;
  add: (p: { id: string; name: string; price: number }) => void;
  remove: (id: string) => void;
}

let items: CartItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return items;
}

function add(p: { id: string; name: string; price: number }) {
  const existing = items.find((i) => i.id === p.id);
  items = existing
    ? items.map((i) => (i.id === p.id ? { ...i, qty: i.qty + 1 } : i))
    : [...items, { ...p, qty: 1 }];
  emit();
}

function remove(id: string) {
  items = items.filter((i) => i.id !== id);
  emit();
}

export function useCart(): Cart {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const count = snapshot.reduce((n, i) => n + i.qty, 0);
  const total = snapshot.reduce((n, i) => n + i.qty * i.price, 0);
  return { items: snapshot, count, total, add, remove };
}
