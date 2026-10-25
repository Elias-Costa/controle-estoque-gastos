import { repositorioModelos } from '../dados/instancia.ts'
import { MODELOS_ORIGINAIS, type SituacaoMensagem } from '../dados/modelos-whatsapp.ts'
import { BotaoLink } from './Botao.tsx'
import { renderizarModelo, type DadosDaMensagem } from './modelos-da-mensagem.ts'
import { useLeitura } from './useLeitura.ts'
import { linkDoWhatsApp } from './whatsapp.ts'

/** A prévia é o mesmo texto do href; só o toque no link abre WhatsApp, sem enviar (D-007/069). */
export function MensagemWhatsApp({ situacao, dados, telefone, acao }: {
  situacao: SituacaoMensagem; dados: DadosDaMensagem; telefone: string | undefined; acao: string
}) {
  const leitura = useLeitura(() => repositorioModelos.ler(), 'mensagem-whatsapp')
  if (leitura.estado !== 'lido') return leitura.estado === 'falhou'
    ? <p role="alert" className="text-atraso">Não deu para abrir a mensagem. Tente de novo.</p> : null
  const resultado = renderizarModelo((leitura.valor?.modelos ?? MODELOS_ORIGINAIS)[situacao], situacao, dados)
  if (!resultado.ok) return <p role="alert" className="text-atraso">Não deu para preparar a mensagem. Confira o texto e os dados da fichinha.</p>
  return <div className="mt-4 text-left">
    <p className="mb-1 font-semibold">Mensagem para conferir</p>
    <p data-mensagem-previa className="mt-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{resultado.texto}</p>
    <BotaoLink tipo="secundario" href={linkDoWhatsApp(telefone, resultado.texto)}>{acao}</BotaoLink>
  </div>
}
