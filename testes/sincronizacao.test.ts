import { describe, expect, test } from 'bun:test'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { BancoLocal } from '../src/dados/banco.ts'
import { cadastrarCliente, estornarLancamento, lancarVendaFiado, receber } from '../src/dados/operacoes.ts'
import { criarRepositorioLocal, type Repositorio } from '../src/dados/repositorio.ts'
import { saldo, type Cliente, type Resultado } from '../src/dominio/ficha.ts'
import { lancamentoParaNuvem, type ClienteNaNuvem, type LancamentoNaNuvem } from '../src/sincronizacao/borda.ts'
import type { Falha, LinhaRecebida, Nuvem, Resposta } from '../src/sincronizacao/nuvem.ts'
import {
  ESPERA_INICIAL_MS,
  ESPERA_MAXIMA_MS,
  INTERVALO_DE_CONSULTA_MS,
  iniciarSincronizacao,
  type Sincronizacao,
} from '../src/sincronizacao/sincronizacao.ts'

/**
 * O motor da sincronização (E-07, D-042) sobre `fake-indexeddb` e uma nuvem **de mentira** que
 * segue as regras do banco de E-06: `upsert` idempotente, lançamento imutável (`23000
 * lancamentos_imutavel`), um estorno por alvo (`23505`), chave estrangeira (`23503`), cadastro
 * por último-que-escreve, sessão que liga e desliga, e falhas programáveis — inclusive a
 * "resposta perdida" de E-00: o servidor grava e a resposta não chega.
 *
 * O que se prova aqui e em nenhum outro lugar: **RT-08 do lado da fila** (EL-04) — reenviar não
 * duplica, e reenviar diferente não passa em silêncio; a fila nunca perde item por falha de rede
 * (EL-01); o download nunca sobrescreve o que está pendente; e a espera cresce e zera como
 * D-042 diz. Nada aqui é afirmação sobre o PostgREST real (isso é
 * `testes/integracao/sincronizacao.test.ts`) nem sobre o WebKit.
 */

const GRANDE = 9007199254740993n // 2^53 + 1

type ClienteGuardado = ClienteNaNuvem & { readonly recebido_em: string }
type LancamentoGuardado = LancamentoNaNuvem & { readonly criado_em: string }

/** Uma falha programada para a próxima requisição. `perder-resposta`: grava e devolve rede. */
type FalhaProgramada = 'rede' | 'perder-resposta'

/** As colunas que o gatilho `lancamentos_imutavel` compara: as do domínio — nem `id`, nem `criado_em`. */
function conteudo(linha: LancamentoNaNuvem | LancamentoGuardado): string {
  const { id: _id, criado_em: _criadoEm, ...resto } = { criado_em: undefined, ...linha }
  return JSON.stringify(resto)
}

/**
 * A nuvem de mentira. Guarda linhas como o banco as guarda (texto de dígitos no dinheiro), carimba
 * `recebido_em`/`criado_em` com um relógio próprio do "servidor", e recusa o que o banco recusa.
 */
class NuvemDeMentira implements Nuvem {
  readonly clientes = new Map<string, ClienteGuardado>()
  readonly lancamentos = new Map<string, LancamentoGuardado>()
  sessao = true
  /** Toda requisição que chegou, na ordem, para o teste contar tentativas. */
  readonly requisicoes: string[] = []
  readonly falhas: FalhaProgramada[] = []
  /** Chamado antes de gravar um lançamento: é como o teste "corrige durante o envio". */
  aoReceberLancamento: ((id: string) => Promise<void>) | null = null
  private tique = 0
  private readonly ouvintes = new Set<() => void>()

  /** Relógio do servidor: um segundo por escrita, para a ordem ser determinística. */
  private agora(): string {
    this.tique += 1
    return `2026-09-12T12:00:${String(this.tique).padStart(2, '0')}.000Z`
  }

  mudarSessao(ligada: boolean): void {
    this.sessao = ligada
    for (const ouvinte of this.ouvintes) ouvinte()
  }

  private falhaProgramada(): { readonly ok: false; readonly falha: Falha } | null {
    const falha = this.falhas.shift()
    if (falha === undefined) return null
    if (falha === 'rede') return { ok: false, falha: { tipo: 'rede', mensagem: 'TypeError: Load failed' } }
    return null
  }

