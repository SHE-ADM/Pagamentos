// src/hooks/useCompanyOptions.ts
// Opções do cadastro `company` (empresa pagadora — OTIMOTEX/LEBIANCO) prontas para um
// <select>. Carrega UMA vez por montagem via GET /api/companies (companyService).
// Compartilhado por quem escolhe a empresa (ContaForm) e por quem filtra por ela
// (/consulta) — evita duas cópias do mesmo fetch.
import { useEffect, useState } from 'react';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import { listCompanies } from '../services/lookups';

/**
 * Empresas para `<select>`, no formato { value: sk_company, label: trade_name }.
 *
 * Devolve `[]` enquanto carrega e TAMBÉM em caso de falha (silenciosa de propósito): a
 * lista de empresas é acessório de UI — quem chama decide o fallback (o ContaForm mantém
 * a OTIMOTEX para não travar o lançamento; o filtro simplesmente não oferece opções).
 */
export function useCompanyOptions(): SelectOption[] {
  const [options, setOptions] = useState<SelectOption[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const rows = await listCompanies();
        if (!active) return;
        setOptions(rows.map((c) => ({ value: c.sk_company, label: c.trade_name ?? `#${c.sk_company}` })));
      } catch {
        // Silencioso — o chamador trata a ausência de opções.
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return options;
}
