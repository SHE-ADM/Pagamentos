// src/pages/Erros.test.tsx
//
// A7-4 (pendência aberta desde o review de 2026-07-08): a página só tinha teste de a11y.
//
// O que o axe não cobre e importa aqui: os filtros só valem ao clicar em "Buscar" (aplicar a
// cada tecla recarregaria a lista a cada caractere), a linha abre o detalhe, e uma falha de rede
// vira mensagem em vez de tela vazia — numa página cujo propósito é justamente diagnosticar
// falhas, "não apareceu nada" é ambíguo entre "sem erros" e "a busca quebrou".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ProcessingError } from '@sheild/shared';

const getProcessingErrors = vi.fn();
const getProcessingErrorStats = vi.fn();

vi.mock('../services/supabase', () => ({
  getProcessingErrors: (...a: unknown[]) => getProcessingErrors(...a),
  getProcessingErrorStats: (...a: unknown[]) => getProcessingErrorStats(...a),
}));

import Erros from './Erros';

const LINHA: ProcessingError = {
  id: 1,
  logged_at: '2026-07-30T10:00:00Z',
  gmail_message_id: '<a@b>',
  sender_name: 'Transportadora X',
  sender_email: 'nf@transportes.com.br',
  subject: 'CT-e 12345',
  received_at: '2026-07-30T09:00:00Z',
  source_file: 'nf_CT-e_20260730_dacte.pdf',
  error_type: 'extracao_falhou',
  error_message: 'PDF protegido por senha',
  raw_payload: { detalhe: 'senha nao encontrada' },
};

describe('Erros — página', () => {
  beforeEach(() => {
    getProcessingErrors.mockReset();
    getProcessingErrorStats.mockReset();
    getProcessingErrors.mockResolvedValue({ data: [LINHA], total: 1 });
    getProcessingErrorStats.mockResolvedValue({ total: 1, counts: { extracao_falhou: 1 } });
  });

  it('carrega e mostra o erro registrado', async () => {
    render(<Erros />);
    expect(await screen.findByText('CT-e 12345')).toBeInTheDocument();
    expect(screen.getByText(/PDF protegido por senha/)).toBeInTheDocument();
  });

  it('o filtro só é aplicado ao clicar em Buscar', async () => {
    render(<Erros />);
    await screen.findByText('CT-e 12345');
    getProcessingErrors.mockClear();

    fireEvent.change(screen.getByLabelText(/Filtrar por remetente/i),
      { target: { value: 'transportes' } });
    expect(getProcessingErrors).not.toHaveBeenCalled();   // digitar não recarrega

    fireEvent.click(screen.getByRole('button', { name: /^Buscar$/i }));
    await waitFor(() => expect(getProcessingErrors).toHaveBeenCalledWith(
      expect.objectContaining({ sender: 'transportes', page: 1 })));
  });

  it('filtrar por tipo de erro chega ao serviço', async () => {
    render(<Erros />);
    await screen.findByText('CT-e 12345');
    getProcessingErrors.mockClear();

    fireEvent.change(screen.getByLabelText(/Filtrar por tipo de erro/i),
      { target: { value: 'extracao_falhou' } });
    fireEvent.click(screen.getByRole('button', { name: /^Buscar$/i }));

    await waitFor(() => expect(getProcessingErrors).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'extracao_falhou' })));
  });

  it('clicar na linha abre o detalhe e clicar de novo fecha', async () => {
    render(<Erros />);
    const linha = (await screen.findByText('CT-e 12345')).closest('tr')!;

    // Asserção em texto EXCLUSIVO do painel: `source_file` e `error_message` também aparecem
    // na tabela, então casá-los não provaria que o detalhe abriu.
    expect(screen.queryByText(/Payload bruto/i)).not.toBeInTheDocument();

    fireEvent.click(linha);
    expect(await screen.findByText(/Payload bruto/i)).toBeInTheDocument();
    expect(screen.getByText(/senha nao encontrada/)).toBeInTheDocument();   // só no <pre>

    fireEvent.click(linha);
    await waitFor(() =>
      expect(screen.queryByText(/Payload bruto/i)).not.toBeInTheDocument());
  });

  it('falha de rede vira mensagem — não uma lista vazia silenciosa', async () => {
    getProcessingErrors.mockRejectedValue(new Error('Falha ao consultar o Supabase'));
    render(<Erros />);
    expect(await screen.findByText(/Falha ao consultar o Supabase/)).toBeInTheDocument();
  });
});
