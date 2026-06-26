import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installPreloadErrorReload } from './lib/chunkReload';
import './index.css';

// Caminho rápido de recuperação de chunk lazy obsoleto (deploy novo) — recarrega
// antes de o React tentar renderizar o erro. O ErrorBoundary é a rede final.
installPreloadErrorReload();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Elemento #root não encontrado');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
