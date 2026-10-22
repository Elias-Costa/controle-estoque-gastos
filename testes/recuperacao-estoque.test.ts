import { describe, expect, test } from 'bun:test'
import { saldo, type Estorno } from '../src/dominio/ficha.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'
import { aceitarGrupoEstoque, efeitosAposEncerramentos, encerrarTentativaEstoque, identidadeDaTentativa,
  type EstadoAceitoEstoque, type TentativaEstoque } from '../src/dominio/recuperacao-estoque.ts'
import { prepararCancelamento, prepararCorrecaoVenda, prepararEntrega, prepararRetorno, prepararVendaEstoque,
  prepararMovimentosEstoque, revisarGrupoPendente, type GrupoEstoque } from '../src/dominio/vendas-estoque.ts'
import { compra, item, ok, operacao, produto, venda } from './apoio-estoque.ts'

const vazio: EstadoAceitoEstoque = { operacoes: [], lancamentos: [], movimentos: [] }
function cenario(quantidade = 2) {
  const v = venda('venda', [item('item', quantidade)])
  const p = compra('compra', quantidade)
  const grupo = ok(prepararVendaEstoque([], [p], v, operacao('op-venda'), [produto], [{ itemId: 'item', quantidade, movimentoId: 'entrega' }]))
  const aceito = ok(aceitarGrupoEstoque({ ...vazio, movimentos: [p] }, grupo))
  return { v, grupo, aceito }
}
function cancelar(estado: ReturnType<typeof cenario>, id: string, quantidade = 0) {
  return ok(prepararCancelamento(estado.aceito.lancamentos, estado.aceito.movimentos, estado.v,
    { operacao: operacao(`op-${id}`), estornoId: id, data: '2026-10-04', revisaoVenda: 1,
      retornos: [{ itemId: 'item', quantidade, movimentoId: `retorno-${id}` }] }))
}
function tentativa(grupo: GrupoEstoque): TentativaEstoque { return { grupo, desfecho: 'recusada', diagnostico: 'revisão recusada após conferência' } }
const confirmacao = { id: 'resolucao', data: '2026-10-05', confirmado: true, intencaoPendente: false }

