import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { banco } from './dados/instancia'
import { Aplicativo } from './interface/Aplicativo'
import { sincronizacao } from './sincronizacao/instancia'
import { pedirVerificacaoDeVersao } from './plataforma/atualizacao'
import { pedirPersistencia } from './plataforma/persistencia'

// Pedido na abertura, antes da montagem (D-032). A versão nova é baixada em segundo
// plano e assume na abertura seguinte — esta sessão nunca é recarregada.
pedirVerificacaoDeVersao()

// A base é aberta aqui, na abertura, para a migração de esquema rodar agora e não no meio
// de uma venda (D-040); e a persistência da origem é pedida junto (EL-05). Os dois são
// fire-and-forget: nenhuma tela espera por eles (RNF-04), e uma falha aqui vira erro na
// primeira operação — que é onde a tela tem como dizer o que houve —, nunca tela de erro
// na abertura (EL-06).
void banco.open().catch(() => undefined)
pedirPersistencia()

// A sincronização acorda na abertura e depois sozinha — a cada gravação, ao voltar a rede, ao
// voltar à aba, ao entrar a sessão (E-07). Nunca é aguardada por ninguém: escrita é local (RI-02)
// e falha de rede não vira tela (EL-06). Sem configuração da nuvem, o motor só conta a fila.
sincronizacao.acordar()

// O laboratório de E-08 (D-043): a prova de offline lança vendas e lê a ficha por ele, por
// fora das telas. Só no build de laboratório (`bun run build:laboratorio`): em produção
// a variável não existe, o ramo é morto e o chunk nem é emitido.
if (import.meta.env.VITE_LABORATORIO === '1') void import('./plataforma/laboratorio')

// Sem `!` e sem `as`: se o elemento não existir, o erro precisa dizer o que houve
// (AGENTS.md §4). Silenciar o compilador aqui esconderia um index.html quebrado.
const raiz = document.getElementById('root')
if (!raiz) throw new Error('Elemento #root não encontrado em index.html')

createRoot(raiz).render(
  <StrictMode>
    <Aplicativo />
  </StrictMode>,
)
