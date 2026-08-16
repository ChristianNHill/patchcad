import { usePatchcadParam } from "@patchcad/preview-runtime";

export interface Tokens {
  accent: string;
  radius: number;
  surface: string;
  surfaceAlt: string;
  ink: string;
  muted: string;
}

export function useTokens(): Tokens {
  const accent = usePatchcadParam<string>("theme", "accent", "#0a7f9e");
  const radius = usePatchcadParam<number>("theme", "radius", 10);
  return {
    accent,
    radius,
    surface: "#ffffff",
    surfaceAlt: "#f2f5f7",
    ink: "#1d2830",
    muted: "#5c6c77",
  };
}
