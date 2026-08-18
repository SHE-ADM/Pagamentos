// Testes de docxPreview — leitura do ZIP do .docx no navegador.
//
// A fixture é um ZIP REAL montado byte a byte aqui (central directory incluído): um mock de
// `listEntries` provaria só que o resto do código funciona com a resposta que eu inventei, e o
// risco desta feature está justamente no parsing do formato.
import { describe, it, expect } from 'vitest';
import {
  extractLargestDocxImage,
  DOCX_MAX_BYTES,
  DOCX_MAX_ENTRIES,
  DOCX_MAX_IMAGE_BYTES,
} from './docxPreview';

// ── Construtor de ZIP mínimo (stored ou deflate) ───────────────────────────────

interface Arquivo {
  name: string;
  data: Uint8Array<ArrayBuffer>;
  /** true = grava comprimido (deflate-raw), como o Word faz. */
  deflate?: boolean;
  /** Sabota o tamanho declarado no índice — para os testes de teto mentiroso. */
  fakeUncompressedSize?: number;
  /**
   * Pula o CRC (grava 0) — só para as entradas de MUITOS MB dos testes de teto, onde o laço
   * byte a byte custaria dezenas de milhões de iterações. `docxPreview` não valida CRC, então
   * isso não enfraquece nenhuma asserção; economiza segundos de suíte.
   */
  skipCrc?: boolean;
  /**
   * Sobrescreve o método declarado, sem mexer nos bytes gravados. Serve para dois cenários que
   * não dá para produzir de outro jeito: método que o leitor não implementa (AES = 99) e
   * "diz que é deflate mas o fluxo é lixo".
   */
  metodoDeclarado?: number;
  /** Marca os tamanhos com 0xFFFFFFFF no central directory, como faz o zip64. */
  zip64?: boolean;
}

const crc32 = (() => {
  const tabela = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = tabela[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

// Mesma razão do lado de produção: `Blob.stream()` não existe no jsdom, então a fonte é um
// ReadableStream construído à mão e o resultado é lido com um reader.
async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const fonte = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const leitor = fonte.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    total += value.byteLength;
  }
  const saida = new Uint8Array(total);
  let p = 0;
  for (const parte of partes) {
    saida.set(parte, p);
    p += parte.byteLength;
  }
  return saida;
}

async function buildZip(arquivos: Arquivo[]): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let offset = 0;

  for (const f of arquivos) {
    const nome = enc.encode(f.name);
    const bruto = f.data;
    const corpo = f.deflate ? await deflateRaw(bruto) : bruto;
    const metodo = f.metodoDeclarado ?? (f.deflate ? 8 : 0);
    const declarado = f.fakeUncompressedSize ?? bruto.byteLength;
    const soma = f.skipCrc ? 0 : crc32(bruto);

    const local = new Uint8Array(30 + nome.length + corpo.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, metodo, true);
    lv.setUint32(14, soma, true);
    lv.setUint32(18, corpo.length, true);
    lv.setUint32(22, declarado, true);
    lv.setUint16(26, nome.length, true);
    local.set(nome, 30);
    local.set(corpo, 30 + nome.length);
    locais.push(local);

    const central = new Uint8Array(46 + nome.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, metodo, true);
    cv.setUint32(16, soma, true);
    cv.setUint32(20, f.zip64 ? 0xffffffff : corpo.length, true);
    cv.setUint32(24, f.zip64 ? 0xffffffff : declarado, true);
    cv.setUint16(28, nome.length, true);
    cv.setUint32(42, offset, true);
    central.set(nome, 46);
    centrais.push(central);

    offset += local.length;
  }

  const tamCentral = centrais.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, arquivos.length, true);
  ev.setUint16(10, arquivos.length, true);
  ev.setUint32(12, tamCentral, true);
  ev.setUint32(16, offset, true);

  const total = offset + tamCentral + eocd.length;
  const saida = new Uint8Array(total);
  let p = 0;
  for (const b of [...locais, ...centrais, eocd]) {
    saida.set(b, p);
    p += b.length;
  }
  return saida.buffer;
}

const png = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47], 0);
  b.fill(0x41, 4); // conteúdo compressível, para o caso deflate valer alguma coisa
  return b;
};
const doc = (): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode('<w:document><w:body/></w:document>');

