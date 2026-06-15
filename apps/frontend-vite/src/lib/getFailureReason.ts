import type { EmailControl } from '@sheild/shared';

// Explica, em linguagem simples para o usuário final, por que um e-mail terminou
// com status 'falha'. Regra de negócio: 'falha' = o assunto casou uma palavra-chave
// financeira (ex.: "boleto"), então o sistema esperava gerar uma conta a pagar, mas
// não havia dado nenhum para isso — nem PDF anexado, nem valor (R$)/número de nota
// fiscal no corpo do e-mail. O texto é exibido no card de detalhes (em vermelho).
export function getFailureReason(email: EmailControl): string {
  const semAnexo =
    'O assunto deste e-mail combinou com uma palavra-chave financeira (como "boleto"), ' +
    'então o sistema esperava registrar uma conta a pagar. Porém o e-mail não veio com ' +
    'nenhum PDF anexado e o próprio texto não trazia um valor (R$) nem um número de nota ' +
    'fiscal. Sem esses dados, não foi possível criar a conta automaticamente — é preciso ' +
    'revisar este e-mail manualmente.';

  const comAnexo =
    'O e-mail trazia um anexo, mas o sistema não conseguiu ler os dados necessários ' +
    '(valor, vencimento ou fornecedor) para gerar a conta a pagar. É preciso revisar ' +
    'este e-mail manualmente.';

  return email.has_attachment ? comAnexo : semAnexo;
}
