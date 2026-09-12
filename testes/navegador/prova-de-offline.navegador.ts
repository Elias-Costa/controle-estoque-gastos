import { expect, test } from '@playwright/test'
import { uuidv7 } from '../../src/dados/identidade.ts'
import type { Parcela, VendaFiado } from '../../src/dominio/ficha.ts'
import { lancamentoParaNuvem } from '../../src/sincronizacao/borda.ts'
import {
  abrirApp,
  apagarBase,
  cadastrar,
  entrar,
  esperarIndicador,
  esperarOk,
  gravarLancamentoPronto,
  lerCliente,
  lerFicha,
  lerFichaInteira,
  nuvemDeFora,
  pularSemUsuario,
  receberValor,
  recarregar,
  regravarCliente,
  sincronizado,
  sincronizar,
  vender,
} from './apoio.ts'

/**
 * A prova de offline (E-08): RT-07, RT-08, RT-09 e RT-10 em navegador real, contra o build,
 * antes de existir tela. É o portão de F1 — nada em `src/interface` nasce sem isto verde.
 *
 * O que cada teste prova, e qual falha eliminatória ele fecha:
 * - **RT-07** (EL-01, EL-06): venda com a rede desligada grava, aparece na ficha, sobrevive a
 *   recarregar o app **offline**, e sobe sozinha quando a rede volta.
 * - **RT-08** (EL-04): a nuvem já tem o lançamento; o app envia de novo e há **uma** linha. O
 *   mesmo id com conteúdo diferente vira "com problema", e a linha local fica como ela deixou.
 * - **RT-09** (EL-04, RN-13): o que um aparelho grava aparece no outro; lançamentos são união;
 *   cadastro concorrente resolve por último-que-escreve (D-010) **sem nada sumir**.
 * - **RT-10** (EL-05, RNF-08): base local apagada, tudo volta da nuvem, igual.
 *
 * Um contexto do navegador é um aparelho (IndexedDB e localStorage próprios). Cada rodada usa ids
 * novos e **deixa linhas na nuvem**, sob o usuário de teste (D-042); a limpeza é
 * `migrar:reverter` + `migrar` antes de E-15. Chromium, e só ele: é a coluna "desktop" de D-036.
 * Nada aqui é afirmação sobre o iPhone dela.
 */

const HOJE = '2026-09-12'

/** A ficha com os ids ordenados, para comparar aparelhos que criaram lançamentos em instantes diferentes. */
function ordenada(ficha: { readonly saldo: string; readonly ids: readonly string[] }): { saldo: string; ids: string[] } {
  return { saldo: ficha.saldo, ids: [...ficha.ids].sort() }
}

test.describe.configure({ mode: 'serial' })

test('RT-07 — venda com a rede desligada: grava, aparece na ficha, sobrevive a recarregar, sobe quando a rede volta', async ({ context, page }) => {
  pularSemUsuario()
  await abrirApp(page)
  await entrar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })

  // A rede cai — e fica caída durante o cadastro, a venda, a leitura e o recarregamento.
  await context.setOffline(true)
  const clienteId = await cadastrar(page, 'Vera (E-08 RT-07)', '(11) 9 1111-1111')
  const vendaId = await vender(page, {
    clienteId,
    data: HOJE,
    itens: [
      { descricao: 'perfume', preco: '10000' },
      { descricao: 'creme', preco: '3990' },
    ],
    parcelas: [
      { vencimento: '2026-10-12', valor: '7000' },
      { vencimento: '2026-11-12', valor: '6990' },
    ],
  })
  expect(await lerFicha(page, clienteId)).toEqual({ saldo: '13990', ids: [vendaId] })
  await esperarIndicador(page, { pendentes: 2, comProblema: 0 })

  // Recarregar o app sem rede: é o service worker do build quem serve, ou este passo cai (EL-06).
  await recarregar(page)
  expect(await lerFicha(page, clienteId)).toEqual({ saldo: '13990', ids: [vendaId] })
  await esperarIndicador(page, { pendentes: 2, comProblema: 0 })

  // A rede volta: a fila esvazia sozinha e a nuvem tem exatamente o que foi lançado.
  await context.setOffline(false)
  await sincronizar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
  expect(await sincronizado(page, vendaId)).toBe(true)

  const deFora = await nuvemDeFora()
  try {
    expect(await deFora.clientePorId(clienteId)).toMatchObject({ id: clienteId, nome: 'Vera (E-08 RT-07)', telefone: '(11) 9 1111-1111' })
    const vendas = await deFora.lancamentosPorId(vendaId)
    expect(vendas).toHaveLength(1)
    expect(vendas[0]).toMatchObject({
      tipo: 'venda',
      pagamento: 'fiado',
      id: vendaId,
      clienteId,
      data: HOJE,
      itens: [
        { descricao: 'perfume', preco: 10000n },
        { descricao: 'creme', preco: 3990n },
      ],
    })
  } finally {
    await deFora.sair()
  }
})

