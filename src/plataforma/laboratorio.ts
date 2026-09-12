/**
 * O laboratório de E-08 (D-043): a mão da prova de offline (`testes/navegador/`) nas mesmas
 * instâncias que o app usa — para lançar uma venda, ler a ficha, apagar a base e entrar com o
 * usuário de teste antes de existir tela (E-09) e login (E-13).
 *
 * **Só existe no build de laboratório.** `main.tsx` importa este módulo dentro de
 * `if (import.meta.env.VITE_LABORATORIO === '1')`; em produção o ramo é morto e o chunk nem é
 * emitido — a conferência por grep está em `testes/navegador/LEIA-ME.md`. Nada aqui é tela, e
 * nada aqui converte tipo: o teste monta `bigint` e lê `String(...)` do lado de lá do `evaluate`.
 */

import type { BancoLocal } from '../dados/banco.ts'
import { banco, repositorio } from '../dados/instancia.ts'
import { cadastrarCliente, lancarVendaFiado, receber } from '../dados/operacoes.ts'
import type { Repositorio } from '../dados/repositorio.ts'
import { saldo } from '../dominio/ficha.ts'
import { sincronizacao, supabaseDoApp } from '../sincronizacao/instancia.ts'
import type { Sincronizacao } from '../sincronizacao/sincronizacao.ts'

/** O que o teste encontra em `window.laboratorio`. As operações já vêm presas ao repositório do app. */
export type Laboratorio = {
  readonly banco: BancoLocal
  readonly repositorio: Repositorio
  readonly sincronizacao: Sincronizacao
  readonly saldo: typeof saldo
  readonly cadastrarCliente: (entrada: Parameters<typeof cadastrarCliente>[1]) => ReturnType<typeof cadastrarCliente>
  readonly lancarVendaFiado: (entrada: Parameters<typeof lancarVendaFiado>[1]) => ReturnType<typeof lancarVendaFiado>
  readonly receber: (entrada: Parameters<typeof receber>[1]) => ReturnType<typeof receber>
  /**
   * Entra com o usuário de teste (D-042, item 4). **Não é o login de E-13** — é o
   * `signInWithPassword` do cliente que o app já tem. Lança se o build veio sem nuvem ou se a
   * nuvem recusou, porque um teste que "passa" sem sessão não provou nada.
   */
  readonly entrar: (email: string, senha: string) => Promise<void>
}

declare global {
  interface Window {
    /** Presente só no build de laboratório (D-043). */
    laboratorio?: Laboratorio
  }
}

async function entrar(email: string, senha: string): Promise<void> {
  if (!supabaseDoApp) throw new Error('build sem VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY: não há nuvem para entrar')
  const { error } = await supabaseDoApp.auth.signInWithPassword({ email, password: senha })
  if (error) throw new Error(`login do usuário de teste falhou: ${error.message}`)
}

window.laboratorio = {
  banco,
  repositorio,
  sincronizacao,
  saldo,
  cadastrarCliente: (entrada) => cadastrarCliente(repositorio, entrada),
  lancarVendaFiado: (entrada) => lancarVendaFiado(repositorio, entrada),
  receber: (entrada) => receber(repositorio, entrada),
  entrar,
}
