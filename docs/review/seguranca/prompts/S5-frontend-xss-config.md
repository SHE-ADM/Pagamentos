# S5 — Frontend: sandbox do iframe de PDF + header CSP

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §5. XSS não reproduzível hoje — isto é hardening.

```xml
<objetivo>
  Confinar o PDF anexado (conteúdo de e-mail hostil) com sandbox no iframe e adicionar um header CSP restritivo,
  reduzindo o impacto de qualquer XSS futuro e de conteúdo ativo em PDF.
</objetivo>

<read_first>
  - apps/frontend-vite/src/components/AttachmentViewer.tsx:105 (<iframe src={url}>)
  - apps/frontend-vite/vercel.json (sem bloco headers hoje)
  - apps/frontend-vite/index.html
  - apps/frontend-vite/src/lib/authStorage.ts (token em web-storage — motivação da CSP)
  - apps/frontend-vite/src/services/supabase.ts:28-29 (origem Supabase p/ connect-src)
</read_first>

<achados>
  - [MÉDIO] S5-1 — AttachmentViewer.tsx:105: iframe do PDF sem sandbox. PDF hostil pode disparar navegação de
    topo (phishing) e popups. Origem é Supabase Storage (SOP protege o token), mas o conteúdo ativo não é confinado.
  - [BAIXO] S5-2 — vercel.json/index.html sem Content-Security-Policy. Qualquer XSS futuro exfiltra o token de
    web-storage sem barreira; frame-src/frame-ancestors sem restrição.
  - [INFO] VITE_IMAP_USER no bundle (Emails.tsx:318) — e-mail, não credencial.
</achados>

<correcao>
  1. S5-1: adicionar `sandbox="allow-same-origin allow-popups"` ao iframe (SEM allow-scripts nem
     allow-top-navigation), e opcionalmente `referrerPolicy="no-referrer"`. Testar que o PDF ainda renderiza
     inline (o visualizador nativo do Chrome funciona sob esse sandbox).
  2. S5-2: adicionar bloco `headers` no vercel.json aplicando CSP à SPA, ex.:
     default-src 'self';
     connect-src 'self' https://<project>.supabase.co https://*.vercel.app;
     img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self';
     frame-src https://*.supabase.co; frame-ancestors 'none'; object-src 'none'; base-uri 'self'.
     Ajustar connect-src/frame-src aos domínios reais (Supabase + data-api). Validar que a app carrega, autentica,
     lê dados e abre o PDF sob a CSP (relaxar pontualmente se algum recurso legítimo quebrar — sem cair para
     'unsafe-eval'/wildcard).
  3. INFO S5-2/VITE_IMAP_USER: opcional — servir o e-mail da caixa via resposta autenticada em vez de VITE_.
</correcao>

<restricoes>
  - NÃO usar 'unsafe-eval' nem 'unsafe-inline' em script-src. 'unsafe-inline' em style-src é tolerável (Tailwind
    injeta estilos); preferir sem, se a app funcionar.
  - Não quebrar o carregamento de fontes/assets nem o proxy /data-api.
  - Manter o csvCell (proteção de fórmula) e o padrão de render de texto (React escapa) — já OK, não regredir.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - Manual (dev + preview Vercel): abrir um anexo PDF (renderiza sob sandbox); navegar por /consulta, /emails,
    /erros, login/logout — todos funcionam sob a CSP; conferir no DevTools que não há violação de CSP no console.
  - No CI: `cd apps/frontend-vite && npm run test:e2e -- protected` (não rodar no sandbox do agente).
</validacao>

<criterio_de_aceite>
  iframe do PDF confinado por sandbox (sem scripts/top-navigation). Header CSP restritivo ativo no deploy Vercel
  sem quebrar a aplicação. Sem regressão de XSS (render de texto + csvCell intactos). Gate verde.
</criterio_de_aceite>
```
