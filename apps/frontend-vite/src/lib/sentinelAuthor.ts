// Identidade SENTINELA de autoria — o usuário atribuído quando o pipeline não resolve um dono
// real para a conta. É o DEFAULT de `financial_account_control.created_by`/`updated_by`/
// `status_changed_by` e de `financial_account_attachment.uploaded_by` (migrations 076/077/079,
// identidade trocada pela 110), e o fallback de `resolve_user_for_account()`.
//
// Vive num módulo PRÓPRIO, e não dentro de `Consulta.tsx`, por dois motivos: exportá-lo de lá
// dispararia `react-refresh/only-export-components` (o arquivo exporta um componente), e o
// guarda cross-layer precisa importá-lo sem arrastar a página inteira para o teste.
//
// 🔴 O UUID tem de ser o MESMO do DEFAULT no banco. Se divergir, nada quebra: a tela apenas
// deixa de reconhecer o sentinela e passa a exibir "Última edição por: <e-mail>" em centenas
// de contas que ninguém editou — um erro de dado plausível, silencioso e difícil de rastrear
// até aqui. `sentinelAuthor.test.ts` lê a migration mais recente que define esse DEFAULT e
// compara, para que a divergência apareça como teste vermelho e não como suporte.
export const SENTINEL_AUTHOR_ID = '89ce3055-1d8f-4da7-8355-f855817e61e0';

// Usado como 2ª via, quando o diretório `app_user` já resolveu o id para e-mail. Não é
// verificável por teste (o vínculo id↔e-mail vive em `auth.users`, fora do repositório) — daí
// a checagem por UUID vir primeiro no call site.
export const SENTINEL_AUTHOR_EMAIL = 'financeiro@otimotex.com.br';
