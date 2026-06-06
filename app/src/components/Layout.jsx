// src/components/Layout.jsx
import { NavLink } from 'react-router-dom'
import { Mail, Search, BarChart2, Edit3, Receipt } from 'lucide-react'

export default function Layout({ children }) {
  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-52 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-4 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Receipt size={18} className="text-brand" />
            <span className="font-semibold text-sm text-gray-900">pagamentos</span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 ml-6">contas a pagar</p>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium text-gray-400 uppercase tracking-widest">
            Ativo
          </p>
          <NavLink to="/emails"   className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Mail size={15} /> E-mails
          </NavLink>
          <NavLink to="/consulta" className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`}>
            <Search size={15} /> Consulta
          </NavLink>

          <p className="px-2 pt-4 pb-1.5 text-[10px] font-medium text-gray-400 uppercase tracking-widest">
            Em breve
          </p>
          <span className="nav-link opacity-40 cursor-not-allowed">
            <Edit3 size={15} /> CRUD Contas
          </span>
          <span className="nav-link opacity-40 cursor-not-allowed">
            <BarChart2 size={15} /> Dashboard
          </span>
        </nav>

        <div className="px-4 py-3 border-t border-gray-200">
          <div className="text-[10px] text-gray-400">v1.0.0 — fase 1</div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  )
}
