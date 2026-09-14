import { useState, useSyncExternalStore } from 'react'
import { conta } from '../sincronizacao/instancia.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { fraseDaRecusaDoLogin, PALAVRAS_DA_CONTA } from './palavras-da-conta.ts'
import { Topo } from './Topo.tsx'

/**
 * A tela de login (E-13, RF-27, D-005, D-048): e-mail, senha, "Entrar". Quem a vê é o mantenedor,
 * uma vez, no aparelho dela — a sessão fica guardada e se renova sozinha. Por isso ela não
 * explica nada: dois campos, um botão e, se a nuvem recusar, uma frase.
 *
 * Nunca é a primeira tela: o app abre na lista com ou sem sessão (D-048 item 1), e esta tela
 * só é alcançada pelo `BotaoEntrar` abaixo. Nada aqui toca a base local (EL-05).
 */
export function TelaEntrar({ aoVoltar, aoEntrar }: { aoVoltar: () => void; aoEntrar: () => void }) {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [recusa, setRecusa] = useState<string | null>(null)
  const podeEntrar = email.trim() !== '' && senha !== '' && !enviando

  async function entrar(): Promise<void> {
    setEnviando(true)
    setRecusa(null)
    const resultado = await conta.entrar(email.trim(), senha)
    setEnviando(false)
    if (resultado.ok) {
      aoEntrar()
      return
    }
    // O detalhe é para o mantenedor, no console; para ela, a frase (RI-07).
    if (resultado.recusa.motivo === 'outra') console.warn('login recusado:', resultado.recusa.mensagem)
    setRecusa(fraseDaRecusaDoLogin(resultado.recusa))
  }

  return (
    <main className="tela">
      <Topo titulo={PALAVRAS_DA_CONTA.entrar} aoVoltar={aoVoltar} />

      <Campo rotulo={PALAVRAS_DA_CONTA.email} valor={email} aoMudar={setEmail} tipo="email" autoFoco />
      <Campo rotulo={PALAVRAS_DA_CONTA.senha} valor={senha} aoMudar={setSenha} tipo="senha" />

      {recusa !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{recusa}</p>}

      <div className="rodape-acao">
        <Botao tipo="principal" aoTocar={() => void entrar()} desabilitado={!podeEntrar}>
          {enviando ? PALAVRAS_DA_CONTA.entrando : PALAVRAS_DA_CONTA.entrar}
        </Botao>
      </div>
    </main>
  )
}

/**
 * A linha "Entrar ›" da tela inicial: um botão de texto, como "Quem está devendo ›", que só
 * existe sem sessão guardada neste aparelho — nunca por falta de rede (`conta.ts`). Some ao
 * entrar. É por onde o mantenedor chega à tela acima; ela, na prática, nunca a vê (D-005).
 */
export function BotaoEntrar({ aoTocar }: { aoTocar: () => void }) {
  const estado = useSyncExternalStore(conta.assinar, conta.estado, conta.estado)
  if (estado !== 'precisa-entrar') return null
  return (
    <button type="button" className="entrar min-h-11 border-0 bg-transparent p-0 text-[1rem] font-semibold text-acento" onClick={aoTocar}>
      {PALAVRAS_DA_CONTA.entrar} <span aria-hidden="true">&rsaquo;</span>
    </button>
  )
}
