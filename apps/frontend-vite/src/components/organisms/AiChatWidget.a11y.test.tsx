import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '../../../tests/axe';

const askAiChat = vi.fn();
vi.mock('../../services/aiChat', async () => {
  const actual = await vi.importActual<typeof import('../../services/aiChat')>('../../services/aiChat');
  return { ...actual, askAiChat: (...a: unknown[]) => askAiChat(...a) };
});

import AiChatWidget from './AiChatWidget';

describe('AiChatWidget — acessibilidade (WCAG AA)', () => {
  // Corpo em bloco — `mockReset()` devolve o mock e o Vitest usaria o retorno como teardown.
  beforeEach(() => {
    askAiChat.mockReset();
  });

  it('fechado (só o botão flutuante) não tem violações', async () => {
    const { container } = render(<AiChatWidget />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('aberto, com conversa e tabela na resposta, não tem violações', async () => {
    askAiChat.mockResolvedValue({
      answer: '**Resumo**\n\n| Situação | Valor |\n| --- | --- |\n| vencido | R$ 10,00 |',
      tool_calls: [{ name: 'resumo_situacao', params: {}, rows: 4 }],
      truncated: true,
    });
    const { container } = render(<AiChatWidget />);

    await userEvent.click(screen.getByRole('button', { name: /abrir assistente/i }));
    const field = await screen.findByLabelText('Sua pergunta');
    await userEvent.type(field, 'como estamos?');
    await userEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await screen.findByRole('cell', { name: 'R$ 10,00' });

    expect(await axe(container)).toHaveNoViolations();
  });

  // O <dialog> nativo dá role/aria-modal/trap de foco; o que falta é o NOME acessível.
  it('o <dialog> tem nome acessível ligado ao título', async () => {
    const { container } = render(<AiChatWidget />);
    await userEvent.click(screen.getByRole('button', { name: /abrir assistente/i }));
    await screen.findByLabelText('Sua pergunta');

    const dialog = container.querySelector('dialog');
    const labelId = dialog?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(labelId ?? '')}`)?.textContent).toContain(
      'Assistente de contas a pagar',
    );
  });
});