test('RT-08 — a nuvem já tem o lançamento: reenviar não duplica; conteúdo diferente vira "com problema"', async ({ page }) => {
  pularSemUsuario()
  await abrirApp(page)
  await entrar(page)
  const clienteId = await cadastrar(page, 'Vera (E-08 RT-08)', '(11) 9 2222-2222')
  await sincronizar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })

  // De fora, a nuvem recebe a venda X — é a "resposta perdida": o servidor gravou, o app não soube.
  const vendaId = uuidv7()
  const parcela: Parcela = { id: uuidv7(), vencimento: '2026-10-12', valor: 2500n }
  const venda: VendaFiado = {
    tipo: 'venda',
    pagamento: 'fiado',
    id: vendaId,
    clienteId,
    data: HOJE,
    itens: [{ descricao: 'batom', preco: 2500n }],
    desconto: 0n,
    parcelas: [parcela],
  }
  const deFora = await nuvemDeFora()
  try {
    esperarOk(await deFora.nuvem.enviarLancamento(lancamentoParaNuvem(venda)))

    // O app tem a mesma X na fila e envia de novo: uma linha só, e a fila esvazia (RI-05).
    // (Sem conferir "1 para enviar" no meio: com rede, o motor envia no mesmo instante.)
    await gravarLancamentoPronto(page, venda)
    await sincronizar(page)
    await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
    expect(await deFora.lancamentosPorId(vendaId)).toHaveLength(1)
    expect(await lerFicha(page, clienteId)).toEqual({ saldo: '2500', ids: [vendaId] })

    // A mesma X com outro valor: a nuvem recusa em definitivo (`lancamentos_imutavel`, D-041), o
    // item vira "com problema" e para — sem retentar, sem sobrescrever, sem sumir (D-042, item 2).
    await gravarLancamentoPronto(page, { ...venda, itens: [{ descricao: 'batom', preco: 2600n }], parcelas: [{ ...parcela, valor: 2600n }] })
    await sincronizar(page)
    await esperarIndicador(page, { pendentes: 0, comProblema: 1 })
    expect(await sincronizado(page, vendaId)).toBe(false)
    // A linha local ficou como ela deixou; a nuvem ficou como estava; continua havendo uma linha.
    expect(await lerFicha(page, clienteId)).toEqual({ saldo: '2600', ids: [vendaId] })
    const naNuvem = await deFora.lancamentosPorId(vendaId)
    expect(naNuvem).toHaveLength(1)
    expect(naNuvem[0]).toMatchObject({ itens: [{ descricao: 'batom', preco: 2500n }] })
  } finally {
    await deFora.sair()
  }
})

