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

/**
 * A varredura de E-13 (RF-27, D-005, D-048, EL-05): a base local **nunca é apagada por causa de
 * sessão** — nem por nada, em `src/`. Apagar a base num logout transformaria um problema de
 * sessão em EL-05. O único lugar que a apaga é a prova de RT-10 (`testes/navegador/apoio.ts`,
 * pelo `banco` que o laboratório expõe), fora de `src/` e fora do build dela. `Dexie.delete()`
 * apaga o banco inteiro; `.clear()` esvazia uma tabela; `banco.fila.…delete()` (apagar um item
 * pelo id) é legítimo e não casa com nenhum dos sinais.
 */
const PASTAS_DE_SRC = ['src/dominio', 'src/dados', 'src/sincronizacao', 'src/interface', 'src/plataforma'] as const
const SINAIS_DE_APAGAR = ['banco.delete(', 'Dexie.delete(', 'deleteDatabase(', '.clear('] as const

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

describe('a base local não é apagada por sessão (E-13, D-005, EL-05)', () => {
  const arquivos = PASTAS_DE_SRC.flatMap(arquivosDeCodigo)

  test('a varredura cobre a conta, o laboratório e as telas (senão não prova nada)', () => {
    expect(arquivos).toContain(join('src/sincronizacao', 'conta.ts'))
    expect(arquivos).toContain(join('src/plataforma', 'laboratorio.ts'))
    expect(arquivos).toContain(join('src/interface', 'TelaEntrar.tsx'))
  })

  for (const arquivo of arquivos) {
    test(`${arquivo} não apaga a base`, () => {
      const fonte = readFileSync(arquivo, 'utf8')
      expect(SINAIS_DE_APAGAR.filter((sinal) => fonte.includes(sinal))).toEqual([])
    })
  }
})
