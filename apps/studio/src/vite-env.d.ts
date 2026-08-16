/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the patchcad server origin (default http://127.0.0.1:4100). */
  readonly VITE_PATCHCAD_API?: string;
}
