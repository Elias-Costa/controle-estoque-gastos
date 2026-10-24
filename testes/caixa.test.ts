import { describe, expect, test } from 'bun:test'
import { projetarCaixa, type TotaisCaixa } from '../src/dominio/caixa.ts'
import {
  corrigirFatoCaixa, estornarFatoCaixa, prepararCorrecaoCaixa, registrarMovimentoCaixa, validarFatosCaixa,
  type Despesa, type FatoCaixa, type ReceitaAvulsa,
} from '../src/dominio/gastos.ts'
import { historico, parcelas, saldo, validar, type Ficha, type Lancamento, type VendaAVista } from '../src/dominio/ficha.ts'
import { considerarPago, desativar, registrarRecebimento } from '../src/dominio/lancamentos.ts'
import { projetarEstoque } from '../src/dominio/estoque.ts'
import { custoDoProduto } from '../src/dominio/produtos.ts'
import { prepararVendaEstoque } from '../src/dominio/vendas-estoque.ts'
import { compra, operacao, produto, venda } from './apoio-estoque.ts'

function ok<T>(resultado: { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly motivo: string }): T {
  if (!resultado.ok) throw new Error(resultado.motivo)
  return resultado.valor
}

function despesa(mudancas: Partial<Despesa> = {}): Despesa {
  return { tipo: 'despesa', id: 'gasto', revisao: 1, data: '2026-09-30', valor: 10000n,
    categoria: 'Termo livre de teste', classificacao: 'negocio', mercadoria: false, ...mudancas }
}

function receita(mudancas: Partial<ReceitaAvulsa> = {}): ReceitaAvulsa {
  return { tipo: 'receita-avulsa', id: 'extra', revisao: 1, data: '2026-09-30', valor: 101n,
    categoria: 'Outro termo de teste', classificacao: 'pessoal', ...mudancas }
}

function avista(mudancas: Partial<VendaAVista> = {}): VendaAVista {
  return { tipo: 'venda', pagamento: 'avista', id: 'avista', clienteId: 'cliente', data: '2026-09-30', forma: 'pix',
    itens: [{ descricao: 'Item fictício', preco: 10003n }, { descricao: 'Outro', preco: 204n }], desconto: 7n, ...mudancas }
}

function totais(entrou: bigint, saiu: bigint): TotaisCaixa { return { entrou, saiu, diferenca: entrou - saiu } }