  private recusa(codigo: string, constraint: string): Resposta<never> {
    const falha: Falha = { tipo: 'recusa', codigo, constraint, mensagem: `violates ${constraint}` }
    return { ok: false, falha }
  }

  temSessao(): Promise<boolean> {
    return Promise.resolve(this.sessao)
  }

  aoMudarSessao(ouvinte: () => void): () => void {
    this.ouvintes.add(ouvinte)
    return () => {
      this.ouvintes.delete(ouvinte)
    }
  }

  async enviarCliente(linha: ClienteNaNuvem): Promise<Resposta<void>> {
    this.requisicoes.push(`enviarCliente ${linha.id}`)
    if (!this.sessao) return { ok: false, falha: { tipo: 'sessao', mensagem: '42501' } }
    const perdida = this.falhas[0] === 'perder-resposta'
    const falha = this.falhaProgramada()
    if (falha !== null) return falha
    const existente = this.clientes.get(linha.id)
    // O gatilho `clientes_ultimo_que_escreve`: a versão mais antiga é descartada, sem erro.
    if (existente === undefined || linha.atualizado_em >= existente.atualizado_em) {
      this.clientes.set(linha.id, { ...linha, recebido_em: this.agora() })
    }
    return perdida ? { ok: false, falha: { tipo: 'rede', mensagem: 'TypeError: Load failed' } } : { ok: true, valor: undefined }
  }

  async enviarLancamento(linha: LancamentoNaNuvem): Promise<Resposta<void>> {
    this.requisicoes.push(`enviarLancamento ${linha.id}`)
    if (!this.sessao) return { ok: false, falha: { tipo: 'sessao', mensagem: '42501' } }
    const perdida = this.falhas[0] === 'perder-resposta'
    const falha = this.falhaProgramada()
    if (falha !== null) return falha
    if (this.aoReceberLancamento !== null) await this.aoReceberLancamento(linha.id)
    if (!this.clientes.has(linha.cliente_id)) return this.recusa('23503', 'lancamentos_cliente')
    if (linha.tipo === 'estorno') {
      if (linha.estorna_id === null || !this.lancamentos.has(linha.estorna_id)) return this.recusa('23503', 'lancamentos_estorno_alvo')
      for (const outro of this.lancamentos.values()) {
        if (outro.tipo === 'estorno' && outro.estorna_id === linha.estorna_id && outro.id !== linha.id) {
          return this.recusa('23505', 'lancamentos_um_estorno_por_alvo')
        }
      }
    }
    const existente = this.lancamentos.get(linha.id)
    if (existente !== undefined) {
      // O gatilho `lancamentos_imutavel`: idêntico passa; diferente é erro (D-041, item 2).
      if (conteudo(existente) !== conteudo(linha)) return this.recusa('23000', 'lancamentos_imutavel')
    } else {
      this.lancamentos.set(linha.id, { ...linha, criado_em: this.agora() })
    }
    return perdida ? { ok: false, falha: { tipo: 'rede', mensagem: 'TypeError: Load failed' } } : { ok: true, valor: undefined }
  }

  private buscar(linhas: readonly LinhaRecebida[], carimbo: string, desde: string | null): Resposta<readonly LinhaRecebida[]> {
    const filtradas = linhas.filter((linha) => desde === null || String(linha[carimbo]) >= desde)
    filtradas.sort((a, b) => String(a[carimbo]).localeCompare(String(b[carimbo])) || String(a['id']).localeCompare(String(b['id'])))
    return { ok: true, valor: filtradas }
  }

  async buscarClientes(desde: string | null): Promise<Resposta<readonly LinhaRecebida[]>> {
    this.requisicoes.push(`buscarClientes ${desde ?? 'tudo'}`)
    if (!this.sessao) return { ok: false, falha: { tipo: 'sessao', mensagem: '42501' } }
    const falha = this.falhaProgramada()
    if (falha !== null) return falha
    return this.buscar([...this.clientes.values()], 'recebido_em', desde)
  }

  async buscarLancamentos(desde: string | null): Promise<Resposta<readonly LinhaRecebida[]>> {
    this.requisicoes.push(`buscarLancamentos ${desde ?? 'tudo'}`)
    if (!this.sessao) return { ok: false, falha: { tipo: 'sessao', mensagem: '42501' } }
    const falha = this.falhaProgramada()
    if (falha !== null) return falha
    return this.buscar([...this.lancamentos.values()], 'criado_em', desde)
  }

