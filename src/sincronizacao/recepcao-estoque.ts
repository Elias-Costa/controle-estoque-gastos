import type { BancoLocal, VersaoEstoque } from '../dados/banco.ts'
import { uuidv7 } from '../dados/identidade.ts'
import { chaveDoEfeito, type MovimentoEstoque } from '../dominio/estoque.ts'
import { efeitosAposEncerramentos, identidadeDaTentativa } from '../dominio/recuperacao-estoque.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import type { GrupoEstoque } from '../dominio/vendas-estoque.ts'
import type { RecepcaoEstoque } from './borda-estoque.ts'

function igual(a: unknown, b: unknown): boolean { return conteudoDoEfeito(a) === conteudoDoEfeito(b) }

/** Aplica uma posição completa e seu cursor no mesmo commit. Falta de vínculo aborta a posição (Q38). */
export async function aplicarRecepcaoEstoque(banco: BancoLocal, recebido: RecepcaoEstoque): Promise<void> {
  await banco.transaction('rw', banco.tables, async () => {
    const cursor = (await banco.sincronizacao.get('estoque'))?.valor ?? '0'
    if (BigInt(recebido.recepcao) <= BigInt(cursor)) return
    let versoes = await banco.versoesEstoque.toArray()
    async function guardar(grupo: GrupoEstoque, aceita = false): Promise<VersaoEstoque> {
      const existente = versoes.find((v) => igual(v.grupo, grupo))
      const versao: VersaoEstoque = existente
        ? { ...existente, ...(aceita ? { aceita: true } : {}) }
        : { id: uuidv7(), operacaoId: grupo.operacao.id, grupo, ...(aceita ? { aceita: true } : {}) }
      await banco.versoesEstoque.put(versao)
      versoes = [...versoes.filter((v) => v.id !== versao.id), versao]
      return versao
    }
    function exigir(condicao: boolean): void { if (!condicao) throw new Error('Recepção de estoque com dependência ausente ou divergente') }
    async function conferir(grupo: GrupoEstoque, evidencias: readonly MovimentoEstoque[]): Promise<void> {
      const clientes = new Set((await banco.clientes.toArray()).map((c) => c.id))
      const produtos = new Set((await banco.produtos.toArray()).map((p) => p.id))
      exigir(grupo.lancamentos.every((l) => clientes.has(l.clienteId)))
      exigir([...grupo.movimentos, ...evidencias].every((m) => produtos.has(m.produtoId)))
      exigir(grupo.lancamentos.every((l) => l.tipo !== 'venda' || l.itens.every((i) => !i.produtoId || produtos.has(i.produtoId))))
      const aceitas = versoes.filter((v) => v.aceita).map((v) => v.grupo)
      const referencias = new Set([...aceitas.flatMap((g) => [g.operacao, ...g.operacao.lancamentos, ...g.movimentos]),
        ...evidencias, ...(await banco.movimentos.toArray())].map(chaveDoEfeito))
      // F1 pode ser dependência financeira; grupos F2 ainda incompletos não passam pela rota F1.
      for (const l of await banco.lancamentos.toArray()) referencias.add(chaveDoEfeito({ id: l.id, revisao: 1 }))
      exigir(grupo.operacao.dependencias.every((r) => referencias.has(chaveDoEfeito(r))))
      const movimentos = new Set([...referencias, ...grupo.movimentos.map(chaveDoEfeito)])
      exigir([...grupo.movimentos, ...evidencias].every((m) => m.conhecidos.every((r) => movimentos.has(chaveDoEfeito(r)))))
      if (grupo.operacao.alvo) exigir(referencias.has(chaveDoEfeito(grupo.operacao.alvo)))
    }

    if (recebido.tipo === 'operacao') {
      await conferir(recebido.grupo, recebido.evidencias)
      if (recebido.encerramentoId) exigir(await banco.encerramentos.get(recebido.encerramentoId) !== undefined)
      const versao = await guardar(recebido.grupo, true)
      // Evidências antigas não são novos efeitos, mas precisam sobreviver à restauração (Q39/42).
      for (const m of recebido.evidencias) {
        const local = await banco.movimentos.get([m.id, m.revisao])
        exigir(local === undefined || igual(local, m))
        await banco.movimentos.put(m)
      }
      const fila = await banco.fila.where('registroId').equals(recebido.grupo.operacao.id).first()
      const atual = await banco.operacoes.get(recebido.grupo.operacao.id)
      const local = versoes.find((v) => v.id === atual?.versaoId)
      if (!fila || !local || local.restaurada || igual(local.grupo, recebido.grupo)) {
        for (const l of recebido.grupo.lancamentos) await banco.lancamentos.put(l)
        for (const m of recebido.grupo.movimentos) await banco.movimentos.put(m)
        await banco.operacoes.put({ ...recebido.grupo.operacao, versaoId: versao.id })
        if (fila && local?.restaurada) await banco.fila.delete(fila.ordem)
      }
      let maximo = (await banco.relogioEstoque.get('cadastro'))?.ultimo ?? 0n
      for (const m of [...recebido.grupo.movimentos, ...recebido.evidencias]) {
        if (m.tipo === 'compra' && m.ordemCadastro > maximo) maximo = m.ordemCadastro
      }
      await banco.relogioEstoque.put({ chave: 'cadastro', ultimo: maximo })
      await banco.sincronizacao.put({ chave: 'estoque', valor: recebido.recepcao })
      return
    } else {
      const encerramento = recebido.encerramento
      exigir(encerramento.aceitosConhecidos.every((g) => versoes.some((v) => v.aceita && igual(v.grupo, g))))
      await guardar(encerramento.evidencia.grupo)
      const existente = await banco.encerramentos.get(encerramento.id)
      exigir(existente === undefined || igual(existente, encerramento))
      await banco.encerramentos.put(encerramento)
      for (const local of await banco.encerramentos.toArray()) {
        if (local.remotoId === encerramento.id && igual(local.tentativa, encerramento.tentativa)) {
          const filaLocal = await banco.fila.where('registroId').equals(local.id).first()
          if (filaLocal?.tabela === 'encerramentos') await banco.fila.delete(filaLocal.ordem)
        }
      }
      const tentativa = encerramento.evidencia.grupo
      // Estorno legado recusado pode não ter manifesto local. Só sua versão exata sai da projeção.
      for (const l of tentativa.lancamentos) {
        const fila = await banco.fila.where('registroId').equals(l.id).first()
        if (fila?.tabela === 'lancamentos' && igual(await banco.lancamentos.get(l.id), l)) await banco.fila.delete(fila.ordem)
      }
      const fila = await banco.fila.where('registroId').equals(tentativa.operacao.id).first()
      const atual = await banco.operacoes.get(tentativa.operacao.id)
      const versaoAtual = versoes.find((v) => v.id === atual?.versaoId)
      if (fila && versaoAtual && (igual(versaoAtual.grupo, tentativa) ||
        (versaoAtual.restaurada && tentativa.operacao.revisao >= versaoAtual.grupo.operacao.revisao))) await banco.fila.delete(fila.ordem)
      if (encerramento.novaOperacao) {
        const nova = encerramento.novaOperacao
        const conhecida = versoes.some((v) => igual(v.grupo, nova))
        const versao = await guardar(nova)
        if (!conhecida) {
          await banco.versoesEstoque.put({ ...versao, restaurada: true })
          versoes = versoes.map((v) => v.id === versao.id ? { ...v, restaurada: true } : v)
          await banco.fila.add({ tabela: 'operacoes', registroId: nova.operacao.id,
            versao: nova.operacao.revisao, criadoEm: new Date().toISOString() })
        }
      }
    }

    const encerramentos = await banco.encerramentos.toArray()
    const fechada = (grupo: GrupoEstoque): boolean => encerramentos.some((e) => igual(e.evidencia.grupo, grupo))
    const aceitas = versoes.filter((v) => v.aceita)
    const idsF2 = new Set(versoes.flatMap((v) => v.grupo.lancamentos.map((l) => l.id)))
    const financeiro = await banco.lancamentos.toArray()
    const historico = await banco.movimentos.toArray()
    const atuais = await banco.operacoes.toArray()
    const gruposLocais = atuais.flatMap((op) => versoes.filter((v) => v.id === op.versaoId).map((v) => v.grupo))
    const legado = versoes.filter((v) => v.legadoId && !fechada(v.grupo)).map((v) => v.grupo)
    const aceito = { operacoes: aceitas.map((v) => v.grupo),
      lancamentos: [...financeiro.filter((l) => !idsF2.has(l.id)), ...aceitas.flatMap((v) => v.grupo.lancamentos)],
      movimentos: aceitas.flatMap((v) => v.grupo.movimentos) }
    // A RPC conserva a identidade textual original. A projeção compara o conteúdo decodificado,
    // inclusive documentos de teste anteriores ao codec, sem reescrever a evidência recebida.
    const projecao = efeitosAposEncerramentos(aceito, [...gruposLocais, ...legado],
      encerramentos.map((e) => ({ ...e, tentativa: identidadeDaTentativa(e.evidencia.grupo) })))
    const vivos = new Map([...aceito.operacoes, ...projecao.pendentes].map((g) => [g.operacao.id, g]))
    const movimentos = new Map<string, MovimentoEstoque>()
    for (const m of historico) {
      const grupo = vivos.get(m.operacaoId)
      if (grupo && grupo.movimentos.some((atual) => atual.id === m.id && atual.revisao >= m.revisao)) movimentos.set(chaveDoEfeito(m), m)
    }
    for (const m of projecao.movimentos) movimentos.set(chaveDoEfeito(m), m)
    const lancamentos = new Map(projecao.lancamentos.map((l) => [l.id, l]))
    for (const l of financeiro) if (idsF2.has(l.id) && !lancamentos.has(l.id)) await banco.lancamentos.delete(l.id)
    for (const l of lancamentos.values()) await banco.lancamentos.put(l)
    for (const m of historico) if (!movimentos.has(chaveDoEfeito(m))) await banco.movimentos.delete([m.id, m.revisao])
    for (const m of movimentos.values()) await banco.movimentos.put(m)
    for (const op of atuais) if (!vivos.has(op.id)) await banco.operacoes.delete(op.id)
    for (const grupo of vivos.values()) {
      // Tentativa F1 não ganha uma operação ativa artificial ao ser reconhecida pelo app novo.
      const v = versoes.find((v) => !v.legadoId && igual(v.grupo, grupo))
      if (v) await banco.operacoes.put({ ...grupo.operacao, versaoId: v.id })
    }
    let maximo = (await banco.relogioEstoque.get('cadastro'))?.ultimo ?? 0n
    for (const m of [...historico, ...versoes.flatMap((v) => v.grupo.movimentos)]) {
      if (m.tipo === 'compra' && m.ordemCadastro > maximo) maximo = m.ordemCadastro
    }
    await banco.relogioEstoque.put({ chave: 'cadastro', ultimo: maximo })
    await banco.sincronizacao.put({ chave: 'estoque', valor: recebido.recepcao })
  })
}
