// src/lib/docxPreview.ts
// Extrai a MAIOR imagem embutida de um .docx, no próprio navegador — para que o boleto
// enviado como documento do Word tenha pré-visualização em vez de "baixe e abra no Word".
//
// POR QUE ISTO EXISTE
//   Nenhum navegador renderiza .docx nativamente. Medido nos 3 casos reais do projeto (guias
//   do TJSP enviadas por advogado): os documentos têm TEXTO ZERO e uma única imagem PNG — o
//   boleto é uma figura colada. Ou seja, o que o usuário quer ver já está lá dentro, e o
//   caminho mais curto é abrir o ZIP e mostrar a figura.
//
// SEM DEPENDÊNCIA NOVA (nada de JSZip): um .docx é um ZIP, e o navegador já sabe inflar —
// `DecompressionStream('deflate-raw')`. O que falta é ler o índice do ZIP, que são ~80 linhas
// de DataView. O mesmo espírito do `docx_content.py` no pipeline, que é stdlib pura.
//
// 🔴 O CONTEÚDO VEM DE REMETENTE NÃO CONFIÁVEL — as mesmas defesas do lado Python valem aqui:
//   - tetos de tamanho (arquivo, imagem) e de número de entradas, contra zip bomb;
//   - lê SÓ entradas cujo nome casa `word/media/<arquivo>.<ext de imagem>`, com `[^/]+` (nome
//     com barra não casa, então `../../evil.png` nem é considerado);
//   - nada é escrito em lugar nenhum: o resultado é um Blob em memória.
//   A diferença de contexto é que aqui não há filesystem — o pior caso é memória, e é isso
//   que os tetos limitam.
//
// 🔴 "NÃO HÁ IMAGEM" E "NÃO CONSEGUI LER" SÃO RESPOSTAS DIFERENTES — e é por isso que esta
//   função devolve um RESULTADO, não `DocxImage | null`. Devolver `null` para as dez causas
//   possíveis fazia a tela afirmar um FATO SOBRE O ARQUIVO ("documento sem imagem") quando o
//   que houve foi recusa por teto, índice corrompido ou ambiente sem `DecompressionStream` —
//   e, no pior caso, um bug futuro em `listEntries`/`readEntry` ficava 100% mascarado, porque
//   os testes só asseguram "não lança" e "devolve null", exatamente o que o bug produziria.
//   Medido antes desta mudança: das 10 corrupções de ZIP testadas, só 3 chegavam ao `catch`
//   do topo — logar ali não teria resolvido, porque as outras 7 saíam por `return null`
//   defensivos, sem lançar. Quem não declara o motivo não pode ser diagnosticado.

/** Teto do .docx inteiro. Um boleto em Word real tem dezenas de KB. */
export const DOCX_MAX_BYTES = 25 * 1024 * 1024;
/** Teto da imagem extraída (descomprimida). */
export const DOCX_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** ZIP com dezenas de milhares de entradas é ataque, não documento. */
export const DOCX_MAX_ENTRIES = 2_000;

const MEDIA_RE = /^word\/media\/[^/]+\.(png|jpe?g|gif|webp)$/i;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

// Por que não houve imagem. Cada valor responde a uma pergunta DIFERENTE do suporte, e é essa
// distinção que justifica a união literal em vez de um booleano:
//
// - `arquivo-grande` / `entradas-demais` / `imagem-grande` — recusa por TETO nosso. O arquivo
//   pode estar perfeito; fomos nós que dissemos não.
// - `nao-e-zip` — o que baixamos não é um .docx (tipicamente um corpo de erro do Storage).
// - `indice-ilegivel` / `entrada-ilegivel` — é um ZIP, mas está corrompido.
// - `zip64-nao-suportado` / `metodo-nao-suportado` / `sem-decompression-stream` — arquivo (ou
//   navegador) válido, recurso que este leitor não implementa. Não é corrupção, e a diferença
//   importa: "conserte o arquivo" e "atualize o navegador" são orientações opostas.
// - `erro-inesperado` — nenhum caminho previsto. É o BUG, e é o motivo de ele existir.
//
// Exportado para quem um dia mapear motivo -> mensagem; hoje é consumido por inferência a partir
// de `DocxPreviewResult`. O marcador tem de ficar na linha IMEDIATAMENTE anterior ao export —
// um comentário no meio faz o ts-prune ignorá-lo em silêncio (CLAUDE.md, Regra 5).
// ts-prune-ignore-next
export type DocxPreviewFailure =
  | 'arquivo-grande'
  | 'nao-e-zip'
  | 'entradas-demais'
  | 'indice-ilegivel'
  | 'zip64-nao-suportado'
  | 'entrada-ilegivel'
  | 'metodo-nao-suportado'
  | 'sem-decompression-stream'
  | 'imagem-grande'
  | 'erro-inesperado';

