import { describe, it, expect } from 'vitest';
import { apiDeferralNotice } from './readerSummary';

describe('apiDeferralNotice', () => {
  it('fica vazio quando a API respondeu', () => {
    expect(apiDeferralNotice({ api_aborted: false, deferred: 0 })).toBe('');
    expect(apiDeferralNotice({})).toBe('');
  });

  it('declara ADIAMENTO com a quantidade, nunca interrupção', () => {
    const aviso = apiDeferralNotice({ api_aborted: true, deferred: 3 });
    expect(aviso).toContain('3 e-mail(s) financeiro(s) adiado(s)');
    expect(aviso).toContain('próxima execução');
    expect(aviso).toContain('os demais foram registrados');
    expect(aviso.toLowerCase()).not.toContain('interrompido');
    expect(aviso.toLowerCase()).not.toContain('rode novamente');
  });

  it('sem o campo deferred (backend antigo) avisa sem número em vez de "0 adiados"', () => {
    const aviso = apiDeferralNotice({ api_aborted: true });
    expect(aviso).toContain('e-mails financeiros adiados');
    expect(aviso).not.toMatch(/\d/);
    expect(apiDeferralNotice({ api_aborted: true, deferred: 0 })).not.toMatch(/\d/);
  });
});
