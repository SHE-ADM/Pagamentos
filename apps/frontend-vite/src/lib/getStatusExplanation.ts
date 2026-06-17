import type { EmailControl } from '@sheild/shared';
import { getFailureReason } from './getFailureReason';

// Variante do Alert + título + texto explicativo para um status de e-mail.
// Local: consumido por inferência (Emails lê os campos via o retorno da função).
type StatusExplanation = {
  variant: 'error' | 'warning' | 'info';
  title: string;
  message: string;
};

// Explica, em linguagem simples para o usuário final, por que um e-mail terminou
// num status que merece contexto: 'falha', 'pendente' ou 'ignorado'. Para
// 'extraído'/'recebido' (sucesso) retorna null — não há o que explicar.
// Exibido no card de detalhes de /emails (Alert colorido conforme a gravidade).
export function getStatusExplanation(email: EmailControl): StatusExplanation | null {
  if (email.status === 'falha') {
    return {
      variant: 'error',
      title: 'Por que este e-mail falhou:',
      message: getFailureReason(email),
    };
  }

  if (email.status === 'pendente') {
    return {
      variant: 'warning',
      title: 'Por que este e-mail está pendente:',
      message:
        'O assunto combinou com uma palavra-chave financeira e o e-mail trazia um anexo ' +
        'PDF, que foi salvo. Mas o sistema ainda não conseguiu ler os dados da conta ' +
        '(valor, vencimento e fornecedor) desse anexo. O e-mail está aguardando ' +
        'reprocessamento automático — não é preciso fazer nada agora; se continuar ' +
        'pendente, revise este e-mail manualmente.',
    };
  }

  if (email.status === 'ignorado') {
    return {
      variant: 'info',
      title: 'Por que este e-mail foi ignorado:',
      message:
        'O assunto deste e-mail não combinou com nenhuma palavra-chave financeira ' +
        '(como "boleto", "nota fiscal" ou "fatura"). Por isso ele foi apenas registrado ' +
        'para referência — espelhando sua caixa de entrada — sem baixar anexos nem tentar ' +
        'gerar uma conta a pagar. Não é um erro: é um e-mail considerado não-financeiro.',
    };
  }

  return null;
}
