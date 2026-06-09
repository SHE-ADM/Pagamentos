// src/lib/getErrorMessage.ts
// Em strict mode o valor capturado em catch é `unknown`; este helper extrai a
// mensagem de forma segura para exibir na UI.
export function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
