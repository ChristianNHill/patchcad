import { usePatchcadParam } from "@patchcad/preview-runtime";
import { useTokens } from "@nodes/theme";
import { useCart } from "@nodes/cart-store";

export function Header() {
  const t = useTokens();
  const cart = useCart();
  const title = usePatchcadParam<string>("header", "title", "patchcad supply co.");

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 20px",
        background: t.surface,
        borderBottom: `2px solid ${t.accent}`,
      }}
    >
      <span style={{ fontWeight: 800, fontSize: 18, color: t.ink, letterSpacing: "-0.02em" }}>
        {title}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: t.accent,
          color: "#fff",
          borderRadius: t.radius * 2,
          padding: "6px 14px",
          fontSize: 14,
          fontWeight: 600,
        }}
      >
        🛒 {cart.count}
        <span style={{ opacity: 0.85, fontWeight: 400 }}>${cart.total.toFixed(2)}</span>
      </span>
    </header>
  );
}
