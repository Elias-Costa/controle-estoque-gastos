/**
 * A base do aplicativo — uma instância só, com o nome definitivo (D-040) — e o repositório
 * sobre ela.
 *
 * Fica num arquivo próprio para que os testes, que importam `BancoLocal` de `banco.ts` e
 * criam bases isoladas, nunca toquem nesta. Quem a usa: `main.tsx` (abre na abertura, para
 * a migração rodar ali), a sincronização (`src/sincronizacao/instancia.ts`, E-07) e, a partir
 * de E-09, as telas por meio de `repositorio`.
 *
 * `aoEnfileirar` é o único fio entre esta pasta e a sincronização, e vai só numa direção:
 * quem quiser saber que a fila cresceu se inscreve aqui; esta pasta não importa nada de
 * `src/sincronizacao` (RI-02: a rede não aparece em `src/dados`).
 */

import { BancoLocal } from './banco.ts'
import { criarRepositorioLocal } from './repositorio.ts'
import { criarRepositorioEstoque } from './repositorio-estoque.ts'
import { criarOperacoesEstoque } from './operacoes-estoque.ts'
import { criarRepositorioFotos } from './fotos.ts'
import { criarRepositorioCaixa } from './repositorio-caixa.ts'
import { criarOperacoesCaixa } from './operacoes-caixa.ts'
import { criarRepositorioModelos } from './repositorio-modelos.ts'
import { criarLeituraDivulgacao } from './leitura-divulgacao.ts'
import { criarRepositorioIdentidadeLoja } from './repositorio-identidade-loja.ts'
import { criarLeituraProblemasDeEnvio } from './problemas-de-envio.ts'
import { criarCorrecaoDescricaoEnvio } from './completar-descricao-envio.ts'

export const banco = new BancoLocal()

const ouvintes = new Set<() => void>()

/** Avisa `ouvinte` toda vez que uma gravação entra na fila. Devolve a função que cancela. */
export function aoEnfileirar(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte)
  return () => {
    ouvintes.delete(ouvinte)
  }
}

/** O repositório do app, sobre a base do app. As telas usam este; os testes criam o seu. */
export const repositorio = criarRepositorioLocal(banco, undefined, () => {
  for (const ouvinte of ouvintes) ouvinte()
})

/** Porta local de F2; a fila permanece pendente até o transporte conjunto de E-21. */
export const repositorioEstoque = criarRepositorioEstoque(banco, undefined, () => {
  for (const ouvinte of ouvintes) ouvinte()
})

/** Operações de estoque do aplicativo; interfaces de F2 serão ligadas nas etapas próprias. */
export const operacoesEstoque = criarOperacoesEstoque(repositorioEstoque)

/** Miniaturas e retenção local usadas no cadastro; não depende da sessão nem da rede. */
export const repositorioFotos = criarRepositorioFotos(banco)

/** Fatos próprios de caixa, lidos pelas telas e transportados em grupos completos. */
export const repositorioCaixa = criarRepositorioCaixa(banco, undefined, () => {
  for (const ouvinte of ouvintes) ouvinte()
})

/** Portas locais de gastos/receitas usadas nas telas da E-34. */
export const operacoesCaixa = criarOperacoesCaixa(repositorioCaixa)

/** Preferência offline dos quatro textos; a sincronização escuta a mesma fila. */
export const repositorioModelos = criarRepositorioModelos(banco, undefined, () => {
  for (const ouvinte of ouvintes) ouvinte()
})

/** Catálogo e compromissos lidos consistentemente, com observação das alterações entre abas. */
export const leituraDivulgacao = criarLeituraDivulgacao(banco)

/** Identificação privada da loja, salva offline e anunciada ao mesmo motor da fila. */
export const repositorioIdentidadeLoja = criarRepositorioIdentidadeLoja(banco, undefined, () => {
  for (const ouvinte of ouvintes) ouvinte()
})

/** Diagnósticos locais observados, sem exportar a base nem tocar na fila (D-077). */
export const leituraProblemasDeEnvio = criarLeituraProblemasDeEnvio(banco)

/** Completa somente o texto faltante após conferência humana, sem alterar o financeiro. */
export const correcaoDescricaoEnvio = criarCorrecaoDescricaoEnvio(banco, () => {
  for (const ouvinte of ouvintes) ouvinte()
})
