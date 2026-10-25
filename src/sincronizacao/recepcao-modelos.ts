import type { BancoLocal } from '../dados/banco.ts'
import type { PreferenciaModelos } from '../dados/modelos-whatsapp.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'

/** LWW inteiro; empate remoto conhecido prevalece depois de concluir o envio local (D-072). */
export async function aplicarModelos(banco: BancoLocal, remoto: PreferenciaModelos): Promise<void> {
  await banco.transaction('rw', banco.modelos, banco.fila, banco.controleCopia, async () => {
    const local = await banco.modelos.get('whatsapp')
    const pendente = local && await banco.fila.where('registroId').equals(local.id).and((f) => f.tabela === 'modelos').first()
    const restaurando = !!await banco.controleCopia.get('restauracao')
    const origem = local && await banco.controleCopia.get(`registro:modelos/${local.id}`)
    const copiado = origem && 'conteudo' in origem && origem.conteudo === conteudoDoEfeito(local)
    if (local && (local.atualizadoEm > remoto.atualizadoEm ||
      (local.atualizadoEm === remoto.atualizadoEm && pendente && !(restaurando && copiado)))) return
    await banco.modelos.put(remoto)
    // Um cadastro remoto mais novo substitui a preferência inteira, inclusive id inicial concorrente.
    if (pendente) await banco.fila.delete(pendente.ordem)
  })
}