  /** Linhas contra ids distintos — o par que prova ausência de duplicata (E-00). */
  contagem(): { linhas: number; ids: number } {
    return { linhas: this.lancamentos.size, ids: new Set(this.lancamentos.keys()).size }
  }
}

/** Um aparelho: base, repositório e motor sobre uma nuvem (compartilhável entre "aparelhos"). */
type Aparelho = {
  readonly banco: BancoLocal
  readonly repositorio: Repositorio
  readonly nuvem: NuvemDeMentira
  readonly sinc: Sincronizacao
  /** As esperas pedidas ao timer, em ms, na ordem. */
  readonly esperas: number[]
  /** Dispara o timer agendado (se houver) e espera o ciclo. */
  readonly disparar: () => Promise<void>
  /** Estados observados pelo assinante, na ordem. */
  readonly historico: string[]
}

function preparar(opcoes: { nuvem?: NuvemDeMentira | null; visivel?: boolean } = {}): Aparelho {
  const banco = new BancoLocal('teste', { indexedDB: new IDBFactory(), IDBKeyRange })
  let tique = 0
  const repositorio = criarRepositorioLocal(banco, () => `2026-09-12T10:00:${String(tique++).padStart(2, '0')}.000Z`)
  const nuvem = opcoes.nuvem === undefined ? new NuvemDeMentira() : opcoes.nuvem
  const esperas: number[] = []
  let agendado: (() => void) | null = null
  const sinc = iniciarSincronizacao({
    banco,
    nuvem,
    agora: () => new Date('2026-09-12T10:30:00.000Z'),
    agendar: (fn, ms) => {
      esperas.push(ms)
      agendado = fn
      return () => {
        if (agendado === fn) agendado = null
      }
    },
    janela: null,
    documento: { visibilityState: opcoes.visivel === false ? 'hidden' : 'visible', addEventListener: () => undefined, removeEventListener: () => undefined },
  })
  const historico: string[] = []
  sinc.assinar(() => {
    const e = sinc.estado()
    historico.push(`${e.enviando ? 'enviando' : 'parado'} p=${e.pendentes} x=${e.comProblema} s=${e.sessao ? 1 : 0} f=${e.ultimaFalha ?? '-'}`)
  })
  return {
    banco,
    repositorio,
    nuvem: nuvem ?? new NuvemDeMentira(),
    sinc,
    esperas,
    historico,
    // O que o timer faria é `void sincronizar()`; aqui se espera o ciclo em vez de disparar o
    // callback, para não pedir um segundo ciclo por cima do primeiro.
    disparar: async () => {
      if (agendado === null) throw new Error('nenhum timer agendado')
      agendado = null
      await sinc.sincronizar()
    },
  }
}

function ok<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) throw new Error(`recusado: ${resultado.motivo}`)
  return resultado.valor
}

async function vera(repositorio: Repositorio): Promise<Cliente> {
  return ok(await cadastrarCliente(repositorio, { nome: 'Vera', telefone: '(11) 9 8765-4321' }))
}

/** Venda fiado de R$ 100,00 + 2^53+1 centavos em 2×, para o bigint grande atravessar. */
async function vendaGrande(repositorio: Repositorio, clienteId: string) {
  return ok(
    await lancarVendaFiado(repositorio, {
      clienteId,
      data: '2026-09-01',
      itens: [{ descricao: 'perfume', preco: 10000n }, { descricao: 'creme', preco: GRANDE }],
      parcelas: [{ vencimento: '2026-10-01', valor: GRANDE }, { vencimento: '2026-11-01', valor: 10000n }],
    }),
  )
}

/** Uma venda fiado de R$ 100,00 em 1×: a dívida que um recebimento precisa (RN-03). */
async function vendaPequena(repositorio: Repositorio, clienteId: string) {
  return ok(
    await lancarVendaFiado(repositorio, {
      clienteId,
      data: '2026-09-01',
      itens: [{ descricao: 'batom', preco: 10000n }],
      parcelas: [{ vencimento: '2026-10-01', valor: 10000n }],
    }),
  )
}

async function fila(banco: BancoLocal): Promise<{ registroId: string; problema: string | null; versao: number | undefined }[]> {
  return (await banco.fila.orderBy('ordem').toArray()).map((item) => ({
    registroId: item.registroId,
    problema: item.problema?.constraint ?? item.problema?.codigo ?? null,
    versao: item.versao,
  }))
}

