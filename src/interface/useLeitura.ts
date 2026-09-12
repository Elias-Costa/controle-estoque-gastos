import { useEffect, useRef, useState } from 'react'
import { sincronizacao } from '../sincronizacao/instancia.ts'

/** O que uma tela sabe sobre o que pediu à base: ainda lendo, lido, ou a base não respondeu. */
export type Leitura<T> = { readonly estado: 'lendo' } | { readonly estado: 'lido'; readonly valor: T } | { readonly estado: 'falhou' }

/**
 * Lê da base local para a tela. Lê ao montar e **relê quando a sincronização termina um
 * ciclo** (`ultimoSucessoEm` muda): é assim que uma venda feita no outro aparelho aparece
 * sem ela fazer nada (D-044). Escrita própria não precisa disto — toda escrita navega para
 * uma tela que lê ao montar.
 *
 * `chave` diz quando a leitura é outra (a ficha de outra cliente). `ler` é uma função nova a
 * cada render e por isso vive numa ref: a leitura roda por `chave` e por ciclo, nunca por
 * render — senão cada resultado renderizaria, releria e renderizaria de novo, sem fim.
 *
 * Nada aqui espera rede (RNF-04): a leitura é IndexedDB. Se ela falhar — a base não abriu —
 * a tela recebe `falhou` e diz isso com palavras dela, em vez de girar para sempre (EL-06).
 */
export function useLeitura<T>(ler: () => Promise<T>, chave: string): Leitura<T> {
  const [leitura, setLeitura] = useState<Leitura<T>>({ estado: 'lendo' })
  const [ciclo, setCiclo] = useState(sincronizacao.estado().ultimoSucessoEm)
  const lerAtual = useRef(ler)

  // Sem lista de dependências: roda a cada render, antes do efeito de leitura (ordem de declaração).
  useEffect(() => {
    lerAtual.current = ler
  })

  useEffect(() => sincronizacao.assinar(() => setCiclo(sincronizacao.estado().ultimoSucessoEm)), [])

  useEffect(() => {
    let vale = true
    lerAtual.current().then(
      (valor) => {
        if (vale) setLeitura({ estado: 'lido', valor })
      },
      () => {
        if (vale) setLeitura({ estado: 'falhou' })
      },
    )
    return () => {
      vale = false
    }
  }, [chave, ciclo])

  return leitura
}
