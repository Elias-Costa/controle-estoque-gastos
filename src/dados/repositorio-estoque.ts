import { validar, type Id, type Lancamento } from '../dominio/ficha.ts'
import { chaveDoEfeito, projetarEstoque, registrarMovimentos, type MovimentoEstoque } from '../dominio/estoque.ts'
import { alterarCustoManual, novaCategoria, novoProduto, proximoCarimboDeCadastro, type Categoria, type Produto } from '../dominio/produtos.ts'
import { aceitarGrupoEstoque, efeitosAposEncerramentos, encerrarTentativaEstoque, identidadeDaTentativa,
  type EncerramentoTentativa, type EstadoAceitoEstoque } from '../dominio/recuperacao-estoque.ts'
import { conteudoDoEfeito, quantidadeValida, type ResultadoEstoque } from '../dominio/regras-estoque.ts'
import type { GrupoEstoque, OperacaoEstoque } from '../dominio/vendas-estoque.ts'
import type { BancoLocal, ItemDaFila, Problema, TabelaDaFila, VersaoEstoque } from './banco.ts'
import { uuidv7 } from './identidade.ts'

/** Estado lido dentro da mesma transação que valida/grava F2; nunca aguardamos rede aqui. */
export type EstadoLocalEstoque = {
  readonly lancamentos: readonly Lancamento[]
  readonly movimentos: readonly MovimentoEstoque[]
  readonly produtos: readonly Produto[]
  readonly operacoes: readonly OperacaoEstoque[]
  readonly grupos: readonly GrupoEstoque[]
  readonly fila: readonly ItemDaFila[]
  readonly clientes: readonly Id[]
  readonly carimbo: bigint
}

/** Preparação síncrona: só domínio puro entre a leitura e a escrita (D-057). */
export type PrepararGrupoLocal = (estado: EstadoLocalEstoque) => ResultadoEstoque<GrupoEstoque>

/** Fotografia durável de envio; uma resposta nunca confirma a edição feita depois dela. */
export type EnvioEstoque = { readonly item: ItemDaFila; readonly versao: VersaoEstoque }

