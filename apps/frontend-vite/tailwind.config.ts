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
          inkFaint: '#7aab8a', // ícone olho
          placeholder: '#8ab89a', // placeholder dos inputs
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
    },
  },
  plugins: [],
} satisfies Config;
