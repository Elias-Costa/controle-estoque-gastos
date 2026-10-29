import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { leituraProblemasDeEnvio } from '../dados/instancia.ts'
import type { ProblemaDeEnvio } from '../dados/problemas-de-envio.ts'
import { CARIMBO_DE_BUILD } from '../plataforma/versao.ts'
import { conta, consultarContatoSuporte } from '../sincronizacao/instancia.ts'
import { Botao, BotaoLink } from './Botao.tsx'
import { linkDoRelatoDeEnvio } from './relato-de-envio.ts'
import type { Leitura } from './useLeitura.ts'
import { CompletarDescricaoEnvio } from './completar-descricao-envio.tsx'

/** D-077: explica a recusa sem jargão e oferece relato técnico pronto só para o mantenedor. */
export function RelatarProblemaEnvio() {
  const estadoDaConta = useSyncExternalStore(conta.assinar, conta.estado, conta.estado)
  const [leitura, setLeitura] = useState<Leitura<readonly ProblemaDeEnvio[]>>({ estado: 'lendo' })
  useEffect(() => leituraProblemasDeEnvio.assinar(
    (valor) => setLeitura({ estado: 'lido', valor }),
    () => setLeitura({ estado: 'falhou' }),
  ), [])
  if (leitura.estado === 'lido' && leitura.valor.length === 0) return null
  return <aside aria-label="Problema no envio" className="my-3 rounded-xl border border-borda bg-papel p-3">
    <p className="mt-0">{leitura.estado === 'lido' && leitura.valor.length > 1 ? 'Algumas anotações não puderam ser enviadas.' : 'Uma anotação não pôde ser enviada.'}</p>
    {leitura.estado === 'lido' && leitura.valor.some((p) => p.tabela === 'lancamentos' && p.problema.codigo === '23514' && p.problema.constraint === 'lancamentos_sem_itens') && <CompletarDescricaoEnvio />}
    {leitura.estado === 'lendo' ? <p role="status">Preparando relato…</p>
      : leitura.estado === 'falhou' ? <p role="status">Não consegui preparar o relato. Feche e abra o aplicativo para tentar de novo.</p>
        : estadoDaConta !== 'entrou' ? <p>Entre na sua conta para relatar o problema.</p>
          : <AcaoRelato problemas={leitura.valor} />}
  </aside>
}

function AcaoRelato({ problemas }: { problemas: readonly ProblemaDeEnvio[] }) {
  const [preparando, setPreparando] = useState(false), [erro, setErro] = useState<string>()
  const [alternativa, setAlternativa] = useState<string>()
  const janela = useRef<Window | null>(null), ativa = useRef(true)
  useEffect(() => {
    ativa.current = true
    return () => { ativa.current = false; janela.current?.close() }
  }, [])
  async function relatar() {
    if (preparando || conta.estado() !== 'entrou') return
    setPreparando(true); setErro(undefined); setAlternativa(undefined)
    try {
      // Reserva no gesto; abrir janela somente após a rede pode ser bloqueado pelo navegador.
      janela.current = window.open('about:blank', '_blank')
      if (janela.current) { janela.current.opener = null; janela.current.document.body.textContent = 'Preparando relato…' }
      const resposta = await consultarContatoSuporte()
      if (!ativa.current || conta.estado() !== 'entrou') { janela.current?.close(); return }
      if (!resposta.ok) {
        janela.current?.close(); janela.current = null
        setErro(resposta.motivo === 'entrar' ? 'Entre novamente na sua conta para relatar o problema.'
          : resposta.motivo === 'nao-configurado' ? 'O contato para ajuda ainda não está disponível.'
            : 'Não consegui abrir o contato para ajuda. Confira a conexão e tente de novo.')
        return
      }
      const link = linkDoRelatoDeEnvio(problemas, CARIMBO_DE_BUILD, resposta.telefone)
      if (janela.current && !janela.current.closed) { janela.current.location.replace(link); janela.current = null }
      else setAlternativa(link)
    } catch {
      janela.current?.close(); janela.current = null
      if (ativa.current) setErro('Não consegui abrir o WhatsApp. Tente de novo.')
    } finally { if (ativa.current) setPreparando(false) }
  }
  return <>
    <Botao tipo="secundario" aoTocar={() => void relatar()} desabilitado={preparando}>{preparando ? 'Preparando relato…' : 'Relatar problema'}</Botao>
    {alternativa && <BotaoLink tipo="secundario" href={alternativa}>Abrir WhatsApp</BotaoLink>}
    {erro && <p role="status">{erro}</p>}
    <p className="mb-0 text-[0.9rem] text-suave">É preciso estar conectado. O relato abre pronto no WhatsApp; confirme o envio.</p>
  </>
}
