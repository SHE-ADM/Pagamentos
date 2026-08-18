import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AttachmentViewer from './AttachmentViewer';

// Mock do client Supabase — só a API de Storage usada pelo viewer.
const { createSignedUrl } = vi.hoisted(() => ({ createSignedUrl: vi.fn() }));
vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
}));

// Extração da imagem do .docx — mockada aqui (o ZIP de verdade é testado em docxPreview.test).
const { extractLargestDocxImage } = vi.hoisted(() => ({ extractLargestDocxImage: vi.fn() }));
vi.mock('../lib/docxPreview', () => ({ extractLargestDocxImage }));

const criarObjectUrl = vi.fn();
const revogarObjectUrl = vi.fn();

describe('AttachmentViewer', () => {
  beforeEach(() => {
    createSignedUrl.mockReset();
    extractLargestDocxImage.mockReset();
    criarObjectUrl.mockReset();
    revogarObjectUrl.mockReset();
  });

  it('renderiza o iframe com a URL assinada quando o anexo existe', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/boleto.pdf?token=x' }, error: null });
    const { container } = render(<AttachmentViewer sourceFile="boleto X.pdf" onClose={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe('https://sb/sign/boleto.pdf?token=x');
    // SEM sandbox (intencional — NÃO reintroduzir): o viewer de PDF do Chrome não renderiza
    // em iframe sandboxed nem com allow-scripts (ícone de documento quebrado em produção).
    // A proteção que resta é o cross-origin do Storage + referrerPolicy=no-referrer.
    expect(iframe?.hasAttribute('sandbox')).toBe(false);
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  // NÃO REGREDIR: o viewer é usado dentro do painel de detalhe de /consulta, ou seja, dentro de
  // um <tr> cujo onClick alterna a linha — fechar/baixar o anexo fecharia o painel junto.
  // `createPortal` NÃO resolveria: o React propaga o evento pela árvore de COMPONENTES, não pela
  // do DOM, então o clique chegaria ao ancestral mesmo com o dialog no body (testado). Quem
  // contém são os botões/links, que são interativos (um handler no <dialog> viraria S1082).
  it('o clique nos botões NÃO vaza para o ancestral (não alterna a linha do grid)', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/x?token=x' }, error: null });
    const onAncestorClick = vi.fn();
    render(
      <section onClick={onAncestorClick}>
        <AttachmentViewer sourceFile="a.pdf" onClose={vi.fn()} />
      </section>,
    );

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByTitle('Fechar'));
    fireEvent.click(screen.getByTitle('Baixar o PDF'));
    expect(onAncestorClick).not.toHaveBeenCalled();
  });

  it('aceita chave com PASTA (anexo manual) e assina a chave crua', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/x?token=x' }, error: null });
    const key = 'manual/512/20260715T120000Z_a1b2c3d4_Boleto_Julho.pdf';
    const { container } = render(<AttachmentViewer sourceFile={key} onClose={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    // A chave vai INTEIRA ao Storage (a barra é pasta virtual, não separador a tratar).
    expect(createSignedUrl).toHaveBeenCalledWith(key, expect.any(Number));
  });

  it('prop `title` exibe o nome amigável em vez da chave crua', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/x?token=x' }, error: null });
    const key = 'manual/512/20260715T120000Z_a1b2c3d4_Boleto_Julho.pdf';
    const { container } = render(<AttachmentViewer sourceFile={key} title="Boleto Julho.pdf" onClose={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(screen.getByText('Boleto Julho.pdf')).toBeInTheDocument();
    expect(screen.queryByText(key)).not.toBeInTheDocument();
    expect(container.querySelector('iframe')?.getAttribute('title')).toBe('Boleto Julho.pdf');
  });

  it('sem `title`, o cabeçalho mostra a chave (comportamento preservado)', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/x?token=x' }, error: null });
    const { container } = render(<AttachmentViewer sourceFile="nota.pdf" onClose={vi.fn()} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(screen.getByText('nota.pdf')).toBeInTheDocument();
  });

  it('chama onClose ao clicar no botão fechar', async () => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://sb/sign/a.pdf?token=x' }, error: null });
    const onClose = vi.fn();
    const { container } = render(<AttachmentViewer sourceFile="a.pdf" onClose={onClose} />);

    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByTitle('Fechar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mostra mensagem quando o anexo não existe no Storage', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    render(<AttachmentViewer sourceFile="sumiu.pdf" onClose={vi.fn()} />);

    expect(await screen.findByText(/não encontrado no Storage/i)).toBeInTheDocument();
  });

  // ── .docx: o navegador não renderiza o formato, mas o boleto está DENTRO dele ────────────
  // WIRING — o parsing do ZIP tem testes próprios em lib/docxPreview.test.ts (com ZIP real).
  // Aqui o módulo é MOCKADO de propósito: o alvo é provar que o viewer o chama e desenha o
  // resultado, e um ZIP de verdade aqui só acoplaria dois testes ao mesmo detalhe.
  describe('anexo .docx', () => {
    beforeEach(() => {
      createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://sb/sign/boleto.docx?token=x' }, error: null,
      });
      // O contrato é um RESULTADO, não `DocxImage | null`: `failure: null` é o que diz "li o
      // arquivo inteiro e não houve anomalia". Ver o bloco "mensagem" mais abaixo.
      extractLargestDocxImage.mockResolvedValue({
        image: { blob: new Blob(['x']), name: 'word/media/image1.png' },
        failure: null,
      });
      // O viewer baixa os bytes para abrir o ZIP; jsdom não traz `fetch` nem object URLs.
      // `ok`/`status` fazem parte do contrato: o viewer checa o status antes de tratar o corpo
      // como ZIP (ver o caso "HTTP de erro" abaixo).
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }));
      criarObjectUrl.mockReturnValue('blob:fake-1');
      Object.defineProperty(URL, 'createObjectURL', { value: criarObjectUrl, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revogarObjectUrl, configurable: true });
    });

    it('NUNCA usa <iframe> — ele mostraria painel em branco ou baixaria o arquivo', async () => {
      const { container } = render(<AttachmentViewer sourceFile="boleto.docx" onClose={vi.fn()} />);

      // querySelector, e não getByRole: no jsdom o <dialog> fica sem `open` (showModal não
      // existe), então tudo dentro dele conta como oculto para as queries por role — mesmo
      // motivo pelo qual os casos de PDF acima usam querySelector('iframe').
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
      expect(container.querySelector('iframe')).toBeNull();
    });

    it('exibe a imagem embutida quando o .docx tem uma', async () => {
      // Mutante: remover a chamada a `extractLargestDocxImage` do viewer -> não há <img>.
      const { container } = render(<AttachmentViewer sourceFile="boleto.docx" title="Guia TJSP" onClose={vi.fn()} />);

      await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
      const img = container.querySelector('img')!;
      expect(img.getAttribute('src')).toBe('blob:fake-1');
      // Conteúdo, não decoração: precisa de alt descritivo (WCAG 1.1.1).
      expect(img.getAttribute('alt')).toMatch(/Guia TJSP/);
      expect(extractLargestDocxImage).toHaveBeenCalledTimes(1);
    });

    // ── 🔴 A TELA NÃO PODE AFIRMAR UM FATO SOBRE O ARQUIVO QUANDO A FALHA FOI NOSSA ──────────
    // As duas mensagens abaixo mandam o leitor investigar lados OPOSTOS: "sem imagem" acusa o
    // documento; "não foi possível ler" acusa a leitura. Antes de o extrator declarar o motivo,
    // as dez causas possíveis saíam como o mesmo `null` e a primeira mensagem era exibida em
    // todas — inclusive quando o `.docx` estava perfeito e quem falhou foi o teto ou um bug.
    //
    // Mutante: fazer o viewer ignorar `resultado.failure` (ou o extrator devolver sempre
    // `failure: null`) deixa os dois últimos casos VERMELHOS; o primeiro segue verde, que é
    // justamente por que ele sozinho não bastava.

    it('sem imagem E sem anomalia: afirma o fato sobre o ARQUIVO', async () => {
      extractLargestDocxImage.mockResolvedValue({ image: null, failure: null });
      render(<AttachmentViewer sourceFile="so_texto.docx" onClose={vi.fn()} />);

      expect(await screen.findByText(/sem imagem para pré-visualizar/i)).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
    });

    it('falha de LEITURA não vira "documento sem imagem" — e deixa o motivo no console', async () => {
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      extractLargestDocxImage.mockResolvedValue({
        image: null, failure: 'indice-ilegivel', error: new RangeError('x'),
      });
      render(<AttachmentViewer sourceFile="corrompido.docx" onClose={vi.fn()} />);

      expect(await screen.findByText(/não foi possível ler este documento/i)).toBeInTheDocument();
      expect(screen.queryByText(/sem imagem para pré-visualizar/i)).not.toBeInTheDocument();
      // O motivo tem de chegar ao console: é o que separa os dois casos no suporte.
      expect(erro).toHaveBeenCalledWith(
        expect.stringContaining('indice-ilegivel'),
        expect.anything(),
      );
      erro.mockRestore();
    });

    it('anomalia PARCIAL com imagem lida: mostra a imagem e não alarma a tela', async () => {
      // `image` presente + `failure` presente é o índice truncado DEPOIS da mídia. Esconder o
      // que foi lido com sucesso seria trocar um defeito por outro.
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      extractLargestDocxImage.mockResolvedValue({
        image: { blob: new Blob(['x']), name: 'word/media/image1.png' },
        failure: 'zip64-nao-suportado',
      });
      const { container } = render(<AttachmentViewer sourceFile="parcial.docx" onClose={vi.fn()} />);

      await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
      expect(screen.queryByText(/não foi possível ler este documento/i)).not.toBeInTheDocument();
      expect(erro).toHaveBeenCalled(); // registrado mesmo assim, para o log
      erro.mockRestore();
    });

    it('libera o object URL ao desmontar (senão o blob fica retido na aba)', async () => {
      const { container, unmount } = render(<AttachmentViewer sourceFile="boleto.docx" onClose={vi.fn()} />);
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

      unmount();
      expect(revogarObjectUrl).toHaveBeenCalledWith('blob:fake-1');
    });

    it('HTTP de erro no download NÃO é tratado como ZIP, e deixa rastro', async () => {
      // `fetch` NÃO lança em 403/404 — e a signed URL expira em 5 min com o modal aberto. Sem
      // a checagem de `res.ok`, o XML de erro do Storage seguiria como se fosse o .docx, não
      // acharia o EOCD e a tela afirmaria "documento sem imagem": um fato sobre o ARQUIVO,
      // quando o que houve foi falha de download — e sem nada no console para o suporte.
      // Mutante: remover o `if (!res.ok) throw` -> `extractLargestDocxImage` é chamada e o
      // console fica limpo; os dois `expect` abaixo ficam vermelhos.
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('<Error/>').buffer),
      }));

      render(<AttachmentViewer sourceFile="expirou.docx" onClose={vi.fn()} />);

      // Falha de DOWNLOAD é falha de leitura, não ausência de imagem — o arquivo no Storage
      // pode estar íntegro; o que expirou foi a URL assinada.
      expect(await screen.findByText(/não foi possível ler este documento/i)).toBeInTheDocument();
      expect(screen.queryByText(/sem imagem para pré-visualizar/i)).not.toBeInTheDocument();
      expect(extractLargestDocxImage).not.toHaveBeenCalled();
      expect(erro).toHaveBeenCalled();
      erro.mockRestore();
    });

    it('PDF continua no iframe — o desvio é só para .docx', async () => {
      createSignedUrl.mockResolvedValue({
        data: { signedUrl: 'https://sb/sign/a.pdf?token=x' }, error: null,
      });
      const { container } = render(<AttachmentViewer sourceFile="a.pdf" onClose={vi.fn()} />);

      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
      expect(extractLargestDocxImage).not.toHaveBeenCalled();
    });
  });
});
