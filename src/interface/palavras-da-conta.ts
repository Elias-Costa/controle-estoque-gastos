import type { RecusaDoLogin } from '../sincronizacao/conta.ts'

/**
 * As palavras do login (RF-27, RI-07) — **hipótese até E-15** (D-048). Quem digita aqui é o
 * mantenedor, uma vez, no aparelho dela (D-005); ainda assim, nada de "autenticação", "sessão",
 * "token" ou "conta expirada". "Entrar" é o verbo do WhatsApp e do banco dela.
 */
export const PALAVRAS_DA_CONTA = {
  /** A linha da tela inicial, com o "›" à parte: só aparece sem sessão guardada. */
  entrar: 'Entrar',
  email: 'E-mail',
  senha: 'Senha',
  entrando: 'Entrando…',
  emailOuSenhaErrados: 'E-mail ou senha errados.',
  semInternet: 'Sem internet agora. Tente de novo quando voltar.',
  naoDeu: 'Não deu para entrar agora. Tente de novo.',
} as const

/** A frase da recusa, por motivo. `outra` e `sem-nuvem` viram a mesma frase; o detalhe vai para o console. */
export function fraseDaRecusaDoLogin(recusa: RecusaDoLogin): string {
  switch (recusa.motivo) {
    case 'credenciais':
      return PALAVRAS_DA_CONTA.emailOuSenhaErrados
    case 'rede':
      return PALAVRAS_DA_CONTA.semInternet
    case 'sem-nuvem':
    case 'outra':
      return PALAVRAS_DA_CONTA.naoDeu
  }
}
