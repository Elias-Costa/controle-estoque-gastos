import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { PainelSpike } from './spike/PainelSpike'
import { vigiarAtualizacoes } from './spike/atualizacao'

// Precisa rodar antes da montagem: o service worker pode assumir o controle a
// qualquer momento, e sem isto a tela fica servida pelo cache da versão antiga.
vigiarAtualizacoes()

// E-00: a raiz monta o painel do spike. Em E-01 isto passa a montar o aplicativo.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PainelSpike />
  </StrictMode>,
)
