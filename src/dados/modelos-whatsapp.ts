/** As quatro situações de RF-09; preferência inteira de D-069/072. */
export const SITUACOES_MENSAGEM = ['cobranca-vencida', 'cobranca-a-vencer', 'recibo-com-saldo', 'recibo-quitado'] as const
/** Situação escolhe o texto, sem condicionais ou código escritos pela usuária. */
export type SituacaoMensagem = typeof SITUACOES_MENSAGEM[number]
/** Trechos restritos aprovados em D-014/069. */
export type TrechoMensagem = 'nome' | 'valor' | 'vencimento' | 'saldo'
/** Os quatro textos são salvos e resolvidos por último-que-escreve juntos. */
export type ModelosWhatsApp = Readonly<Record<SituacaoMensagem, string>>
/** Chave local fixa, identidade gerada no aparelho e relógio de edição como nos cadastros. */
export type PreferenciaModelos = { readonly chave: 'whatsapp'; readonly id: string; readonly atualizadoEm: string; readonly modelos: ModelosWhatsApp }
/** D-050: cobrança ditada por ela; recibos continuam proposta histórica de D-047. */
export const MODELOS_ORIGINAIS: ModelosWhatsApp = {
  'cobranca-vencida': 'Oi, {nome}, tudo bem? Passando para lembrar da parcela que está atrasada. Quando puder, me mande, por favor. Obrigada!',
  'cobranca-a-vencer': 'Oi, {nome}, tudo bem? Passando para lembrar da parcela que vence em {vencimento}. Quando puder, me mande, por favor. Obrigada!',
  'recibo-com-saldo': 'Oi, {nome}! Recebi os {valor}, obrigada! Agora falta {saldo} na sua fichinha.',
  'recibo-quitado': 'Oi, {nome}! Recebi os {valor}, obrigada! Sua fichinha está quitada!',
}
/** Só oferece dados definidos para cada contexto, conforme D-072. */
export function trechosDaMensagem(situacao: SituacaoMensagem): readonly TrechoMensagem[] {
  return situacao.startsWith('cobranca') ? ['nome', 'valor', 'vencimento'] : ['nome', 'valor', 'saldo']
}
/** Vazio e chaves incompletas/desconhecidas não viram mensagem à cliente (D-072). */
export function modeloValido(texto: string, situacao: SituacaoMensagem): boolean {
  if (texto.trim() === '') return false
  const permitidos = trechosDaMensagem(situacao)
  let valido = true
  const resto = texto.replace(/\{([^{}]*)\}/g, (_marcador, nome: string) => {
    if (!permitidos.some((trecho) => trecho === nome)) valido = false
    return ''
  })
  return valido && !/[{}]/.test(resto)
}
/** Forma fechada para banco, transporte e arquivo; não aceita texto parcial como preferência. */
export function modelosValidos(valor: unknown): valor is ModelosWhatsApp {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false
  const entradas = Object.entries(valor)
  return entradas.length === SITUACOES_MENSAGEM.length && SITUACOES_MENSAGEM.every((s) =>
    entradas.some(([chave, texto]) => chave === s && typeof texto === 'string' && modeloValido(texto, s)))
}
/** Preferência íntegra: UUID do cliente e instante normalizado permitem comparação explícita. */
export function preferenciaModelosValida(valor: unknown): valor is PreferenciaModelos {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false
  const v: Record<string, unknown> = Object.fromEntries(Object.entries(valor))
  return Object.keys(v).sort().join(',') === 'atualizadoEm,chave,id,modelos' && v['chave'] === 'whatsapp' &&
    typeof v['id'] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v['id']) &&
    typeof v['atualizadoEm'] === 'string' && !Number.isNaN(Date.parse(v['atualizadoEm'])) &&
    new Date(v['atualizadoEm']).toISOString() === v['atualizadoEm'] && modelosValidos(v['modelos'])
}
