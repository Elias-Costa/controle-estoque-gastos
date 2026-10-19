import { useState } from 'react'
import { operacoesEstoque, repositorioEstoque } from '../dados/instancia.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { projetarEstoque } from '../dominio/estoque.ts'
import { conferirTroca } from '../dominio/trocas-venda.ts'
import { criarItemVendido, situacaoDoItem, sugerirEntrega, type VendaEstoque } from '../dominio/vendas-estoque.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { hoje } from './datas.ts'
import { ItensDaVenda } from './itens-da-venda.tsx'
import { fraseVendaEstoque } from './palavras-venda-estoque.ts'
import { useLeitura } from './useLeitura.ts'
import { conferirVendaComEstoque, lerQuantidade, type RascunhoComEstoque } from './venda-com-estoque.ts'

/** Entrega, cancelamento e retorno real, separados da correção de anotação (D-013/017/059). */
export function AcoesDaVenda({ venda, cancelada, comProblema, aoCorrigir, aoConcluir }: {
  venda: VendaEstoque; cancelada: boolean; comProblema: boolean; aoCorrigir: () => void; aoConcluir: () => void
}) {
  const leitura = useLeitura(async () => ({ estado: await repositorioEstoque.lerEstado(), catalogo: await repositorioEstoque.lerCatalogo() }), venda.id)
  const [modo, setModo] = useState<string | null>(null)
  const [quantidades, setQuantidades] = useState<Record<string, string>>({})
  const [data, setData] = useState(hoje())
  const [erro, setErro] = useState<string>()
  const [gravando, setGravando] = useState(false)
  const [novos, setNovos] = useState<RascunhoComEstoque>({ itens: [], data: hoje(), descontoTexto: '', pagamento: 'avista', forma: 'dinheiro', vezes: 1, edicoes: [] })
  if (leitura.estado !== 'lido') return <p role="status">{leitura.estado === 'falhou' ? 'Não deu para abrir as entregas.' : 'Abrindo entregas…'}</p>
  const { estado, catalogo } = leitura.valor
  const substituida = cancelada && estado.lancamentos.some((l) => l.tipo === 'venda' && l.id !== venda.id &&
    !estado.lancamentos.some((e) => e.tipo === 'estorno' && e.estornaId === l.id) && l.itens.some((i) => venda.itens.some((v) => i.id === v.id)))
  const linhas = venda.itens.map((item) => {
    const situacao = situacaoDoItem(item, estado.movimentos, cancelada)
    if (!situacao.ok) throw new Error('Entregas incompletas')
    const projecao = item.produtoId ? projetarEstoque(estado.movimentos, item.produtoId) : undefined
    return { item, ...situacao.valor, fisico: projecao?.ok ? projecao.valor.fisico : 0 }
  })
  // Os novos itens podem ser gratuitos junto de itens pagos que permaneceram na venda (D-055/059).
  const conferencia = conferirVendaComEstoque({ ...novos, data }, estado, hoje(), true)
  const itensNovos = conferencia.itensLocais.flatMap((i, indice) => {
    const item = criarItemVendido({ ...i, id: `novo-${indice}`, produto: estado.produtos.find((p) => p.id === i.produtoId) })
    return item.ok ? [item.valor] : []
  })
  const devolucoes = linhas.map(({ item }) => ({ itemId: item.id, quantidade: lerQuantidade(quantidades[item.id] ?? '0') ?? -1 }))
  const troca = conferirTroca(venda, devolucoes.filter((d) => d.quantidade >= 0 && d.quantidade <= (venda.itens.find((i) => i.id === d.itemId)?.quantidade ?? 0)), itensNovos)
  const dataValida = /^\d{4}-\d{2}-\d{2}$/.test(data) && data <= hoje()
  const novasGuardas = conferencia.guardas.filter((g) => g !== 'sem-valor')
  const selecionada = linhas.find((l) => l.item.id === modo)
  const entregue = selecionada ? lerQuantidade(quantidades[selecionada.item.id] ?? String(sugerirEntrega(selecionada.pendente, selecionada.fisico))) : null
  const retornoValido = linhas.every((l) => {
    const q = lerQuantidade(quantidades[l.item.id] ?? (modo === 'cancelar' && l.podeRetornar > 0 ? '' : '0'))
    return q !== null && q <= (modo === 'trocar' && !l.item.produtoId ? l.item.quantidade : l.podeRetornar) && (modo !== 'trocar' || q <= l.item.quantidade)
  })
  const valido = dataValida && !gravando && (selecionada ? entregue !== null && entregue > 0 && entregue <= selecionada.pendente
    : retornoValido && (modo === 'cancelar' || devolucoes.some((d) => d.quantidade > 0)) &&
      (modo !== 'trocar' || (!conferencia.erro && novasGuardas.length === 0 && (troca.itens.length === 0 || troca.total > 0n))))
  async function gravar() {
    if (!valido) return
    setGravando(true); setErro(undefined)
    try {
      const resultado = selecionada && entregue !== null ? await operacoesEstoque.entregar({ vendaId: venda.id, itemId: selecionada.item.id, quantidade: entregue, data })
        : modo === 'cancelar' ? await operacoesEstoque.cancelarVenda(venda.id, data, devolucoes.filter((d) => venda.itens.find((i) => i.id === d.itemId)?.produtoId))
          : modo === 'retornar' ? await operacoesEstoque.registrarRetorno(venda.id, data, devolucoes.filter((d) => venda.itens.find((i) => i.id === d.itemId)?.produtoId))
            : await operacoesEstoque.trocarDevolver(venda.id, data, devolucoes, conferencia.itensLocais)
      if (!resultado.ok) { setErro(fraseVendaEstoque(resultado.motivo)); return }
      aoConcluir()
    } catch { setErro('Não deu para anotar. Os campos continuam aqui para tentar de novo.') }
    finally { setGravando(false) }
  }
  return <section aria-label="Entregas e devoluções" className="mt-5">
    <h2 className="text-xl">Entregas e devoluções</h2>
    {linhas.filter((l) => l.item.produtoId).map((l) => <div key={l.item.id} className="my-3 rounded-xl border border-borda p-3">
      <strong>{l.item.descricao} · {l.item.quantidade} unidade(s)</strong>
      <p className="my-1">Entregue: {l.entregue} · Voltou: {l.retornado} · A entregar: {l.pendente}</p>
      {l.excesso > 0 && <p role="status" className="text-atraso">Há {l.excesso} unidade(s) entregues além da venda. Confira se houve entrega repetida ou anotação errada.</p>}
      {l.fisico < 0 && <p role="status" className="text-atraso">O estoque registrado está negativo. Confira as entradas e entregas.</p>}
      {!comProblema && !cancelada && l.pendente > 0 && modo === null && <Botao tipo="secundario" aoTocar={() => setModo(l.item.id)}>Entregar {l.item.descricao}</Botao>}
    </div>)}
    {comProblema ? <p role="status">Esta anotação precisa de conferência. Abra “Conferir anotações” no começo.</p> : <>
      {modo === null && <div className="rodape-acao">
        {!cancelada && <>
          <Botao tipo="principal" aoTocar={aoCorrigir}>Corrigir anotação</Botao>
          <Botao tipo="secundario" aoTocar={() => setModo('trocar')}>Devolução ou troca</Botao>
          <Botao tipo="secundario" aoTocar={() => setModo('cancelar')}>Desfazer esta venda</Botao>
        </>}
        {cancelada && !substituida && linhas.some((l) => l.podeRetornar > 0) && <Botao tipo="secundario" aoTocar={() => setModo('retornar')}>Voltou mercadoria depois</Botao>}
      </div>}
      {modo !== null && <fieldset className="my-4 rounded-xl border border-borda p-3">
        <legend>{selecionada ? 'Confirmar entrega' : modo === 'trocar' ? 'Devolução ou troca' : modo === 'retornar' ? 'Mercadoria que voltou depois' : 'Desfazer esta venda'}</legend>
        {selecionada ? <>
          <p>A entregar: {selecionada.pendente} · Em mãos: {selecionada.fisico}</p>
          <label>Entregue agora<input className={CLASSES_DE_CAMPO} inputMode="numeric" value={quantidades[selecionada.item.id] ?? String(sugerirEntrega(selecionada.pendente, selecionada.fisico))}
            onChange={(e) => setQuantidades((a) => ({ ...a, [selecionada.item.id]: e.target.value }))} /></label>
          {entregue !== null && entregue > selecionada.fisico && <p role="status">Essa entrega deixa o estoque registrado negativo. A entrega será anotada; confira o estoque depois.</p>}
          {entregue !== null && entregue > selecionada.pendente && <p role="status">É mais do que falta entregar. Corrija a venda se a quantidade estava errada.</p>}
        </> : <>
          <p>{modo === 'cancelar' ? 'O que falta entregar será cancelado. Informe o que realmente voltou, inclusive zero.' : 'Informe apenas o que realmente voltou.'}</p>
          {linhas.filter((l) => modo === 'trocar' || l.item.produtoId && l.podeRetornar > 0).map((l) => <label key={l.item.id} className="my-3 block">
            Voltou: {l.item.descricao} (até {l.item.produtoId ? Math.min(l.item.quantidade, l.podeRetornar) : l.item.quantidade})
            <input className={CLASSES_DE_CAMPO} inputMode="numeric" aria-label={`Voltou ${l.item.descricao}`} placeholder="0" value={quantidades[l.item.id] ?? ''}
              onChange={(e) => setQuantidades((a) => ({ ...a, [l.item.id]: e.target.value }))} />
          </label>)}
          {modo === 'trocar' && <>
            <h3>Vai levar no lugar?</h3>
            <ItensDaVenda rascunho={{ ...novos, data }} estado={estado} catalogo={catalogo} aoMudar={(itens) => setNovos((a) => ({ ...a, itens }))} />
            <p>Total que fica na venda: <strong>{emReais(troca.total)}</strong></p>
            <p>Desconto que fica: {emReais(troca.desconto)}</p>
            <p>{troca.diferenca < 0n ? 'Redução' : 'Acréscimo'}: {emReais(troca.diferenca < 0n ? -troca.diferenca : troca.diferenca)}{venda.pagamento === 'avista' ? ' · Acerte a diferença com a cliente.' : ''}</p>
            {novasGuardas.length > 0 && <p className="text-atraso">Falta o preço de um item novo.</p>}
          </>}
          {!retornoValido && <p role="status">Confira o que voltou; use zero se nada voltou.</p>}
        </>}
        <label>Quando foi<input className={CLASSES_DE_CAMPO} type="date" value={data} max={hoje()} onChange={(e) => setData(e.target.value)} /></label>
        {erro && <p role="status" className="text-atraso">{erro}</p>}
        <Botao tipo="principal" className="mt-4" aoTocar={() => void gravar()} desabilitado={!valido}>Confirmar {selecionada ? 'entrega' : modo === 'cancelar' ? 'cancelamento' : modo === 'retornar' ? 'retorno' : 'devolução ou troca'}</Botao>
        <Botao tipo="secundario" className="mt-2" aoTocar={() => { setModo(null); setQuantidades({}); setErro(undefined) }}>Deixar como está</Botao>
      </fieldset>}
    </>}
  </section>
}
