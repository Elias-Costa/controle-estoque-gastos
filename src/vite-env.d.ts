/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** `'1'` só no build de laboratório de E-08 (`bun run build:laboratorio`, D-043). Ausente em produção. */
  readonly VITE_LABORATORIO?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Carimbo do build, injetado por `define` em vite.config.ts. */
declare const __BUILD_ID__: string
