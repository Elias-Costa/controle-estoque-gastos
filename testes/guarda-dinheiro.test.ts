import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Prova que a guarda de EL-03 reprova de fato.
 *
 * O critério de conclusão de E-01 é que uma sonda com `parseFloat` e `.toFixed()` no
 * domínio produza erro, uma linha por violação, citando a decisão. Como sonda manual
 * isso é verdade no dia em que se verifica e ninguém percebe quando deixa de ser; como
 * teste, `check` fica vermelho no dia em que alguém editar `.oxlintrc.json` e afrouxar
 * a regra. `docs/requirements.md` §5.2 pede as duas coisas para toda falha eliminatória:
 * um mecanismo que a torne difícil de introduzir **e** um teste que prove sua ausência.
 *
 * A sonda roda numa pasta temporária que reproduz o caminho `src/dominio/`, e não dentro
 * do repositório, porque o arquivo é proibido por construção — deixá-lo em `src/` faria o
 * lint do projeto reprovar para sempre. A configuração usada é a real, copiada, não uma
 * cópia escrita à mão que poderia divergir da que vale.
 */

const RAIZ = join(import.meta.dir, '..')
const OXLINT = join(RAIZ, 'node_modules', '.bin', process.platform === 'win32' ? 'oxlint.exe' : 'oxlint')

/** Código que viola a guarda de dinheiro, uma violação por linha, na ordem das asserções. */
const SONDA_PROIBIDA = [
  `import Dexie from 'dexie'`,
  `export const a = parseFloat('1,50')`,
  `export const b = (1.5).toFixed(2)`,
  `export const c = Math.round(1.5)`,
  `export const d = Number('3')`,
  `export const e = Dexie`,
].join('\n')

/** O mesmo código fora do domínio: `number` é legítimo na borda de formatação. */
const SONDA_PERMITIDA = [
  `export const b = (1.5).toFixed(2)`,
  `export const c = Math.round(1.5)`,
].join('\n')

/** Monta um repositório de mentira com a configuração real e devolve a saída do oxlint. */
function rodarOxlint(caminhoRelativo: string, codigo: string): string {
  const pasta = mkdtempSync(join(tmpdir(), 'guarda-el03-'))
  try {
    const destino = join(pasta, caminhoRelativo)
    mkdirSync(join(destino, '..'), { recursive: true })
    writeFileSync(destino, codigo, 'utf8')
    copyFileSync(join(RAIZ, '.oxlintrc.json'), join(pasta, '.oxlintrc.json'))

    // `--disable-nested-config` impede que o oxlint suba até a configuração do próprio
    // repositório: o que está sob teste é a cópia, no formato de caminho que ela espera.
    const resultado = Bun.spawnSync([OXLINT, '--disable-nested-config', '.'], { cwd: pasta })
    return resultado.stdout.toString() + resultado.stderr.toString()
  } finally {
    rmSync(pasta, { recursive: true, force: true })
  }
}

describe('guarda de EL-03 no domínio', () => {
  const saida = rodarOxlint('src/dominio/sonda.ts', SONDA_PROIBIDA)

  test('reprova parseFloat citando a decisão', () => {
    expect(saida).toContain(`Unexpected use of 'parseFloat'`)
    expect(saida).toMatch(/parseFloat[\s\S]*?RI-01, EL-03, D-022/)
  })

  test('reprova toFixed citando a decisão', () => {
    expect(saida).toContain(`'toFixed' is restricted from being used`)
    expect(saida).toMatch(/toFixed formata number[\s\S]*?RI-01, EL-03, D-022/)
  })

  test('reprova Math citando a decisão', () => {
    expect(saida).toContain(`Unexpected use of 'Math'`)
  })

  test('reprova Number citando a decisão', () => {
    expect(saida).toContain(`Unexpected use of 'Number'`)
  })

  test('emite uma linha por violação, e não uma só', () => {
    const violacoes = saida.split('\n').filter((linha) => linha.includes('error'))
    expect(violacoes).toHaveLength(5)
  })
})

describe('fronteira de importação do domínio', () => {
  test('reprova qualquer importação que não seja caminho relativo', () => {
    const saida = rodarOxlint('src/dominio/sonda.ts', SONDA_PROIBIDA)
    expect(saida).toContain(`'dexie' import is restricted`)
    expect(saida).toContain('AGENTS.md §4')
  })

  test('aceita importação relativa dentro do próprio domínio', () => {
    const saida = rodarOxlint('src/dominio/sonda.ts', `import { x } from './vizinho'\nexport const y = x`)
    expect(saida).not.toContain('no-restricted-imports')
  })
})

describe('a guarda está no domínio, não solta pelo projeto', () => {
  test('não reprova toFixed nem Math fora do domínio', () => {
    const saida = rodarOxlint('src/interface/formatador.ts', SONDA_PERMITIDA)
    expect(saida).not.toContain('no-restricted-properties')
    expect(saida).not.toContain('no-restricted-globals')
  })
})