describe('fatos próprios de caixa (RF-16/17, D-065/069)', () => {
  test('anotação não exige cliente e conserva texto livre, acentos e classificação', () => {
    const fato = ok(registrarMovimentoCaixa([], { ...despesa(), categoria: '  grafia LIVRE, çã!  ', mercadoria: true }))
    expect(fato).toEqual({ ...despesa(), categoria: 'grafia LIVRE, çã!', mercadoria: true })
    expect('clienteId' in fato).toBe(false)
    expect(ok(registrarMovimentoCaixa([fato], receita()))).toEqual(receita())
  })

  test.each([0n, -1n])('recusa valor não positivo: %s', (valor) => {
    expect(registrarMovimentoCaixa([], { ...despesa(), valor })).toEqual({ ok: false, motivo: 'valor-invalido' })
    expect(registrarMovimentoCaixa([], { ...receita(), valor })).toEqual({ ok: false, motivo: 'valor-invalido' })
  })

  test.each(['', '   '])('categoria livre continua obrigatória: %s', (categoria) => {
    expect(registrarMovimentoCaixa([], { ...despesa(), categoria })).toEqual({ ok: false, motivo: 'categoria-obrigatoria' })
    expect(registrarMovimentoCaixa([], { ...receita(), categoria })).toEqual({ ok: false, motivo: 'categoria-obrigatoria' })
  })

  test('mercadoria exige negócio; escrever mercadoria na categoria não liga a identificação', () => {
    expect(validarFatosCaixa([despesa({ mercadoria: true, classificacao: 'pessoal' })])).toEqual({ ok: false, motivo: 'mercadoria-invalida' })
    const pessoal = despesa({ classificacao: 'pessoal', categoria: 'mercadoria' })
    expect(ok(validarFatosCaixa([pessoal]))).toEqual([pessoal])
    expect(ok(projetarCaixa([pessoal], [], '2026-09')).pessoal).toEqual(totais(0n, 10000n))
  })

  test('identidades e revisões inválidas ou duplicadas não viram soma silenciosa', () => {
    expect(validarFatosCaixa([despesa({ id: '' })])).toEqual({ ok: false, motivo: 'id-invalido' })
    expect(validarFatosCaixa([despesa(), receita({ id: 'gasto' })])).toEqual({ ok: false, motivo: 'id-repetido' })
    for (const revisao of [0, -1, 1.5, 9_007_199_254_740_992]) {
      expect(validarFatosCaixa([despesa({ revisao })])).toEqual({ ok: false, motivo: 'revisao-invalida' })
    }
    expect(registrarMovimentoCaixa([despesa()], despesa())).toEqual({ ok: false, motivo: 'id-repetido' })
  })

  test.each(['2026-00-01', '2026-13-01', '2026-10-00', '2026-10-32', '24/10/2026'])('recusa formato de data inválido: %s', (data) => {
    expect(registrarMovimentoCaixa([], { ...despesa(), data })).toEqual({ ok: false, motivo: 'data-invalida' })
  })

  test('estorno confere alvo presente na conta, revisão corrente e unicidade', () => {
    const fato = despesa({ revisao: 2 })
    const entrada = { id: 'estorno', data: '2026-10-01', alvo: { id: fato.id, revisao: 2 } }
    expect(estornarFatoCaixa([], entrada)).toEqual({ ok: false, motivo: 'alvo-invalido' })
    expect(estornarFatoCaixa([fato], { ...entrada, alvo: { id: fato.id, revisao: 1 } })).toEqual({ ok: false, motivo: 'alvo-invalido' })
    const estorno = ok(estornarFatoCaixa([fato], entrada))
    expect('valor' in estorno).toBe(false)
    expect(estornarFatoCaixa([fato, estorno], { ...entrada, id: 'outro' })).toEqual({ ok: false, motivo: 'ja-estornado' })
    expect(estornarFatoCaixa([fato, estorno], { ...entrada, id: 'outro', alvo: { id: estorno.id, revisao: 1 } })).toEqual({ ok: false, motivo: 'alvo-invalido' })
    expect(ok(validarFatosCaixa([estorno, fato]))).toEqual([estorno, fato])
  })
})

