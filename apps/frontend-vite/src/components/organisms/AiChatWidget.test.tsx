import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mocka só a chamada HTTP — o resto (estado da conversa, histórico, lazy do painel) é o que
// está sob teste. `...actual` mantém `AiChatCancelledError` REAL: o widget o usa em `instanceof`,
// e uma classe ausente no mock daria `instanceof undefined`, que LANÇA (mesma armadilha
// documentada no mock do SDK da Anthropic no api-backend).
const askAiChat = vi.fn();
vi.mock('../../services/aiChat', async () => {
  const actual = await vi.importActual<typeof import('../../services/aiChat')>('../../services/aiChat');
  return { ...actual, askAiChat: (...a: unknown[]) => askAiChat(...a) };
});

import AiChatWidget from './AiChatWidget';
import { AiChatCancelledError } from '../../services/aiChat';

const ok = (answer: string, extra: Record<string, unknown> = {}) => ({
  answer,
  tool_calls: [],
  truncated: false,
  ...extra,
});

/** Abre o painel (lazy: espera o chunk montar) e devolve o campo de pergunta. */
async function openPanel(): Promise<HTMLTextAreaElement> {
  await userEvent.click(screen.getByRole('button', { name: /abrir assistente/i }));
  return screen.findByLabelText<HTMLTextAreaElement>('Sua pergunta');
}

async function ask(text: string): Promise<void> {
  const field = await openPanel();
  await userEvent.type(field, text);
  await userEvent.click(screen.getByRole('button', { name: /enviar/i }));
}

/**
 * A conversa passada ao serviço na última chamada, projetada em role/content.
 *
 * O widget entrega as PRÓPRIAS entradas (que carregam `toolCalls`/`truncated` nas respostas) —
 * normalizar é responsabilidade do `buildHistory`, coberta em services/aiChat.test.ts. Aqui
 * interessa QUAIS mensagens foram passadas, não o formato do payload.
 */
