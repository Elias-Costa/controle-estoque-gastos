import type { Dia, Id } from '../dominio/ficha.ts'
import { corrigirFatoCaixa, estornarFatoCaixa, prepararCorrecaoCaixa, registrarMovimentoCaixa, validarFatosCaixa,
  type EntradaMovimentoCaixa, type FatoCaixa, type ReferenciaFatoCaixa, type ResultadoCaixa } from '../dominio/gastos.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import type { BancoLocal, ItemDaFila, Problema } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { recomporProjecaoCaixa } from './projecao-caixa.ts'
import type { EnvioCaixa, GrupoCaixa, OperacaoCaixaLocal, VersaoCaixa } from './tipos-caixa.ts'

/** Porta local do caixa: janela e validação são conferidas na transação de gravação. */
export interface RepositorioCaixa {
  registrar(entrada: EntradaMovimentoCaixa): Promise<ResultadoCaixa<GrupoCaixa>>
  corrigir(alvo: ReferenciaFatoCaixa, entrada: EntradaMovimentoCaixa, dataCorrecao: Dia): Promise<ResultadoCaixa<GrupoCaixa>>
  estornar(alvo: ReferenciaFatoCaixa, data: Dia): Promise<ResultadoCaixa<GrupoCaixa>>
  listarFatos(): Promise<readonly FatoCaixa[]>
  lerHistorico(id: Id): Promise<readonly VersaoCaixa[]>
  sincronizado(id: Id): Promise<boolean>
  comProblema(id: Id): Promise<boolean>
  capturarEnvio(id: Id): Promise<EnvioCaixa | undefined>
  responderEnvio(envio: EnvioCaixa, problema?: Problema): Promise<void>
}

function mesmo(a: unknown, b: unknown): boolean { return conteudoDoEfeito(a) === conteudoDoEfeito(b) }

