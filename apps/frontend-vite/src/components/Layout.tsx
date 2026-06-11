// src/components/Layout.tsx
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Mail, Search, BarChart2, Edit3, Receipt, AlertTriangle, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export default function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();

  // Avatar/identidade derivados do e-mail do usuário autenticado.
  const email = user?.email ?? '';
  const initials = email.slice(0, 2).toUpperCase();
  const emailShort = email.length > 16 ? `${email.slice(0, 16)}…` : email;

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="flex-shrink-0 w-[var(--sidebar-width)] bg-sidebar text-slate-300 border-r border-sidebar-border flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand-dark shadow-sm shadow-brand/30">
              <Receipt size={16} className="text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm text-white">pagamentos</div>
              <div className="text-xs text-slate-500">contas a pagar</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          <p className="px-3 pt-1 pb-1.5 text-[9px] font-bold tracking-[0.15em] text-slate-600 uppercase">
            Ativo
          </p>
          <NavLink to="/emails" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Mail size={16} /> E-mails
          </NavLink>
          <NavLink to="/consulta" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Search size={16} /> Consulta
          </NavLink>
          <NavLink to="/erros" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <AlertTriangle size={16} /> Log de Erros
          </NavLink>

          <p className="px-3 pt-4 pb-1.5 text-[9px] font-bold tracking-[0.15em] text-slate-600 uppercase">
            Em breve
          </p>
          <span className="nav-link is-disabled">
            <Edit3 size={16} /> CRUD Contas
            <span className="ml-auto text-[9px] bg-slate-800 text-slate-500 rounded px-1">soon</span>
          </span>
          <span className="nav-link is-disabled">
            <BarChart2 size={16} /> Dashboard
            <span className="ml-auto text-[9px] bg-slate-800 text-slate-500 rounded px-1">soon</span>
          </span>
        </nav>

        <div className="px-4 py-3 border-t border-sidebar-border space-y-2">
          {user && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand text-[10px] font-bold">
                  {initials}
                </div>
                <span className="text-xs text-slate-400 truncate" title={email}>
                  {emailShort}
                </span>
              </div>
              <button
                type="button"
                onClick={signOut}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-400 transition-colors"
                title="Sair"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
          <div className="text-[10px] text-slate-600">v1.0.0 — fase 1</div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}
