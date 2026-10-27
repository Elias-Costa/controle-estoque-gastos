import type { ProblemaDeEnvio } from '../dados/problemas-de-envio.ts'
import { linkDoWhatsApp, telefoneParaWhatsApp } from './whatsapp.ts'

/** D-077: o relato identifica cada tentativa; não exporta fichas, dinheiro, fotos ou sessão. */
export function relatoDeEnvio(problemas: readonly ProblemaDeEnvio[], versaoDoApp: string): string {
  return `Preciso de ajuda com o envio das anotações no Fichinhas.\n\n${JSON.stringify({
    aplicativo: 'Fichinhas', versaoDoApp,
    problemas: problemas.map(({ tabela, registroId, criadoEm, versao, problema }) => ({
      tabela, registroId, criadoEm, versao, problema: { codigo: problema.codigo,
        ...(problema.constraint === undefined ? {} : { constraint: problema.constraint }), mensagem: problema.mensagem, em: problema.em },
    })),
  }, null, 2)}`
}

/** Só recebe o contato depois da consulta autenticada; número inválido nunca escolhe outra conversa. */
export function linkDoRelatoDeEnvio(problemas: readonly ProblemaDeEnvio[], versaoDoApp: string, telefone: string): string {
  if (telefoneParaWhatsApp(telefone) === null) throw new Error('Contato de suporte inválido')
  return linkDoWhatsApp(telefone, relatoDeEnvio(problemas, versaoDoApp))
}
