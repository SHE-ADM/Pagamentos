// src/hooks/useDefaultSkCompany.ts
// Empresa PADRÃO do cadastro manual de contas (select "Empresa" do ContaForm no modo
// create). Regra do usuário: a ester lança para a OTIMOTEX FARDOS; todos os demais, para a
// OTIMOTEX TECIDOS (o default do negócio). Espelha, no CRUD manual, a regra que o pipeline
// aplica na extração (read_emails.py: FARDOS_SENDER/_is_fardos_sender).
//
// NOTA (não regredir): isto é um vínculo usuário→empresa — o mesmo conceito da tabela
// `user_company`, que foi implementada e REVERTIDA a pedido do usuário ("não vou mais
// trabalhar com identificação de company nos usuários" — ver CLAUDE.md). Fica
// DELIBERADAMENTE como uma constante de e-mail no código, sem ressuscitar a tabela. Se um
// dia forem vários usuários, a tabela volta a ser a saída certa.
import { useAuth } from '../contexts/AuthContext';

/** OTIMOTEX TECIDOS — empresa pagadora padrão (sk_company = 1). Usada pelo ContaForm
 *  também como valor do fallback quando o lookup de empresas falha. */
export const SK_COMPANY_DEFAULT = 1;
/** OTIMOTEX FARDOS — empresa das contas da ester (sk_company = 3). Sem `export`: só a
 *  regra abaixo a usa; quem consome o hook recebe o número já resolvido. */
const SK_COMPANY_FARDOS = 3;
/** Endereço EXATO (não o domínio otimotex.com.br) — espelha FARDOS_SENDER do read_emails.py. */
const FARDOS_USER_EMAIL = 'ester@otimotex.com.br';

/**
 * sk_company inicial do cadastro manual: 3 (FARDOS) quando a ester está logada; 1
 * (TECIDOS) para os demais. Só vale na CRIAÇÃO — na edição a empresa vem da própria conta.
 */
export function useDefaultSkCompany(): number {
  const { user } = useAuth();
  return user?.email?.trim().toLowerCase() === FARDOS_USER_EMAIL
    ? SK_COMPANY_FARDOS
    : SK_COMPANY_DEFAULT;
}
