import { liveQuery } from 'dexie'
import type { BancoLocal, ItemDaFila, Problema } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { mesmaPreferenciaEncalhe, preferenciaEncalheValida, type PreferenciaEncalhe } from './prazo-encalhe.ts'

/** Registro e versão lidos juntos, para a resposta concluir somente o que subiu. */
export type EnvioEncalhe = { readonly preferencia: PreferenciaEncalhe; readonly fila: ItemDaFila }

/** D-089: escolha e fila no mesmo rw, com conferência de edição conhecida (D-072). */
export function criarRepositorioPrazoEncalhe(banco: BancoLocal, agora = () => new Date().toISOString(), aoEnfileirar = () => {}) {
  const ler = () => banco.prazosEncalhe.get('encalhe')

  async function salvar(dias: number, base: PreferenciaEncalhe | undefined) {
    const resultado = await banco.transaction('rw', banco.prazosEncalhe, banco.fila, async () => {
      const atual = await ler()
      if (!mesmaPreferenciaEncalhe(atual, base)) return { ok: false, atual } as const
      const preferencia: PreferenciaEncalhe = { chave: 'encalhe', id: atual?.id ?? uuidv7(), atualizadoEm: agora(), dias }
      if (!preferenciaEncalheValida(preferencia)) throw new Error('Prazo de encalhe inválido')
      const pendente = await banco.fila.where('registroId').equals(preferencia.id).and((f) => f.tabela === 'prazoEncalhe').first()
      await banco.prazosEncalhe.put(preferencia)
      if (pendente) await banco.fila.update(pendente.ordem, { versao: (pendente.versao ?? 0) + 1, problema: undefined })
      else await banco.fila.add({ tabela: 'prazoEncalhe', registroId: preferencia.id, criadoEm: preferencia.atualizadoEm, versao: 0 })
      return { ok: true, preferencia } as const
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }

  async function capturarEnvio(id: string): Promise<EnvioEncalhe | undefined> {
    return banco.transaction('r', banco.prazosEncalhe, banco.fila, async () => {
      const fila = await banco.fila.where('registroId').equals(id).and((f) => f.tabela === 'prazoEncalhe').first()
      if (!fila || fila.problema) return undefined
      const preferencia = await ler()
      if (!preferenciaEncalheValida(preferencia) || preferencia.id !== id) throw new Error('Fila sem prazo de encalhe íntegro')
      return { preferencia, fila }
    })
  }

  async function responderEnvio(envio: EnvioEncalhe, problema?: Problema): Promise<void> {
    await banco.transaction('rw', banco.fila, async () => {
      const fila = await banco.fila.get(envio.fila.ordem)
      if (!fila || fila.tabela !== 'prazoEncalhe' || fila.registroId !== envio.preferencia.id || (fila.versao ?? 0) !== (envio.fila.versao ?? 0)) return
      if (problema) await banco.fila.put({ ...fila, problema })
      else await banco.fila.delete(fila.ordem)
    })
  }

  return { ler, salvar, capturarEnvio, responderEnvio,
    assinar: (ouvinte: (p: PreferenciaEncalhe | undefined) => void, falha: () => void) => {
      const assinatura = liveQuery(ler).subscribe({ next: ouvinte, error: falha })
      return () => assinatura.unsubscribe()
    } }
}
