import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from '../../../tests/axe';

vi.mock('../../services/cobrancaService', () => ({
  startResend: vi.fn(),
  getResendProgress: vi.fn(),
}));

import ResendErrosAction from './ResendErrosAction';

const baseProps = {
  ids: [1, 2],
  clearSelection: vi.fn(),
  onFinished: vi.fn(),
  onError: vi.fn(),
};

describe('ResendErrosAction — acessibilidade (WCAG AA)', () => {
  it('estado habilitado não tem violações', async () => {
    const { container } = render(<ResendErrosAction {...baseProps} ready reason={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('estado desabilitado (backend offline) não tem violações', async () => {
    const { container } = render(
      <ResendErrosAction {...baseProps} ready={false} reason="Backend offline." />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
