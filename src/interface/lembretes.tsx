import { useEffect, useState, useSyncExternalStore } from 'react'
import { repositorioLembretes } from '../dados/instancia.ts'
import { lembretes } from '../sincronizacao/instancia.ts'
import { useLeitura } from './useLeitura.ts'
import type { Id } from '../dominio/ficha.ts'

/** Reserva D-068: lê base local, mostra caminhos existentes e só pede permissão no botão. */
export function Lembretes({ aoAbrirFicha, aoVerMinimo, aoVerCaixa }: {
  aoAbrirFicha: (id: Id) => void; aoVerMinimo: () => void; aoVerCaixa: (mes: string) => void
}) {
  const versao = useSyncExternalStore(lembretes.assinar, lembretes.versao)
  const [dia, setDia] = useState(0)
  const leitura = useLeitura(() => repositorioLembretes.ler(), `lembretes/${versao}/${dia}`)
  useEffect(() => {
    const reler = () => setDia((n) => n + 1)
    window.addEventListener('focus', reler)
    const intervalo = setInterval(reler, 60_000)
    return () => { window.removeEventListener('focus', reler); clearInterval(intervalo) }
  }, [])
  if (leitura.estado === 'lendo') return null
  if (leitura.estado === 'falhou') return <p role="status">Não foi possível conferir os lembretes. Abra novamente para tentar.</p>
  const { motivos, inscricao, nomes } = leitura.valor
  const temMotivo = motivos.fichas.length > 0 || motivos.minimo.length > 0 || motivos.caixa !== null
  if (!temMotivo && !inscricao) return null
  const ligada = inscricao?.ativa === true
  const estado = inscricao?.estado
  const erro = lembretes.erro()
  return (
    <section id="lembretes" className="my-4 rounded-xl border border-borda bg-papel p-4" aria-labelledby="titulo-lembretes">
      <h2 id="titulo-lembretes" className="m-0 text-lg">Lembretes</h2>
      {motivos.fichas.length > 0 && <details><summary className="min-h-11 cursor-pointer py-2 text-acento underline focus-visible:outline-3 focus-visible:outline-acento">Parcelas de hoje ou atrasadas ({motivos.fichas.length})</summary>
        {motivos.fichas.map((f) => <button key={f.clienteId} type="button" className="block min-h-11 max-w-full text-left text-acento underline [overflow-wrap:anywhere]"
          onClick={() => aoAbrirFicha(f.clienteId)}>Conferir a fichinha de {nomes[f.clienteId]} ›</button>)}
      </details>}
      {motivos.minimo.length > 0 && <button type="button" className="block min-h-11 text-left text-acento underline" onClick={aoVerMinimo}>Conferir produtos no mínimo ›</button>}
      {motivos.caixa && <button type="button" className="block min-h-11 text-left text-acento underline" onClick={() => { if (motivos.caixa) aoVerCaixa(motivos.caixa.mes) }}>Conferir o caixa do mês anterior ›</button>}
      {!temMotivo && <p>Nenhum lembrete para conferir agora.</p>}
      <p className="text-[0.95rem] text-suave">Estes lembretes usam as anotações deste aparelho.</p>
      {ligada && estado === 'ativa' && <p role="status">Avisos ligados neste aparelho. Tentativa de envio às 9h, com as anotações já enviadas.</p>}
      {estado === 'pendente' && <p role="status">{ligada ? 'Falta concluir os avisos quando houver internet.' : 'Avisos desligados aqui. Falta avisar ao serviço quando houver internet.'}</p>}
      {(estado === 'solicitada' || estado === 'invalida' || estado === 'problema') && <p role="status">Falta concluir os avisos. Toque abaixo para tentar; se acabou de atualizar, feche e abra pelo ícone.</p>}
      {erro === 'negada' && <p role="status">Os avisos não foram permitidos. Os lembretes continuam aqui.</p>}
      {erro === 'rede' && <p role="status">Não foi possível concluir os avisos agora. Suas anotações continuam guardadas.</p>}
      {erro === 'indisponivel' && <p role="status">Os avisos ainda não estão disponíveis neste aparelho. Confira os lembretes por aqui.</p>}
      {(!ligada || estado !== 'ativa') && lembretes.disponivel() && <button type="button" className="min-h-11 text-left font-semibold text-acento underline" onClick={() => { void lembretes.ativar() }}>Me avisa neste aparelho</button>}
      {ligada && <button type="button" className="ml-2 min-h-11 text-left text-acento underline" onClick={() => { void lembretes.desligar() }}>Desligar avisos neste aparelho</button>}
    </section>
  )
}

/** O toque externo só sinaliza o caminho; não troca a tela nem perde um formulário (D-079). */
export function AvisoDoLembrete() {
  const [aberto, setAberto] = useState(() => new URL(window.location.href).searchParams.get('lembretes') === '1')
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let montado = true
    const ouvir = (evento: MessageEvent) => {
      if (!evento.source || evento.data?.tipo !== 'ABRIR_LEMBRETES') return
      if (evento.source === navigator.serviceWorker.controller) { setAberto(true); return }
      // D-032/079: na primeira abertura o worker já pode estar ativo sem controlar
      // esta janela. Validar sua identidade sem assumir controle ou recarregar.
      void navigator.serviceWorker.getRegistration().then((registro) => {
        if (montado && registro?.active && evento.source === registro.active) setAberto(true)
      }).catch(() => undefined)
    }
    navigator.serviceWorker.addEventListener('message', ouvir)
    return () => { montado = false; navigator.serviceWorker.removeEventListener('message', ouvir) }
  }, [])
  return aberto ? <div role="status" className="mx-auto max-w-xl border-b border-borda bg-papel px-5 py-2">Há lembretes para conferir no começo.
    <button type="button" className="ml-2 min-h-11 text-acento underline" onClick={() => setAberto(false)}>Fechar aviso</button>
  </div> : null
}
