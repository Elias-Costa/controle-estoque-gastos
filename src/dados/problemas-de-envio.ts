import { liveQuery } from 'dexie'
import type { BancoLocal, ItemDaFila, Problema } from './banco.ts'

/** D-077: somente a identificação da tentativa e o diagnóstico, sem o conteúdo da anotação. */
export type ProblemaDeEnvio = Pick<ItemDaFila, 'tabela' | 'registroId' | 'criadoEm'> & {
  readonly versao: number
  readonly problema: Problema
}

/** Leitura observada da recusa local; relatar nunca confirma, regrava ou retenta um envio. */
export function criarLeituraProblemasDeEnvio(banco: BancoLocal) {
  async function ler(): Promise<readonly ProblemaDeEnvio[]> {
    return banco.transaction('r', banco.fila, async () => {
      const itens = await banco.fila.orderBy('ordem').toArray()
      return itens.flatMap((item) => {
        if (item.problema === undefined) return []
        const { codigo, constraint, mensagem, em } = item.problema
        return [{ tabela: item.tabela, registroId: item.registroId, criadoEm: item.criadoEm,
          versao: item.versao ?? 0, problema: { codigo, ...(constraint === undefined ? {} : { constraint }), mensagem, em } }]
      })
    })
  }
  return { ler, assinar: (aoLer: (problemas: readonly ProblemaDeEnvio[]) => void, aoFalhar: () => void) => {
    // D-077: liveQuery silencia DatabaseClosedError; a tela precisa sair de “Preparando”.
    const assinatura = liveQuery(async () => {
      try { return { ok: true as const, problemas: await ler() } }
      catch { return { ok: false as const } }
    }).subscribe({ next: (resposta) => resposta.ok ? aoLer(resposta.problemas) : aoFalhar(), error: aoFalhar })
    return () => assinatura.unsubscribe()
  } }
}
