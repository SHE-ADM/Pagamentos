// src/components/molecules/SocialLinksBar.tsx
// Número da empresa em formato internacional (ex.: '5511999999999'). Vazio = ainda não
// definido; basta preencher aqui para o círculo do WhatsApp aparecer.
// Anotado como `string` (e não inferido como o literal `''`) de propósito: sem a anotação
// o TS estreita o ramo verdadeiro para `never` e o lint reprova — o valor é um parâmetro
// de configuração que se espera trocar, não uma constante literal.
const WHATSAPP_NUMBER: string = '';

interface SocialLink {
  name: string;
  href: string;
  logo: string;
}

// O círculo do WhatsApp só entra na fileira QUANDO há número. Com a constante vazia, o
// href era `https://wa.me/` — um link que abre uma aba inútil e devolve erro do próprio
// WhatsApp; oferecer um contato quebrado é pior que não oferecê-lo. Degradar para
// "ausente" também mantém honesto o rótulo "fale com a gente".
const links: SocialLink[] = [
  { name: 'Otimotex', href: 'https://www.otimotex.com.br/', logo: '/logos/otimotex.png' },
  { name: 'Lebianco', href: 'https://www.lebianco.com.br/', logo: '/logos/Lebianco-vermelho.png' },
  ...(WHATSAPP_NUMBER
    ? [{ name: 'WhatsApp', href: `https://wa.me/${WHATSAPP_NUMBER}`, logo: '/logos/whatsapp.png' }]
    : []),
];

// Molecule — fileira de logos clicáveis com rótulo abaixo de cada círculo.
export default function SocialLinksBar() {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-sm font-medium text-loginGreen-inkMuted tracking-wider uppercase">
        fale com a gente
      </span>
      <div className="flex justify-center gap-7">
        {links.map(({ name, href, logo }) => (
          <div key={name} className="flex flex-col items-center gap-1">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={name}
              className="flex w-11 h-11 items-center justify-center rounded-full
                border-2 border-loginGreen-borderField bg-loginGreen-socialBg
                overflow-hidden transition-colors
                hover:border-loginGreen-borderFocus hover:bg-loginGreen-fieldFocus"
            >
              <img src={logo} alt={name} className="w-7 h-7 object-contain" />
            </a>
            <span className="text-sm font-medium text-loginGreen-inkMuted">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
