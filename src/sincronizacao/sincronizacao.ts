/**
 * O motor da sincronização (E-07, D-003, D-010, D-042): esvazia a fila para a nuvem e traz de
 * volta o que o outro aparelho escreveu. Roda ao lado do app, nunca na frente dele — nenhuma
 * escrita espera por este arquivo (RI-02), e nenhuma tela é bloqueada por ele (EL-06).
 *
 * **Um ciclo** faz, nesta ordem:
 *
 * 1. Sem `Nuvem` configurada ou sem sessão: não tenta. Sessão não é problema do dado dela; a
 *    fila espera o login e acorda quando a sessão mudar (D-005, D-042 item 3).
 * 2. **Enviar**: a fila na ordem de entrada (`++ordem`, D-040 — o cliente sobe antes do
 *    lançamento que o cita), pulando o que está "com problema". Lê a linha **como estiver agora**
 *    (a fila é ponteiro), traduz na borda, sobe por `upsert` no id (RI-05, D-029). Sucesso remove
 *    o item — **só se a `versao` for a que subiu**; uma correção feita durante o envio fica para a
 *    vez seguinte. Falha de `rede` para o ciclo (nada mais vai passar); falha de `sessao` para e
 *    espera o login; `23503` (o pai ainda não chegou do outro aparelho) pula e tenta no próximo
 *    ciclo; qualquer outra recusa é **definitiva**: o item é marcado com o diagnóstico e o ciclo
 *    segue para o próximo — um item preso não prende os outros (D-042 item 2).
 * 3. **Baixar**: clientes, depois lançamentos, cada tabela desde o cursor guardado menos um
 *    minuto de margem (reaplicar é idempotente). Lançamento é união (D-010): entra se não existir,
 *    e **nunca** por cima de uma linha com item na fila — é o envio que decide essa. Cadastro é
 *    último-que-escreve: entra só se o `atualizadoEm` da nuvem for mais novo que o local, o mesmo
 *    critério do gatilho na nuvem. Nada do que desce enfileira: foi o outro aparelho que subiu.
 * 4. **Agendar**: com tudo enviado, uma consulta a cada 60 s enquanto a aba está visível (é o que
 *    faz "aparece no outro aparelho" sem realtime); com algo pendente ou falha de rede, retentativa
 *    com espera crescente — 5 s dobrando até 5 min. A espera zera com escrita local, `online`, aba
 *    visível ou sessão. **`navigator.onLine` não é consultado**: no iOS ele mente (`AGENTS.md`
 *    §2.1); a prova de rede é a resposta do servidor.
 *
 * Tudo que toca relógio, timer, janela e documento é injetável, para o teste rodar ciclos de
 * forma síncrona e ler as esperas pedidas em vez de esperá-las.
 */

import type { BancoLocal, ItemDaFila, TabelaSincronizada } from '../dados/banco.ts'
import { clienteDaNuvem, clienteParaNuvem, lancamentoDaNuvem, lancamentoParaNuvem, normalizarCarimbo } from './borda.ts'
import type { LinhaRecebida, Nuvem, Resposta } from './nuvem.ts'

/** O que o indicador mostra (RF-25) e o que o mantenedor lê no console. */
export type EstadoDaSincronizacao = {
  /** Itens na fila esperando subir (sem problema). */
  readonly pendentes: number
  /** Itens que a nuvem recusou em definitivo, parados até a linha ser regravada. */
  readonly comProblema: number
  /** Há um ciclo em andamento agora. */
  readonly enviando: boolean
  /** A última vez que se olhou, havia sessão. */
  readonly sessao: boolean
  /** Por que o último ciclo parou antes do fim, ou `null` se chegou ao fim. */
  readonly ultimaFalha: 'rede' | 'sessao' | null
  /** Instante do último ciclo completo, ISO 8601, ou `null` se nunca houve. */
  readonly ultimoSucessoEm: string | null
}

/** O motor, visto de fora. */
export type Sincronizacao = {
  /** "Há algo novo" — escrita local, rede de volta, aba visível. Zera a espera e roda um ciclo, sem bloquear. */
  readonly acordar: () => void
  /** Roda um ciclo agora e espera terminar. É o `acordar` para quem precisa do resultado (testes, E-08). */
  readonly sincronizar: () => Promise<void>
  /** O estado atual. Mesma referência enquanto nada mudar (é o que `useSyncExternalStore` exige). */
  readonly estado: () => EstadoDaSincronizacao
  /** Avisa quando o estado muda. Devolve a função que cancela. */
  readonly assinar: (ouvinte: () => void) => () => void
  /** Cancela timers e ouvintes. Depois disto o motor não faz mais nada. */
  readonly parar: () => void
}

