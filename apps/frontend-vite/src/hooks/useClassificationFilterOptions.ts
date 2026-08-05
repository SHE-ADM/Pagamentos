// src/hooks/useClassificationFilterOptions.ts
// Opções dos 3 <select> nativos da 2ª linha de filtros de /consulta (centro de custo,
// grupo e subgrupo de plano de contas). Mesmo contrato do useCompanyOptions: hook sem
// argumento, um único useEffect com flag `active`, falha SILENCIOSA (devolve [] — o
// select fica só com o placeholder, que é exatamente o estado "sem filtro").
//
// Duas diferenças em relação ao useCompanyOptions, ambas pelo requisito de velocidade:
//  1) As 3 chamadas saem em PARALELO num efeito só (Promise.allSettled) — não em três
//     efeitos que se atropelam.
//  2) CACHE DE MÓDULO: voltar para /consulta não refaz a rede, e o valor já resolvido é
//     lido no INICIALIZADOR do useState — a remontagem nem pisca com a lista vazia.
//
// `allSettled` (e não `all`) é deliberado: uma lista que falha não pode zerar as outras
// duas. E o resultado PARCIAL não é memoizado — senão uma indisponibilidade momentânea da
// Next API deixaria o filtro morto até o reload da aba.
//
// O PLANO DE CONTAS não entra aqui: são ~530 descrições, servidas por busca digitável
// (ChartAccountSelect variant="filter"), que não carrega nada na abertura da página.
import { useEffect, useState } from 'react';
import type { SelectOption } from '../components/atoms/LabeledSelect';
import { listChartAccountGroups, listChartAccountSubgroups, listCostCenters } from '../services/lookups';

export interface ClassificationFilterOptions {
  costCenters: SelectOption[];
  groups: SelectOption[];
  subgroups: SelectOption[];
}

const EMPTY: ClassificationFilterOptions = { costCenters: [], groups: [], subgroups: [] };

// Rótulo "código — descrição". Nenhum dos três cadastros tem UNIQUE em descrição (o CRUD
// valida o CÓDIGO, e só na aplicação), então homônimos são possíveis — prefixar o código
// desambigua sempre, sem lógica condicional.
function optionLabel(code: string | null, description: string | null, id: number): string {
  const c = code?.trim();
  const d = description?.trim();
  if (c && d) return `${c} — ${d}`;
  return d ?? c ?? `#${id}`;
}

let inFlight: Promise<ClassificationFilterOptions> | null = null;
let settled: ClassificationFilterOptions | null = null;

async function fetchAll(): Promise<ClassificationFilterOptions> {
  const [cc, gr, sg] = await Promise.allSettled([
    listCostCenters(),
    listChartAccountGroups(),
    listChartAccountSubgroups(),
  ]);
  const result: ClassificationFilterOptions = {
    costCenters:
      cc.status === 'fulfilled'
        ? cc.value.map((c) => ({
            value: c.cost_center_id,
            label: optionLabel(c.cost_center_code, c.cost_center_description, c.cost_center_id),
          }))
        : [],
    groups:
      gr.status === 'fulfilled'
        ? gr.value.map((g) => ({
            value: g.chart_account_group_id,
            label: optionLabel(g.group_code, g.group_description, g.chart_account_group_id),
          }))
        : [],
    subgroups:
      sg.status === 'fulfilled'
        ? sg.value.map((s) => ({
            value: s.chart_account_subgroup_id,
            label: optionLabel(s.subgroup_code, s.subgroup_description, s.chart_account_subgroup_id),
          }))
        : [],
  };
  if ([cc, gr, sg].some((r) => r.status === 'rejected')) inFlight = null; // parcial: não memoiza
  else settled = result;
  return result;
}

function getOptions(): Promise<ClassificationFilterOptions> {
  inFlight ??= fetchAll();
  return inFlight;
}

/**
 * Centros de custo, grupos e subgrupos para `<select>`, no formato
 * `{ value: <id>, label: "código — descrição" }`.
 *
 * Devolve `[]` enquanto carrega e TAMBÉM em caso de falha (silenciosa de propósito, como
 * no useCompanyOptions): o filtro simplesmente não oferece opções e a tela segue usável.
 */
export function useClassificationFilterOptions(): ClassificationFilterOptions {
  const [options, setOptions] = useState<ClassificationFilterOptions>(() => settled ?? EMPTY);

  useEffect(() => {
    if (settled) return; // cache quente — já veio do inicializador do useState
    let active = true;
    void getOptions()
      .then((o) => {
        if (active) setOptions(o);
      })
      .catch(() => undefined); // silencioso — fetchAll já degrada para listas vazias
    return () => {
      active = false;
    };
  }, []);

  return options;
}
