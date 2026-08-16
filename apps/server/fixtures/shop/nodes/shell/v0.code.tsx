import { useTokens } from "@nodes/theme";
import { Header } from "@nodes/header";
import { ProductGrid } from "@nodes/product-grid";

export function App() {
  const t = useTokens();
  return (
    <div style={{ minHeight: "100vh", background: t.surfaceAlt }}>
      <div
        style={{
          maxWidth: 960,
          margin: "0 auto",
          background: t.surfaceAlt,
          minHeight: "100vh",
          boxShadow: "0 0 40px rgba(0,0,0,.05)",
        }}
      >
        <Header />
        <ProductGrid />
      </div>
    </div>
  );
}