describe('enviar: a fila sobe na ordem, e o que subiu sai da fila', () => {
  test('cliente antes do lançamento que o cita; bigint como texto de dígitos; fila vazia; "tudo em dia"', async () => {
    const { banco, repositorio, nuvem, sinc } = preparar()
    const cliente = await vera(repositorio)
    const venda = await vendaGrande(repositorio, cliente.id)
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'pix' }))
    expect(await banco.fila.count()).toBe(3)

    await sinc.sincronizar()

    expect(nuvem.requisicoes.slice(0, 3)).toEqual([`enviarCliente ${cliente.id}`, `enviarLancamento ${venda.id}`, `enviarLancamento ${recebimento.id}`])
    expect(await banco.fila.count()).toBe(0)
    expect(nuvem.clientes.get(cliente.id)).toMatchObject({ nome: 'Vera', telefone: '(11) 9 8765-4321', apelido: null, atualizado_em: '2026-09-12T10:00:00.000Z' })
    const guardada = nuvem.lancamentos.get(venda.id)
    expect(guardada?.parcelas?.[0]?.valor).toBe('9007199254740993')
    expect(guardada?.itens?.[1]?.preco).toBe('9007199254740993')
    expect(typeof guardada?.desconto).toBe('string')
    expect(sinc.estado()).toMatchObject({ pendentes: 0, comProblema: 0, enviando: false, sessao: true, ultimaFalha: null, ultimoSucessoEm: '2026-09-12T10:30:00.000Z' })
    expect(await repositorio.sincronizado(venda.id)).toBe(true)
  })

  test('o estado passa por "enviando" e volta; o assinante vê cada mudança', async () => {
    const { repositorio, sinc, historico } = preparar()
    await vera(repositorio)
    await sinc.sincronizar()
    expect(historico).toEqual(['enviando p=1 x=0 s=1 f=-', 'parado p=0 x=0 s=1 f=-'])
    // Sem mudança, a referência é a mesma (é o contrato de `useSyncExternalStore`).
    expect(sinc.estado()).toBe(sinc.estado())
    const antes = sinc.estado()
    await sinc.sincronizar()
    // Um ciclo sem nada a enviar ainda passa por "enviando": duas mudanças, e volta ao mesmo valor.
    expect(historico).toHaveLength(4)
    expect(sinc.estado()).toEqual(antes)
  })

  test('com a fila vazia agenda a consulta periódica; com a aba oculta, não', async () => {
    const visivel = preparar()
    await visivel.sinc.sincronizar()
    expect(visivel.esperas).toEqual([INTERVALO_DE_CONSULTA_MS])
    const oculto = preparar({ visivel: false })
    await oculto.sinc.sincronizar()
    expect(oculto.esperas).toEqual([])
  })
})