// Tipos consumidos por inferência a partir do retorno, nunca importados por nome. Export
// intencional, não órfão (CLAUDE.md, Regra 5). O marcador precisa ficar na linha IMEDIATAMENTE
// anterior ao export, senão o ts-prune o ignora.
// ts-prune-ignore-next
export interface DocxImage {
  blob: Blob;
  /** Nome da entrada dentro do .docx — útil para depuração e para o alt. */
  name: string;
}

// ts-prune-ignore-next
export interface DocxPreviewResult {
  /** A maior imagem embutida, ou `null`. */
  image: DocxImage | null;
  /**
   * 🔴 `null` significa "a leitura terminou SEM anomalia" — ou seja, com `image` nula, que o
   * documento realmente não tem imagem. É a única combinação em que a UI pode afirmar um fato
   * sobre o arquivo.
   *
   * Quando `image` e `failure` vêm juntos, a IMAGEM VENCE: uma anomalia parcial (índice
   * truncado depois da mídia, entrada zip64 ignorada) não é motivo para esconder o que foi
   * lido com sucesso. O campo continua ali para o log.
   */
  failure: DocxPreviewFailure | null;
  /** A exceção original, quando houve. Sem ela, um bug futuro chegaria ao log sem stack. */
  error?: unknown;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

interface ListagemZip {
  entries: ZipEntry[];
  failure: DocxPreviewFailure | null;
  error?: unknown;
}

interface LeituraEntrada {
  bytes: Uint8Array | null;
  failure: DocxPreviewFailure | null;
  error?: unknown;
}

/**
 * Offset do End Of Central Directory, ou -1.
 *
 * Varre de trás para frente porque o EOCD fica no FIM e pode ser seguido de um comentário de
 * até 64 KB — não dá para assumir que são os últimos 22 bytes.
 */
function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - (22 + 0xffff));
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Índice do ZIP lido pelo CENTRAL DIRECTORY, não pelos cabeçalhos locais.
 *
 * O cabeçalho local pode trazer tamanhos ZERADOS quando o gravador usa data descriptor (o Word
 * usa em alguns fluxos) — nesse caso "a maior imagem" seria decidida sobre zeros. O central
 * directory sempre tem os tamanhos definitivos.
 */
function listEntries(buf: ArrayBuffer): ListagemZip {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  if (eocd < 0) return { entries: [], failure: 'nao-e-zip' };

  const total = view.getUint16(eocd + 10, true);
  if (total > DOCX_MAX_ENTRIES) return { entries: [], failure: 'entradas-demais' };
  let p = view.getUint32(eocd + 16, true);

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let zip64Ignorada = false;
  for (let i = 0; i < total; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== SIG_CENTRAL) {
      // Parou antes do fim: o índice promete mais do que entrega. As entradas já lidas seguem
      // válidas (a mídia pode estar entre elas), mas a anomalia é declarada.
      return { entries, failure: 'indice-ilegivel' };
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    // `nameLen` vem do arquivo e pode apontar além do buffer — o construtor do Uint8Array lança
    // RangeError. Classificar aqui (e não deixar subir para o `catch` do topo) é o que separa
    // "ZIP corrompido", que é dado ruim, de `erro-inesperado`, que é bug nosso.
    let name: string;
    try {
      name = decoder.decode(new Uint8Array(buf, p + 46, nameLen));
    } catch (error) {
      return { entries, failure: 'indice-ilegivel', error };
    }
    // Zip64 marca os campos com 0xFFFFFFFF e põe os valores reais no extra field. Um .docx de
    // boleto nunca chega lá; declarar não-suportado é melhor que ler um tamanho falso.
    if (compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff) {
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    } else {
      zip64Ignorada = true;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, failure: zip64Ignorada ? 'zip64-nao-suportado' : null };
}

/** Bytes de uma entrada, inflando quando preciso, com o motivo quando não dá. */
async function readEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<LeituraEntrada> {
  const view = new DataView(buf);
  const at = entry.localOffset;
  if (at + 30 > view.byteLength || view.getUint32(at, true) !== SIG_LOCAL) {
    return { bytes: null, failure: 'entrada-ilegivel' };
  }
  // O cabeçalho LOCAL tem seus próprios comprimentos de nome/extra — não os do central.
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > view.byteLength) return { bytes: null, failure: 'entrada-ilegivel' };

  const raw = new Uint8Array(buf, start, entry.compressedSize);
  // STORED também passa pelo teto, e pelos bytes REAIS: o filtro de `extractLargestDocxImage`
  // usa o `uncompressedSize` DECLARADO no índice, que o arquivo escreve e pode mentir — uma
  // entrada stored de 24 MB declarando 1 KB entregaria o dobro do teto de imagem. Sem esta
  // linha, "tetos de tamanho contra zip bomb" (cabeçalho) valeria só no ramo deflate.
  if (entry.method === METHOD_STORED) {
    return raw.byteLength > DOCX_MAX_IMAGE_BYTES
      ? { bytes: null, failure: 'imagem-grande' }
      : { bytes: raw, failure: null };
  }
  if (entry.method !== METHOD_DEFLATE) return { bytes: null, failure: 'metodo-nao-suportado' };
  if (typeof DecompressionStream === 'undefined') {
    return { bytes: null, failure: 'sem-decompression-stream' };
  }

  // `deflate-raw`: dentro do ZIP o fluxo não tem o envelope zlib.
  //
  // A fonte é um ReadableStream construído à mão, e não `new Blob([...]).stream()`: o segundo
  // é o idiomático no navegador, mas NÃO existe no jsdom — e o caminho deflate é justamente o
  // que o Word usa de verdade, ou seja, o mais importante de manter testável. Ler o resultado
  // com um reader (em vez de `new Response(stream).arrayBuffer()`) mantém a dependência em
  // Streams puro, sem Blob nem Response.
  // O genérico é `Uint8Array<ArrayBuffer>`, não `Uint8Array`: no TS 6 o tipo carrega o buffer
  // de origem, e `DecompressionStream` só aceita o par exato — com `Uint8Array` cru o
  // `pipeThrough` não compila.
  const fonte = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(raw);
      controller.close();
    },
  });
  const leitor = fonte.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  // Fluxo deflate corrompido faz o `read()` REJEITAR. É dado ruim, não bug — classificar aqui
  // mantém `erro-inesperado` significando o que ele promete.
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      // Teto aplicado DURANTE a leitura: esperar o fim para medir seria materializar a bomba
      // inteira na memória antes de recusá-la.
      if (total > DOCX_MAX_IMAGE_BYTES) {
        await leitor.cancel();
        return { bytes: null, failure: 'imagem-grande' };
      }
      partes.push(value);
    }
  } catch (error) {
    return { bytes: null, failure: 'entrada-ilegivel', error };
  }
  // O teto já foi aplicado acima, sobre os bytes REAIS — não sobre o tamanho declarado no
  // índice, que o arquivo escreve e pode mentir (mesma razão do `_read_limited` no Python).
  const inflated = new Uint8Array(total);
  let p = 0;
  for (const parte of partes) {
    inflated.set(parte, p);
    p += parte.byteLength;
  }
  return { bytes: inflated, failure: null };
}