function lastConversation(): { role: string; content: string }[] {
  const [, messages] = askAiChat.mock.lastCall as [string, { role: string; content: string }[]];
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

describe('AiChatWidget', () => {
  // Corpo em BLOCO: `mockReset()` devolve o mock, e retorno de função num hook do Vitest é
  // tratado como teardown — o mock seria chamado ao fim do teste (com mockRejectedValue ativo,
  // isso vira rejeição não tratada e o teste falha pelo erro, não pela asserção).
  beforeEach(() => {
    askAiChat.mockReset();
  });

  it('mostra o botão flutuante e o painel só depois do clique', async () => {
    render(<AiChatWidget />);
    expect(screen.queryByText(/assistente de contas a pagar/i)).not.toBeInTheDocument();

    await openPanel();
    expect(screen.getByRole('heading', { name: /assistente de contas a pagar/i })).toBeInTheDocument();
  });

  it('envia a pergunta e renderiza a resposta em markdown', async () => {
    askAiChat.mockResolvedValue(
      ok('| Situação | Valor |\n| --- | --- |\n| vencido | R$ 10,00 |', {
        tool_calls: [{ name: 'resumo_situacao', params: {}, rows: 4 }],
      }),
    );
    render(<AiChatWidget />);
    await ask('como estamos?');

    expect(await screen.findByRole('cell', { name: 'R$ 10,00' })).toBeInTheDocument();
    // Transparência: qual tool rodou e quantas linhas devolveu.
    expect(screen.getByText(/resumo_situacao · 4 linhas/)).toBeInTheDocument();
    // A conversa enviada INCLUI a pergunta atual: quem recorta é o buildHistory do serviço, que
    // descarta a pergunta sem par (é o formato que a rota exige).
    expect(askAiChat.mock.lastCall?.[0]).toBe('como estamos?');
    expect(lastConversation()).toEqual([{ role: 'user', content: 'como estamos?' }]);
  });

  // A 2ª pergunta precisa levar o par (pergunta, resposta) anterior — é o que faz
  // "e os 5 maiores?" ter contexto.
  it('manda o histórico da conversa na segunda pergunta', async () => {
    askAiChat.mockResolvedValue(ok('primeira resposta'));
    render(<AiChatWidget />);
    await ask('pergunta 1');
    await screen.findByText('primeira resposta');

    askAiChat.mockResolvedValue(ok('segunda resposta'));
    await userEvent.type(screen.getByLabelText('Sua pergunta'), 'pergunta 2');
    await userEvent.click(screen.getByRole('button', { name: /enviar/i }));

    await screen.findByText('segunda resposta');
    expect(askAiChat.mock.lastCall?.[0]).toBe('pergunta 2');
    expect(lastConversation()).toEqual([
      { role: 'user', content: 'pergunta 1' },
      { role: 'assistant', content: 'primeira resposta' },
      { role: 'user', content: 'pergunta 2' },
    ]);
  });

  it('avisa quando a resposta pode estar incompleta', async () => {
    askAiChat.mockResolvedValue(ok('parcial', { truncated: true }));
    render(<AiChatWidget />);
    await ask('pergunta longa');
    expect(await screen.findByText(/pode estar incompleta/i)).toBeInTheDocument();
  });

  it('mostra o erro e reenvia a MESMA pergunta no "Tentar novamente", sem duplicá-la', async () => {
    askAiChat.mockRejectedValue(new Error('Muitas requisições. Aguarde um instante.'));
    render(<AiChatWidget />);
    await ask('pergunta que falha');
    expect(await screen.findByText('Muitas requisições. Aguarde um instante.')).toBeInTheDocument();

    askAiChat.mockResolvedValue(ok('agora foi'));
    await userEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));

    await screen.findByText('agora foi');
    expect(screen.getAllByText('pergunta que falha')).toHaveLength(1);
    // No retry a pergunta pendente NÃO entra no histórico (ela não tem par) — senão a rota
    // devolveria 422 por histórico ímpar.
    expect(askAiChat.mock.lastCall?.[0]).toBe('pergunta que falha');
    expect(lastConversation()).toEqual([{ role: 'user', content: 'pergunta que falha' }]);
    expect(screen.queryByText('Muitas requisições. Aguarde um instante.')).not.toBeInTheDocument();
  });

  it('"Nova conversa" limpa as mensagens', async () => {
    askAiChat.mockResolvedValue(ok('resposta'));
    render(<AiChatWidget />);
    await ask('pergunta');
    await screen.findByText('resposta');

    await userEvent.click(screen.getByRole('button', { name: /nova conversa/i }));
    expect(screen.queryByText('resposta')).not.toBeInTheDocument();
    expect(screen.getByText(/pergunte em português/i)).toBeInTheDocument();
  });

  it('a conversa sobrevive a fechar e reabrir o painel', async () => {
    askAiChat.mockResolvedValue(ok('lembro de você'));
    render(<AiChatWidget />);
    await ask('oi');
    await screen.findByText('lembro de você');

    await userEvent.click(screen.getByRole('button', { name: /fechar assistente/i }));
    await waitFor(() => expect(screen.queryByText('lembro de você')).not.toBeInTheDocument());

    await openPanel();
    expect(await screen.findByText('lembro de você')).toBeInTheDocument();
  });

  it('clicar numa sugestão envia direto', async () => {
    askAiChat.mockResolvedValue(ok('resposta da sugestão'));
    render(<AiChatWidget />);
    await openPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Como estamos de contas a pagar?' }));
    expect(await screen.findByText('resposta da sugestão')).toBeInTheDocument();
  });

  it('Enter envia e Shift+Enter apenas quebra a linha', async () => {
    askAiChat.mockResolvedValue(ok('enviada'));
    render(<AiChatWidget />);
    const field = await openPanel();

    await userEvent.type(field, 'linha 1{Shift>}{Enter}{/Shift}linha 2');
    expect(askAiChat).not.toHaveBeenCalled();
    expect(field.value).toBe('linha 1\nlinha 2');

    await userEvent.type(field, '{Enter}');
    await screen.findByText('enviada');
    expect(askAiChat.mock.lastCall?.[0]).toBe('linha 1\nlinha 2');
    expect(lastConversation()).toEqual([{ role: 'user', content: 'linha 1\nlinha 2' }]);
  });

  // Achado do code review (não regredir). Uma requisição leva dezenas de segundos: a janela para
  // clicar em "Nova conversa" antes da resposta chegar é larga. Sem a guarda de geração, o
  // setEntries anexava a resposta a uma conversa VAZIA — balão de resposta sem pergunta, e um
  // histórico começando em `assistant`.
  it('descarta a resposta que chega depois de "Nova conversa"', async () => {
    let resolver: ((v: unknown) => void) | undefined;
    askAiChat.mockReturnValue(new Promise((r) => { resolver = r; }));

    render(<AiChatWidget />);
    await ask('pergunta abandonada');
    expect(screen.getByText('pergunta abandonada')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /nova conversa/i }));
    expect(screen.queryByText('pergunta abandonada')).not.toBeInTheDocument();

    // A resposta da conversa antiga chega AGORA.
    resolver?.(ok('resposta da conversa antiga'));
    await waitFor(() =>
      expect(screen.getByText(/pergunte em português/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('resposta da conversa antiga')).not.toBeInTheDocument();
    // …e o "Consultando…" precisa sair, senão o painel fica preso no estado de carregamento.
    expect(screen.queryByText(/consultando os dados/i)).not.toBeInTheDocument();
  });

  // A exclusão mútua entre envios é ESTRUTURAL: enquanto a requisição está em voo o painel
  // desabilita campo, botão de envio e "Tentar novamente", e nem renderiza as sugestões. É por isso
  // que o widget não carrega trava de reentrância — não haveria caminho que a exercitasse.
  it('trava os controles enquanto a requisição está em voo', async () => {
    askAiChat.mockReturnValue(new Promise(() => { /* nunca resolve */ }));

    render(<AiChatWidget />);
    await ask('pergunta longa');

    expect(await screen.findByText(/consultando os dados/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Sua pergunta')).toBeDisabled();
    expect(screen.getByRole('button', { name: /enviar/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Como estamos de contas a pagar?' })).not.toBeInTheDocument();
    expect(askAiChat).toHaveBeenCalledTimes(1);
  });

  /**
   * Os DOIS caminhos de fechamento do painel dependem de fiação não-óbvia — um listener NATIVO de
   * clique (para não pôr `onClick` no `<dialog>`, que é o smell S1082) e o evento `cancel` do
   * elemento (o Esc). Nenhum dos dois aparece em outro teste, então um refactor podia quebrar
   * "fechar o chat" sem nada ficar vermelho.
   */
  it.each([
    ['Esc (evento cancel do <dialog>)', (d: HTMLDialogElement) => fireEvent(d, new Event('cancel'))],
    ['clique no backdrop (alvo é o próprio dialog)', (d: HTMLDialogElement) => fireEvent.click(d)],
  ])('fecha o painel: %s', async (_label, fechar) => {
    render(<AiChatWidget />);
    await openPanel();
    const dialog = document.querySelector('dialog');
    expect(dialog).not.toBeNull();

    fechar(dialog as HTMLDialogElement);

    await waitFor(() =>
      expect(screen.queryByLabelText('Sua pergunta')).not.toBeInTheDocument(),
    );
  });

  // O listener de backdrop compara `e.target === dialog`: clique DENTRO do conteúdo não fecha —
  // senão escolher uma sugestão ou clicar no texto da conversa fecharia o assistente.
  it('clique no conteúdo do painel NÃO fecha', async () => {
    render(<AiChatWidget />);
    const field = await openPanel();

    await userEvent.click(field);

    expect(screen.getByLabelText('Sua pergunta')).toBeInTheDocument();
  });

  /**
   * "Parar" tem de ABORTAR de verdade — é o que faz o gateway sair do loop e parar de gastar
   * tokens. O mock rejeita SÓ quando o signal aborta: se o widget não repassasse o signal, a
   * promessa nunca resolveria e o teste estouraria por timeout em vez de passar por acidente.
   */
  it('"Parar" aborta a requisição e trata cancelamento como AVISO, não erro', async () => {
    askAiChat.mockImplementation(
      (_q: string, _m: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AiChatCancelledError()));
        }),
    );

    render(<AiChatWidget />);
    await ask('pergunta demorada');
    expect(await screen.findByText(/consultando os dados/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /parar/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent('Consulta cancelada.');
    // Info, não erro: pintar de vermelho o que o usuário pediu seria culpá-lo pela própria ação.
    expect(aviso.className).toContain('status-info');
    expect(aviso.className).not.toContain('status-error');
    // A pergunta continua na conversa, e o retry parte dela.
    expect(screen.getByText('pergunta demorada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeEnabled();
    expect(screen.queryByText(/consultando os dados/i)).not.toBeInTheDocument();
  });

  // "Nova conversa" com requisição em voo também aborta: sem isto o servidor seguiria pagando o
  // loop até o fim de uma resposta que a guarda de geração já ia descartar.
  it('"Nova conversa" aborta a requisição em voo', async () => {
    const signals: AbortSignal[] = [];
    askAiChat.mockImplementation((_q: string, _m: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new AiChatCancelledError()));
      });
    });

    render(<AiChatWidget />);
    await ask('pergunta abandonada');
    await userEvent.click(screen.getByRole('button', { name: /nova conversa/i }));

    expect(signals[0].aborted).toBe(true);
    // Conversa nova e limpa: o cancelamento da conversa ANTIGA não deixa aviso na nova.
    expect(await screen.findByText(/pergunte em português/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
