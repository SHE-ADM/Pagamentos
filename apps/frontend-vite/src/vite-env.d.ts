/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_APP_NAME?: string;
  readonly VITE_IMAP_USER?: string;
  readonly VITE_SESSION_IDLE_MINUTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