/**
 * A maior imagem embutida do .docx, com o MOTIVO quando não há nenhuma. Nunca lança.
 *
 * "A maior" é a mesma heurística do pipeline: num documento que é um print de boleto, o
 * documento É a imagem grande; logo e assinatura são pequenos.
 *
 * 🔴 Leia o contrato de `DocxPreviewResult.failure` antes de mexer aqui: `failure: null` com
 * `image: null` é a ÚNICA combinação que autoriza a UI a dizer "este documento não tem imagem".
 */
export async function extractLargestDocxImage(buf: ArrayBuffer): Promise<DocxPreviewResult> {
  try {
    if (buf.byteLength > DOCX_MAX_BYTES) return { image: null, failure: 'arquivo-grande' };
    const listagem = listEntries(buf);
    const midias = listagem.entries
      .filter((e) => MEDIA_RE.test(e.name) && e.uncompressedSize <= DOCX_MAX_IMAGE_BYTES)
      .sort((a, b) => b.uncompressedSize - a.uncompressedSize);
    // Havia mídia no índice, mas toda ela acima do teto? Isso é recusa nossa, não ausência.
    const recusadaPorTamanho =
      !midias.length && listagem.entries.some((e) => MEDIA_RE.test(e.name));
    if (!midias.length) {
      return {
        image: null,
        failure: recusadaPorTamanho ? 'imagem-grande' : listagem.failure,
        error: listagem.error,
      };
    }

    const maior = midias[0];
    const leitura = await readEntry(buf, maior);
    if (!leitura.bytes?.byteLength) {
      // `listagem.failure` entra como reserva: sem ele, um índice anômalo que ainda assim
      // apontou uma mídia ilegível perderia metade do diagnóstico.
      return {
        image: null,
        failure: leitura.failure ?? listagem.failure ?? 'entrada-ilegivel',
        error: leitura.error ?? listagem.error,
      };
    }

    const ext = maior.name.split('.').pop()?.toLowerCase() ?? '';
    // `slice()` COPIA os bytes: `bytes` pode ser uma view sobre o ArrayBuffer do .docx inteiro
    // (é o que o ramo STORED devolve), e passá-la direto ao Blob reteria o arquivo todo em
    // memória enquanto a imagem estivesse na tela.
    const copia = leitura.bytes.slice();
    return {
      image: {
        blob: new Blob([copia], { type: MIME_BY_EXT[ext] ?? 'application/octet-stream' }),
        name: maior.name,
      },
      // A imagem VENCE, mas a anomalia do índice continua registrada para o log.
      failure: listagem.failure,
      error: listagem.error,
    };
  } catch (error) {
    // Nenhum caminho previsto chega aqui — os de dado ruim são classificados na origem. Cair
    // neste `catch` significa BUG, e é por isso que ele não devolve mais um `null` mudo: era
    // exatamente essa mudez que fazia um `TypeError` novo em `listEntries`/`readEntry` passar
    // por "documento sem imagem", sem teste vermelho e sem rastro.
    return { image: null, failure: 'erro-inesperado', error };
  }
}
