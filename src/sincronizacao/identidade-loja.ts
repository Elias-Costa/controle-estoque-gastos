import type { BancoLocal } from '../dados/banco.ts'
import { preferenciaIdentidadeValida, type PreferenciaIdentidadeLoja } from '../dados/identidade-loja.ts'
import { normalizarCarimbo } from './borda.ts'
import type { LinhaRecebida } from './nuvem.ts'
import { conteudoDoEfeito } from '../dominio/regras-estoque.ts'

/** D-076: textos e PNG no mesmo documento privado, sem referências externas. */
export function identidadeParaNuvem(preferencia: PreferenciaIdentidadeLoja): LinhaRecebida {
  if (!preferenciaIdentidadeValida(preferencia)) throw new Error('Identificação local inválida')
  return { chave: 'loja', id: preferencia.id, atualizado_em: preferencia.atualizadoEm, identidade: preferencia.identidade }
}

/** Download incompleto/malformado não substitui a configuração local. */
export function identidadeDaNuvem(linha: LinhaRecebida): PreferenciaIdentidadeLoja {
  const p = { chave: linha['chave'], id: linha['id'], identidade: linha['identidade'],
    atualizadoEm: normalizarCarimbo('identidade.atualizado_em', linha['atualizado_em']) }
  if (!preferenciaIdentidadeValida(p)) throw new Error('Identificação remota inválida')
  return p
}

/** LWW inteiro; empate mantém a edição pendente até seu envio, como nos cadastros. */
export async function aplicarIdentidadeLoja(banco: BancoLocal, remota: PreferenciaIdentidadeLoja): Promise<void> {
  if (!preferenciaIdentidadeValida(remota)) throw new Error('Identificação remota inválida')
  await banco.transaction('rw', banco.identidadesLoja, banco.fila, banco.controleCopia, async () => {
    const local = await banco.identidadesLoja.get('loja')
    const pendente = local && await banco.fila.where('registroId').equals(local.id).and((f) => f.tabela === 'identidadeLoja').first()
    const restaurando = !!await banco.controleCopia.get('restauracao')
    const origem = local && await banco.controleCopia.get(`registro:identidadeLoja/${local.id}`)
    const copiado = origem && 'conteudo' in origem && origem.conteudo === conteudoDoEfeito(local)
    if (local && (local.atualizadoEm > remota.atualizadoEm ||
      local.atualizadoEm === remota.atualizadoEm && pendente && !(restaurando && copiado))) return
    await banco.identidadesLoja.put(remota)
    if (pendente) await banco.fila.delete(pendente.ordem)
  })
}
