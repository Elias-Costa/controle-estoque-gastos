import { useId, useRef, useState } from 'react'
import { operacoesEstoque, repositorioEstoque } from '../dados/instancia.ts'
import type { EstadoLocalEstoque } from '../dados/repositorio-estoque.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { chaveDoEfeito, referenciaDoEfeito, type ReferenciaEfeito } from '../dominio/estoque.ts'
import { Botao } from './Botao.tsx'
import { Campo, CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { hoje } from './datas.ts'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { fraseDaGuardaDaEntrada, PALAVRAS_DO_ESTOQUE as P } from './palavras-do-estoque.ts'
import { conferirEntrada, rascunhoDaEntrada, type EntradaDeEstoque, type RascunhoDaEntrada } from './rascunho-da-entrada.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** Compra ou contagem inicial sobre operações locais; a confirmação não espera envio. */
export function TelaEntrada({ produtoId, tipo, alvo, aoVoltar, aoSalvar }: {
  produtoId: string; tipo: 'compra' | 'estoque-inicial'; alvo?: ReferenciaEfeito
  aoVoltar: () => void; aoSalvar: (produtoId: string) => void
}) {
  const leitura = useLeitura(() => repositorioEstoque.lerEstado(), `${produtoId}/${alvo ? chaveDoEfeito(alvo) : tipo}`)
  const movimento = leitura.estado === 'lido' && alvo ? leitura.valor.movimentos.find((item) => chaveDoEfeito(item) === chaveDoEfeito(alvo)) : undefined
  const original = movimento?.tipo === 'compra' || movimento?.tipo === 'contagem' ? movimento : undefined
  if (leitura.estado !== 'lido' || (alvo && !original)) return <main className="tela">
    <Topo titulo={P.titulo} aoVoltar={aoVoltar} /><p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p>
  </main>
  return <FormularioEntrada estado={leitura.valor} produtoId={produtoId} tipo={tipo} original={original} aoVoltar={aoVoltar} aoSalvar={aoSalvar} />
}

function FormularioEntrada({ estado, produtoId, tipo, original, aoVoltar, aoSalvar }: {
  estado: EstadoLocalEstoque; produtoId: string; tipo: 'compra' | 'estoque-inicial'; original?: EntradaDeEstoque
  aoVoltar: () => void; aoSalvar: (produtoId: string) => void
}) {
  // O alvo/revisão que abriu a correção não muda silenciosamente durante uma releitura da fila.
  const [alvo] = useState(original)
  const inicial = alvo ? alvo.tipo === 'contagem' : tipo === 'estoque-inicial'
  const [rascunho, setRascunho] = useState(() => rascunhoDaEntrada(produtoId, hoje(), alvo))
  const [gravando, setGravando] = useState(false), [erro, setErro] = useState<string | null>(null)
  const trava = useRef(false), quantidadeId = useId(), produtoCampo = useId()
  const conferencia = conferirEntrada(rascunho, inicial ? 'estoque-inicial' : 'compra', hoje())
  const produto = estado.produtos.find((item) => item.id === rascunho.produtoId)
  function mudar(mudanca: Partial<RascunhoDaEntrada>): void { setRascunho((anterior) => ({ ...anterior, ...mudanca })); setErro(null) }
  async function salvar(): Promise<void> {
    if (!conferencia.ok || trava.current) return
    trava.current = true; setGravando(true); setErro(null)
    try {
      const resultado = alvo
        ? await operacoesEstoque.corrigirRegistroMovimento(referenciaDoEfeito(alvo), conferencia.valor.entrada)
        : await operacoesEstoque.registrarMovimento(conferencia.valor.entrada)
      if (!resultado.ok) { setErro(fraseDaGuardaDaEntrada(resultado.motivo)); return }
      aoSalvar(rascunho.produtoId)
    } catch { setErro(P.falhaGravacao) }
    finally { trava.current = false; setGravando(false) }
  }
  return <main className="tela">
    <Topo titulo={alvo ? P.correcao : inicial ? P.inicial : P.compra} aoVoltar={() => { if (!trava.current) aoVoltar() }} />
    <IndicadorDeEnvio />
    <p>{inicial ? P.inicialExplicacao : P.compraExplicacao}</p>
    {alvo && <p>{P.correcaoExplicacao}</p>}
    <fieldset disabled={gravando} className="min-w-0 border-0 p-0">
      <Rotulo para={produtoCampo}>{P.produto}</Rotulo>
      <select id={produtoCampo} className={CLASSES_DE_CAMPO} value={rascunho.produtoId} disabled={inicial} onChange={(evento) => mudar({ produtoId: evento.target.value })}>
        {[...estado.produtos].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map((item) => <option key={item.id} value={item.id}>{[item.nome, item.marca, item.codigoCatalogo].filter(Boolean).join(' · ')}</option>)}
      </select>
      <Rotulo para={quantidadeId}>{inicial ? P.contado : P.quantidade}</Rotulo>
      <input id={quantidadeId} className={CLASSES_DE_CAMPO} type="text" inputMode="numeric" autoComplete="off" value={rascunho.quantidadeTexto} onChange={(evento) => mudar({ quantidadeTexto: evento.target.value })} />
      {!inicial && <CampoDeDinheiro rotulo={P.custo} texto={rascunho.custoTexto} aoMudar={(custoTexto) => mudar({ custoTexto })} permitirZero />}
      <Campo rotulo={inicial ? P.dataContagem : P.data} tipo="date" valor={rascunho.data} aoMudar={(data) => mudar({ data })} />
    </fieldset>
    {inicial ? <p>{P.custoInicial} {produto?.custoManual === undefined ? P.desconhecido : emReais(produto.custoManual)}</p>
      : <p className="text-2xl font-semibold" aria-live="polite">{P.total}: {conferencia.ok && conferencia.valor.total !== undefined ? emReais(conferencia.valor.total) : P.desconhecido}</p>}
    {!conferencia.ok && <p role="status" className="font-semibold text-atraso">{fraseDaGuardaDaEntrada(conferencia.motivo)}</p>}
    {erro && <p role="alert" className="font-semibold text-atraso">{erro}</p>}
    <div className="rodape-acao"><Botao tipo="principal" aoTocar={() => void salvar()} desabilitado={!conferencia.ok || gravando}>{gravando ? P.salvando : P.salvar}</Botao></div>
  </main>
}
