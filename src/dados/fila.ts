import type { Id } from '../dominio/ficha.ts'
import type { BancoLocal, ItemDaFila } from './banco.ts'

/** F1 aponta ao registro; F2 aponta à operação que contém o efeito (D-057/Q37). */
export async function itemDaFilaDoRegistro(banco: BancoLocal, id: Id): Promise<ItemDaFila | undefined> {
  return banco.transaction('r', banco.fila, banco.operacoes, async () => {
    const direto = await banco.fila.where('registroId').equals(id).first()
    if (direto) return direto
    const operacao = (await banco.operacoes.toArray()).find((item) => item.lancamentos.some((ref) => ref.id === id) || item.movimentos.some((ref) => ref.id === id))
    return operacao ? banco.fila.where('registroId').equals(operacao.id).first() : undefined
  })
}
