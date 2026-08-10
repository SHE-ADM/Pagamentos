import { describe, expect, it } from 'vitest';

import * as shared from './index';

/**
 * O BARREL é a API pública do pacote: os apps consomem tudo por `@sheild/shared`, que resolve
 * para `src/index.ts`. Um `export *` esquecido em `schemas/index.ts` não quebra a compilação
 * DESTE pacote — quebra a do consumidor, longe daqui, com "has no exported member".
 *
 * Este arquivo também é o que faz a COBERTURA enxergar o pacote inteiro: o v8 só reporta os
 * arquivos efetivamente carregados, então sem um teste que importe o barrel os schemas sem teste
 * próprio ficariam FORA do lcov e o Sonar os leria como 0% — que foi exatamente a armadilha que
 * levou `packages/shared/**` a ser excluído da cobertura no PR #223. Importar o barrel resolve
 * pela raiz, sem depender de configuração de include.
 */

// Um símbolo representativo por módulo re-exportado — se um `export *` cair, o nome some daqui.
const EXPORTS_POR_MODULO: Record<string, readonly string[]> = {
  'auth.schema': ['loginSchema', 'mustChangePassword', 'PASSWORD_CHANGED_META_KEY'],
  'supplier.schema': ['supplierSchema'],
  'financial-account-control.schema': [
    'financialAccountControlSchema',
    'financialAccountControlCreateSchema',
    'DOCUMENT_TYPES',
    'EXTRACTION_SOURCES',
    'EXTRACTION_CONFIDENCES',
    'STATUS_IDS',
  ],
  'financial-account-attachment.schema': ['financialAccountAttachmentSchema'],
  'cost-center.schema': ['costCenterSchema'],
  'chart-account.schema': ['chartAccountSchema'],
  'chart-account-group.schema': ['chartAccountGroupSchema'],
  'chart-account-subgroup.schema': ['chartAccountSubgroupSchema'],
  'bank.schema': ['bankSchema'],
  'financial-account.schema': ['financialAccountSchema'],
  'email-control.schema': ['emailControlSchema'],
  'processing-error.schema': ['processingErrorSchema'],
};

describe('barrel público de @sheild/shared', () => {
  it('reexporta um símbolo de cada módulo de schema', () => {
    for (const [modulo, simbolos] of Object.entries(EXPORTS_POR_MODULO)) {
      for (const nome of simbolos) {
        expect(shared, `'${nome}' sumiu do barrel — o export * de '${modulo}' caiu?`).toHaveProperty(nome);
      }
    }
  });

  it('sanidade: o barrel não veio vazio', () => {
    // Sem isto, um `import * as shared` que resolvesse para `{}` deixaria o caso acima verde
    // apenas se toHaveProperty também falhasse — mas um barrel truncado a poucos nomes passaria
    // despercebido. O piso é deliberadamente folgado: cresce com o pacote, não trava nele.
    expect(Object.keys(shared).length).toBeGreaterThan(30);
  });
});
