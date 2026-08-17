// lib/ai-chat/model.ts
// Qual modelo o chat pede à Claude API.
//
// POR QUE UM MÓDULO SÓ PARA UMA CONSTANTE
// Ela morava em `gateway.ts`, que é quem monta o request — parecia o lugar óbvio. Mas o consumidor
// não é só ele: a auditoria de FALHA (`session.ts`) precisa do mesmo valor quando nenhuma chamada
// chegou a responder e não há modelo servido para registrar. E as rotas mockam o gateway inteiro
// para stubar `runChat`, então importar a constante de lá fazia todo teste que exercitasse o caminho
// de erro quebrar com "No CONFIGURED_MODEL export is defined on the mock" — um erro que não tem nada
// a ver com o que o teste estava verificando.
//
// A saída não é ensinar cada mock a reexportar a constante: isso duplicaria o valor no mock, e a
// asserção sobre o payload de auditoria passaria a comparar com uma ficção. Configuração não deve
// ficar refém do mock de um módulo de comportamento — daí o módulo próprio, que ninguém precisa
// mockar.

/**
 * O modelo padrão do projeto. Configurável por env para permitir troca sem deploy de código.
 *
 * ATENÇÃO AO TROCAR: o prompt caching tem um tamanho MÍNIMO de prefixo que varia por modelo e
 * **não é monotônico entre gerações** (512 no Opus 5; 1.024 no Sonnet 5; 4.096 no Opus 4.6 e no
 * Haiku 4.5). Abaixo do mínimo o `cache_control` é ignorado **em silêncio** — sem erro, só a conta
 * subindo.
 *
 * NÃO há número a decorar aqui, e isso é deliberado: o prefixo (system + tools) **cresce a cada
 * tool acrescentada** — medido 3.653 tokens com 6 tools (30/07/2026) e 7.408 com 9 tools
 * (10/08/2026), o que inverteu a conclusão sobre o risco em 11 dias. Valor anotado em comentário
 * envelhece e, pior, dá a impressão de que alguém está conferindo. Quem confere é
 * `warnIfCachingDisabled`, a cada turno. Série histórica em
 * `docs/arquitetura-chat-ia-pagamentos.md` §19.10.
 *
 * É o modelo PEDIDO — o que vai no request. O que a API respondeu ter usado é outra coisa, e é essa
 * que vai para o log (ver `ChatResult.model` e a migration 129).
 *
 * 🔴 **O default espelha o que roda de fato** (dev e Vercel, ambos `claude-sonnet-5` em 15/08/2026).
 * Ele valia `claude-opus-5` enquanto os dois ambientes já rodavam Sonnet — um valor que NENHUM
 * ambiente usava e que, por isso, só entraria em cena por ESQUECIMENTO da env var: exatamente
 * quando ninguém está olhando, e trocando o modelo em silêncio (preço diferente e mínimo de prefixo
 * cacheável diferente — 512 no Opus 5 contra 1.024 no Sonnet 5). Ao trocar o modelo dos ambientes,
 * TROQUE AQUI TAMBÉM: um default que ninguém usa é uma armadilha, não uma rede.
 *
 * ⚠️ Lido do ambiente na carga do módulo. Ambientes ainda podem apontar para modelos diferentes sem
 * nenhum sintoma — o que detecta isso é o modelo SERVIDO no log, não este valor.
 */
export const CONFIGURED_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