/** Um timer injetável: agenda `fn` para daqui a `ms` e devolve quem cancela. */
export type Agendar = (fn: () => void, ms: number) => () => void

/** O pedaço de `document` que o motor usa. */
export type Documento = {
  readonly visibilityState: string
  readonly addEventListener: (tipo: 'visibilitychange', ouvinte: () => void) => void
  readonly removeEventListener: (tipo: 'visibilitychange', ouvinte: () => void) => void
}

/** O pedaço de `window` que o motor usa. */
export type Janela = {
  readonly addEventListener: (tipo: 'online', ouvinte: () => void) => void
  readonly removeEventListener: (tipo: 'online', ouvinte: () => void) => void
}

export type Dependencias = {
  readonly banco: BancoLocal
  /** `null` quando o app foi construído sem configuração da nuvem: a fila fica "para enviar". */
  readonly nuvem: Nuvem | null
  readonly agora?: () => Date
  readonly agendar?: Agendar
  readonly janela?: Janela | null
  readonly documento?: Documento | null
}

/** Primeira espera depois de uma falha retentável, em ms; dobra a cada tentativa (D-042). */
export const ESPERA_INICIAL_MS = 5_000
/** Teto da espera crescente, em ms. */
export const ESPERA_MAXIMA_MS = 300_000
/** Intervalo da consulta à nuvem com a fila vazia e a aba visível, em ms. */
export const INTERVALO_DE_CONSULTA_MS = 60_000
/** Margem do cursor de download, em ms: reaplicar é idempotente, perder uma linha não (D-042). */
export const MARGEM_DO_CURSOR_MS = 60_000

/** Como um ciclo terminou. `ok` inclui itens pulados por `23503` e itens marcados com problema. */
type Desfecho = 'ok' | 'rede' | 'sessao'

/** A chave estrangeira que ainda não foi satisfeita: o pai vem do outro aparelho e ainda não subiu. */
const CHAVE_ESTRANGEIRA = '23503'

