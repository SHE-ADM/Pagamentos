// src/components/ErrorBoundary.tsx
// Rede de segurança global: captura exceções de render (incluindo a rejeição do
// import() de um chunk lazy) e evita a "tela branca". Para erro de chunk, recarrega
// automaticamente (deploy novo invalidou os assets — ver lib/chunkReload). Para os
// demais, mostra um fallback com botão "Recarregar" em vez de sumir com a UI.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reloadOnceForChunk } from '../lib/chunkReload';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  reloading: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Erro de chunk → tenta recarregar (a flag evita piscar o fallback de erro).
    if (isChunkLoadError(error)) return { error, reloading: true };
    return { error, reloading: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isChunkLoadError(error)) {
      const reloaded = reloadOnceForChunk();
      // Esgotadas as tentativas → mostra o fallback de erro em vez de recarregar à toa.
      if (!reloaded) this.setState({ reloading: false });
      return;
    }
    // Erro de runtime — log para diagnóstico (telemetria pode ser plugada aqui).
    console.error('ErrorBoundary capturou um erro de render:', error, info.componentStack);
  }

  private readonly handleReload = (): void => {
    globalThis.location.reload();
  };

  render(): ReactNode {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;

    if (reloading) {
      // Recarregando para pegar a versão nova — não exibe a UI de erro.
      return (
        <div className="flex h-screen items-center justify-center text-sm text-gray-500">Atualizando…</div>
      );
    }

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-base font-semibold text-gray-900">Algo deu errado ao carregar a página.</p>
        <p className="max-w-md text-sm text-gray-500">
          Recarregue para continuar. Se o problema persistir, contate o suporte.
        </p>
        <button type="button" onClick={this.handleReload} className="btn btn-primary">
          Recarregar
        </button>
      </div>
    );
  }
}