/** Transações aditivas de D-069; nenhuma espera por rede ou API externa dentro do rw. */
export function criarRepositorioCaixa(banco: BancoLocal, agora: () => string = () => new Date().toISOString(),
  aoEnfileirar: () => void = () => undefined): RepositorioCaixa {
  const tabelas = [banco.fatosCaixa, banco.operacoesCaixa, banco.versoesCaixa, banco.fila]

  async function operacaoDoFato(id: Id): Promise<OperacaoCaixaLocal | undefined> {
    return (await banco.operacoesCaixa.toArray()).find((op) => op.fatos.some((ref) => ref.id === id))
  }

  async function itemDaOperacao(id: Id): Promise<ItemDaFila | undefined> {
    return banco.fila.where('registroId').equals(id).and((item) => item.tabela === 'operacoesCaixa').first()
  }

  async function lerGrupo(op: OperacaoCaixaLocal): Promise<VersaoCaixa> {
    const versao = await banco.versoesCaixa.get(op.versaoId)
    const { versaoId: _versaoId, ...manifesto } = op
    const fatos = await banco.fatosCaixa.bulkGet(op.fatos.map((ref) => ref.id))
    if (!versao || versao.operacaoId !== op.id || !mesmo(versao.grupo, { operacao: manifesto, fatos }) ||
      !op.fatos.length || op.fatos.some((ref, i) => fatos[i]?.revisao !== ref.revisao)) {
      throw new Error('Caixa sem grupo completo ou evidência correspondente')
    }
    return versao
  }

  function grupoNovo(tipo: GrupoCaixa['operacao']['tipo'], fatos: readonly FatoCaixa[], alvo?: ReferenciaFatoCaixa): GrupoCaixa {
    return { operacao: { id: uuidv7(), formato: 1, revisao: 1, tipo,
      ...(alvo ? { alvo: { id: alvo.id, revisao: alvo.revisao } } : {}),
      fatos: fatos.map(({ id, revisao }) => ({ id, revisao })) }, fatos }
  }

  async function gravar(grupo: GrupoCaixa): Promise<void> {
    const versaoId = uuidv7()
    for (const fato of grupo.fatos) await banco.fatosCaixa.put(fato)
    await banco.operacoesCaixa.put({ ...grupo.operacao, versaoId })
    await banco.versoesCaixa.add({ id: versaoId, operacaoId: grupo.operacao.id, grupo })
    const item = await itemDaOperacao(grupo.operacao.id)
    if (item) await banco.fila.put({ ...item, versao: grupo.operacao.revisao, problema: undefined })
    else await banco.fila.add({ tabela: 'operacoesCaixa', registroId: grupo.operacao.id,
      criadoEm: agora(), versao: grupo.operacao.revisao })
  }

  async function executar(preparar: (fatos: readonly FatoCaixa[]) => Promise<ResultadoCaixa<GrupoCaixa>>): Promise<ResultadoCaixa<GrupoCaixa>> {
    const resultado = await banco.transaction('rw', tabelas, async () => {
      const fatos = await banco.fatosCaixa.toArray()
      const validacao = validarFatosCaixa(fatos)
      if (!validacao.ok) return validacao
      const preparado = await preparar(fatos)
      if (preparado.ok) await gravar(preparado.valor)
      return preparado
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }

  function registrar(entrada: EntradaMovimentoCaixa): Promise<ResultadoCaixa<GrupoCaixa>> {
    return executar(async (fatos) => {
      const novo = registrarMovimentoCaixa(fatos, entrada)
      return novo.ok ? { ok: true, valor: grupoNovo('registro', [novo.valor]) } : novo
    })
  }

  function corrigir(alvo: ReferenciaFatoCaixa, entrada: EntradaMovimentoCaixa, dataCorrecao: Dia): Promise<ResultadoCaixa<GrupoCaixa>> {
    return executar(async (fatos) => {
      const op = await operacaoDoFato(alvo.id)
      if (!op) return { ok: false, motivo: 'alvo-invalido' }
      const versao = await lerGrupo(op)
      const item = await itemDaOperacao(op.id)
      if (item) {
        // A tela não fornece sincronizado: uma resposta concorrente pode ter fechado a janela.
        if (item.versao !== op.revisao) throw new Error('Fila de caixa diverge da revisão corrente')
        if (item.problema) return { ok: false, motivo: 'envio-com-problema' }
        const corrigido = corrigirFatoCaixa(fatos, alvo, { ...entrada, id: alvo.id }, { sincronizado: false })
        if (!corrigido.ok) return corrigido
        const novos = versao.grupo.fatos.map((fato) => fato.id === alvo.id ? corrigido.valor : fato)
        return { ok: true, valor: { operacao: { ...versao.grupo.operacao, revisao: op.revisao + 1,
          fatos: novos.map(({ id, revisao }) => ({ id, revisao })) }, fatos: novos } }
      }
      const correcao = prepararCorrecaoCaixa(fatos, alvo, { estornoId: uuidv7(), dataCorrecao,
        substituto: { ...entrada, id: uuidv7() } })
      return correcao.ok ? { ok: true, valor: grupoNovo('correcao', [correcao.valor.estorno, correcao.valor.substituto], alvo) } : correcao
    })
  }

  function estornar(alvo: ReferenciaFatoCaixa, data: Dia): Promise<ResultadoCaixa<GrupoCaixa>> {
    return executar(async (fatos) => {
      const op = await operacaoDoFato(alvo.id)
      if (!op) return { ok: false, motivo: 'alvo-invalido' }
      await lerGrupo(op)
      const estorno = estornarFatoCaixa(fatos, { id: uuidv7(), data, alvo })
      return estorno.ok ? { ok: true, valor: grupoNovo('estorno', [estorno.valor], alvo) } : estorno
    })
  }

  async function capturarEnvio(id: Id): Promise<EnvioCaixa | undefined> {
    return banco.transaction('r', tabelas, async () => {
      const item = await itemDaOperacao(id)
      if (!item || item.problema) return undefined
      // D-070: dependente permanece pendente em evidência, sem enviar alvo retirado.
      if (await banco.versoesCaixa.where('operacaoId').equals(id).and((v) =>
        v.grupo.operacao.revisao === item.versao && v.foraDaProjecao !== undefined).count()) return undefined
      const op = await banco.operacoesCaixa.get(id)
      if (!op || op.revisao !== item.versao) throw new Error('Fila de caixa sem operação correspondente')
      const versao = await lerGrupo(op)
      const validacao = validarFatosCaixa(await banco.fatosCaixa.toArray())
      if (!validacao.ok) throw new Error(`Caixa inválido para envio: ${validacao.motivo}`)
      return { item, versao }
    })
  }

  async function responderEnvio(envio: EnvioCaixa, problema?: Problema): Promise<void> {
    await banco.transaction('rw', tabelas, async () => {
      const versao = await banco.versoesCaixa.get(envio.versao.id)
      if (!versao || !mesmo(versao.grupo, envio.versao.grupo) || envio.item.tabela !== 'operacoesCaixa' ||
        envio.item.registroId !== versao.operacaoId || envio.item.versao !== versao.grupo.operacao.revisao) {
        throw new Error('Resposta sem versão correspondente de caixa')
      }
      // Aceite é evidência definitiva; uma falha atrasada da mesma captura não o reverte.
      if (versao.aceita && problema) return
      await banco.versoesCaixa.put({ ...versao, ...(problema ? { problema } : { aceita: true, problema: undefined }) })
      const atual = await banco.fila.get(envio.item.ordem)
      const op = await banco.operacoesCaixa.get(versao.operacaoId)
      if (atual && atual.tabela === 'operacoesCaixa' && atual.registroId === envio.item.registroId &&
        atual.versao === envio.item.versao && op?.versaoId === versao.id) {
        if (problema) await banco.fila.put({ ...atual, problema })
        else await banco.fila.delete(atual.ordem)
      }
      // O download pode ter conhecido o aceite antes desta resposta de recusa.
      await recomporProjecaoCaixa(banco)
    })
  }

  async function filaDoFato(id: Id): Promise<ItemDaFila | undefined> {
    const op = await operacaoDoFato(id)
    const direta = op ? await itemDaOperacao(op.id) : undefined
    if (direta) return direta
    for (const v of await banco.versoesCaixa.toArray()) {
      if (v.grupo.fatos.some((f) => f.id === id)) {
        const item = await itemDaOperacao(v.operacaoId)
        if (item) return item
      }
    }
    return undefined
  }

  return { registrar, corrigir, estornar, capturarEnvio, responderEnvio,
    listarFatos: () => banco.fatosCaixa.toArray(),
    lerHistorico: (id) => banco.versoesCaixa.filter((versao) => versao.grupo.operacao.alvo?.id === id ||
      versao.grupo.fatos.some((fato) => fato.id === id)).toArray(),
    sincronizado: (id) => banco.transaction('r', tabelas, async () => !(await filaDoFato(id))),
    comProblema: (id) => banco.transaction('r', tabelas, async () => (await filaDoFato(id))?.problema !== undefined) }
}
