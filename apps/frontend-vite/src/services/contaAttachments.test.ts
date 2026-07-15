import { describe, it, expect, vi, beforeEach } from 'vitest';

const dataApiCallMock = vi.fn();
vi.mock('./dataApi', () => ({ dataApiCall: (...a: unknown[]) => dataApiCallMock(...a) }));

const uploadToSignedUrlMock = vi.fn();
vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: (...a: unknown[]) => uploadToSignedUrlMock(...a) }) } },
}));

import { uploadContaAttachment, uploadContaAttachments, listContaAttachments, deleteContaAttachment } from './contaAttachments';

const file = (name = 'boleto.pdf'): File => new File(['x'], name, { type: 'application/pdf' });
const AUTH = { storage_key: 'manual/7/ts_rand_boleto.pdf', signed_url: 'https://s.test/u', token: 'tok' };

beforeEach(() => {
  dataApiCallMock.mockReset();
  uploadToSignedUrlMock.mockReset().mockResolvedValue({ error: null });
});

describe('uploadContaAttachment', () => {
  it('faz os 3 passos: autoriza → sobe os bytes → registra', async () => {
    dataApiCallMock
      .mockResolvedValueOnce({ success: true, data: AUTH }) // upload-url
      .mockResolvedValueOnce({ success: true, data: { id: 3 } }); // register

    const saved = await uploadContaAttachment(7, file());

    expect(dataApiCallMock.mock.calls[0][0]).toBe('/contas/7/attachments/upload-url');
    // Os BYTES não passam pela Next API — vão direto ao Storage com a URL assinada.
    expect(uploadToSignedUrlMock).toHaveBeenCalledWith(AUTH.storage_key, AUTH.token, expect.any(File), {
      contentType: 'application/pdf',
    });
    expect(dataApiCallMock.mock.calls[1][0]).toBe('/contas/7/attachments');
    expect(saved).toEqual({ id: 3 });
  });

  it('registra com a CHAVE que o servidor gerou (nunca uma escolhida pelo cliente)', async () => {
    dataApiCallMock
      .mockResolvedValueOnce({ success: true, data: AUTH })
      .mockResolvedValueOnce({ success: true, data: { id: 3 } });

    await uploadContaAttachment(7, file());

    const body = JSON.parse((dataApiCallMock.mock.calls[1][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ storage_key: AUTH.storage_key, file_name: 'boleto.pdf', mime_type: 'application/pdf' });
  });

  it('erro do Storage vira mensagem em pt-BR e NÃO registra o anexo', async () => {
    dataApiCallMock.mockResolvedValueOnce({ success: true, data: AUTH });
    uploadToSignedUrlMock.mockResolvedValue({ error: { message: 'network' } });

    await expect(uploadContaAttachment(7, file())).rejects.toThrow(/Falha ao enviar o arquivo/);
    expect(dataApiCallMock).toHaveBeenCalledTimes(1); // não chegou ao register
  });

  it('falha ao autorizar não sobe nada', async () => {
    dataApiCallMock.mockRejectedValueOnce(new Error('Arquivo maior que o limite de 10 MB'));
    await expect(uploadContaAttachment(7, file())).rejects.toThrow(/limite de 10 MB/);
    expect(uploadToSignedUrlMock).not.toHaveBeenCalled();
  });
});

describe('uploadContaAttachments (lote)', () => {
  it('envia SEQUENCIALMENTE e reporta o progresso', async () => {
    dataApiCallMock.mockResolvedValue({ success: true, data: AUTH });
    dataApiCallMock
      .mockResolvedValueOnce({ success: true, data: AUTH })
      .mockResolvedValueOnce({ success: true, data: { id: 1 } })
      .mockResolvedValueOnce({ success: true, data: AUTH })
      .mockResolvedValueOnce({ success: true, data: { id: 2 } });

    const onProgress = vi.fn();
    const { saved, failed } = await uploadContaAttachments(7, [file('a.pdf'), file('b.pdf')], onProgress);

    expect(saved).toHaveLength(2);
    expect(failed).toHaveLength(0);
    expect(onProgress.mock.calls).toEqual([[1, 2], [2, 2]]);
  });

  it('NÃO lança: um arquivo com falha não derruba os outros', async () => {
    dataApiCallMock
      .mockResolvedValueOnce({ success: true, data: AUTH }) // a.pdf: autoriza
      .mockResolvedValueOnce({ success: true, data: { id: 1 } }) // a.pdf: registra
      .mockRejectedValueOnce(new Error('Tipo de arquivo não permitido')); // b.pdf: falha

    const { saved, failed } = await uploadContaAttachments(7, [file('a.pdf'), file('b.pdf')]);

    // A conta já existe neste ponto — abortar tudo por um arquivo seria pior; quem decide
    // o que dizer ao usuário é a página.
    expect(saved).toEqual([{ id: 1 }]);
    expect(failed).toHaveLength(1);
    expect(failed[0].file.name).toBe('b.pdf');
    expect(failed[0].message).toBe('Tipo de arquivo não permitido');
  });

  it('lista vazia não chama a API', async () => {
    const { saved, failed } = await uploadContaAttachments(7, []);
    expect(saved).toEqual([]);
    expect(failed).toEqual([]);
    expect(dataApiCallMock).not.toHaveBeenCalled();
  });
});

describe('listContaAttachments / deleteContaAttachment', () => {
  it('lista devolve os anexos', async () => {
    dataApiCallMock.mockResolvedValue({ success: true, data: [{ id: 1 }] });
    expect(await listContaAttachments(7)).toEqual([{ id: 1 }]);
    expect(dataApiCallMock).toHaveBeenCalledWith('/contas/7/attachments');
  });

  it('lista sem data devolve array vazio', async () => {
    dataApiCallMock.mockResolvedValue({ success: true });
    expect(await listContaAttachments(7)).toEqual([]);
  });

  it('delete usa DELETE na rota do anexo', async () => {
    dataApiCallMock.mockResolvedValue({ success: true, data: { id: 3 } });
    await deleteContaAttachment(7, 3);
    expect(dataApiCallMock).toHaveBeenCalledWith('/contas/7/attachments/3', { method: 'DELETE' });
  });
});
