import { usePatchcadParam } from "@patchcad/preview-runtime";

export interface Product {
  id: string;
  name: string;
  price: number;
  art: string;
}

const CATALOG: Product[] = [
  { id: "p1", name: "Patch cable (2m)", price: 12, art: "🔌" },
  { id: "p2", name: "Knob set (×4)", price: 18, art: "🎛️" },
  { id: "p3", name: "Oscillator module", price: 149, art: "〰️" },
  { id: "p4", name: "Filter module", price: 129, art: "🎚️" },
  { id: "p5", name: "Envelope module", price: 99, art: "📈" },
  { id: "p6", name: "Rack case 84hp", price: 249, art: "🧰" },
  { id: "p7", name: "Power supply", price: 89, art: "⚡" },
  { id: "p8", name: "Blank panel", price: 9, art: "⬜" },
  { id: "p9", name: "MIDI adapter", price: 39, art: "🎹" },
  { id: "p10", name: "Sequencer", price: 199, art: "🟦" },
  { id: "p11", name: "Ring modulator", price: 119, art: "💍" },
  { id: "p12", name: "Sticker pack", price: 5, art: "✨" },
];

export function useProducts(): Product[] {
  const productCount = usePatchcadParam<number>("product-data", "productCount", 8);
  return CATALOG.slice(0, Math.max(1, Math.min(12, productCount)));
}
