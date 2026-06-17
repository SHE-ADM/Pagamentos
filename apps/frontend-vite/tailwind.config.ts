import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1D9E75',
          dark: '#0F6E56',
          light: '#E1F5EE',
          glow: 'rgba(29,158,117,0.15)',
        },
        sidebar: {
          DEFAULT: '#0f1623', // fundo do painel de navegação
          hover: '#1a2333', // hover de itens
          active: '#ffffff14', // bg de item ativo (~8% branco)
          border: '#ffffff08', // bordas internas (~3% branco)
        },
        surface: {
          DEFAULT: '#ffffff', // cards
          page: '#f8fafc', // fundo da página
        },
        danger: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6',
        // Paleta semântica de feedback — fonte de verdade dos status/banners.
        // bg = fundo suave · fg = texto/borda forte · border = borda suave.
        status: {
          error: { bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca', solid: '#dc2626', solidBorder: '#b91c1c' },
          success: { bg: '#f0fdf4', fg: '#15803d', border: '#bbf7d0' },
          warning: { bg: '#fffbeb', fg: '#b45309', border: '#fde68a' },
          info: { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
          source: { bg: '#f0fdfa', fg: '#0f766e', border: '#99f6e4' }, // teal — origem da extração
          neutral: { bg: '#f8fafc', fg: '#475569', border: '#e2e8f0' }, // slate-600 — neutro/cancelado/pendente/ignorado/duplicidade (um pouco mais escuro)
        },
        ink: {
          primary: '#0f172a', // texto principal
          secondary: '#64748b', // texto secundário
          muted: '#94a3b8', // texto auxiliar
        },
        auth: {
          navy: '#5B5FA8',
          teal: '#57BFB6',
        },
        loginGreen: {
          // Hierarquia de texto
          ink: '#0c1e14', // títulos, labels, input text
          inkMid: '#2a3d30', // "lembrar-me"
          inkMuted: '#4a6b55', // labels sociais, divisor
          inkFaint: '#558a6d', // ícone olho — AA: ≥3:1 sobre o campo verde (1.4.11)
          placeholder: '#437355', // placeholder dos inputs — AA: ≥4.5:1 sobre o campo
          // Fundos
          surface: '#e6f5ec',
          field: '#eef9f3', // fundo do campo
          fieldFocus: '#e4f6ec', // fundo do campo em foco
          socialBg: '#f4fcf7', // fundo dos círculos sociais
          // Bordas
          border: '#94D0AE', // borda principal (frame externo)
          borderLight: '#c6e8d3',
          borderField: '#b8dfc8', // borda dos campos
          borderFocus: '#2d8a52', // borda em foco
          // Ações
          accent: '#1e7a40', // botão, links
          accentHover: '#165c30', // hover do botão
          accentMuted: '#6aaa85', // botão desabilitado
          // Aliases mantidos para ForgotPasswordPage / ResetPasswordPage
          accentDark: '#165c30',
        },
      },
      backgroundImage: {
        'gradient-auth': 'linear-gradient(135deg, #5B5FA8 0%, #57BFB6 100%)',
        'gradient-login-green': 'linear-gradient(180deg, #e6f5ec 0%, #FFFFFF 100%)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        jakarta: ["'Plus Jakarta Sans'", 'system-ui', 'sans-serif'],
      },
      keyframes: {
        fadeInUp: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.2s ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config;
