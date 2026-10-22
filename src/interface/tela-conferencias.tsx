import { useState } from 'react'
import { repositorio, repositorioEstoque } from '../dados/instancia.ts'
import { prepararIntencaoRecusada } from '../dados/recuperar-tentativa.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { projetarEstoque } from '../dominio/estoque.ts'
import { saldo, totalDaVenda } from '../dominio/ficha.ts'
import type { GrupoEstoque } from '../dominio/vendas-estoque.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { hoje } from './datas.ts'
import { fraseVendaEstoque } from './palavras-venda-estoque.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'
import { lerQuantidade } from './venda-com-estoque.ts'

/** Só aparece quando há recusa definitiva; resposta perdida permanece no indicador normal (Q47A). */
export function AvisoConferencias({ aoAbrir }: { aoAbrir: () => void }) {
  const leitura = useLeitura(() => repositorioEstoque.listarRecusas(), 'recusas')
  if (leitura.estado !== 'lido' || leitura.valor.length === 0) return null
  return <button type="button" className="block min-h-11 border-0 bg-transparent px-1 text-left font-semibold text-atraso underline" onClick={aoAbrir}>
    Conferir anotações ({leitura.valor.length})</button>
}

function ResumoTentativa({ grupo }: { grupo: GrupoEstoque }) {
  return <ul className="list-none p-0">
    {grupo.lancamentos.map((l) => <li key={l.id}>{l.tipo === 'venda' ? `Venda: ${l.itens.map((i) => `${i.quantidade ?? 1} × ${i.descricao}`).join(', ')} · ${emReais(totalDaVenda(l))}`
      : l.tipo === 'estorno' ? 'Desfazer uma anotação' : l.tipo === 'recebimento' ? `Pagamento: ${emReais(l.valor)}` : 'Anotação na fichinha'}</li>)}
    {grupo.movimentos.map((m) => <li key={`${m.id}/${m.revisao}`}>{m.tipo === 'entrega' ? `Entregue: ${m.quantidade}` : m.tipo === 'retorno' ? `Voltou: ${m.quantidade}` :
      m.tipo === 'compra' ? `Compra: ${m.quantidade}` : m.tipo === 'contagem' ? `Contado: ${m.totalContado}` : m.tipo === 'saida' ? `Saiu: ${m.quantidade}` : 'Correção de estoque'}</li>)}
  </ul>
}

/** Conferência humana do recusado e da situação sem seus efeitos, sem apagar evidência (D-057/Q47A). */
export function TelaConferencias({ aoVoltar }: { aoVoltar: () => void }) {
  const [selecionada, setSelecionada] = useState<string>()
  const [releituras, setReleituras] = useState(0)
  const [erro, setErro] = useState<string>()
  const leitura = useLeitura(async () => ({ recusas: await repositorioEstoque.listarRecusas(), clientes: await repositorio.listarClientes() }), `recusas/${releituras}`)
  async function abrir(id: string, legadoId?: string) {
    if (!legadoId) { setSelecionada(id); return }
    const resultado = await repositorioEstoque.registrarRecusaLegada(legadoId)
    if (!resultado.ok) { setErro(fraseVendaEstoque(resultado.motivo)); return }
    setSelecionada(resultado.valor.id)
  }
  return <main className="tela"><Topo titulo="Conferir anotações" aoVoltar={aoVoltar} />
    {erro && <p role="status">{erro}</p>}
    {selecionada ? <Conferencia key={selecionada} versaoId={selecionada} aoConcluir={() => { setSelecionada(undefined); setReleituras((a) => a + 1) }} /> :
      leitura.estado !== 'lido' ? <p>{leitura.estado === 'falhou' ? 'Não deu para abrir as anotações.' : 'Abrindo…'}</p> : <>
        {leitura.valor.recusas.length === 0 && <p>Nenhuma anotação para conferir.</p>}
        {leitura.valor.recusas.map((r) => {
          const ids = r.versao?.grupo.lancamentos.map((l) => l.clienteId) ?? []
          const nomes = leitura.valor.clientes.filter((c) => ids.includes(c.id)).map((c) => c.nome).join(', ')
          return <Botao key={r.id} tipo="secundario" className="my-3" aoTocar={() => void abrir(r.id, r.versao ? undefined : r.legadoId)}>Conferir {nomes || 'anotação de venda/estoque'}</Botao>
        })}
      </>}
  </main>
}

