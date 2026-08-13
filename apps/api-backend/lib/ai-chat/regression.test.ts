// lib/ai-chat/regression.test.ts
// BATERIA DE REGRESSÃO DE PERGUNTAS — item 1.4 da Onda 1 (Fase 4 do roadmap do chat).
//
// O QUE ESTA SUÍTE PROTEGE
// Cada pergunta sugerida no painel é um CONTRATO: o usuário clica confiando que ela responde. Se
// uma mudança de schema, de tool ou de prompt quebrar a cobertura, isto falha ANTES de o usuário
// descobrir clicando.
//
// POR QUE ELA NÃO CHAMA A CLAUDE API
// A resposta do modelo é não-determinística e paga. O que dá para travar de forma determinística é
// o que está sob nosso controle: (a) a pergunta tem alguma tool capaz de respondê-la; (b) os
// parâmetros que o modelo produziria são aceitos pela camada de validação; (c) o dicionário do
// prompt cobre os conceitos que a pergunta usa. A resposta em si é verificada na validação manual
// em produção (§20.9 do doc de arquitetura).
//
// ⚠️ ASSERÇÃO NUNCA É NÚMERO ABSOLUTO (achado da Fase 1, registrado no roadmap §3): o pipeline roda
// a cada 5 min e o batch de vencidos 1×/dia, então qualquer literal de contagem ou valor reprovaria
// no dia seguinte sem defeito nenhum — e o ruído treinaria a equipe a ignorar a bateria.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, parseToolInput, type ToolName } from './tools';

/**
 * As perguntas do painel (`AiChatPanel.tsx`) e a tool que cada uma exercita.
 *
 * A duplicação do texto entre este arquivo e o componente é DELIBERADA: são apps distintos
 * (`api-backend` e `frontend-vite`), sem dependência entre si, e criar um pacote compartilhado só
 * para 18 strings acoplaria as duas camadas por um ganho pequeno. O que importa é que toda
 * pergunta sugerida tenha cobertura — e é isso que esta lista trava.
 */
type Params = Record<string, unknown>;

/**
 * `params` aceita UMA chamada ou uma LISTA delas.
 *
 * A lista existe para as perguntas que nenhuma tool resolve numa chamada só (comparar as três
 * empresas, hoje). Antes desta mudança essas perguntas eram registradas com uma chamada
 * arbitrária, o que fazia a bateria afirmar uma cobertura que não existe — foi assim que
 * `sk_company: 2` acabou documentando "compare as três empresas".
 */
