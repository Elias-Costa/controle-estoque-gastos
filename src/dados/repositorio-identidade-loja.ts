import { liveQuery } from 'dexie'
import type { BancoLocal, ItemDaFila, Problema } from './banco.ts'
import { uuidv7 } from './identidade.ts'
import { identidadeLojaValida, mesmaPreferenciaIdentidade, preferenciaIdentidadeValida, type IdentidadeLoja, type PreferenciaIdentidadeLoja } from './identidade-loja.ts'

/** Captura íntegra: logo e textos sobem da mesma versão da fila. */
export type EnvioIdentidadeLoja = { readonly preferencia: PreferenciaIdentidadeLoja; readonly fila: ItemDaFila }

/** D-076: preferência e fila atômicas; nenhuma escrita espera a rede. */
export function criarRepositorioIdentidadeLoja(banco: BancoLocal, agora = () => new Date().toISOString(), aoEnfileirar = () => {}) {
  async function salvar(identidade: IdentidadeLoja, base: PreferenciaIdentidadeLoja | undefined) {
    if (!identidadeLojaValida(identidade)) throw new Error('Identificação da loja inválida')
    const resultado = await banco.transaction('rw', banco.identidadesLoja, banco.fila, async () => {
      const atual = await banco.identidadesLoja.get('loja')
      if (!mesmaPreferenciaIdentidade(atual, base)) return { ok: false, atual } as const
      const preferencia: PreferenciaIdentidadeLoja = { chave: 'loja', id: atual?.id ?? uuidv7(), atualizadoEm: agora(), identidade }
      if (!preferenciaIdentidadeValida(preferencia)) throw new Error('Preferência da loja inválida')
      const pendente = await banco.fila.where('registroId').equals(preferencia.id).and((f) => f.tabela === 'identidadeLoja').first()
      await banco.identidadesLoja.put(preferencia)
      if (pendente) await banco.fila.update(pendente.ordem, { versao: (pendente.versao ?? 0) + 1, problema: undefined })
      else await banco.fila.add({ tabela: 'identidadeLoja', registroId: preferencia.id, criadoEm: preferencia.atualizadoEm, versao: 0 })
      return { ok: true, preferencia } as const
    })
    if (resultado.ok) aoEnfileirar()
    return resultado
  }
  async function capturarEnvio(id: string): Promise<EnvioIdentidadeLoja | undefined> {
    return banco.transaction('r', banco.identidadesLoja, banco.fila, async () => {
      const preferencia = await banco.identidadesLoja.get('loja')
      const fila = await banco.fila.where('registroId').equals(id).and((f) => f.tabela === 'identidadeLoja').first()
      if (!fila || fila.problema) return undefined
      if (!preferenciaIdentidadeValida(preferencia) || preferencia.id !== id) throw new Error('Fila sem identificação íntegra')
      return { preferencia, fila }
    })
  }
  async function responderEnvio(envio: EnvioIdentidadeLoja, problema?: Problema): Promise<void> {
    await banco.transaction('rw', banco.fila, async () => {
      const atual = await banco.fila.get(envio.fila.ordem)
      if (!atual || atual.tabela !== 'identidadeLoja' || atual.registroId !== envio.preferencia.id || (atual.versao ?? 0) !== (envio.fila.versao ?? 0)) return
      if (problema) await banco.fila.put({ ...atual, problema })
      else await banco.fila.delete(atual.ordem)
    })
  }
  return { ler: () => banco.identidadesLoja.get('loja'), salvar, capturarEnvio, responderEnvio,
    assinar: (ouvinte: (p: PreferenciaIdentidadeLoja | undefined) => void, falha: () => void) => {
      const assinatura = liveQuery(() => banco.identidadesLoja.get('loja')).subscribe({ next: ouvinte, error: falha })
      return () => assinatura.unsubscribe()
    } }
}
