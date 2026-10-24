import type { BancoLocal } from '../dados/banco.ts'
import { uuidv7 } from '../dados/identidade.ts'
import { recomporProjecaoCaixa } from '../dados/projecao-caixa.ts'
import { validarFatosCaixa } from '../dominio/gastos.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import { grupoCaixaParaNuvem, recepcaoCaixaDaNuvem, type RecepcaoCaixa } from './borda-caixa.ts'

/** Confirma grupo, aceite, projeção e posição juntos; vínculo/forma inválidos abortam tudo. */
export async function aplicarRecepcaoCaixa(banco: BancoLocal, recebido: RecepcaoCaixa): Promise<void> {
  // Também valida chamadas diretas, não apenas a rota do motor.
  recepcaoCaixaDaNuvem({ recepcao: recebido.recepcao, grupo: grupoCaixaParaNuvem(recebido.grupo) })
  await banco.transaction('rw', banco.fatosCaixa, banco.operacoesCaixa, banco.versoesCaixa, banco.fila, banco.sincronizacao, async () => {
    const cursor = (await banco.sincronizacao.get('caixa'))?.valor ?? '0'
    if (BigInt(recebido.recepcao) <= BigInt(cursor)) return
    if (BigInt(recebido.recepcao) !== BigInt(cursor) + 1n) throw new Error('Recepção de caixa fora de ordem ou posição ausente')
    const versoes = await banco.versoesCaixa.toArray()
    const igual = (v: { grupo: unknown }) => conteudoDoEfeito(v.grupo) === conteudoDoEfeito(recebido.grupo)
    if (versoes.some((v) => v.aceita && v.operacaoId === recebido.grupo.operacao.id && !igual(v))) throw new Error('Aceite de caixa divergente')
    const existente = versoes.find(igual)
    const grupos = [...versoes.filter((v) => v.aceita && !igual(v)).map((v) => v.grupo), recebido.grupo]
    const idsOperacoes = new Set(grupos.map((g) => g.operacao.id))
    if (grupos.some((g) => g.fatos.some((f) => idsOperacoes.has(f.id)))) throw new Error('Identidade de caixa reutilizada')
    const validacao = validarFatosCaixa(grupos.flatMap((g) => g.fatos))
    if (!validacao.ok) throw new Error(`Caixa recebido sem vínculo íntegro: ${validacao.motivo}`)
    await banco.versoesCaixa.put({ ...existente, id: existente?.id ?? uuidv7(), operacaoId: recebido.grupo.operacao.id,
      grupo: recebido.grupo, aceita: true, problema: undefined, foraDaProjecao: undefined })
    const item = await banco.fila.where('registroId').equals(recebido.grupo.operacao.id).and((i) => i.tabela === 'operacoesCaixa').first()
    // Conteúdo idêntico é prova do aceite, inclusive após resposta perdida. Revisão nova fica.
    if (item && item.versao === recebido.grupo.operacao.revisao && existente && igual(existente)) await banco.fila.delete(item.ordem)
    await recomporProjecaoCaixa(banco)
    await banco.sincronizacao.put({ chave: 'caixa', valor: recebido.recepcao })
  })
}
