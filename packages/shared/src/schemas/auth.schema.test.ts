import { describe, expect, it } from 'vitest';

import {
  createUserSchema,
  loginSchema,
  mustChangePassword,
  PASSWORD_CHANGED_META_KEY,
  resetPasswordSchema,
} from './auth.schema';

/**
 * `mustChangePassword` é a única LÓGICA (não só declaração) deste pacote, e ela decide se um
 * usuário é barrado em /auth/change-password no 1º acesso.
 *
 * A marca é POSITIVA de propósito: ausência = senha ainda é a temporária do admin. Inverter esse
 * default é a falha perigosa — cobre QUALQUER caminho de criação (Dashboard ou API), porque
 * usuário novo nunca tem a marca. Se a função passasse a devolver `false` para metadata ausente,
 * todo usuário criado pelo admin entraria direto com a senha temporária, sem erro nenhum.
 */
describe('mustChangePassword — a marca é POSITIVA', () => {
  it('força a troca quando o metadata está ausente (usuário recém-criado)', () => {
    expect(mustChangePassword(undefined)).toBe(true);
    expect(mustChangePassword(null)).toBe(true);
    expect(mustChangePassword({})).toBe(true);
  });

  it('força a troca quando a marca é false', () => {
    expect(mustChangePassword({ [PASSWORD_CHANGED_META_KEY]: false })).toBe(true);
  });

  it('libera SOMENTE com a marca booleana true', () => {
    expect(mustChangePassword({ [PASSWORD_CHANGED_META_KEY]: true })).toBe(false);
  });

  it('não aceita valor "parecido com true" — a comparação é estrita', () => {
    // Um `'true'` string viria de metadata mal gravado; tratá-lo como verdadeiro deixaria passar
    // quem nunca trocou a senha.
    expect(mustChangePassword({ [PASSWORD_CHANGED_META_KEY]: 'true' })).toBe(true);
    expect(mustChangePassword({ [PASSWORD_CHANGED_META_KEY]: 1 })).toBe(true);
  });

  it('a chave é a esperada pelo backfill em auth.users.raw_app_meta_data', () => {
    expect(PASSWORD_CHANGED_META_KEY).toBe('password_changed');
  });
});

describe('formulários de auth', () => {
  it('login exige e-mail válido e senha de 6+', () => {
    expect(loginSchema.safeParse({ email: 'nao-e-email', password: '123456' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '12345' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: '123456' }).success).toBe(true);
  });

  it('criação de usuário (admin) exige senha de 8+ — mais estrita que o login', () => {
    const base = { name: 'Fulano de Tal', email: 'a@b.com' };
    expect(createUserSchema.safeParse({ ...base, password: '1234567' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, password: '12345678' }).success).toBe(true);
  });

  it('reset recusa quando a confirmação não confere, e aponta o campo certo', () => {
    const r = resetPasswordSchema.safeParse({ password: 'senha-boa-1', confirmPassword: 'outra' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('confirmPassword'))).toBe(true);
    }
  });
});
