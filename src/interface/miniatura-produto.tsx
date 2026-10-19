import { useEffect, useRef } from 'react'
import { PALAVRAS_DOS_PRODUTOS as P } from './palavras-dos-produtos.ts'

/** Exibe apenas bytes locais e revoga a URL ao trocar/sair; a consulta nunca busca foto na rede. */
export function MiniaturaProduto({ binario, nome, temFoto = false }: { binario?: Uint8Array; nome: string; temFoto?: boolean }) {
  const imagem = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!binario || !imagem.current) return
    const url = URL.createObjectURL(new Blob([new Uint8Array(binario)], { type: 'image/jpeg' }))
    imagem.current.src = url
    return () => URL.revokeObjectURL(url)
  }, [binario])
  return binario
    ? <img ref={imagem} className="h-20 w-20 flex-none rounded-xl bg-papel object-contain" alt={nome} width={80} height={80} />
    : <span className="flex h-20 w-20 flex-none items-center justify-center rounded-xl bg-fundo p-1 text-center text-xs text-suave">{temFoto ? P.aguardandoFoto : P.semFoto}</span>
}