function Conferencia({ versaoId, aoConcluir }: { versaoId: string; aoConcluir: () => void }) {
  const leitura = useLeitura(async () => ({ conferencia: await repositorioEstoque.lerConferencia(versaoId), clientes: await repositorio.listarClientes() }), versaoId)
  const [intencao, setIntencao] = useState('')
  const [conferido, setConferido] = useState(false)
  const [quantidades, setQuantidades] = useState<Record<string, string>>({})
  const [erro, setErro] = useState<string>()
  const [gravando, setGravando] = useState(false)
  if (leitura.estado !== 'lido' || !leitura.valor.conferencia) return <p>{leitura.estado === 'falhou' ? 'Não deu para conferir.' : 'Abrindo…'}</p>
  const { conferencia: c, clientes } = leitura.valor
  if (c.encerrada) return <><p>Esta conferência já foi concluída.</p><Botao tipo="principal" aoTocar={aoConcluir}>Voltar</Botao></>
  const tentativa = c.versao.grupo
  const estorno = tentativa.lancamentos.find((l) => l.tipo === 'estorno')
  const alvo = c.semTentativa.lancamentos.find((l) => l.id === (tentativa.operacao.alvo?.id ?? (estorno?.tipo === 'estorno' ? estorno.estornaId : '')))
  const jaCancelada = alvo && c.semTentativa.lancamentos.some((l) => l.tipo === 'estorno' && l.estornaId === alvo.id)
  const itens = alvo?.tipo === 'venda' ? alvo.itens : tentativa.lancamentos.flatMap((l) => l.tipo === 'venda' ? l.itens : [])
  const entradas = new Map(itens.flatMap((i) => i.id && i.produtoId ? [[i.id, i.descricao] as const] : []))
  for (const m of tentativa.movimentos) if (m.tipo === 'entrega' || m.tipo === 'retorno') entradas.set(m.itemId, c.estado.produtos.find((p) => p.id === m.produtoId)?.nome ?? 'Produto')
  const valores = Object.fromEntries([...entradas.keys()].map((id) => [id, lerQuantidade(quantidades[id] ?? '')]))
  const quantidadesValidas = Object.values(valores).every((v) => v !== null)
  const somenteRetorno = tentativa.operacao.tipo === 'cancelamento' && jaCancelada
  const precisaNova = intencao === 'sim' && !(somenteRetorno && Object.values(valores).every((v) => v === 0))
  async function confirmar() {
    if (!conferido || !intencao || gravando || intencao === 'sim' && !quantidadesValidas) return
    setGravando(true); setErro(undefined)
    try {
      const resultado = await repositorioEstoque.encerrar(versaoId, { data: hoje(), confirmado: true, intencaoPendente: precisaNova,
        prepararNova: precisaNova ? (estado) => prepararIntencaoRecusada(estado, tentativa, hoje(), Object.fromEntries(Object.entries(valores).map(([id, valor]) => [id, valor ?? 0]))) : undefined })
      if (!resultado.ok) { setErro(fraseVendaEstoque(resultado.motivo)); return }
      aoConcluir()
    } catch { setErro('Não deu para concluir. A tentativa continua guardada para conferir.') }
    finally { setGravando(false) }
  }
  const clienteIds = new Set(tentativa.lancamentos.map((l) => l.clienteId))
  return <>
    <h2>O que ficou recusado</h2><ResumoTentativa grupo={tentativa} />
    <p>Essa tentativa não foi aceita no envio. Sua anotação e o motivo ficarão guardados depois desta conferência.</p>
    <h2>Como fica sem essa tentativa</h2>
    {clientes.filter((cl) => clienteIds.has(cl.id)).map((cl) => <p key={cl.id}>{cl.nome}: {emReais(saldo(c.semTentativa.lancamentos.filter((l) => l.clienteId === cl.id)))}</p>)}
    {[...new Set(tentativa.movimentos.map((m) => m.produtoId).concat(alvo?.tipo === 'venda' ? alvo.itens.flatMap((i) => i.produtoId ? [i.produtoId] : []) : []))].map((id) => {
      const p = projetarEstoque(c.semTentativa.movimentos, id)
      return <p key={id}>{c.estado.produtos.find((p) => p.id === id)?.nome}: em mãos {p.ok ? p.valor.fisico : 'a conferir'}</p>
    })}
    {c.aceito.operacoes.filter((g) => g.operacao.id === tentativa.operacao.id || g.operacao.alvo?.id === alvo?.id && alvo).map((g) => <section key={g.operacao.id}><h3>Já aceito no envio</h3><ResumoTentativa grupo={g} /></section>)}
    {jaCancelada && <p role="status">A venda já foi desfeita. Não será desfeita outra vez; informe só mercadoria que ainda voltou.</p>}
    <p>Confira também o que aconteceu com a cliente e a mercadoria.</p>
    <label className="my-2 flex min-h-11 items-center gap-3"><input type="radio" name="intencao" value="nao" checked={intencao === 'nao'} onChange={() => setIntencao('nao')} className="h-11 w-11" />Não precisa fazer essa anotação de novo</label>
    <label className="my-2 flex min-h-11 items-center gap-3"><input type="radio" name="intencao" value="sim" checked={intencao === 'sim'} onChange={() => setIntencao('sim')} className="h-11 w-11" />Ainda preciso anotar o que aconteceu</label>
    {intencao === 'sim' && [...entradas].map(([id, nome]) => <label key={id} className="my-3 block">
      {tentativa.operacao.tipo === 'cancelamento' || tentativa.operacao.tipo === 'retorno' || alvo?.tipo === 'venda' && alvo.itens.some((i) => i.id === id) && tentativa.operacao.tipo === 'troca' ? 'Voltou de verdade' : 'Entregue de verdade'}: {nome}
      <input className={CLASSES_DE_CAMPO} inputMode="numeric" value={quantidades[id] ?? ''} placeholder="0 se nada" onChange={(e) => setQuantidades((a) => ({ ...a, [id]: e.target.value }))} />
    </label>)}
    <label className="my-4 flex min-h-11 items-center gap-3"><input className="h-11 w-11 flex-none" type="checkbox" checked={conferido} onChange={(e) => setConferido(e.target.checked)} />Conferi os valores e o que aconteceu</label>
    {erro && <p role="status" className="text-atraso">{erro}</p>}
    <Botao tipo="principal" aoTocar={() => void confirmar()} desabilitado={!intencao || !conferido || gravando || intencao === 'sim' && !quantidadesValidas}>Confirmar conferência</Botao>
  </>
}
