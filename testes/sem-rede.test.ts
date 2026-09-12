import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A varredura de E-08: "nenhum caminho de escrita depende de rede — verificado por varredura,
 * não por lembrança" (RI-02, EL-01, EL-06; D-043).
 *
 * O caminho de escrita é `src/dominio` (decide) e `src/dados` (grava e enfileira). A rede mora
 * em `src/sincronizacao`, e a dependência é `sincronizacao → dados`, nunca o inverso
 * (`src/dados/LEIA-ME.md`). Este teste lê os fontes das duas pastas e falha ao primeiro sinal de
 * rede — uma lista explícita, com o porquê de cada item, para que um `await fetch(...)` dentro
 * de uma operação nunca chegue ao aparelho dela por esquecimento. `navigator.` entra porque
 * `navigator.onLine` mente no iOS (`docs/fatos-verificados.md`) e nenhuma escrita pode consultá-lo.
 *
 * É varredura de texto, de propósito: não depende de bundler nem de grafo de módulos, e quem
 * ler daqui a meses entende em trinta segundos o que ela proíbe. Os sinais de import têm a forma
 * do import (`from '…`) para um comentário que cite a pasta não derrubar o teste.
 */

const PASTAS_SEM_REDE = ['src/dominio', 'src/dados'] as const

const SINAIS_DE_REDE: readonly { readonly sinal: string; readonly porque: string }[] = [
  { sinal: 'fetch(', porque: 'requisição HTTP dentro do caminho de escrita (RI-02)' },
  { sinal: 'XMLHttpRequest', porque: 'requisição HTTP dentro do caminho de escrita (RI-02)' },
  { sinal: 'WebSocket', porque: 'conexão de rede dentro do caminho de escrita (RI-02)' },
  { sinal: 'navigator.', porque: '`navigator.onLine` mente no iOS; a escrita não consulta a rede (EL-06)' },
  { sinal: "from '@supabase", porque: 'o cliente da nuvem só existe em src/sincronizacao (D-042)' },
  { sinal: "from '../sincronizacao", porque: 'a dependência é sincronizacao → dados, nunca o inverso (D-040)' },
  { sinal: "import('../sincronizacao", porque: 'a dependência é sincronizacao → dados, nunca o inverso (D-040)' },
]

function arquivosDeCodigo(pasta: string): string[] {
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith('.ts') || nome.endsWith('.tsx'))
    .map((nome) => join(pasta, nome))
}

describe('nenhum caminho de escrita depende de rede (E-08, RI-02)', () => {
  for (const pasta of PASTAS_SEM_REDE) {
    const arquivos = arquivosDeCodigo(pasta)

    test(`${pasta} tem arquivos para varrer`, () => {
      expect(arquivos.length).toBeGreaterThan(0)
    })

    for (const arquivo of arquivos) {
      test(`${arquivo} não toca a rede`, () => {
        const fonte = readFileSync(arquivo, 'utf8')
        const achados = SINAIS_DE_REDE.filter(({ sinal }) => fonte.includes(sinal)).map(
          ({ sinal, porque }) => `${sinal} — ${porque}`,
        )
        expect(achados).toEqual([])
      })
    }
  }
})
