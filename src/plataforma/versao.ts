/**
 * Carimbo da versão em uso, injetado em tempo de build por `define` em vite.config.ts.
 *
 * Existe porque em 2026-09-05 uma rodada inteira de teste no iPhone rodou contra o
 * build anterior sem ninguém perceber: o service worker instalado não havia trocado.
 * Sem um carimbo visível, "testei e deu X" é uma afirmação sobre versão desconhecida,
 * e nenhum suporte remoto é possível. É critério de aceite de RF-23 (D-032).
 */
export const CARIMBO_DE_BUILD: string = __BUILD_ID__
