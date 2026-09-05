import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { InvolucroMinimo } from './interface/InvolucroMinimo'
import { pedirVerificacaoDeVersao } from './plataforma/atualizacao'

// Pedido na abertura, antes da montagem (D-032). A versão nova é baixada em segundo
// plano e assume na abertura seguinte — esta sessão nunca é recarregada.
pedirVerificacaoDeVersao()

// Sem `!` e sem `as`: se o elemento não existir, o erro precisa dizer o que houve
// (AGENTS.md §4). Silenciar o compilador aqui esconderia um index.html quebrado.
const raiz = document.getElementById('root')
if (!raiz) throw new Error('Elemento #root não encontrado em index.html')

createRoot(raiz).render(
  <StrictMode>
    <InvolucroMinimo />
  </StrictMode>,
)