/** Infla o `nameLen` da 1ª entrada do central directory além do fim do buffer. */
function corrompeNameLen(zip: ArrayBuffer, offsetCentral: number): ArrayBuffer {
  new DataView(zip).setUint16(offsetCentral + 28, 60_000, true);
  return zip;
}

// ── Testes ────────────────────────────────────────────────────────────────────

describe('extractLargestDocxImage', () => {
  it('extrai a imagem embutida (stored)', async () => {
    const zip = await buildZip([
      { name: 'word/document.xml', data: doc() },
      { name: 'word/media/image1.png', data: png(5_000) },
    ]);
    const r = await extractLargestDocxImage(zip);

    expect(r.image).not.toBeNull();
    expect(r.image?.name).toBe('word/media/image1.png');
    expect(r.image?.blob.type).toBe('image/png');
    expect(r.image?.blob.size).toBe(5_000);
    // Leitura limpa não inventa anomalia — senão a UI alarmaria no caminho feliz.
    expect(r.failure).toBeNull();
  });

  it('extrai a imagem COMPRIMIDA — o caso do Word de verdade', async () => {
    // O mutante que remove o ramo `deflate-raw` deixa este caso vermelho; o de cima, não.
    const zip = await buildZip([
      { name: 'word/document.xml', data: doc(), deflate: true },
      { name: 'word/media/image1.png', data: png(9_000), deflate: true },
    ]);
    const r = await extractLargestDocxImage(zip);

    expect(r.image?.blob.size).toBe(9_000);
    expect(r.failure).toBeNull();
  });

  it('escolhe a MAIOR imagem, não a primeira', async () => {
    const zip = await buildZip([
      { name: 'word/media/image1.png', data: png(2_000) }, // logo
      { name: 'word/media/image2.png', data: png(40_000) }, // o boleto
      { name: 'word/media/image3.png', data: png(3_000) },
    ]);
    const r = await extractLargestDocxImage(zip);

    expect(r.image?.name).toBe('word/media/image2.png');
    expect(r.image?.blob.size).toBe(40_000);
  });

  it('preserva a extensão no mime do Blob', async () => {
    const zip = await buildZip([{ name: 'word/media/foto.jpg', data: png(1_000) }]);
    expect((await extractLargestDocxImage(zip)).image?.blob.type).toBe('image/jpeg');
  });

  it('ignora formato que o navegador não exibe (.emf)', async () => {
    const zip = await buildZip([{ name: 'word/media/desenho.emf', data: png(50_000) }]);
    const r = await extractLargestDocxImage(zip);
    expect(r.image).toBeNull();
    // Sem anomalia: não há imagem EXIBÍVEL, e isso é um fato sobre o arquivo.
    expect(r.failure).toBeNull();
  });

  it('ignora entrada de mídia com BARRA no nome (path traversal)', async () => {
    // `[^/]+` no padrão: `../../evil.png` não casa e a entrada nem é lida.
    const zip = await buildZip([{ name: 'word/media/../../evil.png', data: png(9_000) }]);
    const r = await extractLargestDocxImage(zip);
    expect(r.image).toBeNull();
    expect(r.failure).toBeNull();
  });

  // ── 🔴 O invariante desta camada: "não há imagem" ≠ "não deu para ler" ────────────────────

  describe('distingue ausência de imagem de falha de leitura', () => {
    // Este bloco é a razão de a função devolver um RESULTADO em vez de `DocxImage | null`.
    // Antes, as duas situações saíam idênticas (`null`) e a tela afirmava "documento sem
    // imagem" — um fato sobre o ARQUIVO — quando o que havia acontecido era recusa por teto,
    // índice corrompido ou bug nosso.
    //
    // Mutante: fazer `extractLargestDocxImage` devolver sempre `failure: null` deixa VERMELHO
    // todo o bloco menos o primeiro caso. Colapsar tudo em `failure: 'erro-inesperado'` deixa
    // vermelho o primeiro e o último.

    it('.docx sem imagem nenhuma: image null E failure null — o ÚNICO caso que autoriza a tela a dizer "sem imagem"', async () => {
      const zip = await buildZip([{ name: 'word/document.xml', data: doc() }]);
      const r = await extractLargestDocxImage(zip);

      expect(r.image).toBeNull();
      expect(r.failure).toBeNull();
      expect(r.error).toBeUndefined();
    });

    it('bytes que não são um ZIP: `nao-e-zip` (o corpo de erro do Storage cai aqui)', async () => {
      const r = await extractLargestDocxImage(new TextEncoder().encode('%PDF-1.4').buffer);
      expect(r.image).toBeNull();
      expect(r.failure).toBe('nao-e-zip');
    });

    it('ZIP truncado: `nao-e-zip` — sem EOCD não há índice para ler', async () => {
      const zip = await buildZip([{ name: 'word/media/image1.png', data: png(5_000) }]);
      const r = await extractLargestDocxImage(zip.slice(0, 40));
      expect(r.image).toBeNull();
      expect(r.failure).toBe('nao-e-zip');
    });

    it('índice corrompido: `indice-ilegivel` E o erro original preservado', async () => {
      // `nameLen` além do buffer faz `new Uint8Array(buf, p+46, nameLen)` lançar RangeError.
      // Era exatamente este caminho que saía como `null` mudo antes da correção.
      const zip = await buildZip([{ name: 'word/media/image1.png', data: png(5_000) }]);
      const offsetCentral = 30 + 'word/media/image1.png'.length + 5_000;
      const r = await extractLargestDocxImage(corrompeNameLen(zip, offsetCentral));

      expect(r.image).toBeNull();
      expect(r.failure).toBe('indice-ilegivel');
      // Sem o erro original, um bug futuro chegaria ao log sem nada acionável.
      //
      // ⚠️ `toBeInstanceOf(RangeError)` FALHA aqui, e não é o código que está errado: o módulo
      // roda no realm do jsdom e o teste compara com o `RangeError` do realm do Node — são
      // construtores distintos para a mesma classe. Mesma família da lição já registrada no
      // projeto sobre `instanceof` no chat de IA: identidade de classe é frágil em fronteira de
      // contexto; asserir a FORMA é o que sobrevive.
      expect(r.error).toMatchObject({ name: 'RangeError' });
    });

    it('fluxo deflate corrompido: `entrada-ilegivel`, não `erro-inesperado`', async () => {
      // Declara method=8 sobre bytes que não são um fluxo deflate válido.
      const zip = await buildZip([
        { name: 'word/media/image1.png', data: new Uint8Array(500), metodoDeclarado: 8 },
      ]);
      const r = await extractLargestDocxImage(zip);

      expect(r.image).toBeNull();
      expect(r.failure).toBe('entrada-ilegivel');
    });

    it('método de compressão não implementado: `metodo-nao-suportado` (arquivo válido, leitor limitado)', async () => {
      // 99 = AES do WinZip. "Conserte o arquivo" seria a orientação errada aqui.
      const zip = await buildZip([
        { name: 'word/media/image1.png', data: png(1_000), metodoDeclarado: 99 },
      ]);
      const r = await extractLargestDocxImage(zip);

      expect(r.image).toBeNull();
      expect(r.failure).toBe('metodo-nao-suportado');
    });

    it('entrada zip64: `zip64-nao-suportado` — não é corrupção nem ausência', async () => {
      const zip = await buildZip([
        { name: 'word/media/image1.png', data: png(1_000), zip64: true },
      ]);
      const r = await extractLargestDocxImage(zip);

      expect(r.image).toBeNull();
      expect(r.failure).toBe('zip64-nao-suportado');
    });

    it('NENHUMA corrupção de dado produz `erro-inesperado` — ele significa BUG, e só', async () => {
      // A sanidade que dá sentido ao motivo: se qualquer entrada hostil o produzisse, ele
      // deixaria de distinguir "dado ruim" de "defeito nosso" e o valor diagnóstico sumiria.
      const zipOk = await buildZip([{ name: 'word/media/image1.png', data: png(5_000) }]);
      const offsetCentral = 30 + 'word/media/image1.png'.length + 5_000;
      const hostis: ArrayBuffer[] = [
        new TextEncoder().encode('%PDF-1.4').buffer,
        zipOk.slice(0, 40),
        corrompeNameLen(await buildZip([{ name: 'word/media/image1.png', data: png(5_000) }]), offsetCentral),
        await buildZip([{ name: 'word/media/image1.png', data: new Uint8Array(500), metodoDeclarado: 8 }]),
        await buildZip([{ name: 'word/media/image1.png', data: png(1_000), metodoDeclarado: 99 }]),
        await buildZip([{ name: 'word/media/image1.png', data: png(1_000), zip64: true }]),
        new ArrayBuffer(0),
      ];

      const motivos = await Promise.all(
        hostis.map(async (b) => (await extractLargestDocxImage(b)).failure),
      );
      expect(motivos).not.toContain('erro-inesperado');
      // Sanidade do próprio caso: se as fixtures parassem de ser hostis, a asserção acima
      // ficaria verde sem provar nada.
      expect(motivos.filter(Boolean)).toHaveLength(hostis.length);
    });
  });

  // ── Tetos ─────────────────────────────────────────────────────────────────────

  it('recusa imagem acima do teto pelo tamanho DECLARADO, e diz que foi teto', async () => {
    const zip = await buildZip([
      { name: 'word/media/image1.png', data: png(1_000),
        fakeUncompressedSize: DOCX_MAX_IMAGE_BYTES + 1 },
    ]);
    const r = await extractLargestDocxImage(zip);

    expect(r.image).toBeNull();
    // 🔴 Recusa NOSSA, não ausência: o arquivo tem a imagem, nós é que dissemos não.
    expect(r.failure).toBe('imagem-grande');
  });

  // Este e os próximos dois alocam dezenas de MB de propósito: os tetos que eles travam só
  // existem acima de MB, e o `skipCrc` da fixture é o que mantém o custo em memcpy em vez de
  // num laço byte a byte.

  it('recusa o .docx inteiro acima do teto de arquivo', async () => {
    // ⚠️ O ZIP tem de ser VÁLIDO e a mídia REAL: um buffer de zeros de 26 MB ficaria verde sem
    // a guarda (findEocd não acharia assinatura nenhuma e devolveria `nao-e-zip` assim mesmo),
    // o que é a armadilha do `0 === 0`. Aqui o mutante que remove o `> DOCX_MAX_BYTES` devolve
    // a imagem e o caso fica VERMELHO.
    const enchimento = new Uint8Array(DOCX_MAX_BYTES);
    const zip = await buildZip([
      { name: 'word/media/image1.png', data: png(5_000) },
      { name: 'docProps/thumbnail.bin', data: enchimento, skipCrc: true },
    ]);

    expect(zip.byteLength).toBeGreaterThan(DOCX_MAX_BYTES); // sanidade: a fixture excede o teto
    const r = await extractLargestDocxImage(zip);
    expect(r.image).toBeNull();
    expect(r.failure).toBe('arquivo-grande');
  });

  it('recusa mídia STORED grande que MENTE o tamanho no índice', async () => {
    // O filtro de `extractLargestDocxImage` lê o tamanho DECLARADO; só o teto aplicado sobre os
    // bytes reais, dentro de readEntry, barra este caso. Mutante: voltar o ramo STORED a
    // devolver `raw` -> entrega um Blob acima do teto de imagem e o caso fica vermelho.
    const gorda = png(DOCX_MAX_IMAGE_BYTES + 1_000);
    const zip = await buildZip([
      { name: 'word/media/image1.png', data: gorda, skipCrc: true, fakeUncompressedSize: 1_000 },
    ]);
    const r = await extractLargestDocxImage(zip);

    expect(r.image).toBeNull();
    expect(r.failure).toBe('imagem-grande');
  });

  it('recusa ZIP com entradas demais', async () => {
    // Teto de entradas: o EOCD declara mais do que DOCX_MAX_ENTRIES.
    const zip = await buildZip([{ name: 'word/media/image1.png', data: png(1_000) }]);
    const view = new DataView(zip);
    const eocd = zip.byteLength - 22;
    view.setUint16(eocd + 10, DOCX_MAX_ENTRIES + 1, true);
    const r = await extractLargestDocxImage(zip);

    expect(r.image).toBeNull();
    expect(r.failure).toBe('entradas-demais');
  });
});
