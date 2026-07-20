// src/components/Layout.tsx
import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { cva } from 'class-variance-authority';
import {
  Mail,
  Wallet,
  BarChart2,
  FilePlus,
  Building2,
  Receipt,
  AlertTriangle,
  Layers,
  Landmark,
  BookText,
  FolderTree,
  ListTree,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../lib/cn';

// Link de navegação — estado ativo via cva (fonte única das classes). Local e
// não exportado, então não dispara react-refresh/only-export-components.
const navLink = cva('nav-link', {
  variants: { active: { true: 'active', false: '' } },
  defaultVariants: { active: false },
});

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const { user, signOut } = useAuth();
  // Drawer da sidebar no mobile (< lg). Em lg+ a sidebar é estática e sempre visível.
  const [navOpen, setNavOpen] = useState(false);

  // Avatar/identidade derivados do e-mail do usuário autenticado.
  const email = user?.email ?? '';
  const initials = email.slice(0, 2).toUpperCase();
  const emailShort = email.length > 16 ? `${email.slice(0, 16)}…` : email;

  const closeNav = (): void => setNavOpen(false);

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Backdrop do drawer — só no mobile quando aberto. */}
      {navOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          onClick={closeNav}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-(--sidebar-width) bg-sidebar text-slate-300',
          'border-r border-sidebar-border flex flex-col transition-transform duration-200',
          'lg:static lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="px-4 py-3 border-b border-sidebar-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-brand to-brand-dark shadow-xs shadow-brand/30">
              <Receipt size={16} className="text-white" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm text-white">pagamentos</div>
              <div className="text-xs text-slate-400">contas a pagar</div>
            </div>
          </div>
          {/* Fechar — só no mobile. */}
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={closeNav}
            className="lg:hidden text-slate-400 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* min-h-0 + overflow-y-auto: com muitos itens, o nav rola DENTRO da sidebar
            (superfície escura) em vez de transbordar sobre o <main> branco — senão os
            últimos itens e o rodapé caem no fundo claro e o texto slate-400 reprova AA
            (2,57:1). Mantém todo o texto sobre bg-sidebar (~7:1). */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5">
          {/* Grupo 1 — Recebimentos */}
          <p className="px-3 pt-0.5 pb-1 text-xs font-bold tracking-widest text-slate-400 uppercase">
            Recebimentos
          </p>
          <NavLink to="/emails" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Mail size={16} /> E-mails
          </NavLink>
          <NavLink to="/erros" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <AlertTriangle size={16} /> Log de erros
          </NavLink>

          {/* Grupo 2 — Envios */}
          <p className="px-3 pt-2.5 pb-1 text-xs font-bold tracking-widest text-slate-400 uppercase">
            Envios
          </p>
          <NavLink to="/cobranca/envios" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Mail size={16} /> E-mails
          </NavLink>
          <NavLink to="/cobranca/erros" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <AlertTriangle size={16} /> Log de erros
          </NavLink>

          {/* Grupo 3 — Contas */}
          <p className="px-3 pt-2.5 pb-1 text-xs font-bold tracking-widest text-slate-400 uppercase">
            Contas
          </p>
          <NavLink to="/consulta" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Wallet size={16} /> Gestão de contas
          </NavLink>
          <NavLink to="/contas" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <FilePlus size={16} /> Cadastro de contas
          </NavLink>
          <NavLink to="/fornecedores" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Building2 size={16} /> Cadastro de fornecedores
          </NavLink>

          {/* Grupo 4 — Tabelas */}
          <p className="px-3 pt-2.5 pb-1 text-xs font-bold tracking-widest text-slate-400 uppercase">
            Tabelas
          </p>
          <NavLink to="/tabelas/bancos" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Landmark size={16} /> Bancos
          </NavLink>
          <NavLink to="/tabelas/contas" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Wallet size={16} /> Contas bancárias
          </NavLink>
          <NavLink to="/tabelas/centros-de-custo" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <Layers size={16} /> Centro de custos
          </NavLink>
          <NavLink to="/tabelas/plano-de-contas" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <BookText size={16} /> Plano de contas
          </NavLink>
          <NavLink to="/tabelas/grupos-plano-de-contas" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <FolderTree size={16} /> Grupos de plano de contas
          </NavLink>
          <NavLink to="/tabelas/subgrupos-plano-de-contas" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <ListTree size={16} /> Sub grupos de plano de contas
          </NavLink>

          {/* Grupo 5 — Análise */}
          <p className="px-3 pt-2.5 pb-1 text-xs font-bold tracking-widest text-slate-400 uppercase">
            Análise
          </p>
          <NavLink to="/dashboard" onClick={closeNav} className={({ isActive }) => navLink({ active: isActive })}>
            <BarChart2 size={16} /> Dashboard de Vencimentos
          </NavLink>
        </nav>

        <div className="px-4 py-2.5 border-t border-sidebar-border space-y-2">
          {user && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/20 text-brand-light text-xs font-bold">
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
                aria-label="Sair"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {/* Barra superior — só no mobile (< lg): abre o drawer. */}
        <header className="lg:hidden flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <button
            type="button"
            aria-label="Abrir menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
            className="text-slate-600 hover:text-brand transition-colors"
          >
            <Menu size={22} />
          </button>
          <span className="font-semibold text-sm text-ink-primary">pagamentos</span>
        </header>

        <div className="flex-1 min-h-0">{children}</div>
      </main>
    </div>
  );
}