const PERGUNTAS: ReadonlyArray<{
  pergunta: string;
  tool: ToolName;
  params: Params | ReadonlyArray<Params>;
}> = [
  // ---- Panorama ----
  {
    pergunta: 'Como estamos de contas a pagar?',
    tool: 'resumo_situacao',
    params: {},
  },
  {
    pergunta: 'Quanto vence nos próximos 7 dias?',
    tool: 'listar_contas',
    params: { date_from: '2026-07-31', date_to: '2026-08-07' },
  },
  {
    pergunta: 'Qual a distribuição das contas vencidas por faixa de atraso?',
    tool: 'aging_vencidos',
    params: { group_by: 'faixa' },
  },
  {
    // CORRIGIDO em 2026-08-12. Estava fixada em `gasto_por_fornecedor`, que NÃO tem filtro de
    // situação e portanto não consegue restringir a vencidos: o oráculo diferencial rodado no
    // banco devolveu 1 fornecedor por `aging_vencidos` contra 5 não-vencidos pela tool antiga —
    // interseção ZERO. Em produção o modelo já escolhia `aging_vencidos` (ai_chat_log ids 2 e 4):
    // ele acertava e a bateria é que documentava o mapeamento errado, verde, porque só verificava
    // que os parâmetros parseavam. Ver a guarda `tool com recorte de situação` abaixo.
    pergunta: 'Quais os 5 maiores fornecedores com contas vencidas?',
    tool: 'aging_vencidos',
    params: { group_by: 'fornecedor', limit: 5 },
  },

  // ---- Despesas e custos (foco de auditoria 1) ----
  {
    pergunta: 'Mostre o demonstrativo de custos e despesas do mês',
    tool: 'demonstrativo_despesas',
    params: { date_from: '2026-07-01', date_to: '2026-07-31' },
  },
  {
    pergunta: 'Quanto foi despesa fixa e quanto foi variável neste mês?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', group_by: 'tipo' },
  },
  {
    pergunta: 'Quanto gastamos por centro de custo neste mês?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', group_by: 'centro_custo' },
  },
  {
    pergunta: 'Quanto pagamos de tributos no período?',
    tool: 'demonstrativo_despesas',
    params: { date_from: '2026-07-01', date_to: '2026-07-31' },
  },

  // ---- Compliance (o achado mais material: boleto sem NF) ----
  {
    pergunta: 'Quais contas têm boleto mas não têm nota fiscal?',
    tool: 'listar_contas',
    params: {
      date_from: '2020-01-01', date_to: '2030-12-31',
      has_bank_slip: true, has_invoice: false,
    },
  },
  {
    pergunta: 'Quanto pagamos de juros e multa, e por qual fornecedor?',
    tool: 'gasto_por_fornecedor',
    params: { date_from: '2026-01-01', date_to: '2026-12-31' },
  },
  {
    pergunta: 'Quanto capturamos em descontos por antecipação?',
    tool: 'gasto_por_fornecedor',
    params: { date_from: '2026-01-01', date_to: '2026-12-31' },
  },
  {
    pergunta: 'Quais contas estão sem centro de custo ou plano de contas definido?',
    tool: 'gasto_por_classificacao',
    params: { date_from: '2020-01-01', date_to: '2030-12-31', group_by: 'centro_custo' },
  },

  // ---- Evolução ----
  {
    pergunta: 'Como evoluíram os pagamentos mês a mês neste ano?',
    tool: 'gasto_por_periodo',
    params: { date_from: '2026-01-01', date_to: '2026-12-31', date_field: 'pagamento', granularity: 'mes' },
  },
  {
    pergunta: 'Qual a diferença entre o que vence e o que saiu de caixa neste mês?',
    tool: 'gasto_por_periodo',
    params: { date_from: '2026-07-01', date_to: '2026-07-31', date_field: 'pagamento' },
  },
  {
    // CORRIGIDO em 2026-08-12. Estava fixada em `sk_company: 2` — UMA empresa, ou seja não
    // comparava nada, e passava porque um filtro escalar válido parseia perfeitamente.
    //
    // `gasto_por_periodo` não tem eixo de empresa (só o escalar `sk_company`), então a pergunta
    // custa N chamadas — em produção o modelo fez 6 (`ai_chat_log` id 9). Registrar as três
    // chamadas deixa esse custo VISÍVEL na bateria em vez de escondido atrás de um mapeamento
    // que fingia resolver com uma. Uma tool com `group_by: 'empresa'` resolveria em 1 chamada;
    // é decisão da Onda 9, não deste teste.
    pergunta: 'Compare os gastos entre OTIMOTEX TECIDOS, LEBIANCO e OTIMOTEX FARDOS',
    tool: 'gasto_por_periodo',
    params: [
      { date_from: '2026-07-01', date_to: '2026-07-31', sk_company: 1 },
      { date_from: '2026-07-01', date_to: '2026-07-31', sk_company: 2 },
      { date_from: '2026-07-01', date_to: '2026-07-31', sk_company: 3 },
    ],
  },

  // ---- Pontualidade (Onda 9) ----
  {
    pergunta: 'Estamos pagando as contas em dia?',
    tool: 'pontualidade_pagamento',
    params: { group_by: 'geral' },
  },

  // ---- E-mails (Onda 2) ----
  {
    pergunta: 'Em quais e-mails falaram sobre reajuste?',
    tool: 'buscar_emails',
    params: { termo: 'reajuste' },
  },

  // ---- Documentos fiscais (Onda 3) ----
  {
    pergunta: 'Quantos CT-e recebemos neste mês, e de quais transportadoras?',
    tool: 'documentos_fiscais',
    params: { tipo: ['cte'], date_from: '2026-07-01', date_to: '2026-07-31' },
  },

  // ---- Auditoria (Onda 7) ----
  // A pergunta é de VOLUME por autor, então a tool certa é o resumo, não a lista de eventos:
  // a lista é truncada pelo LIMIT e contá-la daria número errado.
  {
    pergunta: 'Quem alterou o valor ou o vencimento das contas neste mês?',
    tool: 'auditoria_resumo',
    params: { group_by: 'usuario', apenas_sensiveis: true, date_from: '2026-08-01', date_to: '2026-08-31' },
  },
];

