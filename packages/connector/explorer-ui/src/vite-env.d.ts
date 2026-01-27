/// <reference types="vite/client" />

// Fallback for when vite/client types are not available (e.g., production builds)
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
