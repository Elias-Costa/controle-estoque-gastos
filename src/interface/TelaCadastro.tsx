import { useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { cadastrarCliente, lancarSaldoAnterior } from '../dados/operacoes.ts'
import { lerDinheiro } from '../dominio/dinheiro.ts'
import type { Id } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { Topo } from './Topo.tsx'

/**
 * Cadastro de cliente (RF-01) com o saldo anterior opcional (RF-07): a fichinha nova.
 *
 * Só o nome é obrigatório; ele já vem preenchido com o que ela digitou na busca — quem toca em
 * "+ É uma cliente nova" acabou de procurar alguém e não achou (regra do protótipo). Os outros
 * campos são o que RF-01 lista; nenhum é exigido. A meta é cadastro em menos de 15 s.
 *
 * "Já me deve" é a migração do papel em uma linha (D-009, D-044): valor, "desde" e "vence em"
 * viram **um** saldo anterior com **uma** parcela. Os dois campos de data só aparecem depois
 * que há um valor, com padrão visível: "desde" é hoje e "vence em" acompanha "desde" até ela
 * mexer. Nada é carimbado em silêncio (lição do "Outro dia" do protótipo).
 *
 * "Pronto" fica indisponível (não morto) enquanto falta o nome ou o valor não foi lido. Ao
 * gravar, a tela abre a ficha nova: o nome no topo e "Deve R$ X" (ou "Nada") são a confirmação.
 */
export function TelaCadastro({
  nomeInicial,
  aoVoltar,
  aoCadastrar,
}: {
  nomeInicial: string
  aoVoltar: () => void
  aoCadastrar: (clienteId: Id) => void
}) {
  const [nome, setNome] = useState(nomeInicial)
  const [telefone, setTelefone] = useState('')
  const [apelido, setApelido] = useState('')
  const [observacao, setObservacao] = useState('')
  const [valorTexto, setValorTexto] = useState('')
  const [desde, setDesde] = useState(hoje)
  const [venceEmEditado, setVenceEmEditado] = useState<string | null>(null)
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const venceEm = venceEmEditado ?? desde
  const valor = lerDinheiro(valorTexto)
  const temValor = valorTexto.trim() !== ''
  // Valor zero é "não deve nada": não vira lançamento (um saldo anterior de R$ 0,00 seria lixo na ficha).
  const temSaldoAnterior = temValor && valor !== null && valor > 0n
  const valorIlegivel = temValor && valor === null
  const datasCompletas = !temSaldoAnterior || (desde !== '' && venceEm !== '')
  const podeGravar = nome.trim() !== '' && !valorIlegivel && datasCompletas && !gravando

  async function gravar(): Promise<void> {
    setGravando(true)
    setErro(null)
    try {
      const cliente = await cadastrarCliente(repositorio, {
        nome,
        ...(telefone.trim() !== '' && { telefone: telefone.trim() }),
        ...(apelido.trim() !== '' && { apelido: apelido.trim() }),
        ...(observacao.trim() !== '' && { observacao: observacao.trim() }),
      })
      if (!cliente.ok) {
        setErro(cliente.motivo === 'nome-obrigatorio' ? PALAVRAS.cadastro.faltaONome : PALAVRAS.cadastro.naoDeu)
        return
      }
      if (temSaldoAnterior) {
        const anterior = await lancarSaldoAnterior(repositorio, {
          clienteId: cliente.valor.id,
          data: desde,
          parcelas: [{ vencimento: venceEm, valor }],
        })
        // A cliente já está gravada; o que falhou foi o saldo. A ficha aberta mostra "Nada", e
        // isso é visível — melhor do que um cadastro duplicado numa segunda tentativa.
        if (!anterior.ok) setErro(PALAVRAS.cadastro.naoDeu)
      }
      aoCadastrar(cliente.valor.id)
    } catch {
      // A base local não gravou (EL-06): dito na tela, com palavras dela; nada foi perdido em silêncio.
      setErro(PALAVRAS.cadastro.naoDeu)
    } finally {
      setGravando(false)
    }
  }

  return (
    <main className="tela">
      <Topo titulo={PALAVRAS.cadastro.titulo} aoVoltar={aoVoltar} />

      <Campo rotulo={PALAVRAS.cadastro.nome} valor={nome} aoMudar={setNome} autoFoco />
      <Campo rotulo={PALAVRAS.cadastro.telefone} valor={telefone} aoMudar={setTelefone} tipo="tel" />
      <Campo rotulo={PALAVRAS.cadastro.apelido} valor={apelido} aoMudar={setApelido} exemplo={PALAVRAS.cadastro.apelidoExemplo} />
      <Campo rotulo={PALAVRAS.cadastro.observacao} valor={observacao} aoMudar={setObservacao} multilinha />

      <CampoDeDinheiro rotulo={PALAVRAS.cadastro.jaMeDeve} texto={valorTexto} aoMudar={setValorTexto} />
      {temSaldoAnterior && (
        <>
          <Campo rotulo={PALAVRAS.cadastro.desde} valor={desde} aoMudar={setDesde} tipo="date" />
          <Campo rotulo={PALAVRAS.cadastro.venceEm} valor={venceEm} aoMudar={setVenceEmEditado} tipo="date" />
        </>
      )}

      {erro !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{erro}</p>}

      <div className="rodape-acao">
        <Botao tipo="principal" aoTocar={() => void gravar()} desabilitado={!podeGravar}>
          {PALAVRAS.cadastro.pronto}
        </Botao>
      </div>
    </main>
  )
}