describe('aceite serial de operações completas — Q40 (sem banco)', () => {
  test('reenvio idêntico devolve mesmo estado; conteúdo divergente recusa o conjunto', () => {
    const { aceito, grupo } = cenario()
    expect(ok(aceitarGrupoEstoque(aceito, grupo))).toBe(aceito)
    const divergente = { ...grupo, movimentos: grupo.movimentos.map((m) => m.tipo === 'entrega' ? { ...m, quantidade: 1 } : m) }
    expect(aceitarGrupoEstoque(aceito, divergente)).toEqual({ ok: false, motivo: 'conteudo-divergente' })
    expect(ok(projetarEstoque(aceito.movimentos, produto.id)).fisico).toBe(0)
    expect(saldo(aceito.lancamentos)).toBe(10000n)
  })
  test('grupo incompleto, dependência ausente ou id reaproveitado não têm aceite parcial', () => {
    const { grupo } = cenario()
    const inicial = { ...vazio, movimentos: [compra('compra', 2)] }
    expect(aceitarGrupoEstoque(inicial, { ...grupo, movimentos: [] }).ok).toBe(false)
    expect(aceitarGrupoEstoque(inicial, { ...grupo, operacao: { ...grupo.operacao, dependencias: [{ id: 'ausente', revisao: 1 }] } })).toEqual({ ok: false, motivo: 'dependencia-ausente' })
    expect(aceitarGrupoEstoque(inicial, { ...grupo, operacao: { ...grupo.operacao, id: 'compra' } }).ok).toBe(false)
    expect(inicial.lancamentos).toEqual([])
    expect(inicial.movimentos).toHaveLength(1)
  })
  test('primeiro envio da venda já editada leva entrega; se revisão anterior foi aceita, a nova é recusada inteira', () => {
    const estado = cenario()
    const nova = venda('venda', [item('item', 2, 5500n)])
    const revisado = ok(prepararCorrecaoVenda([estado.v], estado.aceito.movimentos, estado.v, nova,
      { operacao: operacao('op-venda', 2), revisaoOriginal: 1, sincronizado: false, data: '2026-10-04', natureza: 'financeira', grupoPendente: estado.grupo }))
    const inicial = { ...vazio, movimentos: [compra('compra', 2)] }
    const aceito = ok(aceitarGrupoEstoque(inicial, revisado))
    expect(saldo(aceito.lancamentos)).toBe(11000n)
    expect(ok(projetarEstoque(aceito.movimentos, produto.id)).fisico).toBe(0)
    expect(aceitarGrupoEstoque(estado.aceito, revisado)).toEqual({ ok: false, motivo: 'conteudo-divergente' })
    expect(saldo(estado.aceito.lancamentos)).toBe(10000n)
  })
  test('compra e correção de compra usam manifesto próprio, preservando histórico e rejeitando concorrente', () => {
    const p = compra()
    const grupo = ok(prepararMovimentosEstoque([], operacao(p.operacaoId), [p]))
    const aceito = ok(aceitarGrupoEstoque(vazio, grupo))
    const revisado = ok(revisarGrupoPendente(grupo, operacao(p.operacaoId, 2), [], [{ ...p, revisao: 2, quantidade: 8 }]))
    expect(ok(projetarEstoque(ok(aceitarGrupoEstoque(vazio, revisado)).movimentos, produto.id)).fisico).toBe(8)
    const operacoes = ['a', 'b'].map((id) => ok(prepararMovimentosEstoque([p], operacao(`op-${id}`), [
      { tipo: 'anulacao', id: `inverso-${id}`, operacaoId: `op-${id}`, revisao: 1, produtoId: produto.id, data: p.data, conhecidos: [p], alvo: p },
      { ...p, id, operacaoId: `op-${id}`, quantidade: id === 'a' ? 8 : 7, compraOriginalId: p.id },
    ], p)))
    for (const ordem of [operacoes, [...operacoes].reverse()]) {
      const a = ordem[0]
      const b = ordem[1]
      if (!a || !b) throw new Error('correções ausentes')
      const primeiro = ok(aceitarGrupoEstoque(aceito, a))
      expect(aceitarGrupoEstoque(primeiro, b).ok).toBe(false)
      expect(primeiro.movimentos).toHaveLength(3)
    }
  })
  test('duas correções financeiras da mesma revisão: primeiro vence em ambas as ordens', () => {
    const estado = cenario()
    const grupos = ['a', 'b'].map((id) => ok(prepararCorrecaoVenda(estado.aceito.lancamentos, estado.aceito.movimentos, estado.v,
      venda(`nova-${id}`, [item('item', 2, id === 'a' ? 5500n : 6000n)]),
      { operacao: operacao(`op-${id}`), revisaoOriginal: 1, sincronizado: true, estornoId: `estorno-${id}`, data: '2026-10-04', natureza: 'financeira' })))
    for (const ordem of [grupos, [...grupos].reverse()]) {
      const primeiro = ordem[0]
      const segundo = ordem[1]
      if (!primeiro || !segundo) throw new Error('grupos ausentes')
      const aceito = ok(aceitarGrupoEstoque(estado.aceito, primeiro))
      expect(aceitarGrupoEstoque(aceito, segundo).ok).toBe(false)
      expect(ok(aceitarGrupoEstoque(aceito, primeiro))).toBe(aceito)
      expect(aceito.movimentos).toEqual(estado.aceito.movimentos)
      expect(aceito.lancamentos).toHaveLength(3)
      expect(saldo(aceito.lancamentos)).toBe(saldo(primeiro.lancamentos.filter((l) => l.tipo === 'venda')))
    }
  })
  test('cancelamentos concorrentes são indivisíveis: não entra retorno do grupo recusado', () => {
    const estado = cenario(1)
    const a = cancelar(estado, 'a', 1)
    const b = cancelar(estado, 'b', 1)
    for (const [primeiro, segundo] of [[a, b], [b, a]]) {
      if (!primeiro || !segundo) throw new Error('grupos ausentes')
      const aceito = ok(aceitarGrupoEstoque(estado.aceito, primeiro))
      expect(aceitarGrupoEstoque(aceito, segundo).ok).toBe(false)
      expect(saldo(aceito.lancamentos)).toBe(0n)
      expect(ok(projetarEstoque(aceito.movimentos, produto.id)).fisico).toBe(1)
      expect(aceito.lancamentos.filter((l) => l.tipo === 'estorno')).toHaveLength(1)
    }
  })
  test('dois retornos cabem em 2; em 1, o segundo inteiro é recusado, inclusive ordem inversa', () => {
    for (const quantidade of [1, 2]) {
      const estado = cenario(quantidade)
      const cancelado = ok(aceitarGrupoEstoque(estado.aceito, cancelar(estado, 'cancelado')))
      const retornos = ['a', 'b'].map((id) => ok(prepararRetorno(cancelado.lancamentos, cancelado.movimentos, estado.v,
        { operacao: operacao(`op-${id}`), data: '2026-10-05', retornos: [{ itemId: 'item', quantidade: 1, movimentoId: id }] })))
      for (const ordem of [retornos, [...retornos].reverse()]) {
        const a = ordem[0]
        const b = ordem[1]
        if (!a || !b) throw new Error('retornos ausentes')
        const primeiro = ok(aceitarGrupoEstoque(cancelado, a))
        const segundo = aceitarGrupoEstoque(primeiro, b)
        expect(segundo.ok).toBe(quantidade === 2)
        expect(ok(projetarEstoque((segundo.ok ? segundo.valor : primeiro).movimentos, produto.id)).fisico).toBe(quantidade)
        expect(ok(aceitarGrupoEstoque(primeiro, a))).toBe(primeiro)
      }
    }
  })
  test('duas entregas além da pendência são aceitas para conferência, sem regra dos retornos', () => {
    const v = venda('v', [item('item', 1)])
    const p = compra('p', 1)
    const inicial = { ...vazio, lancamentos: [v], movimentos: [p] }
    const grupos = ['a', 'b'].map((id) => ok(prepararEntrega([v], [p], v,
      { operacao: operacao(`op-${id}`), id, data: '2026-10-03', itemId: 'item', quantidade: 1 }, produto)))
    let aceito: EstadoAceitoEstoque = inicial
    for (const grupo of grupos) aceito = ok(aceitarGrupoEstoque(aceito, grupo))
    expect(ok(projetarEstoque(aceito.movimentos, produto.id)).fisico).toBe(-1)
    expect(saldo(aceito.lancamentos)).toBe(5000n)
  })
})

