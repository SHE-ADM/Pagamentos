import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AttachmentList, { type AttachmentListItem } from './AttachmentList';

const item = (over: Partial<AttachmentListItem> = {}): AttachmentListItem => ({
  id: 1,
  name: 'boleto.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  ...over,
});

describe('AttachmentList', () => {
  it('lista os itens com nome e tamanho legível', () => {
    render(<AttachmentList items={[item(), item({ id: 2, name: 'nota.pdf', sizeBytes: 1048576 })]} />);
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('1 MB')).toBeInTheDocument();
  });

  it('exibe o texto de vazio quando não há itens', () => {
    render(<AttachmentList items={[]} emptyText="Nenhum anexo nesta conta." />);
    expect(screen.getByText('Nenhum anexo nesta conta.')).toBeInTheDocument();
  });

  it('chama onView com o item', async () => {
    const onView = vi.fn();
    render(<AttachmentList items={[item()]} onView={onView} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ver boleto.pdf' }));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  // 🔴 O NOME do arquivo tem de ser o alvo de clique — não um ícone no fim da linha.
  // No painel de detalhe de /consulta a lista fica num `<td colSpan>` com a largura TOTAL da
  // tabela: um botão no fim do flex cai fora da área visível quando o grid rola na horizontal,
  // e o anexo vira "não clicável" mesmo com o botão presente e funcionando. Este caso trava a
  // propriedade que resolve isso — o alvo está na borda esquerda, junto do nome.
  // Mutante: voltar o nome a um <span> solto -> o clique no texto não dispara onView.
  it('clicar no NOME do arquivo abre o anexo', async () => {
    const onView = vi.fn();
    render(<AttachmentList items={[item()]} onView={onView} />);

    await userEvent.click(screen.getByText('boleto.pdf'));
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    // E o nome está DENTRO do botão nomeado — não é um segundo controle ao lado.
    const botao = screen.getByRole('button', { name: 'Ver boleto.pdf' });
    expect(botao).toHaveTextContent('boleto.pdf');
    // O padrão do navegador para <button> é `cursor: default`: sem a classe explícita, o alvo
    // de clique não se anuncia como tal ao passar o mouse. Mutante: remover `cursor-pointer`.
    expect(botao).toHaveClass('cursor-pointer');
  });

  it('o nome truncado continua legível no hover (title com o NOME, não com a ação)', () => {
    // Esta lista vive num `<td colSpan>` estreito e o nome trunca com reticências — o `title`
    // era a única forma de ler o nome inteiro com o mouse. Ao envolver o texto num <button>
    // com `title="Ver o anexo"`, o tooltip passaria a descrever a AÇÃO e o nome se perderia.
    // Mutante: remover o `title` do <span> -> `getByTitle` não acha o elemento.
    render(<AttachmentList items={[item()]} onView={vi.fn()} />);
    expect(screen.getByTitle('boleto.pdf')).toHaveTextContent('boleto.pdf');
  });

  it('só UM controle acessível por anexo — o ícone de olho é atalho visual', () => {
    // Sem `aria-hidden` no ícone, o Tab pararia DUAS vezes no mesmo destino e o leitor de tela
    // anunciaria a mesma ação em duplicidade.
    //
    // ⚠️ A asserção conta TODOS os botões acessíveis da linha, e não os que têm o nome exato
    // "Ver boleto.pdf": medido por mutante, o ícone sem `aria-hidden` ganha nome acessível do
    // seu próprio `title` ("Ver o anexo"), então uma contagem por nome exato daria 1 nos dois
    // casos e ficaria VERDE com a duplicação instalada.
    render(<AttachmentList items={[item()]} onView={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button')).toHaveAccessibleName('Ver boleto.pdf');
  });

  it('sem onView (fila de pendentes) o nome NÃO vira botão', () => {
    render(<AttachmentList items={[item()]} />);
    expect(screen.queryByRole('button', { name: /^Ver / })).not.toBeInTheDocument();
    expect(screen.getByText('boleto.pdf')).toBeInTheDocument();
  });

  it('chama onRemove com o item', async () => {
    const onRemove = vi.fn();
    render(<AttachmentList items={[item()]} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('anexo de E-MAIL: mostra o selo e NÃO oferece remover (trilha de auditoria)', () => {
    render(<AttachmentList items={[item({ fromEmail: true })]} onRemove={vi.fn()} />);
    expect(screen.getByText('e-mail')).toBeInTheDocument();
    // Mesmo com onRemove passado, o anexo do e-mail não tem lixeira.
    expect(screen.queryByRole('button', { name: 'Remover boleto.pdf' })).not.toBeInTheDocument();
  });

  it('sem onRemove não há lixeira em anexo nenhum', () => {
    render(<AttachmentList items={[item()]} onView={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });

  it('busy desabilita a remoção', () => {
    render(<AttachmentList items={[item()]} onRemove={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Remover boleto.pdf' })).toBeDisabled();
  });

  // No painel de detalhe de /consulta a lista fica DENTRO do <tr>, cujo onClick alterna a
  // linha — sem conter o clique, abrir/remover um anexo fecharia o próprio painel.
  it('o clique nos botões NÃO vaza para o ancestral (não alterna a linha do grid)', async () => {
    const onAncestorClick = vi.fn();
    // O ancestral é um <table>/<tr> no app; aqui um wrapper com onClick basta para provar a
    // contenção — o `section` mantém o DOM válido (a lista é <ul>) sem handler em elemento
    // não-interativo no código de produção.
    render(
      <section onClick={onAncestorClick}>
        <AttachmentList items={[item()]} onView={vi.fn()} onRemove={vi.fn()} />
      </section>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ver boleto.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remover boleto.pdf' }));
    expect(onAncestorClick).not.toHaveBeenCalled();
  });
});
