import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { repositorio, repositorioEstoque } from '../dados/instancia.ts'
import { emReais, multiplicar } from '../dominio/dinheiro.ts'
import { chaveDoEfeito, type MovimentoEstoque, type ReferenciaEfeito } from '../dominio/estoque.ts'
import { Botao } from './Botao.tsx'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { lerEstoque } from './leitura-de-estoque.ts'
import { nomeDoMovimento, PALAVRAS_DO_ESTOQUE as P, quantidadeComSinal } from './palavras-do-estoque.ts'
import { efeitoDoAjuste } from './rascunho-do-ajuste.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

function detalhes(movimento: MovimentoEstoque, historico: readonly MovimentoEstoque[]): string {
  switch (movimento.tipo) {
    case 'compra': return `${movimento.quantidade} × ${movimento.custoUnitario === undefined ? P.desconhecido : emReais(movimento.custoUnitario)}${movimento.custoUnitario === undefined ? '' : ` = ${emReais(multiplicar(movimento.custoUnitario, movimento.quantidade))}`}`
    case 'contagem': return `${P.contado}: ${movimento.totalContado} · Ajuste: ${quantidadeComSinal(efeitoDoAjuste(movimento, 0, movimento))}`
    case 'anulacao': {
      const alvo = historico.find((item) => chaveDoEfeito(item) === chaveDoEfeito(movimento.alvo))
      return alvo ? `${nomeDoMovimento(alvo)} de ${alvo.data.split('-').reverse().join('/')} · ${detalhes(alvo, [])}` : ''
    }
    case 'retorno': return `+${movimento.quantidade}`
    case 'entrega': case 'saida': return `−${movimento.quantidade}`
  }
}

/** Consulta de RF-12/25: posição relida após gravar, histórico e acesso à correção de D-013. */
export function TelaEstoque({ produtoId, aoVoltar, aoCompra, aoInicial, aoAjuste, aoCorrigir, aoCorrigirAjuste, aoCadastro, aoVenda }: {
  produtoId: string; aoVoltar: () => void; aoCompra: () => void; aoInicial: () => void
  aoCorrigir: (alvo: ReferenciaEfeito) => void; aoCadastro: () => void
  aoAjuste: (conferir: boolean) => void; aoCorrigirAjuste: (alvo: ReferenciaEfeito) => void
  aoVenda: (clienteId: string, vendaId: string) => void
}) {
  const leitura = useLeitura(async () => ({ ...lerEstoque(await repositorioEstoque.lerEstado(), produtoId), clientes: await repositorio.listarClientes() }), produtoId)
  return <main className="tela">
    <Topo titulo={P.titulo} aoVoltar={aoVoltar} />
    <IndicadorDeEnvio />
    {leitura.estado !== 'lido' ? <p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p> : <>
      <h2 className="break-words">{leitura.valor.produto.nome}</h2>
      <section aria-label={P.fisico} className="rounded-xl border border-borda bg-papel p-4">
        <p className="m-0">{P.fisico}: <strong className="text-3xl" data-estoque-fisico>{leitura.valor.fisico}</strong></p>
        <p className="my-1">Prometido: <strong data-estoque-prometido>{leitura.valor.prometido}</strong></p>
        <p className="my-1">Disponível: <strong>{leitura.valor.disponivel}</strong>{leitura.valor.falta > 0 && ` · Faltam ${leitura.valor.falta}`}</p>
        <p className="mb-0">{P.custoAtual}: {leitura.valor.custo === undefined ? P.desconhecido : emReais(leitura.valor.custo)}</p>
      </section>
      {leitura.valor.contagensAfetadas && <p role="status" className="font-semibold text-atraso">{P.afetada}</p>}
      <Botao tipo="secundario" className="mt-4" aoTocar={() => aoAjuste(true)}>{P.conferir}</Botao>
      <Botao tipo="secundario" className="mt-3" aoTocar={() => aoAjuste(false)}>{P.ajuste}</Botao>
      {leitura.valor.fisico < 0 && <p role="status" className="font-semibold text-atraso">{P.divergencia}</p>}
      {leitura.valor.pendencias.length > 0 && <section aria-label="A entregar">
        <h2>A entregar</h2>
        {leitura.valor.pendencias.map((p) => {
          const cliente = leitura.valor.clientes.find((c) => c.id === p.clienteId)
          return <div key={p.itemId} className="my-2 border-b border-borda py-2">
            <p>{cliente?.nome ?? 'Fichinha'} · {p.pendente} a entregar{p.excesso > 0 && ` · ${p.excesso} entregue(s) além da venda: conferir`}</p>
            {cliente && !cliente.desativadoEm ? <Botao tipo="secundario" aoTocar={() => aoVenda(p.clienteId, p.vendaId)}>Ver venda de {cliente.nome}</Botao> : <p>Fichinha desativada</p>}
          </div>
        })}
      </section>}
      <Botao tipo="secundario" className="mt-4" aoTocar={aoInicial}>{P.inicial}</Botao>
      <Botao tipo="secundario" className="mt-3" aoTocar={aoCadastro}>{P.cadastro}</Botao>
      <h2 className="mt-6">{P.historico}</h2>
      {leitura.valor.historico.length === 0 && <p>{P.vazio}</p>}
      <ul aria-label={P.historico} className="list-none p-0">
        {leitura.valor.historico.map(({ movimento, superada, anulada, resolvida, problema, afetada, corrigivel }) => <li key={chaveDoEfeito(movimento)} data-movimento-id={movimento.id} data-revisao={movimento.revisao} className="border-b border-borda py-3">
          <p className={`m-0 font-semibold ${superada || anulada ? 'line-through' : ''}`}>{nomeDoMovimento(movimento)} · {movimento.data.split('-').reverse().join('/')}</p>
          <p className="my-1 break-words">{detalhes(movimento, leitura.valor.historico.map((item) => item.movimento))}</p>
          {superada && <p className="my-1 text-suave">{P.corrigida}</p>}
          {anulada && <p className="my-1 text-suave">{P.anulada}</p>}
          {resolvida && <p className="my-1 text-suave">{P.resolvida}</p>}
          {afetada && <p role="status" className="my-1 text-atraso">{P.conferir}</p>}
          {problema && <p role="status" className="my-1 text-atraso">{P.problema}</p>}
          {corrigivel && <Botao tipo="secundario" className="mt-2" aoTocar={() => {
            const corrigir = movimento.tipo === 'saida' || (movimento.tipo === 'contagem' && movimento.motivo === 'conferencia') ? aoCorrigirAjuste : aoCorrigir
            corrigir({ id: movimento.id, revisao: movimento.revisao })
          }}>{P.corrigir}</Botao>}
        </li>)}
      </ul>
      <RodapeDeAcoes><Botao tipo="principal" aoTocar={aoCompra}>{P.compra}</Botao></RodapeDeAcoes>
    </>}
  </main>
}