describe('correções não representam devolução de dinheiro (RF-08, D-013/066)', () => {
  test('correção local conserva id, avança revisão e respeita a janela da fila', () => {
    const original = despesa()
    const entrada = { ...original, valor: 8000n }
    const corrigido = ok(corrigirFatoCaixa([original], original, entrada, { sincronizado: false }))
    expect(corrigido).toEqual({ ...entrada, revisao: 2 })
    expect(original.valor).toBe(10000n)
    expect(ok(projetarCaixa([corrigido], [], '2026-09')).tudo).toEqual(totais(0n, 8000n))
    expect(ok(projetarCaixa([corrigido], [], '2026-10')).tudo).toEqual(totais(0n, 0n))
    expect(corrigirFatoCaixa([original], original, entrada, { sincronizado: true })).toEqual({ ok: false, motivo: 'ja-sincronizado' })
    expect(corrigirFatoCaixa([], original, entrada, { sincronizado: false })).toEqual({ ok: false, motivo: 'alvo-invalido' })
    expect(corrigirFatoCaixa([corrigido], original, entrada, { sincronizado: false })).toEqual({ ok: false, motivo: 'alvo-invalido' })
    expect(corrigirFatoCaixa([original], original, receita({ id: original.id }), { sincronizado: false })).toEqual({ ok: false, motivo: 'tipo-diferente' })
    expect(corrigirFatoCaixa([original], original, { ...entrada, valor: 0n }, { sincronizado: false })).toEqual({ ok: false, motivo: 'valor-invalido' })
  })

  test('correção enviada preserva três linhas, reexpressa setembro e deixa outubro sem movimento fictício', () => {
    const original = despesa()
    const grupo = ok(prepararCorrecaoCaixa([original], original, {
      estornoId: 'estorno', dataCorrecao: '2026-10-20', substituto: { ...original, id: 'correto', valor: 8000n },
    }))
    const fatos = [original, grupo.estorno, grupo.substituto]
    expect(fatos).toHaveLength(3)
    expect(original.valor).toBe(10000n)
    expect(grupo.alvo).toEqual({ id: original.id, revisao: 1 })
    expect(ok(projetarCaixa(fatos, [], '2026-09')).tudo).toEqual(totais(0n, 8000n))
    expect(ok(projetarCaixa(fatos, [], '2026-10')).tudo).toEqual(totais(0n, 0n))
    expect(corrigirFatoCaixa(fatos, original, original, { sincronizado: false })).toEqual({ ok: false, motivo: 'ja-estornado' })
    expect(prepararCorrecaoCaixa(fatos, original, { estornoId: 'outro', dataCorrecao: '2026-10-21', substituto: despesa({ id: 'outra' }) }))
      .toEqual({ ok: false, motivo: 'ja-estornado' })
    expect(prepararCorrecaoCaixa([original], original, { estornoId: 'estorno', dataCorrecao: '2026-10-21', substituto: original }))
      .toEqual({ ok: false, motivo: 'id-repetido' })
  })

  test('correção de data muda o mês; estornar receita não fabrica saída', () => {
    const original = receita()
    const grupo = ok(prepararCorrecaoCaixa([original], original, {
      estornoId: 'estorno', dataCorrecao: '2026-11-01', substituto: { ...original, id: 'correto', data: '2026-10-01' },
    }))
    const fatos = [original, grupo.estorno, grupo.substituto]
    expect(ok(projetarCaixa(fatos, [], '2026-09')).tudo).toEqual(totais(0n, 0n))
    expect(ok(projetarCaixa(fatos, [], '2026-10')).pessoal).toEqual(totais(101n, 0n))
    expect(ok(projetarCaixa(fatos, [], '2026-11')).tudo).toEqual(totais(0n, 0n))
  })

  test('dinheiro realmente devolvido é fato próprio na data real, inclusive sem estorno', () => {
    const pago = despesa({ mercadoria: true })
    const devolvido = receita({ data: '2026-10-01', valor: 2000n, classificacao: 'negocio' })
    expect(ok(projetarCaixa([pago, devolvido], [], '2026-09')).tudo).toEqual(totais(0n, 10000n))
    expect(ok(projetarCaixa([pago, devolvido], [], '2026-10')).tudo).toEqual(totais(2000n, 0n))
  })
})

