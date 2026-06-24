// src/lib/featureFlags.ts
// A leitura de e-mails (IMAP) depende do backend Flask (server/app.py), que NÃO é
// publicado no Vercel — roda só localmente (e, em produção, pelo agendador do Windows).
// Por isso os botões que DISPARAM a leitura ficam OCULTOS no build de produção; a
// leitura automática (agendada) segue populando o banco. Override opcional:
// VITE_EMAIL_READER_ENABLED='true' reativa (ex.: quando o Flask for exposto numa VM).
// Sem a env: LIGADO em dev, DESLIGADO em produção (import.meta.env.PROD).
const flag = import.meta.env.VITE_EMAIL_READER_ENABLED as string | undefined;
export const EMAIL_READER_ENABLED = flag != null ? flag !== 'false' : !import.meta.env.PROD;
