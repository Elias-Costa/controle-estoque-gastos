/** Conteúdo externo não escolhe texto, URL ou dados da tela bloqueada (D-068/079). */
export function avisoDaMensagemPush(valor: unknown) {
  const rodada = typeof valor === 'object' && valor !== null && 'formato' in valor && valor.formato === 1 &&
    'rodada' in valor && typeof valor.rodada === 'string' && /^[a-f0-9]{32}$/.test(valor.rodada) ? valor.rodada : 'atual'
  return { titulo: 'Fichinhas', opcoes: { body: 'Há lembretes para conferir.', tag: `lembretes-${rodada}`,
    icon: '/icones/icone-192.png', data: { lembretes: true } } }
}