describe('projeção do movimento mensal (RF-18, RN-04/09/10/12)', () => {
  test('vazio e diferença negativa; dezembro não transporta saldo para janeiro', () => {
    expect(ok(projetarCaixa([], [], '2027-01'))).toEqual({ mes: '2027-01', tudo: totais(0n, 0n), negocio: totais(0n, 0n), pessoal: totais(0n, 0n) })
    const fatos = [receita({ data: '2026-12-31', valor: 99999n }), despesa({ data: '2027-01-01', classificacao: 'pessoal', valor: 3n })]
    expect(ok(projetarCaixa(fatos, [], '2027-01')).pessoal).toEqual({ entrou: 0n, saiu: 3n, diferenca: -3n })
    expect(ok(projetarCaixa(fatos, [], '2026-12')).tudo).toEqual(totais(99999n, 0n))
  })

  test.each(['2026-00', '2026-13', '2026-1', '2026-10-01', 'outubro'])('recusa mês inválido: %s', (mes) => {
    expect(projetarCaixa([], [], mes)).toEqual({ ok: false, motivo: 'mes-invalido' })
  })

  test('centavos acima do inteiro seguro de number e cortes fecham exatamente', () => {
    const enorme = 9_007_199_254_740_993n
    const caixa = ok(projetarCaixa([
      despesa({ valor: enorme, mercadoria: true }),
      despesa({ id: 'pessoal', valor: 3n, classificacao: 'pessoal' }),
      receita({ id: 'negocio', valor: enorme + 1n, classificacao: 'negocio' }),
      receita({ valor: 2n }),
    ], [avista()], '2026-09'))
    expect(caixa.negocio).toEqual(totais(enorme + 10201n, enorme))
    expect(caixa.pessoal).toEqual(totais(2n, 3n))
    expect(caixa.tudo).toEqual(totais(enorme + 10203n, enorme + 3n))
  })

  test('vista conta uma vez; dívida antiga entra só quando recebida, sem quitação nem fiado', () => {
    const antiga: Lancamento = { tipo: 'saldo-anterior', id: 'antiga', clienteId: 'cliente', data: '2025-01-01',
      parcelas: [{ id: 'parcela', vencimento: '2025-02-01', valor: 4703n }] }
    const recebimento = ok(registrarRecebimento([antiga], { id: 'recebido', clienteId: 'cliente', data: '2026-10-01', valor: 4700n, forma: 'dinheiro' })).recebimento
    const quitacao = ok(considerarPago([antiga, recebimento], { id: 'quitacao', clienteId: 'cliente', data: '2026-10-01' }))
    const fiado: Lancamento = { tipo: 'venda', pagamento: 'fiado', id: 'fiado', clienteId: 'cliente', data: '2026-10-01',
      itens: [{ descricao: 'Item fictício', preco: 2000n }], desconto: 0n, parcelas: [{ id: 'futura', valor: 2000n, vencimento: '2026-11-01' }] }
    const ficha = ok(validar([antiga, recebimento, quitacao, fiado, avista()]))
    expect(ok(projetarCaixa([], ficha, '2025-01')).tudo).toEqual(totais(0n, 0n))
    expect(ok(projetarCaixa([], ficha, '2026-09')).negocio).toEqual(totais(10200n, 0n))
    expect(ok(projetarCaixa([], ficha, '2026-10')).negocio).toEqual(totais(4700n, 0n))
    const cliente = desativar({ id: 'cliente', nome: 'Cliente fictícia' }, '2026-10-02')
    expect(cliente.desativadoEm).toBe('2026-10-02')
    expect(ok(projetarCaixa([], ficha, '2026-10')).negocio.entrou).toBe(4700n)
  })

  test('estornos legados de recebimento e vista reexpressam o mês original, mesmo vindo antes do alvo', () => {
    const ficha: Ficha = [
      { tipo: 'estorno', id: 'er', clienteId: 'cliente', data: '2026-11-01', estornaId: 'recebido' },
      { tipo: 'estorno', id: 'ev', clienteId: 'cliente', data: '2026-10-01', estornaId: 'avista' },
      avista(),
      { tipo: 'saldo-anterior', id: 'antiga', clienteId: 'cliente', data: '2026-01-01', parcelas: [{ id: 'p', valor: 10000n, vencimento: '2026-02-01' }] },
      { tipo: 'recebimento', id: 'recebido', clienteId: 'cliente', data: '2026-09-30', valor: 1000n, forma: 'pix' },
      { tipo: 'recebimento', id: 'certo', clienteId: 'cliente', data: '2026-09-30', valor: 800n, forma: 'pix' },
    ]
    ok(validar(ficha))
    expect(ok(projetarCaixa([], ficha, '2026-09')).tudo).toEqual(totais(800n, 0n))
    expect(ok(projetarCaixa([], ficha, '2026-10')).tudo).toEqual(totais(0n, 0n))
    expect(ok(projetarCaixa([], ficha, '2026-11')).tudo).toEqual(totais(0n, 0n))
  })

  test('oráculo independente: 24 meses, cortes, correções e ordem inversa', () => {
    const fatos: FatoCaixa[] = []
    const financeiro: Lancamento[] = []
    const esperado = new Map<string, { negocio: TotaisCaixa; pessoal: TotaisCaixa; tudo: TotaisCaixa }>()
    for (const ano of ['2025', '2026']) {
      for (const mes of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
        const periodo = `${ano}-${mes}`
        const data = `${periodo}-01`
        const k = BigInt(esperado.size + 1)
        // O oráculo soma os valores conhecidos na geração; não lê/faz seleção dos fatos.
        fatos.push(despesa({ id: `dn-${periodo}`, data, valor: k * 101n, mercadoria: true }),
          despesa({ id: `dp-${periodo}`, data, valor: k * 7n, classificacao: 'pessoal' }),
          receita({ id: `rn-${periodo}`, data, valor: k * 3n, classificacao: 'negocio' }),
          receita({ id: `rp-${periodo}`, data, valor: k * 2n }))
        financeiro.push(avista({ id: `v-${periodo}`, data, itens: [{ descricao: 'Teste', preco: k * 13n }], desconto: k }),
          { tipo: 'saldo-anterior', id: `s-${periodo}`, clienteId: `c-${periodo}`, data: '2024-01-01', parcelas: [{ id: `p-${periodo}`, valor: k * 20n, vencimento: data }] },
          { tipo: 'recebimento', id: `r-${periodo}`, clienteId: `c-${periodo}`, data, valor: k * 5n, forma: 'pix' })
        esperado.set(periodo, { negocio: totais(k * 20n, k * 101n), pessoal: totais(k * 2n, k * 7n), tudo: totais(k * 22n, k * 108n) })
      }
    }
    // Corrige 101 centavos para 80 em janeiro/2025, mas o conserto só acontece em 2027.
    fatos.push({ tipo: 'estorno', id: 'erro', revisao: 1, data: '2027-01-01', alvo: { id: 'dn-2025-01', revisao: 1 } },
      despesa({ id: 'correto', data: '2025-01-01', valor: 80n, mercadoria: true }))
    esperado.set('2025-01', { negocio: totais(20n, 80n), pessoal: totais(2n, 7n), tudo: totais(22n, 87n) })
    for (const clienteId of new Set(financeiro.map((lancamento) => lancamento.clienteId))) {
      ok(validar(financeiro.filter((lancamento) => lancamento.clienteId === clienteId)))
    }
    for (const [mes, valores] of esperado) {
      expect(ok(projetarCaixa(fatos, financeiro, mes))).toEqual({ mes, ...valores })
      expect(ok(projetarCaixa([...fatos].reverse(), [...financeiro].reverse(), mes))).toEqual({ mes, ...valores })
    }
    expect(ok(projetarCaixa(fatos, financeiro, '2027-01')).tudo).toEqual(totais(0n, 0n))
  })

  test('fatos inválidos são recusados mesmo fora do mês consultado', () => {
    expect(projetarCaixa([despesa({ valor: 0n })], [], '2026-10')).toEqual({ ok: false, motivo: 'valor-invalido' })
  })

  test('leitura e correção do caixa preservam ficha, estoque e custo histórico (EL-02/07)', () => {
    const entrada = compra()
    const vendaEntregue = ok(prepararVendaEstoque([], [entrada], venda(), operacao('op-venda'), [produto],
      [{ itemId: 'item', quantidade: 3, movimentoId: 'entrega' }]))
    const financeiro: Ficha = Object.freeze([Object.freeze(avista()), ...vendaEntregue.lancamentos.map((lancamento) => Object.freeze(lancamento))])
    const movimentos = Object.freeze([Object.freeze(entrada), ...vendaEntregue.movimentos.map((movimento) => Object.freeze(movimento))])
    const original = Object.freeze(despesa({ mercadoria: true }))
    const fatos = Object.freeze([original])
    const posicao = ok(projetarEstoque(movimentos, produto.id))
    const antes = { saldo: saldo(financeiro), parcelas: parcelas(financeiro), historico: historico(financeiro),
      posicao, custo: custoDoProduto(produto, posicao.comprasVigentes) }
    const grupo = ok(prepararCorrecaoCaixa(fatos, original, {
      estornoId: 'estorno', dataCorrecao: '2026-10-24', substituto: despesa({ id: 'certo', valor: 8000n, mercadoria: true }),
    }))
    expect(ok(projetarCaixa([...fatos, grupo.estorno, grupo.substituto], financeiro, '2026-09')).tudo).toEqual(totais(10200n, 8000n))
    const depois = ok(projetarEstoque(movimentos, produto.id))
    expect({ saldo: saldo(financeiro), parcelas: parcelas(financeiro), historico: historico(financeiro),
      posicao: depois, custo: custoDoProduto(produto, depois.comprasVigentes) }).toEqual(antes)
    // Compra física não entrou no caixa de outubro nem fabricou pagamento de 10 × 3000.
    expect(ok(projetarCaixa(fatos, financeiro, '2026-10')).tudo).toEqual(totais(0n, 0n))
    expect(movimentos).toEqual([compra(), ...vendaEntregue.movimentos])
    expect(posicao.fisico).toBe(7)
    expect(vendaEntregue.movimentos[0]).toMatchObject({ tipo: 'entrega', quantidade: 3, custoUnitario: 3000n })
  })
})
