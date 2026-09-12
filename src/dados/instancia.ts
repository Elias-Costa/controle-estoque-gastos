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