/** Normaliza `params` para lista — uma pergunta pode custar N chamadas. */
const chamadas = (p: Params | ReadonlyArray<Params>): ReadonlyArray<Params> =>
  Array.isArray(p) ? p : [p as Params];

describe('bateria de regressão — perguntas sugeridas no painel', () => {
  it.each(PERGUNTAS)('"$pergunta" → $tool aceita os parâmetros', ({ tool, params }) => {
    for (const p of chamadas(params)) {
      const r = parseToolInput(tool, p);
      // A mensagem do Zod entra na asserção para o teste dizer O QUE está errado, não só que falhou.
      expect(r.ok ? '' : r.message).toBe('');
      expect(r.ok).toBe(true);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // GUARDA DE CAPACIDADE — o defeito de fundo que esta bateria tinha (achado de 2026-08-12).
  //
  // Verificar que os parâmetros PARSEIAM não verifica que a tool CONSEGUE RESPONDER. Foi essa
  // lacuna que deixou "os 5 maiores fornecedores com contas VENCIDAS" fixada em
  // `gasto_por_fornecedor` — uma tool sem nenhum filtro de situação — com a suíte verde por
  // meses. Um mapeamento impossível é pior que nenhum: ele documenta como correto o que o
  // modelo, em produção, já fazia diferente.
  //
  // A guarda é estrutural: se o TEXTO da pergunta pede um recorte de situação, a tool escolhida
  // precisa ou aceitar `status`, ou ser intrinsecamente restrita àquela situação (é o caso de
  // `aging_vencidos`, que por definição só olha título vencido em aberto). A capacidade é lida
  // do `input_schema` REAL — o mesmo que o modelo enxerga —, nunca de uma lista mantida à mão,
  // que divergiria em silêncio quando a tool mudasse.
  it('pergunta que pede recorte de situação aponta para tool capaz de recortar situação', () => {
    const TERMOS = /\bvencid|\bem aberto\b|\bpag(a|o|as|os)\b|\bcancelad/i;
    // Tools cujo escopo JÁ é a situação pedida — não precisam do parâmetro para respeitá-la.
    const INTRINSECAS = new Set<ToolName>(['aging_vencidos', 'resumo_situacao']);

    const aceitaStatus = (tool: ToolName): boolean => {
      const def = TOOL_DEFINITIONS.find((t) => t.name === tool);
      const props = (def?.input_schema as { properties?: Record<string, unknown> })?.properties;
      return Boolean(props && 'status' in props);
    };

    const impossiveis = PERGUNTAS
      .filter(({ pergunta, tool }) =>
        TERMOS.test(pergunta) && !INTRINSECAS.has(tool) && !aceitaStatus(tool))
      .map(({ pergunta, tool }) => `${pergunta} → ${tool}`);

    expect(impossiveis, 'pergunta com recorte de situação mapeada em tool sem esse filtro')
      .toEqual([]);

    // Sanidade: a guarda só vale se o regex de fato casar alguma pergunta e se a leitura do
    // input_schema estiver funcionando. Sem isto ela viraria "[] === []" — verde para sempre.
    expect(PERGUNTAS.filter((p) => TERMOS.test(p.pergunta)).length).toBeGreaterThan(0);
    expect(aceitaStatus('listar_contas')).toBe(true);
    expect(aceitaStatus('gasto_por_fornecedor')).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // GUARDA ANTI-DUPLA-CONTAGEM (Onda 5, item 5.3).
  //
  // Até a Onda 3 a proteção era ESTRUTURAL: `fiscal_document` não tinha coluna de valor, então
  // não havia como somar documento fiscal com despesa nem por engano. A migration 119 acrescenta
  // `freight_amount` — o frete por conhecimento —, e a barreira passa a ser DECLARADA.
  //
  // Declaração sozinha é frase, não garantia: alguém enxuga o prompt, o modelo deixa de ser
  // avisado e passa a somar o frete decomposto com `gasto_por_periodo`, contando a MESMA despesa
  // duas vezes — sem erro, sem teste vermelho, com um número plausível na tela. Esta guarda é o
  // que transforma a frase em invariante verificável.
  //
  // Lê o gateway REAL (o SYSTEM_PROMPT não é exportado), no mesmo padrão de `log.test.ts` × as
  // migrations e da guarda do painel acima. Ancorado em `import.meta.dirname`.
  it('tool que expõe valor de frete traz a advertência de não somar, na tool E no prompt', () => {
    const fiscal = TOOL_DEFINITIONS.find((t) => t.name === 'documentos_fiscais');
    expect(fiscal, 'documentos_fiscais sumiu do catálogo').toBeTruthy();

    const expoeValor = /frete_rs/.test(fiscal!.description);
    // Sanidade: se a tool deixar de expor valor, a guarda não tem o que proteger — mas ela não
    // pode virar "true === true" em silêncio, então o próprio pressuposto é asseverado.
    expect(expoeValor, 'documentos_fiscais deixou de expor frete_rs — revise esta guarda').toBe(true);

    // (a) a própria descrição da tool proíbe a soma, nomeando as tools com que não se mistura
    expect(fiscal!.description).toMatch(/DECOMPOSIÇÃO/i);
    expect(fiscal!.description).toMatch(/gasto_por_periodo/);
    expect(fiscal!.description).toMatch(/duas vezes|duplicaria/i);

    // (b) o SYSTEM_PROMPT carrega a mesma proibição — é ele que o modelo lê a cada turno
    const gateway = readFileSync(resolve(import.meta.dirname, './gateway.ts'), 'utf8');
    // A crase de fechamento não pode estar escapada: o prompt cita tools em `crase escapada`
    // (\`gasto_por_periodo\`), e um `[\s\S]*?` guloso pararia na primeira delas.
    const prompt = /const SYSTEM_PROMPT = `[\s\S]*?[^\\]`;/.exec(gateway)?.[0];
    expect(prompt, 'SYSTEM_PROMPT não encontrado — o gateway foi reestruturado?').toBeTruthy();
    expect(prompt!.length).toBeGreaterThan(2000);   // sanidade do parser

    expect(prompt).toMatch(/frete_rs/);
    expect(prompt).toMatch(/DECOMPOSIÇÃO/i);
    expect(prompt).toMatch(/nunca\D{0,40}some/i);
    expect(prompt).toMatch(/gasto_por_periodo/);

    // (c) a frase antiga "a ferramenta não devolve valor algum" NÃO pode sobreviver: ela era
    // verdadeira na Onda 3 e virou mentira aqui — e uma mentira no prompt é pior que um silêncio,
    // porque o modelo confia nela e deixa de aplicar a regra de não somar.
    expect(prompt).not.toMatch(/não devolve valor algum/i);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // GUARDA DO NOME E DA COBERTURA — pontualidade (Onda 9).
  //
  // Duas coisas podem se perder aqui em silêncio, e as duas transformam um número certo numa
  // resposta errada:
  //
  //   (a) apresentar o resultado como DPO. DPO é indicador contábil (saldo de contas a pagar ÷
  //       CMV × dias) e exige o passivo da empresa; aqui a base é só o que chegou por e-mail. É
  //       exatamente o erro que a decisão do DRE evitou — número com o nome de outra coisa.
  //   (b) omitir a cobertura. As contas pagas antes do corte carregam a data do BACKFILL da 096
  //       (payment_date = due_date), e incluí-las devolveria "atraso zero" artificial. A tool
  //       exclui e CONTA; se o prompt não mandar declarar, o modelo não declara.
  //
  // A guarda lê a descrição REAL da tool e o SYSTEM_PROMPT real — nunca uma cópia local, que
  // divergiria sem ninguém perceber. Mesmo padrão da guarda anti-dupla-contagem acima.
  it('a tool de pontualidade nega o nome DPO e declara a cobertura, na tool E no prompt', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'pontualidade_pagamento');
    expect(tool, 'pontualidade_pagamento sumiu do catálogo').toBeTruthy();

    // (a) a descrição da tool nega o nome e diz o que fazer no lugar
    expect(tool!.description).toMatch(/NÃO é DPO/i);
    // (b) a descrição nomeia os dois campos de cobertura — sem eles o modelo não tem o que citar
    expect(tool!.description).toMatch(/fora_da_cobertura/);
    expect(tool!.description).toMatch(/excluidas_venc_alterado/);
    // "atraso médio" que embute antecipação seria menor que o atraso real, com nome de atraso
    expect(tool!.description).toMatch(/APENAS as atrasadas/i);

    const gateway = readFileSync(resolve(import.meta.dirname, './gateway.ts'), 'utf8');
    const prompt = /const SYSTEM_PROMPT = `[\s\S]*?[^\\]`;/.exec(gateway)?.[0];
    expect(prompt, 'SYSTEM_PROMPT não encontrado — o gateway foi reestruturado?').toBeTruthy();
    expect(prompt!.length).toBeGreaterThan(2000);   // sanidade do parser

    expect(prompt).toMatch(/pontualidade_pagamento/);
    expect(prompt).toMatch(/NÃO é DPO/i);
    expect(prompt).toMatch(/cobertura_desde/);
    // O modelo precisa saber que campo VAZIO ali não é zero — é "não houve atraso".
    expect(prompt).toMatch(/vazio ali significa/i);
  });

  // Pergunta que compara N entidades não pode ser registrada com UMA chamada filtrando uma só:
  // era exatamente o `sk_company: 2` em "compare as três empresas".
  it('pergunta comparativa entre empresas registra uma chamada por empresa', () => {
    const comparativas = PERGUNTAS.filter((p) => /\bcompare\b/i.test(p.pergunta));
    expect(comparativas.length, 'nenhuma pergunta comparativa na bateria').toBeGreaterThan(0);

    for (const { pergunta, params } of comparativas) {
      const cs = chamadas(params);
      const empresas = new Set(cs.map((c) => c.sk_company).filter((v) => v !== undefined));
      // Ou a chamada não filtra empresa (compara todas de uma vez), ou filtra mais de uma.
      const ok = empresas.size === 0 || empresas.size > 1;
      expect(ok, `${pergunta}: compara empresas mas filtra só ${[...empresas]}`).toBe(true);
    }
  });

  it('toda pergunta aponta para uma tool que existe de fato', () => {
    const existentes = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const { pergunta, tool } of PERGUNTAS) {
      expect(existentes.has(tool), `${pergunta} → ${tool}`).toBe(true);
    }
  });

  // As 3 tools/capacidades que a Onda 1 acrescentou precisam estar REPRESENTADAS. Sem isto, alguém
  // poderia remover o eixo `tipo` ou o demonstrativo e a bateria seguiria verde.
  it('cobre as capacidades novas da Onda 1 (demonstrativo, eixo tipo, filtro de compliance)', () => {
    const usadas = PERGUNTAS.map((p) => p.tool);
    expect(usadas).toContain('demonstrativo_despesas');

    // Varre TODAS as chamadas de cada pergunta — desde 2026-08-12 uma pergunta pode custar N.
    const todasAsChamadas = PERGUNTAS.flatMap((p) => chamadas(p.params));

    const porTipo = todasAsChamadas.some((c) => c.group_by === 'tipo');
    expect(porTipo, 'nenhuma pergunta exercita group_by="tipo"').toBe(true);

    const compliance = todasAsChamadas.some(
      (c) => c.has_bank_slip === true && c.has_invoice === false,
    );
    expect(compliance, 'nenhuma pergunta exercita boleto sem NF').toBe(true);
  });

  // GUARDA CROSS-LAYER — lê o componente REAL do outro app e compara.
  //
  // A versão anterior deste teste só fazia `expect(PERGUNTAS).toHaveLength(16)` e o comentário
  // afirmava que "se alguém acrescentar uma no painel sem cobrir aqui, o número diverge". Era
  // FALSO: contar o array local não observa o painel em nada, e uma sugestão nova entraria sem
  // teste — quebrando em silêncio o invariante de que **sugestão é contrato**.
  //
  // Ler o arquivo (em vez de importar) é deliberado: `api-backend` e `frontend-vite` são apps
  // distintos, sem dependência entre si, e criar um pacote compartilhado para 18 strings acoplaria
  // as duas camadas. O mesmo padrão do `log.test.ts`, que confere o payload contra as migrations.
  // Ancorado em `import.meta.dirname` porque `process.cwd()` muda conforme o vitest é invocado.
  it('cobre TODAS as perguntas oferecidas no painel (sugestão é contrato)', () => {
    const painel = readFileSync(
      resolve(import.meta.dirname, '../../../frontend-vite/src/components/organisms/AiChatPanel.tsx'),
      'utf8',
    );

    // Extrai o bloco de SUGGESTION_GROUPS e, dentro dele, as strings de cada `questions: [...]`.
    const bloco = /const SUGGESTION_GROUPS[\s\S]*?\n\];/.exec(painel)?.[0];
    expect(bloco, 'SUGGESTION_GROUPS não encontrado — o painel foi reestruturado?').toBeTruthy();

    const doPainel = [...bloco!.matchAll(/questions:\s*\[([\s\S]*?)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((s) => s[1]));

    // Sanidade do parser: se ele parar de casar, o teste viraria "0 === 0" e passaria sempre.
    expect(doPainel.length).toBeGreaterThan(10);

    const cobertas = new Set(PERGUNTAS.map((p) => p.pergunta));
    const semCobertura = doPainel.filter((q) => !cobertas.has(q));
    expect(semCobertura, 'perguntas no painel sem cobertura na bateria').toEqual([]);
    expect(PERGUNTAS).toHaveLength(doPainel.length);
  });

  // GUARDA DO FEW-SHOT (Onda 8). Os exemplos de raciocínio no SYSTEM_PROMPT citam tools pelo
  // nome; um nome errado ou de tool removida ensina o modelo a chamar algo que não existe — e o
  // sintoma seria uma tool_result de erro no meio do loop, gastando iteração, sem nada vermelho
  // no CI. Também confere que o exemplo de vencidos ensina a MESMA tool que a bateria fixa,
  // senão prompt e bateria divergem em silêncio.
  it('os exemplos do prompt citam apenas tools existentes e coerentes com a bateria', () => {
    const gateway = readFileSync(resolve(import.meta.dirname, './gateway.ts'), 'utf8');
    const secao = /## Exemplos de raciocínio[\s\S]*?[^\\]`;/.exec(gateway)?.[0];
    expect(secao, 'seção de exemplos não encontrada no SYSTEM_PROMPT').toBeTruthy();

    // Tools citadas como \`nome\` dentro do template literal.
    const citadas = [...secao!.matchAll(/\\`([a-z_]+)\\`/g)].map((m) => m[1]);
    expect(citadas.length, 'sanidade: nenhum nome de tool casou no parser').toBeGreaterThan(3);

    // Nem tudo entre crases é tool: os exemplos também citam COLUNAS do retorno. A lista é
    // explícita (e não um filtro esperto) justamente para que um nome de tool digitado errado
    // continue caindo na asserção em vez de ser absorvido como "deve ser um campo".
    const CAMPOS = new Set(['frete_rs', 'fora_da_cobertura']);
    const existentes = new Set(TOOL_DEFINITIONS.map((t) => t.name as string));
    const inexistentes = [...new Set(citadas)]
      .filter((n) => !CAMPOS.has(n))
      .filter((n) => !existentes.has(n));
    expect(inexistentes, 'exemplo do prompt cita tool que não existe').toEqual([]);

    // Coerência com a bateria: o exemplo de vencidos tem de ensinar a mesma tool registrada.
    const daBateria = PERGUNTAS.find((p) => /vencidas\?$/.test(p.pergunta))?.tool;
    expect(daBateria).toBe('aging_vencidos');
    expect(secao).toMatch(new RegExp(`maiores fornecedores[\\s\\S]{0,120}${daBateria}`));
  });

  it('cobre a busca em e-mails (capacidade nova da Onda 2)', () => {
    expect(PERGUNTAS.map((p) => p.tool)).toContain('buscar_emails');
  });

  it('cobre os documentos fiscais (capacidade nova da Onda 3)', () => {
    expect(PERGUNTAS.map((p) => p.tool)).toContain('documentos_fiscais');
  });

  it('cobre a trilha de auditoria (capacidade nova da Onda 7)', () => {
    expect(PERGUNTAS.map((p) => p.tool)).toContain('auditoria_resumo');
  });

  // O eixo de agrupamento é OBRIGATÓRIO no resumo: sem ele o modelo receberia um erro do banco
  // no meio do loop em vez de uma mensagem que consegue corrigir.
  it('auditoria_resumo exige group_by, e rejeita eixo inventado', () => {
    expect(parseToolInput('auditoria_resumo', {}).ok).toBe(false);
    expect(parseToolInput('auditoria_resumo', { group_by: 'fornecedor' }).ok).toBe(false);
    expect(parseToolInput('auditoria_resumo', { group_by: 'usuario' }).ok).toBe(true);
  });

  // Tabela fora do domínio auditado devolveria VAZIO no banco, e o modelo concluiria "não houve
  // alteração" em vez de "essa tabela não é auditada".
  it('auditoria_eventos aceita só as tabelas realmente auditadas', () => {
    expect(parseToolInput('auditoria_eventos', { tabela: 'email_control' }).ok).toBe(false);
    expect(parseToolInput('auditoria_eventos', { tabela: 'supplier' }).ok).toBe(true);
    expect(parseToolInput('auditoria_eventos', { tabela: 'financial_account_control' }).ok).toBe(true);
  });
});
