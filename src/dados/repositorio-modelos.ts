import type { BancoLocal, ItemDaFila, Problema } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { SITUACOES_MENSAGEM, modelosValidos, preferenciaModelosValida, type ModelosWhatsApp, type PreferenciaModelos } from './modelos-whatsapp.ts'

/** Captura consistente; a resposta só pode concluir esta versão da fila (EL-05). */
export type EnvioModelos = { readonly preferencia: PreferenciaModelos; readonly fila: ItemDaFila }
/** Compara também conteúdo e identidade: duas edições podem ter o mesmo relógio. */
export function mesmaPreferencia(a: PreferenciaModelos | undefined, b: PreferenciaModelos | undefined): boolean {
  return a?.id === b?.id && a?.atualizadoEm === b?.atualizadoEm &&
    SITUACOES_MENSAGEM.every((s) => a?.modelos[s] === b?.modelos[s])
}
/** Preferência e fila no mesmo rw; nunca depende de sessão ou rede (D-069/072). */
export function criarRepositorioModelos(banco: BancoLocal, agora = () => new Date().toISOString(), aoEnfileirar = () => {}) {
  async function salvar(modelos: ModelosWhatsApp, base: PreferenciaModelos | undefined) {
    if (!modelosValidos(modelos)) throw new Error('Modelos de mensagem inválidos')
    const resultado = await banco.transaction('rw', banco.modelos, banco.fila, async () => {
      const atual = await banco.modelos.get('whatsapp')
      if (!mesmaPreferencia(atual, base)) return { ok: false, atual } as const
      const preferencia: PreferenciaModelos = { chave: 'whatsapp', id: atual?.id ?? uuidv7(), atualizadoEm: agora(), modelos }
      if (!preferenciaModelosValida(preferencia)) throw new Error('Preferência de mensagens inválida')
      const pendente = await banco.fila.where('registroId').equals(preferencia.id).and((f) => f.tabela === 'modelos').first()
      await banco.modelos.put(preferencia)
      if (pendente) await banco.fila.update(pendente.ordem, { versao: (pendente.versao ?? 0) + 1, problema: undefined })
      else await banco.fila.add({ tabela: 'modelos', registroId: preferencia.id, criadoEm: preferencia.atualizadoEm, versao: 0 })
      return { ok: true, preferencia } as const
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }
  async function capturarEnvio(id: string): Promise<EnvioModelos | undefined> {
    return banco.transaction('r', banco.modelos, banco.fila, async () => {
      const preferencia = await banco.modelos.get('whatsapp')
      const fila = await banco.fila.where('registroId').equals(id).and((f) => f.tabela === 'modelos').first()
      if (!fila || fila.problema) return undefined
      if (!preferenciaModelosValida(preferencia) || preferencia.id !== id) throw new Error('Fila de modelos sem preferência íntegra')
      return { preferencia, fila }
    })
  }
  async function responderEnvio(envio: EnvioModelos, problema?: Problema): Promise<void> {
    await banco.transaction('rw', banco.fila, async () => {
      const fila = await banco.fila.get(envio.fila.ordem)
      if (!fila || fila.tabela !== 'modelos' || fila.registroId !== envio.preferencia.id || (fila.versao ?? 0) !== (envio.fila.versao ?? 0)) return
      if (problema) await banco.fila.put({ ...fila, problema })
      else await banco.fila.delete(fila.ordem)
    })
  }
  return { ler: () => banco.modelos.get('whatsapp'), salvar, capturarEnvio, responderEnvio }
}