describe('RT-08, lado da fila (EL-04, RI-05): reenviar não duplica, reenviar diferente não passa em silêncio', () => {
  test('resposta perdida: o servidor gravou, a fila não soube, retentou — uma linha, um id', async () => {
    const { banco, repositorio, nuvem, sinc, esperas } = preparar()
    const cliente = await vera(repositorio)
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    await vendaGrande(repositorio, cliente.id)

    // A primeira tentativa do recebimento é gravada lá e "morre" na volta (`Load failed`, E-00).
    nuvem.falhas.push('perder-resposta')
    await sinc.sincronizar()
    expect(nuvem.contagem()).toEqual({ linhas: 2, ids: 2 })
    // Nada foi marcado como enviado: os dois continuam pendentes, e a venda grande nem foi tentada.
    expect((await fila(banco)).map((item) => item.registroId)).toEqual([recebimento.id, expect.any(String)])
    expect(nuvem.requisicoes.filter((r) => r.startsWith('enviarLancamento'))).toHaveLength(2)
    expect(sinc.estado()).toMatchObject({ pendentes: 2, ultimaFalha: 'rede' })
    expect(esperas.at(-1)).toBe(ESPERA_INICIAL_MS)

    // A retentativa: o mesmo upsert passa, a venda grande sobe, e continua uma linha por id.
    await sinc.sincronizar()
    expect(await banco.fila.count()).toBe(0)
    expect(nuvem.contagem()).toEqual({ linhas: 3, ids: 3 })
    expect(sinc.estado()).toMatchObject({ pendentes: 0, ultimaFalha: null })
  })

  test('corrigir no lugar DURANTE o envio não se perde: a versão nova sobe depois, e a nuvem recusa — "com problema", nunca silêncio', async () => {
    const { banco, repositorio, nuvem, sinc } = preparar()
    const cliente = await vera(repositorio)
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))

    // Enquanto a linha está no ar, ela corrige o valor (D-013: ainda não sincronizou).
    nuvem.aoReceberLancamento = async () => {
      nuvem.aoReceberLancamento = null
      await repositorio.gravarLancamento({ ...recebimento, valor: 4000n })
    }
    await sinc.sincronizar()
    // O servidor gravou a versão 0 (R$ 50,00). O item NÃO saiu: a versão local é a 1.
    expect(nuvem.lancamentos.get(recebimento.id)?.valor).toBe('5000')
    expect(await fila(banco)).toEqual([{ registroId: recebimento.id, problema: null, versao: 1 }])
    expect(sinc.estado()).toMatchObject({ pendentes: 1, comProblema: 0 })

    // A vez seguinte sobe R$ 40,00 para um id que já existe com R$ 50,00: `lancamentos_imutavel`.
    await sinc.sincronizar()
    expect(await fila(banco)).toEqual([{ registroId: recebimento.id, problema: 'lancamentos_imutavel', versao: 1 }])
    const item = (await banco.fila.toArray())[0]
    expect(item?.problema).toEqual({ codigo: '23000', constraint: 'lancamentos_imutavel', mensagem: 'violates lancamentos_imutavel', em: '2026-09-12T10:30:00.000Z' })
    // A linha local é a dela (R$ 40,00); a nuvem tem R$ 50,00. Divergência visível, não escondida.
    const local = await banco.lancamentos.get(recebimento.id)
    expect(local?.tipo === 'recebimento' ? local.valor : null).toBe(4000n)
    expect(sinc.estado()).toMatchObject({ pendentes: 0, comProblema: 1 })
    expect(await repositorio.sincronizado(recebimento.id)).toBe(false)
  })
})

