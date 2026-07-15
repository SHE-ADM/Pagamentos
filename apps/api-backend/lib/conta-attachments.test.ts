import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock do client Supabase (espelha lib/contas.test.ts): cada from() devolve um builder
// encadeável "thenable" que resolve para o próximo resultado da fila. Aqui o mock também
// cobre `storage.from()` — createSignedUploadUrl / info / remove.
type QueryResult = { data?: unknown; count?: number; error?: { code?: string; message: string; details?: string } | null };

const resultQueue: QueryResult[] = [];
const builders: Record<string, ReturnType<typeof vi.fn>>[] = [];

function makeBuilder(result: QueryResult) {
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
  for (const m of ['select', 'neq', 'or', 'order', 'range', 'eq', 'is', 'maybeSingle', 'single', 'insert', 'update', 'limit']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  builders.push(b);
  return b;
}

const fromMock = vi.fn(() => makeBuilder(resultQueue.shift() ?? { data: null, error: null, count: 0 }));

// ── Storage ──────────────────────────────────────────────────────────────────
type InfoResult = { data: { size?: number; contentType?: string } | null; error: { message: string } | null };
const signedUrlMock = vi.fn(async (key: string) => ({
  data: { signedUrl: `https://storage.test/signed/${key}`, token: 'tok-123', path: key },
  error: null,
}));
const infoMock = vi.fn(async (): Promise<InfoResult> => ({
  data: { size: 1024, contentType: 'application/pdf' },
  error: null,
}));
const removeMock = vi.fn(async (keys: string[]) => ({ data: keys, error: null }));
const storageFromMock = vi.fn(() => ({
  createSignedUploadUrl: signedUrlMock,
  info: infoMock,
  remove: removeMock,
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({ from: fromMock, storage: { from: storageFromMock } }),
}));

// A existência da conta é responsabilidade de contaService.getById — mockado aqui para o
// caso feliz; os testes de 404 sobrescrevem.
const getByIdMock = vi.fn(async (id: number) => ({ id }));
vi.mock('@/lib/contas', () => ({ contaService: { getById: (id: number) => getByIdMock(id) } }));

// Tipado com o parâmetro (a chamada real passa o userId), mas a implementação o ignora —
// evita o warning de arg não usado sem quebrar a assinatura.
const isInAdminGroupMock = vi.fn<(userId: string) => Promise<boolean>>(async () => false);
vi.mock('@/lib/auth', () => ({ isInAdminGroup: (u: string) => isInAdminGroupMock(u) }));

const { contaAttachmentService, buildStorageKey, safeFileName } = await import('./conta-attachments');

const AUTOR = '11111111-1111-1111-1111-111111111111';
const OUTRO = '22222222-2222-2222-2222-222222222222';
const PDF = { file_name: 'Boleto Julho.pdf', mime_type: 'application/pdf', size_bytes: 1024 };

beforeEach(() => {
  resultQueue.length = 0;
  builders.length = 0;
  fromMock.mockClear();
  signedUrlMock.mockClear();
  infoMock.mockClear();
  removeMock.mockClear();
  storageFromMock.mockClear();
  isInAdminGroupMock.mockClear();
  isInAdminGroupMock.mockImplementation(async () => false);
  getByIdMock.mockClear();
  getByIdMock.mockImplementation(async (id: number) => ({ id }));
  infoMock.mockImplementation(async () => ({ data: { size: 1024, contentType: 'application/pdf' }, error: null }));
});

describe('safeFileName', () => {
  // Saídas conferidas contra o safe_filename REAL do pipeline (read_emails.py) — as duas
  // implementações têm de coincidir, senão a chave do Storage diverge entre as origens.
  // Note o `º` → `o`: NFKD é decomposição de COMPATIBILIDADE, e o Python faz o mesmo.
  it('derruba acentos e não-ASCII (espelha safe_filename do pipeline)', () => {
    expect(safeFileName('Ação Nº 5 çãõ')).toBe('Acao_No_5_cao');
  });

  it('remove ponto e barra — sem path traversal a partir do nome do cliente', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd');
  });

  it('trunca no limite pedido', () => {
    expect(safeFileName('a'.repeat(80), 40)).toHaveLength(40);
  });
});

