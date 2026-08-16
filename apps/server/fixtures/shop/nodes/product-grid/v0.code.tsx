import { usePatchcadParam } from "@patchcad/preview-runtime";
import { useTokens } from "@nodes/theme";
import { useCart } from "@nodes/cart-store";
import { useProducts } from "@nodes/product-data";

export function ProductGrid() {
  const t = useTokens();
  const cart = useCart();
  const products = useProducts();
  const columns = usePatchcadParam<number>("product-grid", "columns", 3);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.max(1, columns)}, 1fr)`,
        gap: 16,
        padding: 20,
      }}
    >
      {products.map((p) => (
        <div
          key={p.id}
          style={{
            background: t.surface,
            border: `1px solid ${t.surfaceAlt}`,
            borderRadius: t.radius,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            boxShadow: "0 1px 4px rgba(0,0,0,.06)",
          }}
        >
          <div style={{ fontSize: 40, textAlign: "center", padding: "10px 0" }}>{p.art}</div>
          <div style={{ fontWeight: 600, color: t.ink, fontSize: 14 }}>{p.name}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: t.muted, fontSize: 14 }}>${p.price}</span>
            <button
              onClick={() => cart.add(p)}
              style={{
                background: t.accent,
                color: "#fff",
                border: "none",
                borderRadius: t.radius,
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + add to rig
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