describe('recusa definitiva (D-042, item 2): marca, para, não prende os outros; regravar reabre', () => {
  test('segundo estorno do mesmo alvo vindo "do outro aparelho": este fica com problema, o item seguinte sobe, e não é retentado', async () => {
    const nuvem = new NuvemDeMentira()
    const a = preparar({ nuvem })
    const cliente = await vera(a.repositorio)
    await vendaPequena(a.repositorio, cliente.id)
    const { recebimento } = ok(await receber(a.repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    await a.sinc.sincronizar()

    // O outro aparelho já estornou o recebimento na nuvem.
    nuvem.lancamentos.set('e-outro', { ...lancamentoParaNuvem({ tipo: 'estorno', id: 'e-outro', clienteId: cliente.id, data: '2026-09-06', estornaId: recebimento.id }), criado_em: '2026-09-12T12:00:50.000Z' })

    // Este aparelho, offline, estorna também — e depois lança uma venda.
    const estorno = ok(await estornarLancamento(a.repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: recebimento.id }))
    const venda = await vendaGrande(a.repositorio, cliente.id)
    await a.sinc.sincronizar()

    expect(await fila(a.banco)).toEqual([{ registroId: estorno.id, problema: 'lancamentos_um_estorno_por_alvo', versao: 0 }])
    expect(nuvem.lancamentos.has(venda.id)).toBe(true)
    expect(a.sinc.estado()).toMatchObject({ pendentes: 0, comProblema: 1, ultimaFalha: null })
    // Com problema e nada pendente: consulta periódica, não retentativa.
    expect(a.esperas.at(-1)).toBe(INTERVALO_DE_CONSULTA_MS)

    // Dois ciclos depois, o estorno não foi tentado de novo.
    const tentativas = () => nuvem.requisicoes.filter((r) => r === `enviarLancamento ${estorno.id}`).length
    expect(tentativas()).toBe(1)
    await a.sinc.sincronizar()
    await a.sinc.sincronizar()
    expect(tentativas()).toBe(1)
    // O estorno local continua valendo aqui: é a limitação registrada em ARCHITECTURE.md §6.
    expect(await a.repositorio.sincronizado(estorno.id)).toBe(false)
  })

  test('regravar a linha com problema limpa o problema e a fila tenta de novo', async () => {
    const { banco, repositorio, nuvem, sinc } = preparar()
    const cliente = await vera(repositorio)
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    await sinc.sincronizar()
    // O outro aparelho "já tinha" este id com outro conteúdo — forçado direto na nuvem de mentira.
    nuvem.lancamentos.set(recebimento.id, { ...lancamentoParaNuvem({ ...recebimento, valor: 1n }), criado_em: '2026-09-12T12:00:00.000Z' })
    await repositorio.gravarLancamento({ ...recebimento, observacao: 'de novo' })
    await sinc.sincronizar()
    expect((await fila(banco))[0]?.problema).toBe('lancamentos_imutavel')

    // Ela regrava com exatamente o conteúdo da nuvem: o reenvio idêntico passa e o item sai.
    await repositorio.gravarLancamento({ ...recebimento, valor: 1n })
    expect((await fila(banco))[0]?.problema).toBeNull()
    await sinc.sincronizar()
    expect(await banco.fila.count()).toBe(0)
  })
})

describe('falha retentável: rede e chave estrangeira', () => {
  test('rede: nada é marcado, a fila fica inteira, a espera dobra até o teto e acordar() zera', async () => {
    const { banco, repositorio, nuvem, sinc, esperas, disparar } = preparar()
    await vera(repositorio)
    nuvem.falhas.push('rede', 'rede', 'rede', 'rede', 'rede', 'rede', 'rede', 'rede')
    await sinc.sincronizar()
    expect(await fila(banco)).toEqual([{ registroId: expect.any(String), problema: null, versao: 0 }])
    expect(sinc.estado()).toMatchObject({ pendentes: 1, comProblema: 0, ultimaFalha: 'rede' })
    for (let i = 0; i < 7; i += 1) await disparar()
    expect(esperas).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
    expect(esperas.at(-1)).toBe(ESPERA_MAXIMA_MS)
    expect(nuvem.clientes.size).toBe(0)

    // Uma escrita local (ou `online`, ou aba visível) zera a espera: a próxima falha volta a 5 s.
    nuvem.falhas.push('rede')
    sinc.acordar()
    await sinc.sincronizar()
    expect(esperas.at(-1)).toBe(ESPERA_INICIAL_MS)
    // Com a rede de volta, sobe e a espera vira consulta.
    await disparar()
    expect(nuvem.clientes.size).toBe(1)
    expect(esperas.at(-1)).toBe(INTERVALO_DE_CONSULTA_MS)
  })

  test('23503 (o cliente ainda não chegou do outro aparelho): pula, não marca, tenta no próximo ciclo', async () => {
    const { banco, repositorio, nuvem, sinc, esperas } = preparar()
    // Um lançamento cujo cliente foi cadastrado no outro aparelho e ainda não subiu de lá:
    // gravado direto na base para pular a guarda local de `cliente-nao-encontrado`.
    await repositorio.gravarLancamento({ tipo: 'recebimento', id: 'r-sem-pai', clienteId: 'c-do-outro', data: '2026-09-05', valor: 100n, forma: 'pix' })
    await sinc.sincronizar()
    expect(await fila(banco)).toEqual([{ registroId: 'r-sem-pai', problema: null, versao: 0 }])
    expect(sinc.estado()).toMatchObject({ pendentes: 1, comProblema: 0, ultimaFalha: null })
    // Pendente depois de um ciclo inteiro: retentativa com espera, não consulta.
    expect(esperas.at(-1)).toBe(ESPERA_INICIAL_MS)

    // O outro aparelho subiu o cliente; o próximo ciclo o baixa e o recebimento passa.
    nuvem.clientes.set('c-do-outro', { id: 'c-do-outro', nome: 'Do outro', telefone: null, apelido: null, observacao: null, desativado_em: null, atualizado_em: '2026-09-12T09:00:00.000Z', recebido_em: '2026-09-12T12:00:30.000Z' })
    await sinc.sincronizar()
    expect(await banco.fila.count()).toBe(0)
    expect(nuvem.lancamentos.has('r-sem-pai')).toBe(true)
    expect((await banco.clientes.get('c-do-outro'))?.nome).toBe('Do outro')
  })
})

describe('sessão (D-005, D-042 item 3): sem login a fila espera, nada vira "com problema"', () => {
  test('sem sessão nem tenta; quando a sessão chega, sobe', async () => {
    const { banco, repositorio, nuvem, sinc, esperas } = preparar()
    nuvem.sessao = false
    await vera(repositorio)
    await sinc.sincronizar()
    expect(nuvem.requisicoes).toEqual([])
    expect(sinc.estado()).toMatchObject({ pendentes: 1, comProblema: 0, sessao: false, ultimaFalha: 'sessao' })
    expect(esperas).toEqual([])

    nuvem.mudarSessao(true)
    await sinc.sincronizar()
    expect(await banco.fila.count()).toBe(0)
    expect(sinc.estado()).toMatchObject({ sessao: true, ultimaFalha: null })
  })

  test('a sessão cai no meio: o item volta a esperar, sem problema marcado', async () => {
    const { banco, repositorio, nuvem, sinc } = preparar()
    const cliente = await vera(repositorio)
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 100n, forma: 'pix' }))
    nuvem.sessao = false // `temSessao` ainda não sabe: o motor descobre pela resposta
    await sinc.sincronizar()
    expect(sinc.estado()).toMatchObject({ pendentes: 1, comProblema: 0 })
    expect((await fila(banco))[0]?.problema).toBeNull()
  })

  test('sem nuvem configurada: a fila fica "para enviar", sem tentativa e sem timer', async () => {
    const { repositorio, sinc, esperas } = preparar({ nuvem: null })
    await vera(repositorio)
    await sinc.sincronizar()
    expect(sinc.estado()).toMatchObject({ pendentes: 1, sessao: false, ultimaFalha: 'sessao' })
    expect(esperas).toEqual([])
  })
})