describe('buildStorageKey', () => {
  it('prefixa manual/{accountId}/ — namespace disjunto do pipeline (que nunca tem "/")', () => {
    expect(buildStorageKey(512, 'boleto.pdf', 'application/pdf')).toMatch(/^manual\/512\//);
  });

  it('usa a extensão do MIME validado, não a do nome enviado', () => {
    // Cliente diz ".exe" mas declarou image/png → a chave sai .png.
    expect(buildStorageKey(1, 'virus.exe', 'image/png')).toMatch(/\.png$/);
  });

  it('duas chamadas iguais geram chaves DIFERENTES (sufixo aleatório evita colisão)', () => {
    const a = buildStorageKey(1, 'boleto.pdf', 'application/pdf');
    const b = buildStorageKey(1, 'boleto.pdf', 'application/pdf');
    expect(a).not.toBe(b);
  });

  it('nome vazio após sanitizar vira "anexo"', () => {
    expect(buildStorageKey(1, '???.pdf', 'application/pdf')).toMatch(/_anexo\.pdf$/);
  });
});

describe('contaAttachmentService.list', () => {
  it('filtra deleted_at explicitamente (service_role IGNORA a RLS que esconderia o removido)', async () => {
    resultQueue.push({ data: [{ id: 1, storage_key: 'manual/5/x.pdf' }], error: null });
    const r = await contaAttachmentService.list(5);
    expect(r).toEqual([{ id: 1, storage_key: 'manual/5/x.pdf' }]);
    expect(builders[0].is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('404 quando a conta não existe', async () => {
    getByIdMock.mockImplementation(() => Promise.reject(Object.assign(new Error('Conta não encontrada'), { status: 404 })));
    await expect(contaAttachmentService.list(9)).rejects.toMatchObject({ status: 404 });
  });
});

describe('contaAttachmentService.createUploadUrl', () => {
  it('devolve a chave gerada pelo SERVIDOR + url assinada', async () => {
    const r = await contaAttachmentService.createUploadUrl(7, PDF);
    expect(r.storage_key).toMatch(/^manual\/7\/.*\.pdf$/);
    expect(r.token).toBe('tok-123');
    // A URL é emitida para a chave do servidor, não para uma escolhida pelo cliente.
    expect(signedUrlMock).toHaveBeenCalledWith(r.storage_key);
  });

  it('422 com mime fora da allowlist — não emite URL', async () => {
    await expect(
      contaAttachmentService.createUploadUrl(7, { ...PDF, mime_type: 'application/x-msdownload' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(signedUrlMock).not.toHaveBeenCalled();
  });

  it('422 acima do limite de 10 MB — não emite URL', async () => {
    await expect(
      contaAttachmentService.createUploadUrl(7, { ...PDF, size_bytes: 11 * 1024 * 1024 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(signedUrlMock).not.toHaveBeenCalled();
  });

  it('404 quando a conta não existe — não emite URL', async () => {
    getByIdMock.mockImplementation(() => Promise.reject(Object.assign(new Error('Conta não encontrada'), { status: 404 })));
    await expect(contaAttachmentService.createUploadUrl(9, PDF)).rejects.toMatchObject({ status: 404 });
    expect(signedUrlMock).not.toHaveBeenCalled();
  });
});

describe('contaAttachmentService.register', () => {
  const KEY = 'manual/7/20260715T120000Z_abcd1234_Boleto.pdf';

  it('grava com o metadado REAL do objeto, não o declarado pelo cliente', async () => {
    infoMock.mockImplementation(async () => ({ data: { size: 4096, contentType: 'image/png' }, error: null }));
    resultQueue.push({ data: { id: 3, account_id: 7 }, error: null });
    await contaAttachmentService.register(7, { ...PDF, storage_key: KEY, size_bytes: 1 }, AUTOR);
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    // Cliente declarou "pdf de 1 byte"; o objeto real é png de 4096 → vale o real.
    expect(insertArg).toMatchObject({ mime_type: 'image/png', size_bytes: 4096, uploaded_by: AUTOR });
  });

  it('422 quando a chave não é `manual/{accountId}/` — bloqueia registrar objeto alheio', async () => {
    // Chave do pipeline (nome flat): registrá-la roubaria o anexo de e-mail sem subir nada.
    await expect(
      contaAttachmentService.register(7, { ...PDF, storage_key: 'ester_RES_HYOSUNG.pdf' }, AUTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('422 quando a chave é de OUTRA conta', async () => {
    await expect(
      contaAttachmentService.register(7, { ...PDF, storage_key: 'manual/8/x.pdf' }, AUTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(fromMock).not.toHaveBeenCalled();
  });

  // PATH TRAVERSAL (regressão de segurança — não afrouxar para um startsWith).
  // O Storage NORMALIZA o `..` (verificado contra o bucket real: info() resolve,
  // createSignedUrl assina e o download entrega os bytes). Um guard só de prefixo aceitaria
  // estas chaves e o usuário registraria — e VERIA — o objeto do pipeline ou de outra conta.
  it.each([
    ['manual/7/../../ester_HYOSUNG.pdf', 'escapa para a raiz → objeto do PIPELINE'],
    ['manual/7/../8/boleto.pdf', 'escapa para OUTRA conta'],
    ['manual/7/./x.pdf', 'segmento "." não é formato do servidor'],
    ['manual/7/sub/dir/x.pdf', 'subpasta não é formato do servidor'],
    ['manual/7/20260715T120000Z_abcd1234_Boleto.exe', 'extensão fora da allowlist'],
    ['manual/7/naotem-o-formato.pdf', 'sem timestamp/rand do servidor'],
    ['manual/70/20260715T120000Z_abcd1234_x.pdf', 'conta 70 tentando passar por 7'],
  ])('422 para chave forjada: %s (%s)', async (key) => {
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: key }, AUTOR)).rejects.toMatchObject({
      status: 422,
    });
    expect(infoMock).not.toHaveBeenCalled(); // nem chega a consultar o Storage
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('aceita a chave REAL que o buildStorageKey gera (o guard não é rígido demais)', async () => {
    const key = buildStorageKey(7, 'Ação Nº 5.pdf', 'application/pdf');
    resultQueue.push({ data: { id: 9 }, error: null });
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: key }, AUTOR)).resolves.toMatchObject({
      id: 9,
    });
  });

  it('422 quando o objeto não existe no Storage — não grava linha fantasma', async () => {
    infoMock.mockImplementation(async () => ({ data: null, error: { message: 'not found' } }));
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 422,
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('objeto REAL acima do limite → 422 e REMOVE o objeto (ainda não vinculado a conta)', async () => {
    infoMock.mockImplementation(async () => ({
      data: { size: 20 * 1024 * 1024, contentType: 'application/pdf' },
      error: null,
    }));
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 422,
    });
    expect(removeMock).toHaveBeenCalledWith([KEY]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('objeto REAL de tipo não permitido → 422 e REMOVE o objeto', async () => {
    infoMock.mockImplementation(async () => ({ data: { size: 10, contentType: 'text/html' }, error: null }));
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 422,
    });
    expect(removeMock).toHaveBeenCalledWith([KEY]);
  });

  it('409 quando o anexo já foi registrado (UNIQUE account_id+storage_key)', async () => {
    resultQueue.push({ data: null, error: { code: '23505', message: 'duplicate' } });
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('404 quando a conta sumiu entre o getById e o insert (FK 23503)', async () => {
    resultQueue.push({ data: null, error: { code: '23503', message: 'fk violation' } });
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 404,
    });
  });

  // §3 M-2: failFromError ECOA a mensagem de qualquer status < 500. Um erro de banco
  // inesperado precisa sair como 500 para virar mensagem genérica — senão o cliente
  // receberia "violates check constraint ..." com nome de tabela/constraint.
  it('erro inesperado do banco vira 500 (não vaza detalhe do Postgres em 4xx)', async () => {
    resultQueue.push({
      data: null,
      error: {
        code: '23514',
        message: 'new row for relation "financial_account_attachment" violates check constraint "..._file_name_check"',
      },
    });
    await expect(contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR)).rejects.toMatchObject({
      status: 500,
    });
  });

  it('preserva o nome ORIGINAL do arquivo para exibição', async () => {
    resultQueue.push({ data: { id: 3 }, error: null });
    await contaAttachmentService.register(7, { ...PDF, storage_key: KEY }, AUTOR);
    const insertArg = builders[0].insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({ file_name: 'Boleto Julho.pdf', storage_key: KEY, account_id: 7 });
  });
});

describe('contaAttachmentService.remove', () => {
  const manual = { account_id: 7, origin: 'manual', uploaded_by: AUTOR, deleted_at: null };

  it('soft delete: marca deleted_at/deleted_by e NUNCA remove o objeto do bucket', async () => {
    resultQueue.push({ data: manual, error: null }); // findById
    resultQueue.push({ data: { id: 3 }, error: null }); // softDelete
    await contaAttachmentService.remove(7, 3, AUTOR);
    const updateArg = builders[1].update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).toMatchObject({ deleted_by: AUTOR });
    expect(updateArg.deleted_at).toEqual(expect.any(String));
    expect(removeMock).not.toHaveBeenCalled(); // o objeto FICA no Storage
  });

  it('403 no anexo vindo do e-mail (origin=pipeline) — trilha de auditoria', async () => {
    resultQueue.push({ data: { ...manual, origin: 'pipeline' }, error: null });
    await expect(contaAttachmentService.remove(7, 3, AUTOR)).rejects.toMatchObject({ status: 403 });
  });

  it('403 ao remover anexo manual de OUTRO usuário (não-admin)', async () => {
    resultQueue.push({ data: manual, error: null });
    await expect(contaAttachmentService.remove(7, 3, OUTRO)).rejects.toMatchObject({ status: 403 });
  });

  it('grupo Administrador remove anexo manual de outro usuário', async () => {
    isInAdminGroupMock.mockImplementation(async () => true);
    resultQueue.push({ data: manual, error: null });
    resultQueue.push({ data: { id: 3 }, error: null });
    await expect(contaAttachmentService.remove(7, 3, OUTRO)).resolves.toBeUndefined();
  });

  it('404 quando o anexo é de OUTRA conta (não revela que existe)', async () => {
    resultQueue.push({ data: { ...manual, account_id: 8 }, error: null });
    await expect(contaAttachmentService.remove(7, 3, AUTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('404 quando já removido', async () => {
    resultQueue.push({ data: { ...manual, deleted_at: '2026-07-15T00:00:00Z' }, error: null });
    await expect(contaAttachmentService.remove(7, 3, AUTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('404 quando não existe', async () => {
    resultQueue.push({ data: null, error: null });
    await expect(contaAttachmentService.remove(7, 3, AUTOR)).rejects.toMatchObject({ status: 404 });
  });
});
