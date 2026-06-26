-- 053_financial_account_status_fk.sql
-- Adiciona a chave estrangeira financial_account.status_id -> status.status_id,
-- formalizando no banco a relação que já era lógica (lookup do CRUD de Contas).
--
-- Pré-condição verificada: todos os status_id de financial_account existem na
-- dimensão `status` (a tabela contém os ids 1..10 do ciclo de contas a pagar + o
-- 30 = "ativo" usado pelas contas bancárias). Sem linhas órfãs, a constraint não falha.
--
-- ON DELETE/UPDATE NO ACTION (default): impede excluir/renumerar um status em uso.

ALTER TABLE financial_account
  ADD CONSTRAINT fk_financial_account_status
  FOREIGN KEY (status_id) REFERENCES status (status_id);
