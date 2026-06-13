import { describe, it, expect, beforeEach } from 'vitest';
import { hybridAuthStorage, setRememberPreference, getRememberPreference } from './authStorage';

const TOKEN_KEY = 'sb-auth-token';
const REMEMBER_KEY = 'pag:remember';

describe('authStorage — storage híbrido', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('setRememberPreference / getRememberPreference', () => {
    it('persiste a preferência marcada e a lê de volta', () => {
      setRememberPreference(true);
      expect(localStorage.getItem(REMEMBER_KEY)).toBe('1');
      expect(getRememberPreference()).toBe(true);
    });

    it('persiste a preferência desmarcada e a lê de volta', () => {
      setRememberPreference(true);
      setRememberPreference(false);
      expect(getRememberPreference()).toBe(false);
    });

    it('getRememberPreference é false quando nunca foi definida', () => {
      expect(getRememberPreference()).toBe(false);
    });
  });

  describe('setItem — roteamento conforme a preferência', () => {
    it('marcado → grava em localStorage e limpa sessionStorage', () => {
      setRememberPreference(true);
      hybridAuthStorage.setItem(TOKEN_KEY, 'abc');

      expect(localStorage.getItem(TOKEN_KEY)).toBe('abc');
      expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    it('desmarcado → grava em sessionStorage e limpa localStorage', () => {
      setRememberPreference(false);
      hybridAuthStorage.setItem(TOKEN_KEY, 'abc');

      expect(sessionStorage.getItem(TOKEN_KEY)).toBe('abc');
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });

    it('trocar a preferência move o token e não deixa duplicata órfã', () => {
      setRememberPreference(true);
      hybridAuthStorage.setItem(TOKEN_KEY, 'v1');

      setRememberPreference(false);
      hybridAuthStorage.setItem(TOKEN_KEY, 'v2');

      expect(sessionStorage.getItem(TOKEN_KEY)).toBe('v2');
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('getItem — encontra o token onde quer que esteja', () => {
    it('lê o token do localStorage (sessão lembrada)', () => {
      setRememberPreference(true);
      hybridAuthStorage.setItem(TOKEN_KEY, 'fromLocal');
      expect(hybridAuthStorage.getItem(TOKEN_KEY)).toBe('fromLocal');
    });

    it('lê o token do sessionStorage (sessão não lembrada)', () => {
      setRememberPreference(false);
      hybridAuthStorage.setItem(TOKEN_KEY, 'fromSession');
      expect(hybridAuthStorage.getItem(TOKEN_KEY)).toBe('fromSession');
    });

    it('retorna null quando não há token em nenhum storage', () => {
      expect(hybridAuthStorage.getItem(TOKEN_KEY)).toBeNull();
    });
  });

  describe('removeItem — limpa ambos os storages', () => {
    it('remove o token de localStorage e sessionStorage', () => {
      localStorage.setItem(TOKEN_KEY, 'a');
      sessionStorage.setItem(TOKEN_KEY, 'b');

      hybridAuthStorage.removeItem(TOKEN_KEY);

      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    });
  });
});