describe('baixar (D-010): lançamento é união, cadastro é último-que-escreve, e nada que desce enfileira', () => {
  test('o que o outro aparelho subiu aparece aqui, sem item na fila, com bigint exato; o cursor anda e a margem reaplica sem efeito', async () => {
    const nuvem = new NuvemDeMentira()
    const outro = preparar({ nuvem })
    const cliente = await vera(outro.repositorio)
    const venda = await vendaGrande(outro.repositorio, cliente.id)
    await outro.sinc.sincronizar()

    const este = preparar({ nuvem })
    await este.sinc.sincronizar()
    expect(await este.banco.fila.count()).toBe(0)
    expect((await este.banco.clientes.get(cliente.id))?.nome).toBe('Vera')
    const lida = await este.banco.lancamentos.get(venda.id)
    expect(lida).toEqual(venda)
    if (lida?.tipo !== 'venda' || lida.pagamento !== 'fiado') throw new Error('tipo trocado')
    expect(lida.parcelas[0]?.valor).toBe(GRANDE)
    expect(saldo(await este.repositorio.lerFicha(cliente.id))).toBe(GRANDE + 10000n)
    expect((await este.banco.sincronizacao.get('lancamentos'))?.valor).toBe('2026-09-12T12:00:02.000Z')
    expect((await este.banco.sincronizacao.get('clientes'))?.valor).toBe('2026-09-12T12:00:01.000Z')

    // Segundo ciclo: pede desde um minuto antes do cursor, recebe as mesmas linhas, nada muda.
    await este.sinc.sincronizar()
    expect(este.nuvem.requisicoes.at(-1)).toBe('buscarLancamentos 2026-09-12T11:59:02.000Z')
    expect(await este.banco.lancamentos.count()).toBe(1)
    expect(await este.banco.fila.count()).toBe(0)
  })

  test('não sobrescreve lançamento com item pendente: quem decide é o envio', async () => {
    const nuvem = new NuvemDeMentira()
    const { banco, repositorio, sinc } = preparar({ nuvem })
    const cliente = await vera(repositorio)
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    const { recebimento } = ok(await receber(repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 4000n, forma: 'dinheiro' }))
    // A nuvem tem o mesmo id com outro valor, e o download vem antes do envio deste item
    // (rede cai no envio, o download não roda; depois a rede volta e o envio recusa).
    nuvem.lancamentos.set(recebimento.id, { ...lancamentoParaNuvem({ ...recebimento, valor: 5000n }), criado_em: '2026-09-12T12:00:00.000Z' })
    await sinc.sincronizar()
    const local = await banco.lancamentos.get(recebimento.id)
    expect(local?.tipo === 'recebimento' ? local.valor : null).toBe(4000n)
    expect((await fila(banco))[0]?.problema).toBe('lancamentos_imutavel')
  })

  test('cadastro: a nuvem mais nova vence o local (mesmo pendente); a mais antiga perde; o local pendente sobe e sai', async () => {
    const nuvem = new NuvemDeMentira()
    const { banco, repositorio, sinc } = preparar({ nuvem })
    const cliente = await vera(repositorio) // atualizadoEm 10:00:00
    // O computador mexeu depois (10:05) e já subiu.
    nuvem.clientes.set(cliente.id, { id: cliente.id, nome: 'Vera Lúcia', telefone: '(11) 9 0000-0000', apelido: null, observacao: null, desativado_em: null, atualizado_em: '2026-09-12T10:05:00.000Z', recebido_em: '2026-09-12T12:00:00.000Z' })
    await sinc.sincronizar()
    // O envio da versão de 10:00 foi descartado pela nuvem (sem erro); o download trouxe a de 10:05.
    expect(await banco.clientes.get(cliente.id)).toEqual({ id: cliente.id, nome: 'Vera Lúcia', telefone: '(11) 9 0000-0000', atualizadoEm: '2026-09-12T10:05:00.000Z' })
    expect(await banco.fila.count()).toBe(0)
    expect(nuvem.clientes.get(cliente.id)?.nome).toBe('Vera Lúcia')

    // Agora ela edita aqui (10:00:01 no relógio de teste... que é anterior a 10:05: perde de novo).
    await repositorio.gravarCliente({ ...cliente, nome: 'Vera do iPhone' })
    await sinc.sincronizar()
    expect((await banco.clientes.get(cliente.id))?.nome).toBe('Vera Lúcia')
    expect(nuvem.clientes.get(cliente.id)?.nome).toBe('Vera Lúcia')
    expect(await banco.fila.count()).toBe(0)

    // Uma versão da nuvem mais antiga que a local não entra.
    nuvem.clientes.set(cliente.id, { ...nuvem.clientes.get(cliente.id)!, nome: 'Velha', atualizado_em: '2026-09-12T09:00:00.000Z', recebido_em: '2026-09-12T12:00:59.000Z' })
    await sinc.sincronizar()
    expect((await banco.clientes.get(cliente.id))?.nome).toBe('Vera Lúcia')
  })

  test('RT-10, a lógica: base zerada, tudo volta da nuvem íntegro — a prova real é E-08', async () => {
    const nuvem = new NuvemDeMentira()
    const antigo = preparar({ nuvem })
    const cliente = await vera(antigo.repositorio)
    const venda = await vendaGrande(antigo.repositorio, cliente.id)
    await vendaPequena(antigo.repositorio, cliente.id)
    const { recebimento } = ok(await receber(antigo.repositorio, { clienteId: cliente.id, data: '2026-09-05', valor: 5000n, forma: 'dinheiro' }))
    const estorno = ok(await estornarLancamento(antigo.repositorio, { clienteId: cliente.id, data: '2026-09-06', estornaId: recebimento.id, motivo: 'engano' }))
    await antigo.sinc.sincronizar()
    const fichaAntes = [...(await antigo.repositorio.lerFicha(cliente.id))].sort((a, b) => a.id.localeCompare(b.id))

    const novo = preparar({ nuvem })
    await novo.sinc.sincronizar()
    const fichaDepois = [...(await novo.repositorio.lerFicha(cliente.id))].sort((a, b) => a.id.localeCompare(b.id))
    expect(fichaDepois).toEqual(fichaAntes)
    expect(fichaDepois.map((l) => l.id)).toContain(venda.id)
    expect(fichaDepois.map((l) => l.id)).toContain(recebimento.id)
    expect(fichaDepois.map((l) => l.id)).toContain(estorno.id)
    expect(fichaDepois).toHaveLength(4)
    expect(saldo(fichaDepois)).toBe(saldo(fichaAntes))
    expect(await novo.banco.fila.count()).toBe(0)
  })
})

describe('parar() e sincronizar() concorrente', () => {
  test('acordar durante um ciclo agenda outro; parar cancela o timer', async () => {
    const { repositorio, nuvem, sinc, esperas } = preparar()
    const cliente = await vera(repositorio)
    nuvem.aoReceberLancamento = async () => {
      nuvem.aoReceberLancamento = null
      sinc.acordar()
    }
    await vendaPequena(repositorio, cliente.id)
    await sinc.sincronizar()
    // Dois ciclos: o pedido no meio do primeiro rodou um segundo.
    expect(nuvem.requisicoes.filter((r) => r.startsWith('buscarClientes'))).toHaveLength(2)
    sinc.parar()
    const antes = esperas.length
    await sinc.sincronizar()
    expect(esperas.length).toBe(antes)
  })
})