describe('encerramento humano por revisão e conteúdo — Q47A', () => {
  test('resposta perdida e falta de confirmação não autorizam encerrar/refazer', () => {
    const estado = cenario()
    const recusada = tentativa(cancelar(estado, 'tentativa'))
    expect(encerrarTentativaEstoque({ ...recusada, desfecho: 'resposta-perdida' }, estado.aceito, [], confirmacao)).toEqual({ ok: false, motivo: 'recusa-nao-confirmada' })
    expect(encerrarTentativaEstoque(recusada, estado.aceito, [], { ...confirmacao, confirmado: false })).toEqual({ ok: false, motivo: 'confirmacao-necessaria' })
    expect(encerrarTentativaEstoque(tentativa(estado.grupo), estado.aceito, [], confirmacao).ok).toBe(false)
  })
  test('sem intenção restante, retira só efeito provisório; conserva saldo, estoque, evidência e aceite', () => {
    const estado = cenario()
    const recusada = tentativa(cancelar(estado, 'tentativa', 1))
    const antes = efeitosAposEncerramentos(estado.aceito, [recusada.grupo], [])
    expect(saldo(antes.lancamentos)).toBe(0n)
    expect(ok(projetarEstoque(antes.movimentos, produto.id)).fisico).toBe(1)
    const encerrada = ok(encerrarTentativaEstoque(recusada, estado.aceito, [], confirmacao))
    const depois = efeitosAposEncerramentos(estado.aceito, [recusada.grupo], [encerrada])
    expect(saldo(depois.lancamentos)).toBe(10000n)
    expect(ok(projetarEstoque(depois.movimentos, produto.id)).fisico).toBe(0)
    expect(depois.pendentes).toEqual([])
    expect(encerrada.evidencia).toBe(recusada)
    expect(encerrada.aceitosConhecidos).toEqual(estado.aceito.operacoes)
    expect(encerrada.novaOperacao).toBeUndefined()
    expect(ok(encerrarTentativaEstoque(recusada, estado.aceito, [encerrada], { ...confirmacao, id: 'segunda' }))).toBe(encerrada)
    expect(efeitosAposEncerramentos(estado.aceito, [recusada.grupo, recusada.grupo], [encerrada])).toEqual(depois)
  })
  test('versão aceita do mesmo id continua ativa após encerrar tentativa de outra revisão/conteúdo', () => {
    const estado = cenario()
    const aceito = cancelar(estado, 'mesmo-id', 1)
    const remoto = ok(aceitarGrupoEstoque(estado.aceito, aceito))
    for (const revisao of [1, 2]) {
      const divergente = { ...aceito, operacao: { ...aceito.operacao, revisao }, movimentos: aceito.movimentos.map((m) => ({ ...m, revisao, quantidade: 2 })) }
      const recusada = tentativa(divergente)
      const encerrada = ok(encerrarTentativaEstoque(recusada, remoto, [], confirmacao))
      const depois = efeitosAposEncerramentos(remoto, [divergente], [encerrada])
      expect(depois.lancamentos).toEqual(remoto.lancamentos)
      expect(depois.movimentos).toEqual(remoto.movimentos)
      expect(ok(projetarEstoque(depois.movimentos, produto.id)).fisico).toBe(1)
      expect(saldo(depois.lancamentos)).toBe(0n)
      expect(encerrada.tentativa).toEqual(identidadeDaTentativa(divergente))
    }
  })
  test('nova operação completa tem ids próprios e vínculo; confirmação repetida não duplica', () => {
    const estado = cenario()
    const recusada = tentativa(cancelar(estado, 'antiga', 1))
    const novaOperacao = cancelar(estado, 'nova', 1)
    const encerrada = ok(encerrarTentativaEstoque(recusada, estado.aceito, [], { ...confirmacao, intencaoPendente: true, novaOperacao }))
    const depois = efeitosAposEncerramentos(estado.aceito, [recusada.grupo, novaOperacao], [encerrada, encerrada])
    expect(depois.pendentes).toEqual([novaOperacao])
    expect(saldo(depois.lancamentos)).toBe(0n)
    expect(ok(projetarEstoque(depois.movimentos, produto.id)).fisico).toBe(1)
    expect(encerrada.novaOperacao).toBe(novaOperacao)
    expect(encerrarTentativaEstoque(recusada, estado.aceito, [], { ...confirmacao, intencaoPendente: true, novaOperacao: recusada.grupo })).toEqual({ ok: false, motivo: 'identidade-reutilizada' })
    expect(encerrarTentativaEstoque(recusada, estado.aceito, [], { ...confirmacao, intencaoPendente: true }).ok).toBe(false)
    const remoto = ok(aceitarGrupoEstoque(estado.aceito, novaOperacao))
    expect(efeitosAposEncerramentos(remoto, [recusada.grupo, novaOperacao], [encerrada]).pendentes).toEqual([])
  })
  test('se outro aparelho já cancelou, não refaz financeiro; só retorno restante real', () => {
    const estado = cenario()
    const recusada = tentativa(cancelar(estado, 'recusada', 1))
    const remoto = ok(aceitarGrupoEstoque(estado.aceito, cancelar(estado, 'outro-aparelho')))
    const duplicada = cancelar(estado, 'duplicada', 1)
    expect(encerrarTentativaEstoque(recusada, remoto, [], { ...confirmacao, intencaoPendente: true, novaOperacao: duplicada }).ok).toBe(false)
    const retorno = ok(prepararRetorno(remoto.lancamentos, remoto.movimentos, estado.v,
      { operacao: operacao('op-retorno'), data: '2026-10-05', retornos: [{ itemId: 'item', quantidade: 1, movimentoId: 'retorno-real' }] }))
    const encerrada = ok(encerrarTentativaEstoque(recusada, remoto, [], { ...confirmacao, intencaoPendente: true, novaOperacao: retorno }))
    const depois = efeitosAposEncerramentos(remoto, [recusada.grupo], [encerrada])
    expect(depois.lancamentos.filter((l) => l.tipo === 'estorno')).toHaveLength(1)
    expect(saldo(depois.lancamentos)).toBe(0n)
    expect(ok(projetarEstoque(depois.movimentos, produto.id)).fisico).toBe(1)
  })
  test('recusa da nova operação continua visível; encerrá-la depois não ressuscita a fila anterior', () => {
    const estado = cenario()
    const a = tentativa(cancelar(estado, 'a', 1))
    const b = tentativa(cancelar(estado, 'b', 1))
    const primeira = ok(encerrarTentativaEstoque(a, estado.aceito, [], { ...confirmacao, intencaoPendente: true, novaOperacao: b.grupo }))
    expect(efeitosAposEncerramentos(estado.aceito, [a.grupo, b.grupo], [primeira]).pendentes).toEqual([b.grupo])
    const segunda = ok(encerrarTentativaEstoque(b, estado.aceito, [primeira], { ...confirmacao, id: 'segunda' }))
    const depois = efeitosAposEncerramentos(estado.aceito, [a.grupo, b.grupo], [primeira, segunda])
    expect(depois.pendentes).toEqual([])
    expect(depois.lancamentos).toEqual(estado.aceito.lancamentos)
    expect(depois.movimentos).toEqual(estado.aceito.movimentos)
  })
  test('estorno F1 recusado conserva evidência sem tentar apagar o id aceito', () => {
    const estado = cenario()
    const estorno: Estorno = { tipo: 'estorno', id: 'legado', clienteId: 'cliente', data: '2026-10-04', estornaId: estado.v.id }
    // O transporte futuro identifica a rota recusada; aqui a evidência não inventa baixa ausente.
    const grupo: GrupoEstoque = { operacao: { ...operacao('tentativa-legada'), tipo: 'cancelamento', formato: 1,
      lancamentos: [{ id: estorno.id, revisao: 1 }], movimentos: [], alvo: { id: estado.v.id, revisao: 1 } }, lancamentos: [estorno], movimentos: [] }
    const encerrada = ok(encerrarTentativaEstoque(tentativa(grupo), estado.aceito, [], confirmacao))
    const depois = efeitosAposEncerramentos(estado.aceito, [grupo], [encerrada])
    expect(saldo(depois.lancamentos)).toBe(10000n)
    expect(encerrada.evidencia.grupo.lancamentos).toEqual([estorno])
    expect(depois.movimentos).toEqual(estado.aceito.movimentos)
  })
})