/** O timer real: `setTimeout`/`clearTimeout` do ambiente. */
const agendarPadrao: Agendar = (fn, ms) => {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

/** Cria e liga o motor. Não roda nada até o primeiro `acordar()`/`sincronizar()`. */
export function iniciarSincronizacao(dependencias: Dependencias): Sincronizacao {
  const { banco, nuvem } = dependencias
  const agora = dependencias.agora ?? (() => new Date())
  const agendar = dependencias.agendar ?? agendarPadrao
  const janela = dependencias.janela === undefined ? (typeof window === 'undefined' ? null : window) : dependencias.janela
  const documento = dependencias.documento === undefined ? (typeof document === 'undefined' ? null : document) : dependencias.documento

  let estado: EstadoDaSincronizacao = { pendentes: 0, comProblema: 0, enviando: false, sessao: false, ultimaFalha: null, ultimoSucessoEm: null }
  const ouvintes = new Set<() => void>()
  let cancelarTimer: (() => void) | null = null
  let tentativa = 0
  let emAndamento: Promise<void> | null = null
  let pedidoDurante = false
  let parado = false

  function notificar(): void {
    for (const ouvinte of ouvintes) ouvinte()
  }

  /** Recalcula o estado a partir da fila; troca a referência só se algo mudou. */
  async function atualizarEstado(mudancas: Partial<EstadoDaSincronizacao> = {}): Promise<void> {
    const itens = await banco.fila.toArray()
    const comProblema = itens.filter((item) => item.problema !== undefined).length
    const novo: EstadoDaSincronizacao = { ...estado, ...mudancas, pendentes: itens.length - comProblema, comProblema }
    if (JSON.stringify(novo) === JSON.stringify(estado)) return
    estado = novo
    notificar()
  }

  function cancelarAgendado(): void {
    cancelarTimer?.()
    cancelarTimer = null
  }

  function agendarCiclo(ms: number): void {
    cancelarAgendado()
    if (parado) return
    cancelarTimer = agendar(() => {
      cancelarTimer = null
      void rodar()
    }, ms)
  }

  /** Espera crescente: 5 s, 10 s, 20 s… até 5 min (D-042). */
  function agendarRetentativa(): void {
    const ms = Math.min(ESPERA_INICIAL_MS * 2 ** tentativa, ESPERA_MAXIMA_MS)
    tentativa += 1
    agendarCiclo(ms)
  }

  /** Com a fila vazia: consultar a nuvem de tempos em tempos, só com a aba visível. */
  function agendarConsulta(): void {
    if (documento !== null && documento.visibilityState !== 'visible') return
    agendarCiclo(INTERVALO_DE_CONSULTA_MS)
  }

  // ---------------------------------------------------------------------------------------------
  // Enviar
  // ---------------------------------------------------------------------------------------------

  /** Sobe a linha atual do item. Linha que não existe mais não tem o que subir: o item sai. */
  async function enviarItem(nuvemLigada: Nuvem, item: ItemDaFila): Promise<Resposta<void>> {
    if (item.tabela === 'clientes') {
      const cliente = await banco.clientes.get(item.registroId)
      if (cliente === undefined) return { ok: true, valor: undefined }
      // Linha gravada pela v1 não tem `atualizadoEm`: o instante em que entrou na fila é o melhor
      // carimbo do aparelho que existe para ela.
      return nuvemLigada.enviarCliente(clienteParaNuvem({ ...cliente, atualizadoEm: cliente.atualizadoEm ?? item.criadoEm }))
    }
    const lancamento = await banco.lancamentos.get(item.registroId)
    if (lancamento === undefined) return { ok: true, valor: undefined }
    return nuvemLigada.enviarLancamento(lancamentoParaNuvem(lancamento))
  }

  /** Remove o item só se ninguém regravou a linha enquanto ela subia (D-042). */
  async function concluirItem(item: ItemDaFila): Promise<void> {
    await banco.fila
      .where('ordem')
      .equals(item.ordem)
      .and((atual) => (atual.versao ?? 0) === (item.versao ?? 0))
      .delete()
  }

  async function enviar(nuvemLigada: Nuvem): Promise<Desfecho> {
    const itens = await banco.fila.orderBy('ordem').toArray()
    for (const item of itens) {
      if (item.problema !== undefined) continue
      const resposta = await enviarItem(nuvemLigada, item)
      if (resposta.ok) {
        await concluirItem(item)
        continue
      }
      const { falha } = resposta
      if (falha.tipo === 'rede' || falha.tipo === 'sessao') return falha.tipo
      if (falha.codigo === CHAVE_ESTRANGEIRA) continue
      // Recusa definitiva (D-042, item 2): fica parado, com o diagnóstico, até a linha ser regravada.
      await banco.fila.update(item.ordem, {
        problema: {
          codigo: falha.codigo,
          ...(falha.constraint === undefined ? {} : { constraint: falha.constraint }),
          mensagem: falha.mensagem,
          em: agora().toISOString(),
        },
      })
      console.warn(`sincronização: a nuvem recusou ${item.tabela}/${item.registroId} em definitivo (${falha.codigo}${falha.constraint ? ` ${falha.constraint}` : ''}): ${falha.mensagem}`)
    }
    return 'ok'
  }

  // ---------------------------------------------------------------------------------------------
  // Baixar
  // ---------------------------------------------------------------------------------------------

  /** Cadastro é último-que-escreve (D-010): entra só se for mais novo que o local. */
  async function aplicarCliente(linha: LinhaRecebida): Promise<void> {
    const cliente = clienteDaNuvem(linha)
    await banco.transaction('rw', banco.clientes, async () => {
      const local = await banco.clientes.get(cliente.id)
      // Linha da v1 sem carimbo conta como "mais antiga que qualquer coisa".
      if (local !== undefined && (local.atualizadoEm ?? '') >= cliente.atualizadoEm) return
      await banco.clientes.put(cliente)
    })
  }

  /** Lançamento é união (D-010): entra se não estiver na fila — a linha pendente é o envio quem decide. */
  async function aplicarLancamento(linha: LinhaRecebida): Promise<void> {
    const lancamento = lancamentoDaNuvem(linha)
    await banco.transaction('rw', banco.lancamentos, banco.fila, async () => {
      const pendente = await banco.fila.where('registroId').equals(lancamento.id).count()
      if (pendente > 0) return
      await banco.lancamentos.put(lancamento)
    })
  }

  function comMargem(cursor: string): string {
    return new Date(new Date(cursor).getTime() - MARGEM_DO_CURSOR_MS).toISOString()
  }

  async function baixarTabela(
    tabela: TabelaSincronizada,
    buscar: (desde: string | null) => Promise<Resposta<readonly LinhaRecebida[]>>,
    carimbo: 'recebido_em' | 'criado_em',
    aplicar: (linha: LinhaRecebida) => Promise<void>,
  ): Promise<Desfecho> {
    const cursor = (await banco.sincronizacao.get(tabela))?.valor ?? null
    const resposta = await buscar(cursor === null ? null : comMargem(cursor))
    if (!resposta.ok) {
      // Uma recusa num GET (coluna que não existe, migration por aplicar) não é problema de item
      // nenhum: é "tenta de novo", e o mantenedor vê no console.
      if (resposta.falha.tipo === 'recusa') console.warn(`sincronização: o download de ${tabela} foi recusado (${resposta.falha.codigo}): ${resposta.falha.mensagem}`)
      return resposta.falha.tipo === 'sessao' ? 'sessao' : 'rede'
    }
    let maior = cursor
    for (const linha of resposta.valor) {
      const instante = normalizarCarimbo(`${tabela}.${carimbo}`, linha[carimbo])
      await aplicar(linha)
      if (maior === null || instante > maior) maior = instante
    }
    if (maior !== null && maior !== cursor) await banco.sincronizacao.put({ chave: tabela, valor: maior })
    return 'ok'
  }

  async function baixar(nuvemLigada: Nuvem): Promise<Desfecho> {
    const clientes = await baixarTabela('clientes', (desde) => nuvemLigada.buscarClientes(desde), 'recebido_em', aplicarCliente)
    if (clientes !== 'ok') return clientes
    return baixarTabela('lancamentos', (desde) => nuvemLigada.buscarLancamentos(desde), 'criado_em', aplicarLancamento)
  }

  // ---------------------------------------------------------------------------------------------
  // O ciclo
  // ---------------------------------------------------------------------------------------------

  async function ciclo(): Promise<void> {
    cancelarAgendado()
    if (nuvem === null) {
      await atualizarEstado({ sessao: false, ultimaFalha: 'sessao' })
      return
    }
    const sessao = await nuvem.temSessao()
    if (!sessao) {
      // Sem timer: quem acorda o motor é `aoMudarSessao` (ou uma escrita local, que tenta de novo).
      await atualizarEstado({ sessao: false, ultimaFalha: 'sessao' })
      return
    }
    await atualizarEstado({ sessao: true, enviando: true })
    let desfecho: Desfecho
    try {
      desfecho = await enviar(nuvem)
      if (desfecho === 'ok') desfecho = await baixar(nuvem)
    } catch (erro) {
      // Erro de programador (linha malformada, base fechada). Não pode virar tela (EL-06) nem
      // sumir: fica no console e o motor tenta de novo com espera crescente.
      console.error('sincronização: o ciclo falhou', erro)
      desfecho = 'rede'
    }
    if (desfecho === 'ok') {
      tentativa = 0
      await atualizarEstado({ enviando: false, ultimaFalha: null, ultimoSucessoEm: agora().toISOString() })
      if (estado.pendentes > 0) agendarRetentativa()
      else agendarConsulta()
      return
    }
    await atualizarEstado({ enviando: false, ultimaFalha: desfecho })
    if (desfecho === 'rede') agendarRetentativa()
    // `sessao`: sem timer; `aoMudarSessao` acorda.
  }

  /** Roda um ciclo; se já há um no ar, pede mais um depois dele (há algo novo) e devolve o que está rodando. */
  function rodar(): Promise<void> {
    if (parado) return Promise.resolve()
    if (emAndamento !== null) {
      pedidoDurante = true
      return emAndamento
    }
    emAndamento = (async () => {
      do {
        pedidoDurante = false
        await ciclo()
      } while (pedidoDurante && !parado)
    })().finally(() => {
      emAndamento = null
    })
    return emAndamento
  }

  /** O ciclo em andamento, ou um novo. Não pede um segundo: quem tem novidade chama `acordar`. */
  function sincronizar(): Promise<void> {
    return emAndamento ?? rodar()
  }

  function acordar(): void {
    tentativa = 0
    void rodar()
  }

  // ---------------------------------------------------------------------------------------------
  // Ouvintes do ambiente
  // ---------------------------------------------------------------------------------------------

  const aoFicarVisivel = (): void => {
    if (documento === null || documento.visibilityState === 'visible') acordar()
  }
  janela?.addEventListener('online', acordar)
  documento?.addEventListener('visibilitychange', aoFicarVisivel)
  const cancelarSessao = nuvem?.aoMudarSessao(acordar) ?? null

  return {
    acordar,
    sincronizar,
    estado: () => estado,
    assinar: (ouvinte) => {
      ouvintes.add(ouvinte)
      return () => {
        ouvintes.delete(ouvinte)
      }
    },
    parar: () => {
      parado = true
      cancelarAgendado()
      janela?.removeEventListener('online', acordar)
      documento?.removeEventListener('visibilitychange', aoFicarVisivel)
      cancelarSessao?.()
    },
  }
}
