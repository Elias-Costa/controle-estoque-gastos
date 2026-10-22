import type { Id } from '../dominio/ficha.ts'
import type { ProdutoLocal } from './banco.ts'

/** Tetos de bytes aprovados em D-025 antes do código de E-22; dinheiro não passa por estes números. */
export const LIMITE_FOTO_BYTES = 204_800
/** Miniatura local/restaurada aprovada em D-025; não é o original remoto. */
export const LIMITE_MINIATURA_BYTES = 20_480

/** Resultado já comprimido e medido, preparado fora da transação IndexedDB. */
export type FotoPreparada = {
  readonly binario: Uint8Array
  readonly miniatura: Uint8Array
  readonly sha256: string
  readonly largura: number
  readonly altura: number
}

/** Identidade lógica e localização física são distintas; uma cópia coletada nunca é reutilizada. */
export type ReferenciaFoto = {
  readonly fotoId: Id
  readonly copiaId: Id
  readonly sha256: string
  readonly bytes: number
  readonly largura: number
  readonly altura: number
  readonly caminho: string
  readonly disponivel: boolean
}

/** Binário pendente só é liberado após publicação confirmada ou resolução explícita de troca superada. */
export type FotoLocal = {
  readonly id: Id
  readonly copiaId: Id
  readonly produtoId: Id
  readonly cadastroEm: string
  readonly geracaoEnvio: Id
  readonly sha256: string
  readonly bytes: number
  readonly largura: number
  readonly altura: number
  readonly binario?: Uint8Array
  readonly miniatura?: Uint8Array
  readonly caminho?: string
  readonly registrada?: boolean
  readonly geracaoReferencia?: Id
  readonly situacao: 'pendente' | 'disponivel' | 'superada'
  /** Impede reapresentar referência conhecida depois da reconciliação que autorizou soltá-la. */
  readonly dispensada?: boolean
}

/** Geração cliente distingue a proteção nova de uma liberação antiga/atrasada (D-025/Q41A). */
export type ProtecaoFoto = ReferenciaFoto & {
  readonly aparelhoId: Id
  readonly geracao: Id
}

/** A liberação fica durável antes da rede; uma geração marcada nunca volta a ser reutilizada. */
export type ProtecaoFotoLocal = ProtecaoFoto & { readonly id: string; readonly liberar?: boolean }

/** Fotografia durável de produto em trânsito; seu fotoId ainda pode reaparecer após resposta perdida. */
export type EnvioProdutoFoto = { readonly id: Id; readonly produtoId: Id; readonly cadastro: ProdutoLocal }

/** Leitura para edição protege a referência até a reconciliação local durável do consumidor. */
export type UsoFotoLocal = { readonly id: Id; readonly fotoId: Id }

/** Identidade de aparelho e geração de leitura sobrevivem ao fechamento; não têm expiração automática. */
export type EstadoFotos = { readonly chave: 'aparelho' | 'leitura'; readonly valor: Id }