test('RT-09 — dois aparelhos: escrita em um aparece no outro; cadastro concorrente resolve por D-010 sem sumiço', async ({ browser }) => {
  pularSemUsuario()
  const aparelhoA = await browser.newContext()
  const aparelhoB = await browser.newContext()
  const a = await aparelhoA.newPage()
  const b = await aparelhoB.newPage()
  try {
    await abrirApp(a)
    await entrar(a)
    await abrirApp(b)
    await entrar(b)

    // A cadastra e vende; B, ao consultar a nuvem, vê os dois.
    const clienteId = await cadastrar(a, 'Vera (E-08 RT-09)', '(11) 9 0000-0001')
    const vendaId = await vender(a, { clienteId, data: HOJE, itens: [{ descricao: 'perfume', preco: '5000' }], parcelas: [{ vencimento: '2026-10-12', valor: '5000' }] })
    await sincronizar(a)
    await esperarIndicador(a, { pendentes: 0, comProblema: 0 })
    await sincronizar(b)
    expect(await lerFicha(b, clienteId)).toEqual({ saldo: '5000', ids: [vendaId] })
    expect(await lerCliente(b, clienteId)).toMatchObject({ nome: 'Vera (E-08 RT-09)', telefone: '(11) 9 0000-0001' })

    // B recebe; A vê. Lançamentos são união (D-010): cada aparelho fica com os dois.
    const recebimentoId = await receberValor(b, clienteId, HOJE, '2000')
    await sincronizar(b)
    await sincronizar(a)
    const fichaCompleta = ordenada({ saldo: '3000', ids: [vendaId, recebimentoId] })
    expect(ordenada(await lerFicha(a, clienteId))).toEqual(fichaCompleta)

    // Cadastro concorrente: A edita o telefone sem rede (t1); B edita depois, com rede (t2 > t1)
    // e sobe. Quando A volta, o gatilho descarta a edição mais antiga (D-042, item 1) e A baixa a
    // de B: os dois aparelhos terminam iguais, com o telefone de B, e nenhum lançamento some.
    await aparelhoA.setOffline(true)
    await regravarCliente(a, { id: clienteId, nome: 'Vera (E-08 RT-09)', telefone: '(11) 9 0000-000A' })
    await b.waitForTimeout(50)
    await regravarCliente(b, { id: clienteId, nome: 'Vera (E-08 RT-09)', telefone: '(11) 9 0000-000B' })
    await sincronizar(b)
    await esperarIndicador(b, { pendentes: 0, comProblema: 0 })
    await aparelhoA.setOffline(false)
    await sincronizar(a)
    await esperarIndicador(a, { pendentes: 0, comProblema: 0 })
    expect(await lerCliente(a, clienteId)).toMatchObject({ telefone: '(11) 9 0000-000B' })
    await sincronizar(b)
    expect(await lerCliente(b, clienteId)).toMatchObject({ telefone: '(11) 9 0000-000B' })
    for (const aparelho of [a, b]) expect(ordenada(await lerFicha(aparelho, clienteId))).toEqual(fichaCompleta)

    const deFora = await nuvemDeFora()
    try {
      expect(await deFora.clientePorId(clienteId)).toMatchObject({ telefone: '(11) 9 0000-000B' })
      expect(await deFora.lancamentosPorId(vendaId)).toHaveLength(1)
      expect(await deFora.lancamentosPorId(recebimentoId)).toHaveLength(1)
    } finally {
      await deFora.sair()
    }
  } finally {
    await aparelhoA.close()
    await aparelhoB.close()
  }
})

test('RT-10 — base local apagada: os dados voltam da nuvem, íntegros', async ({ page }) => {
  pularSemUsuario()
  await abrirApp(page)
  await entrar(page)
  const clienteId = await cadastrar(page, 'Vera (E-08 RT-10)', '(11) 9 3333-3333')
  const vendaId = await vender(page, {
    clienteId,
    data: HOJE,
    itens: [
      { descricao: 'perfume', preco: '10000' },
      { descricao: 'creme', preco: '3990' },
    ],
    parcelas: [
      { vencimento: '2026-10-12', valor: '7000' },
      { vencimento: '2026-11-12', valor: '6990' },
    ],
  })
  const recebimentoId = await receberValor(page, clienteId, HOJE, '1500')
  await sincronizar(page)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })

  const clienteAntes = await lerCliente(page, clienteId)
  const resumoAntes = await lerFicha(page, clienteId)
  const fichaAntes = await lerFichaInteira(page, clienteId)
  expect(resumoAntes).toEqual({ saldo: '12490', ids: [vendaId, recebimentoId] })

  // O aparelho perde a base — e a sessão sobrevive no localStorage, como no aparelho dela.
  await apagarBase(page)
  await recarregar(page)
  await sincronizar(page)

  expect(await lerCliente(page, clienteId)).toEqual(clienteAntes)
  expect(await lerFicha(page, clienteId)).toEqual(resumoAntes)
  expect(await lerFichaInteira(page, clienteId)).toEqual(fichaAntes)
  await esperarIndicador(page, { pendentes: 0, comProblema: 0 })
})
