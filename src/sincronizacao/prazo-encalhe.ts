import type { BancoLocal } from '../dados/banco.ts'
import { mesmaPreferenciaEncalhe, preferenciaEncalheValida, type PreferenciaEncalhe } from '../dados/prazo-encalhe.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'
import { normalizarCarimbo } from './borda.ts'
import type { LinhaRecebida } from './nuvem.ts'

/** Transporte da escolha inteira, sem recorrer ao padrão para dados inválidos. */
export function prazoEncalheParaNuvem(p: PreferenciaEncalhe): LinhaRecebida {
  if (!preferenciaEncalheValida(p)) throw new Error('Prazo de encalhe local inválido')
  return { escolha_id: p.id, dias: p.dias, carimbo: p.atualizadoEm }
}

/** Borda compartilhada pelo download e pela captura do servidor. */
export function prazoEncalheDaNuvem(linha: LinhaRecebida): PreferenciaEncalhe {
  const p = { chave: 'encalhe', id: linha['id'], dias: linha['dias'],
    atualizadoEm: normalizarCarimbo('prazo_encalhe.atualizado_em', linha['atualizado_em']) }
  if (!preferenciaEncalheValida(p)) throw new Error('Prazo de encalhe remoto inválido')
  return p
}

/** D-072/089: a edição pendente conserva o empate até enviar, salvo aceite conhecido na restauração. */
export async function aplicarPrazoEncalhe(banco: BancoLocal, remoto: PreferenciaEncalhe): Promise<void> {
  await banco.transaction('rw', banco.prazosEncalhe, banco.fila, banco.controleCopia, async () => {
    const local = await banco.prazosEncalhe.get('encalhe')
    const pendente = local && await banco.fila.where('registroId').equals(local.id).and((f) => f.tabela === 'prazoEncalhe').first()
    if (local && local.atualizadoEm > remoto.atualizadoEm) return
    if (local && local.atualizadoEm === remoto.atualizadoEm && pendente && !mesmaPreferenciaEncalhe(local, remoto)) {
      const restaurando = await banco.controleCopia.get('restauracao')
      const origem = await banco.controleCopia.get(`registro:prazoEncalhe/${local.id}`)
      if (!restaurando || !origem || !('conteudo' in origem) || origem.conteudo !== conteudoDoEfeito(local)) return
    }
    if (!mesmaPreferenciaEncalhe(local, remoto)) await banco.prazosEncalhe.put(remoto)
    if (pendente) await banco.fila.delete(pendente.ordem)
  })
}
