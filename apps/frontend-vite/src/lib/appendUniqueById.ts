// lib/appendUniqueById.ts
// Concatenação de páginas do scroll infinito SEM repetir registro já carregado.
//
// Segunda barreira contra a linha duplicada (a primeira é o desempate de
// `lib/stableOrder.ts`, que torna a paginação por offset determinística).
//
// Por que as DUAS são necessárias (não regredir): mesmo com ordem total, paginar por
// offset sobre um conjunto que MUDA é intrinsecamente frágil — o reader agendado grava
// contas a cada 5 minutos e o botão "Atualizar" dispara leitura sob demanda. Uma conta
// inserida entre a página N e a N+1 desloca a janela: uma linha já exibida reaparece na
// página seguinte. O desempate não resolve isso (o conjunto é outro), e só a dedup por
// PK garante o invariante que o usuário enxerga: a mesma conta nunca aparece duas vezes.
//
// A dedup PRESERVA a versão já em tela (não sobrescreve com a recém-chegada) porque as
// linhas visíveis carregam edições otimistas ainda em voo — curadoria NF/Boleto, troca
// de situação. Sobrescrever faria a marcação do usuário "piscar" de volta ao valor
// antigo se a página nova tiver sido lida antes do commit no banco.

/** Registro paginável — precisa de uma chave estável (a PK da tabela). */
interface HasId {
  id: number;
}

/**
 * Acrescenta uma página à lista acumulada, descartando registros já presentes.
 *
 * @param current Linhas já carregadas (mantidas como estão, na ordem atual).
 * @param page Página recém-chegada do servidor.
 * @returns Nova lista; a referência de `current` é preservada quando nada é acrescentado
 *          (evita re-render inútil do grid virtualizado).
 *
 * @example
 * appendUniqueById([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]); // [{id:1},{id:2},{id:3}]
 */
export function appendUniqueById<T extends HasId>(current: T[], page: T[]): T[] {
  if (page.length === 0) return current;
  const seen = new Set(current.map((r) => r.id));
  // O `seen.add` cobre também a duplicata DENTRO da própria página — filtrar só contra
  // `current` deixaria passar dois registros de mesmo id vindos na mesma resposta.
  const novos = page.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if (novos.length === 0) return current;
  return [...current, ...novos];
}
