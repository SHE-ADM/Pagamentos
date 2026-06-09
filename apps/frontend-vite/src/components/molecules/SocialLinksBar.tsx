// src/components/molecules/SocialLinksBar.tsx
// TODO: preencher com o numero da empresa em formato internacional
// quando definido (ex.: '5511999999999') para o link do WhatsApp funcionar.
const WHATSAPP_NUMBER = '';

interface SocialLink {
  name: string;
  href: string;
  logo: string;
}

const links: SocialLink[] = [
  { name: 'Otimotex', href: 'https://www.otimotex.com.br/', logo: '/logos/otimotex.png' },
  { name: 'Lebianco', href: 'https://www.lebianco.com.br/', logo: '/logos/Lebianco-vermelho.png' },
  { name: 'WhatsApp', href: `https://wa.me/${WHATSAPP_NUMBER}`, logo: '/logos/whatsapp.png' },
];

// Molecule — fileira de logos clicáveis com rótulo abaixo de cada círculo.
export default function SocialLinksBar() {
  return (
    <div className="flex flex-col items-center gap-3">
      <span className="text-xs font-medium text-loginGreen-inkMuted tracking-wider uppercase">
        fale com a gente
      </span>
      <div className="flex justify-center gap-8">
        {links.map(({ name, href, logo }) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={name}
              className="flex w-14 h-14 items-center justify-center rounded-full
                border-2 border-loginGreen-borderField bg-loginGreen-socialBg
                overflow-hidden transition-colors
                hover:border-loginGreen-borderFocus hover:bg-loginGreen-fieldFocus"
            >
              <img src={logo} alt={name} className="w-8 h-8 object-contain" />
            </a>
            <span className="text-xs font-medium text-loginGreen-inkMuted">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
