/**
 * A base do aplicativo — uma instância só, com o nome definitivo (D-040).
 *
 * Fica num arquivo próprio para que os testes, que importam `BancoLocal` de `banco.ts` e
 * criam bases isoladas, nunca toquem nesta. Quem a usa: `main.tsx` (abre na abertura, para
 * a migração rodar ali) e, a partir de E-09, as telas por meio do repositório.
 */

import { BancoLocal } from './banco.ts'

export const banco = new BancoLocal()
