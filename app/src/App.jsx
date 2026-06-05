// src/App.jsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Emails   from './pages/Emails'
import Consulta from './pages/Consulta'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"         element={<Navigate to="/emails" replace />} />
        <Route path="/emails"   element={<Emails />} />
        <Route path="/consulta" element={<Consulta />} />
      </Routes>
    </Layout>
  )
}
