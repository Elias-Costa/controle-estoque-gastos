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

import type { BancoLocal, CursorDeDownload, ItemDaFila, Problema } from '../dados/banco.ts'
import { itemDaFilaDoRegistro } from '../dados/fila.ts'
import { criarRepositorioEstoque } from '../dados/repositorio-estoque.ts'
import { criarRepositorioCaixa } from '../dados/repositorio-caixa.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import { clienteDaNuvem, clienteParaNuvem, lancamentoDaNuvem, lancamentoParaNuvem, normalizarCarimbo } from './borda.ts'
import { categoriaDaNuvem, documentoEstoque, produtoDaNuvem, recepcaoDaNuvem } from './borda-estoque.ts'
import { LINHAS_POR_PAGINA, type Falha, type LinhaRecebida, type Nuvem, type Resposta } from './nuvem.ts'
import { aplicarRecepcaoEstoque } from './recepcao-estoque.ts'
import { aplicarRecepcaoCaixa } from './recepcao-caixa.ts'
import { grupoCaixaParaNuvem, recepcaoCaixaDaNuvem } from './borda-caixa.ts'
import { criarSincronizacaoFotos } from './fotos.ts'
import { vincularContaCopia } from '../dados/repositorio-copia.ts'
import { criarRepositorioModelos } from '../dados/repositorio-modelos.ts'
import { modelosDaNuvem, modelosParaNuvem } from './borda-modelos.ts'
import { aplicarModelos } from './recepcao-modelos.ts'

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
  const estoque = criarRepositorioEstoque(banco)
  const caixa = criarRepositorioCaixa(banco)
  const fotos = nuvem?.fotos ? criarSincronizacaoFotos(banco, nuvem, nuvem.fotos) : null
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
    if (item.tabela === 'categorias') {
      const categoria = await banco.categorias.get(item.registroId)
      if (!categoria) throw new Error('Fila sem categoria')
      return nuvemLigada.enviarCategoria(documentoEstoque(categoria))
    }
    if (item.tabela === 'produtos') {
      const produto = await banco.produtos.get(item.registroId)
      if (!produto) throw new Error('Fila sem produto')
      return fotos ? fotos.enviarProduto(produto) : nuvemLigada.enviarProduto(documentoEstoque(produto))
    }
    if (item.tabela === 'encerramentos') {
      const encerramento = await banco.encerramentos.get(item.registroId)
      if (!encerramento) throw new Error('Fila sem encerramento')
      const { remotoId: _remotoId, ...documento } = encerramento
      const resposta = await nuvemLigada.enviarEncerramento(documentoEstoque(documento))
      if (!resposta.ok) return resposta
      if (resposta.valor !== encerramento.id) {
        // Q47A: sucesso pode designar resolução anterior diferente. O download confirma qual foi.
        await banco.encerramentos.put({ ...encerramento, remotoId: resposta.valor })
        return { ok: false, falha: { tipo: 'recusa', codigo: CHAVE_ESTRANGEIRA, mensagem: 'Aguardando resolução já aceita' } }
      }
      return { ok: true, valor: undefined }
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
    const modelos = criarRepositorioModelos(banco)
    const itens = await banco.fila.orderBy('ordem').toArray()
    for (const item of itens) {
      if (await banco.controleCopia.get('restauracao')) return 'ok'
      // E-22: o ciclo de binários vem depois das operações; foto nunca segue pela rota financeira.
      if (item.tabela === 'fotos') continue
      if (item.problema !== undefined) continue
      if (item.tabela === 'modelos') {
        const envio = await modelos.capturarEnvio(item.registroId)
        if (!envio) continue
        const resposta = await nuvemLigada.enviarModelos(modelosParaNuvem(envio.preferencia))
        if (resposta.ok) await modelos.responderEnvio(envio)
        else if (resposta.falha.tipo !== 'recusa') return resposta.falha.tipo
        else await modelos.responderEnvio(envio, problemaDaFalha(resposta.falha))
        continue
      }
      if (item.tabela === 'operacoesCaixa') {
        const envio = await caixa.capturarEnvio(item.registroId)
        if (!envio) continue
        const resposta = await nuvemLigada.enviarCaixa(grupoCaixaParaNuvem(envio.versao.grupo))
        if (resposta.ok) await caixa.responderEnvio(envio)
        else if (resposta.falha.tipo !== 'recusa') return resposta.falha.tipo
        else if (resposta.falha.codigo !== CHAVE_ESTRANGEIRA) await caixa.responderEnvio(envio, problemaDaFalha(resposta.falha))
        continue
      }
      if (item.tabela === 'operacoes') {
        const envio = await estoque.capturarEnvio(item.registroId)
        if (!envio) continue
        const encerramento = (await banco.encerramentos.toArray()).find((e) => e.novaOperacao?.operacao.id === item.registroId)
        if (encerramento && await banco.fila.where('registroId').equals(encerramento.id).count()) continue
        const resposta = await nuvemLigada.enviarGrupo(documentoEstoque(envio.versao.grupo), envio.evidencias.map(documentoEstoque),
          encerramento?.remotoId ?? encerramento?.id ?? null)
        if (resposta.ok) await estoque.responderEnvio(envio)
        else if (resposta.falha.tipo !== 'recusa') return resposta.falha.tipo
        else if (resposta.falha.codigo !== CHAVE_ESTRANGEIRA) await estoque.responderEnvio(envio, problemaDaFalha(resposta.falha))
        continue
      }
      const resposta = await enviarItem(nuvemLigada, item)
      if (resposta.ok) {
        await concluirItem(item)
        continue
      }
      const { falha } = resposta
      if (falha.tipo === 'rede' || falha.tipo === 'sessao') return falha.tipo
      if (falha.codigo === CHAVE_ESTRANGEIRA) continue
      // Recusa definitiva (D-042, item 2): fica parado, com o diagnóstico, até a linha ser regravada.
      await banco.transaction('rw', banco.fila, async () => {
        const atual = await banco.fila.get(item.ordem)
        if (atual && (atual.versao ?? 0) === (item.versao ?? 0)) await banco.fila.put({ ...atual, problema: problemaDaFalha(falha) })
      })
      console.warn(`sincronização: a nuvem recusou ${item.tabela}/${item.registroId} em definitivo (${falha.codigo}${falha.constraint ? ` ${falha.constraint}` : ''}): ${falha.mensagem}`)
    }
    return 'ok'
  }

  function problemaDaFalha(falha: Extract<Falha, { tipo: 'recusa' }>): Problema {
    return { codigo: falha.codigo, ...(falha.constraint ? { constraint: falha.constraint } : {}),
      mensagem: falha.mensagem, em: agora().toISOString() }
  }

  // ---------------------------------------------------------------------------------------------
  // Baixar
  // ---------------------------------------------------------------------------------------------

  /** Cadastro é último-que-escreve (D-010): entra só se for mais novo que o local. */
  async function aplicarCliente(linha: LinhaRecebida): Promise<void> {
    const cliente = clienteDaNuvem(linha)
    await banco.transaction('rw', banco.clientes, banco.fila, banco.controleCopia, async () => {
      const local = await banco.clientes.get(cliente.id)
      const restaurando = !!await banco.controleCopia.get('restauracao')
      const origem = await banco.controleCopia.get(`registro:clientes/${cliente.id}`)
      const copiado = origem && 'conteudo' in origem && origem.conteudo === conteudoDoEfeito(local)
      if (restaurando && (!local || (local.atualizadoEm ?? '') < cliente.atualizadoEm || (copiado && local.atualizadoEm === cliente.atualizadoEm))) {
        await banco.clientes.put(cliente)
        const fila = await banco.fila.where('registroId').equals(cliente.id).and((i) => i.tabela === 'clientes').first()
        if (fila) await banco.fila.delete(fila.ordem)
        return
      }
      // Linha da v1 sem carimbo conta como "mais antiga que qualquer coisa".
      if (local !== undefined && (local.atualizadoEm ?? '') >= cliente.atualizadoEm) return
      await banco.clientes.put(cliente)
    })
  }

  /** Lançamento é união (D-010): entra se não estiver na fila — a linha pendente é o envio quem decide. */
  async function aplicarLancamento(linha: LinhaRecebida): Promise<void> {
    // O cursor próprio de F2 é quem aplica financeiro e estoque juntos, inclusive após restauração.
    if (linha['operacao_estoque_id'] !== undefined && linha['operacao_estoque_id'] !== null) return
    const lancamento = lancamentoDaNuvem(linha)
    await banco.transaction('rw', banco.lancamentos, banco.fila, banco.operacoes, banco.controleCopia, banco.evidenciasCopia, async () => {
      if (await banco.controleCopia.get('restauracao')) {
        const fila = await itemDaFilaDoRegistro(banco, lancamento.id)
        // Grupos F2 continuam indivisíveis, mesmo quando o arquivo tem uma linha F1 com o mesmo id.
        if (fila && fila.tabela !== 'lancamentos') return
        const local = await banco.lancamentos.get(lancamento.id)
        const origem = await banco.controleCopia.get(`registro:lancamentos/${lancamento.id}`)
        if (local && fila && (!origem || !('conteudo' in origem) || origem.conteudo !== conteudoDoEfeito(local))) return
        if (local && conteudoDoEfeito(local) !== conteudoDoEfeito(lancamento)) {
          await banco.evidenciasCopia.put({ id: lancamento.id, tentativa: local, aceita: lancamento })
        }
        if (fila) await banco.fila.delete(fila.ordem)
        await banco.lancamentos.put(lancamento)
        return
      }
      if (await itemDaFilaDoRegistro(banco, lancamento.id)) return
      await banco.lancamentos.put(lancamento)
    })
  }

  function comMargem(cursor: string): string {
    return new Date(new Date(cursor).getTime() - MARGEM_DO_CURSOR_MS).toISOString()
  }

  async function baixarTabela(
    tabela: Exclude<CursorDeDownload['chave'], 'estoque' | 'caixa'>,
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
    const modelos = await nuvemLigada.buscarModelos()
    if (!modelos.ok) return modelos.falha.tipo === 'sessao' ? 'sessao' : 'rede'
    if (modelos.valor.length > 1) throw new Error('Mais de uma preferência de mensagens')
    for (const linha of modelos.valor) await aplicarModelos(banco, modelosDaNuvem(linha))
    const clientes = await baixarTabela('clientes', (desde) => nuvemLigada.buscarClientes(desde), 'recebido_em', aplicarCliente)
    if (clientes !== 'ok') return clientes
    const lancamentos = await baixarTabela('lancamentos', (desde) => nuvemLigada.buscarLancamentos(desde), 'criado_em', aplicarLancamento)
    if (lancamentos !== 'ok') return lancamentos
    const categorias = await nuvemLigada.buscarCategorias(null)
    if (!categorias.ok) return categorias.falha.tipo === 'sessao' ? 'sessao' : 'rede'
    for (const linha of categorias.valor) {
      const categoria = categoriaDaNuvem(linha)
      await banco.transaction('rw', banco.categorias, banco.fila, banco.controleCopia, async () => {
        const local = await banco.categorias.get(categoria.id)
        if (local && conteudoDoEfeito(local) !== conteudoDoEfeito(categoria)) throw new Error('Categoria remota divergente')
        await banco.categorias.put(categoria)
        if (await banco.controleCopia.get('restauracao')) {
          const fila = await banco.fila.where('registroId').equals(categoria.id).and((i) => i.tabela === 'categorias').first()
          if (fila) await banco.fila.delete(fila.ordem)
        }
      })
    }
    const produtos = await baixarTabela('produtos', (desde) => fotos ? fotos.buscarProdutos(desde) : nuvemLigada.buscarProdutos(desde), 'recebido_em', async (linha) => {
      if (fotos) return fotos.receberProduto(linha)
      const produto = produtoDaNuvem(linha)
      await banco.transaction('rw', banco.produtos, banco.categorias, async () => {
        if (!await banco.categorias.get(produto.categoriaId)) throw new Error('Produto remoto sem categoria')
        const local = await banco.produtos.get(produto.id)
        if (!local || local.atualizadoEm < produto.atualizadoEm) await banco.produtos.put(produto)
      })
    })
    if (produtos !== 'ok') return produtos
    for (;;) {
      const cursor = (await banco.sincronizacao.get('estoque'))?.valor ?? '0'
      const resposta = await nuvemLigada.buscarEstoque(cursor, LINHAS_POR_PAGINA)
      if (!resposta.ok) return resposta.falha.tipo === 'sessao' ? 'sessao' : 'rede'
      let anterior = BigInt(cursor)
      for (const linha of resposta.valor) {
        const recebido = recepcaoDaNuvem(linha)
        if (BigInt(recebido.recepcao) !== anterior + 1n) throw new Error('Recepções fora de ordem ou posição ausente')
        await aplicarRecepcaoEstoque(banco, recebido)
        anterior = BigInt(recebido.recepcao)
      }
      if (resposta.valor.length < LINHAS_POR_PAGINA) break
    }
    for (;;) {
      const cursor = (await banco.sincronizacao.get('caixa'))?.valor ?? '0'
      const resposta = await nuvemLigada.buscarCaixa(cursor, LINHAS_POR_PAGINA)
      if (!resposta.ok) return resposta.falha.tipo === 'sessao' ? 'sessao' : 'rede'
      let anterior = BigInt(cursor)
      for (const linha of resposta.valor) {
        const recebido = recepcaoCaixaDaNuvem(linha)
        if (BigInt(recebido.recepcao) !== anterior + 1n) throw new Error('Recepções de caixa fora de ordem ou posição ausente')
        await aplicarRecepcaoCaixa(banco, recebido)
        anterior = BigInt(recebido.recepcao)
      }
      if (resposta.valor.length < LINHAS_POR_PAGINA) return 'ok'
    }
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
    if (nuvem.identidade) {
      try {
        const identidade = await nuvem.identidade()
        if (!identidade) throw new Error('Sessão sem identidade')
        await vincularContaCopia(banco, identidade)
      } catch (erro) {
        console.error('sincronização: conta incompatível com a base local', erro)
        await atualizarEstado({ sessao: false, enviando: false, ultimaFalha: 'sessao' }); return
      }
    }
    await atualizarEstado({ sessao: true, enviando: true })
    let desfecho: Desfecho
    try {
      const restauracao = await banco.controleCopia.get('restauracao')
      if (restauracao?.chave === 'restauracao' && restauracao.fase === 'escolher') {
        await atualizarEstado({ enviando: false }); agendarConsulta(); return
      }
      desfecho = 'ok'
      if (restauracao?.chave === 'restauracao') {
        if (restauracao.fase === 'reconciliar') {
          desfecho = await baixar(nuvem)
          if (desfecho === 'ok') await banco.controleCopia.put({ ...restauracao, fase: 'proteger' })
        }
        if (desfecho === 'ok') {
          if (!fotos && await banco.fotos.count()) throw new Error('Restauração de fotos sem transporte')
          const protecao = await fotos?.protegerRestauracao()
          if (protecao && !protecao.ok) desfecho = protecao.falha.tipo === 'sessao' ? 'sessao' : 'rede'
          if (desfecho === 'ok') await banco.controleCopia.delete('restauracao')
        }
      }
      if (desfecho === 'ok') desfecho = await enviar(nuvem)
      if (desfecho === 'ok') desfecho = await baixar(nuvem)
      if (desfecho === 'ok' && fotos) {
        const resposta = await fotos.ciclo()
        if (!resposta.ok) desfecho = resposta.falha.tipo === 'sessao' ? 'sessao' : 'rede'
      }
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