/** Base local de F2. Os métodos de transporte só registram resultados; não fazem rede. */
export function criarRepositorioEstoque(banco: BancoLocal, agora: () => string = () => new Date().toISOString(),
  aoEnfileirar: () => void = () => undefined) {
  // O mesmo escopo em todas as escritas serializa abas, inclusive o máximo lógico de Q42.
  const tabelas = [banco.clientes, banco.lancamentos, banco.fila, banco.categorias, banco.produtos,
    banco.operacoes, banco.movimentos, banco.versoesEstoque, banco.encerramentos, banco.relogioEstoque]

  async function enfileirar(tabela: TabelaDaFila, registroId: Id, revisao?: number): Promise<void> {
    const item = await banco.fila.where('registroId').equals(registroId).first()
    if (item) {
      await banco.fila.update(item.ordem, { tabela, registroId,
        versao: revisao ?? (item.versao ?? 0) + 1, problema: undefined })
    } else await banco.fila.add({ tabela, registroId, criadoEm: agora(), versao: revisao ?? 0 })
  }

  async function lerEstado(): Promise<EstadoLocalEstoque> {
    const versoes = await banco.versoesEstoque.toArray()
    const linhas = await banco.operacoes.toArray()
    const operacoes = linhas.map(({ versaoId: _versaoId, ...operacao }) => operacao)
    const grupos = linhas.map(({ versaoId, ...operacao }) => {
      const versao = versoes.find((item) => item.id === versaoId && !item.legadoId && conteudoDoEfeito(item.grupo.operacao) === conteudoDoEfeito(operacao))
      if (!versao) throw new Error('Manifesto de estoque sem revisão durável')
      return versao.grupo
    })
    let maximo = (await banco.relogioEstoque.get('cadastro'))?.ultimo ?? 0n
    const movimentos = await banco.movimentos.toArray()
    // Recupera o máximo também das evidências: restauração ou tentativa encerrada não volta o relógio.
    for (const movimento of [...movimentos, ...versoes.flatMap((item) => item.grupo.movimentos)]) {
      if (movimento.tipo === 'compra' && movimento.ordemCadastro > maximo) maximo = movimento.ordemCadastro
    }
    return { operacoes, grupos, movimentos, lancamentos: await banco.lancamentos.toArray(),
      produtos: await banco.produtos.toArray(), clientes: (await banco.clientes.toArray()).map((item) => item.id),
      fila: await banco.fila.toArray(), carimbo: proximoCarimboDeCadastro(BigInt(new Date(agora()).getTime()), maximo) }
  }

  function conferirReferencias(estado: EstadoLocalEstoque, grupo: GrupoEstoque): ResultadoEstoque<GrupoEstoque> {
    const op = grupo.operacao
    if (op.formato !== 1 || !op.id || !quantidadeValida(op.revisao, 1) ||
      op.lancamentos.length !== grupo.lancamentos.length || op.movimentos.length !== grupo.movimentos.length ||
      new Set(op.lancamentos.map((ref) => ref.id)).size !== op.lancamentos.length ||
      new Set(op.movimentos.map((ref) => ref.id)).size !== op.movimentos.length ||
      op.lancamentos.some((ref) => ref.revisao !== op.revisao || !grupo.lancamentos.some((item) => item.id === ref.id)) ||
      op.movimentos.some((ref) => !grupo.movimentos.some((item) => item.id === ref.id && item.revisao === ref.revisao)) ||
      grupo.movimentos.some((item) => item.operacaoId !== op.id)) return { ok: false, motivo: 'base-invalida' }
    if (grupo.lancamentos.some((item) => !estado.clientes.includes(item.clienteId))) return { ok: false, motivo: 'cliente-nao-encontrado' }
    const produtos = new Set(estado.produtos.map((item) => item.id))
    if (grupo.movimentos.some((item) => !produtos.has(item.produtoId)) || grupo.lancamentos.some((item) =>
      item.tipo === 'venda' && item.itens.some((vendido) => vendido.produtoId && !produtos.has(vendido.produtoId)))) return { ok: false, motivo: 'produto-inexistente' }
    const anterior = estado.grupos.find((item) => item.operacao.id === grupo.operacao.id)
    if (!anterior) {
      const conferida = aceitarGrupoEstoque({ operacoes: estado.grupos, lancamentos: estado.lancamentos, movimentos: estado.movimentos }, grupo)
      return conferida.ok ? { ok: true, valor: grupo } : conferida
    }
    const pendente = estado.fila.find((item) => item.tabela === 'operacoes' && item.registroId === anterior.operacao.id)
    if (!pendente) return { ok: false, motivo: 'ja-sincronizado' }
    if (pendente.problema) return { ok: false, motivo: 'confirmacao-necessaria' }
    if (grupo.operacao.revisao !== anterior.operacao.revisao + 1 || grupo.operacao.tipo !== anterior.operacao.tipo ||
      anterior.lancamentos.some((item) => !grupo.lancamentos.some((novo) => novo.id === item.id)) ||
      anterior.movimentos.some((item) => !grupo.movimentos.some((novo) => novo.id === item.id))) return { ok: false, motivo: 'revisao-invalida' }
    const ids = new Set(grupo.lancamentos.map((item) => item.id))
    const lancamentos = [...estado.lancamentos.filter((item) => !ids.has(item.id)), ...grupo.lancamentos]
    for (const clienteId of new Set(lancamentos.map((item) => item.clienteId))) {
      const ficha = validar(lancamentos.filter((item) => item.clienteId === clienteId))
      if (!ficha.ok) return ficha
    }
    const movimentos = registrarMovimentos(estado.movimentos, grupo.movimentos)
    return movimentos.ok ? { ok: true, valor: grupo } : movimentos
  }

  async function gravarGrupo(grupo: GrupoEstoque): Promise<void> {
    const versaoId = uuidv7()
    await banco.operacoes.put({ ...grupo.operacao, versaoId })
    for (const lancamento of grupo.lancamentos) await banco.lancamentos.put(lancamento)
    for (const movimento of grupo.movimentos) await banco.movimentos.put(movimento)
    // A cópia é evidência histórica, não outra fonte editável de saldo/estoque (Q39/47A).
    await banco.versoesEstoque.add({ id: versaoId, operacaoId: grupo.operacao.id, grupo })
    await enfileirar('operacoes', grupo.operacao.id, grupo.operacao.revisao)
  }

  async function executar(preparar: PrepararGrupoLocal): Promise<ResultadoEstoque<GrupoEstoque>> {
    const resultado = await banco.transaction('rw', tabelas, async () => {
      const estado = await lerEstado()
      const preparado = preparar(estado)
      if (!preparado.ok) return preparado
      const conferido = conferirReferencias(estado, preparado.valor)
      if (!conferido.ok) return conferido
      await gravarGrupo(conferido.valor)
      await banco.relogioEstoque.put({ chave: 'cadastro', ultimo: estado.carimbo })
      return conferido
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }

  async function cadastrarCategoria(nome: string): Promise<ResultadoEstoque<Categoria>> {
    let criada = false
    const resultado = await banco.transaction('rw', tabelas, async () => {
      const conhecidas = await banco.categorias.toArray()
      const categoria = novaCategoria({ id: uuidv7(), nome }, conhecidas)
      if (categoria.ok && !conhecidas.some((item) => item.id === categoria.valor.id)) {
        await banco.categorias.add(categoria.valor)
        await enfileirar('categorias', categoria.valor.id)
        criada = true
      }
      return categoria
    })
    if (criada) aoEnfileirar()
    return resultado
  }

  async function salvarProduto(produto: Produto): Promise<ResultadoEstoque<Produto>> {
    const resultado = await banco.transaction('rw', tabelas, async () => {
      const conferido = novoProduto(produto, await banco.categorias.toArray())
      if (!conferido.ok) return conferido
      const anterior = await banco.produtos.get(produto.id)
      if (conteudoDoEfeito(anterior?.custoManual) !== conteudoDoEfeito(produto.custoManual)) {
        const estado = await lerEstado()
        const projecao = projetarEstoque(estado.movimentos, produto.id)
        if (!projecao.ok) return projecao
        const custo = alterarCustoManual(produto, produto.custoManual, projecao.valor.comprasVigentes)
        if (!custo.ok) return custo
      }
      await banco.produtos.put({ ...conferido.valor, atualizadoEm: agora() })
      await enfileirar('produtos', produto.id)
      return conferido
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }

  async function capturarEnvio(operacaoId: Id): Promise<EnvioEstoque | undefined> {
    return banco.transaction('r', tabelas, async () => {
      const item = await banco.fila.where('registroId').equals(operacaoId).first()
      if (!item || item.tabela !== 'operacoes' || item.problema) return undefined
      const estado = await lerEstado()
      const grupo = estado.grupos.find((item) => item.operacao.id === operacaoId)
      if (!grupo || grupo.operacao.revisao !== item.versao) throw new Error('Fila de estoque sem grupo completo')
      const versao = (await banco.versoesEstoque.where('operacaoId').equals(operacaoId).toArray())
        .find((item) => conteudoDoEfeito(item.grupo) === conteudoDoEfeito(grupo))
      if (!versao) throw new Error('Envio de estoque sem evidência')
      // A evidência não substitui a leitura dos registros próprios; qualquer divergência impede envio parcial.
      const lancamentos: Lancamento[] = []
      const movimentos: MovimentoEstoque[] = []
      for (const ref of grupo.operacao.lancamentos) {
        const registro = await banco.lancamentos.get(ref.id)
        if (!registro) throw new Error('Envio sem lançamento do manifesto')
        lancamentos.push(registro)
      }
      for (const ref of grupo.operacao.movimentos) {
        const registro = await banco.movimentos.get([ref.id, ref.revisao])
        if (!registro) throw new Error('Envio sem movimento do manifesto')
        movimentos.push(registro)
      }
      if (conteudoDoEfeito({ operacao: grupo.operacao, lancamentos, movimentos }) !== conteudoDoEfeito(grupo)) throw new Error('Registros divergem da revisão do envio')
      return { item, versao }
    })
  }

  async function responderEnvio(envio: EnvioEstoque, problema?: Problema): Promise<void> {
    await banco.transaction('rw', tabelas, async () => {
      const versao = await banco.versoesEstoque.get(envio.versao.id)
      if (!versao || conteudoDoEfeito(versao.grupo) !== conteudoDoEfeito(envio.versao.grupo)) throw new Error('Resposta sem versão capturada')
      const encerramentos = await banco.encerramentos.toArray()
      if (encerramentos.some((item) => conteudoDoEfeito(item.tentativa) === conteudoDoEfeito(identidadeDaTentativa(versao.grupo)))) return
      // Sucesso atrasado da revisão anterior guarda seu aceite, sem concluir nem substituir a nova.
      await banco.versoesEstoque.put({ ...versao, ...(problema ? { problema } : { aceita: true, problema: undefined }) })
      const atual = await banco.fila.get(envio.item.ordem)
      if (!atual || atual.registroId !== envio.item.registroId || atual.versao !== envio.item.versao) return
      if (problema) await banco.fila.put({ ...atual, problema })
      else await banco.fila.delete(atual.ordem)
    })
  }

  function estadoAceito(estado: EstadoLocalEstoque, versoes: readonly VersaoEstoque[]): EstadoAceitoEstoque {
    const operacoes = versoes.filter((item) => item.aceita).map((item) => item.grupo)
    const idsF2 = new Set(versoes.flatMap((item) => item.grupo.lancamentos.map((item) => item.id)))
    const movimentos = new Map<string, MovimentoEstoque>()
    for (const versao of versoes.filter((versao) => operacoes.some((aceita) => aceita.operacao.id === versao.operacaoId &&
      versao.grupo.operacao.revisao < aceita.operacao.revisao))) {
      for (const movimento of versao.grupo.movimentos) movimentos.set(chaveDoEfeito(movimento), movimento)
    }
    for (const grupo of operacoes) for (const movimento of grupo.movimentos) movimentos.set(chaveDoEfeito(movimento), movimento)
    return { operacoes,
      lancamentos: [...estado.lancamentos.filter((item) => !idsF2.has(item.id)), ...operacoes.flatMap((item) => item.lancamentos)],
      movimentos: [...movimentos.values()] }
  }

  async function encerrar(versaoId: Id, entrada: { readonly data: string; readonly confirmado: boolean;
    readonly intencaoPendente: boolean; readonly prepararNova?: PrepararGrupoLocal }): Promise<ResultadoEstoque<EncerramentoTentativa>> {
    let alterou = false
    const resultado = await banco.transaction('rw', tabelas, async () => {
      const versao = await banco.versoesEstoque.get(versaoId)
      if (!versao) return { ok: false, motivo: 'alvo-invalido' } as const
      const encerramentos = await banco.encerramentos.toArray()
      const existente = encerramentos.find((item) => conteudoDoEfeito(item.tentativa) === conteudoDoEfeito(identidadeDaTentativa(versao.grupo)))
      if (existente) return { ok: true, valor: existente } as const
      if (!versao.problema) return { ok: false, motivo: 'recusa-nao-confirmada' } as const
      const estado = await lerEstado()
      const versoes = await banco.versoesEstoque.toArray()
      const aceito = estadoAceito(estado, versoes)
      const pendentes = estado.grupos.filter((item) => conteudoDoEfeito(item) !== conteudoDoEfeito(versao.grupo))
      const semTentativa = efeitosAposEncerramentos(aceito, pendentes, encerramentos)
      const nova = entrada.prepararNova?.({ ...estado, ...semTentativa, grupos: [...aceito.operacoes, ...semTentativa.pendentes] })
      if (nova && !nova.ok) return nova
      const encerramento = encerrarTentativaEstoque({ grupo: versao.grupo, desfecho: 'recusada', diagnostico: conteudoDoEfeito(versao.problema) },
        aceito, encerramentos, { id: uuidv7(), data: entrada.data, confirmado: entrada.confirmado,
          intencaoPendente: entrada.intencaoPendente, novaOperacao: nova?.valor })
      if (!encerramento.ok) return encerramento
      if (nova?.ok) {
        const conferida = conferirReferencias({ ...estado, ...semTentativa, grupos: [...aceito.operacoes, ...semTentativa.pendentes] }, nova.valor)
        if (!conferida.ok) return conferida
      }
      await banco.encerramentos.add(encerramento.valor)
      const projecao = efeitosAposEncerramentos(aceito, pendentes, [...encerramentos, encerramento.valor])
      // Só a projeção provisória é retirada; conteúdo financeiro original permanece na evidência Q47A.
      const idsAtuais = new Set(projecao.lancamentos.map((item) => item.id))
      for (const item of versoes.flatMap((item) => item.grupo.lancamentos)) if (!idsAtuais.has(item.id)) await banco.lancamentos.delete(item.id)
      for (const item of projecao.lancamentos) await banco.lancamentos.put(item)
      const vivos = [...aceito.operacoes, ...projecao.pendentes]
      const movimentos = new Map<string, MovimentoEstoque>()
      for (const vivo of vivos) {
        // Mantém revisões antigas que fundamentam contagens, sem reativar a tentativa encerrada.
        for (const antiga of versoes.filter((item) => !item.legadoId && item.operacaoId === vivo.operacao.id && item.grupo.operacao.revisao <= vivo.operacao.revisao)) {
          for (const movimento of antiga.grupo.movimentos) movimentos.set(chaveDoEfeito(movimento), movimento)
        }
      }
      for (const item of projecao.movimentos) movimentos.set(chaveDoEfeito(item), item)
      for (const item of estado.movimentos) if (!movimentos.has(chaveDoEfeito(item))) await banco.movimentos.delete([item.id, item.revisao])
      for (const item of movimentos.values()) await banco.movimentos.put(item)
      const fila = await banco.fila.where('registroId').equals(versao.legadoId ?? versao.operacaoId).first()
      if (fila && (versao.legadoId || fila.versao === versao.grupo.operacao.revisao)) await banco.fila.delete(fila.ordem)
      const atual = await banco.operacoes.get(versao.operacaoId)
      if (atual?.revisao === versao.grupo.operacao.revisao) {
        const aceita = aceito.operacoes.find((item) => item.operacao.id === versao.operacaoId)
        if (aceita) {
          const evidencia = versoes.find((item) => item.aceita && conteudoDoEfeito(item.grupo) === conteudoDoEfeito(aceita))
          if (!evidencia) throw new Error('Aceite sem evidência durável')
          await banco.operacoes.put({ ...aceita.operacao, versaoId: evidencia.id })
        }
        else await banco.operacoes.delete(versao.operacaoId)
      }
      if (nova?.ok) await gravarGrupo(nova.valor)
      await enfileirar('encerramentos', encerramento.valor.id)
      await banco.relogioEstoque.put({ chave: 'cadastro', ultimo: estado.carimbo })
      alterou = true
      return encerramento
    })
    if (alterou) aoEnfileirar()
    return resultado
  }

  async function registrarRecusaLegada(lancamentoId: Id): Promise<ResultadoEstoque<VersaoEstoque>> {
    return banco.transaction('rw', tabelas, async () => {
      const existentes = await banco.versoesEstoque.toArray()
      const existente = existentes.find((item) => item.legadoId === lancamentoId)
      if (existente) return { ok: true, valor: existente }
      const lancamento = await banco.lancamentos.get(lancamentoId)
      const fila = await banco.fila.where('registroId').equals(lancamentoId).first()
      if (!lancamento || lancamento.tipo !== 'estorno' || !fila?.problema || fila.tabela !== 'lancamentos') return { ok: false, motivo: 'recusa-nao-confirmada' }
      const alvo = await banco.lancamentos.get(lancamento.estornaId)
      if (!alvo || alvo.tipo !== 'venda' || !alvo.itens.some((item) => item.id && item.quantidade !== undefined)) return { ok: false, motivo: 'alvo-invalido' }
      const operacaoId = uuidv7()
      const versao: VersaoEstoque = { id: uuidv7(), operacaoId, legadoId: lancamentoId, problema: fila.problema,
        grupo: { operacao: { id: operacaoId, revisao: 1, formato: 1, tipo: 'cancelamento',
          lancamentos: [{ id: lancamento.id, revisao: 1 }], movimentos: [], dependencias: [] }, lancamentos: [lancamento], movimentos: [] } }
      await banco.versoesEstoque.add(versao)
      return { ok: true, valor: versao }
    })
  }

  return { executar, cadastrarCategoria, salvarProduto, capturarEnvio, responderEnvio, encerrar, registrarRecusaLegada,
    listarCategorias: () => banco.categorias.toArray(), listarProdutos: () => banco.produtos.toArray(),
    lerEstado: () => banco.transaction('r', tabelas, lerEstado) }
}

/** Porta das operações locais; o restante do app não precisa conhecer Dexie. */
export type RepositorioEstoque = ReturnType<typeof criarRepositorioEstoque>
