import { useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { cadastrarCliente, lancarSaldoAnterior } from '../dados/operacoes.ts'
import { somar } from '../dominio/dinheiro.ts'
import type { Dia, Id } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { fraseDaGuardaDoSaldoAnterior } from './palavras-do-saldo-anterior.ts'
import { conferirSaldoAnterior, type RascunhoDoSaldoAnterior } from './rascunho-do-saldo-anterior.ts'
import { CamposDoSaldoAnterior } from './TelaSaldoAnterior.tsx'
import { Topo } from './Topo.tsx'

/** O máximo de "vezes" da venda (D-049, item 2). */
const VEZES_DO_PROTOTIPO = 4

/**
 * Cadastro de cliente (RF-01) com o saldo anterior opcional (RF-07): a fichinha nova.
 *
 * Só o nome é obrigatório; ele já vem preenchido com o que ela digitou na busca — quem toca em
 * "+ É uma cliente nova" acabou de procurar alguém e não achou (regra do protótipo). Os outros
 * campos são o que RF-01 lista; nenhum é exigido. A meta é cadastro em menos de 15 s.
 *
 * "Já me deve" é a migração do papel em uma linha (D-009, D-044, D-049): valor, "desde",
 * "vence em" e, com 2× ou mais, as parcelas — os mesmos campos da tela "O que a X já devia"
 * (`CamposDoSaldoAnterior`). Só aparecem depois que há um valor, com padrão visível: "desde"
 * é a última data digitada nesta sessão (ou hoje) e "vence em" acompanha "desde" até ela
 * mexer. Nada é carimbado em silêncio (lição do "Outro dia" do protótipo).
 *
 * "Pronto" fica indisponível (não morto) enquanto falta o nome ou o saldo não fecha. Ao
 * gravar, a tela abre a ficha nova: o nome no topo e "Deve R$ X" (ou "Nada") são a confirmação.
 */
export function TelaCadastro({
  nomeInicial,
  outroDiaLembrado,
  aoLembrarOutroDia,
  aoVoltar,
  aoCadastrar,
}: {
  nomeInicial: string
  outroDiaLembrado: Dia
  aoLembrarOutroDia: (dia: Dia) => void
  aoVoltar: () => void
  aoCadastrar: (clienteId: Id) => void
}) {
  const dia = hoje()
  const [nome, setNome] = useState(nomeInicial)
  const [telefone, setTelefone] = useState('')
  const [apelido, setApelido] = useState('')
  const [observacao, setObservacao] = useState('')
  const [saldo, setSaldo] = useState<RascunhoDoSaldoAnterior>({
    valorTexto: '',
    desde: outroDiaLembrado === '' ? dia : outroDiaLembrado,
    venceEm: '',
    vezes: 1,
    edicoes: [],
  })
  const [venceEmEditado, setVenceEmEditado] = useState<Dia | null>(null)
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const rascunho: RascunhoDoSaldoAnterior = { ...saldo, venceEm: venceEmEditado ?? saldo.desde }
  const conferencia = conferirSaldoAnterior(rascunho, dia)
  // Sem valor (ou zero) é "não deve nada": cadastro sem saldo anterior, permitido. Qualquer outra guarda trava.
  const temSaldoAnterior = !conferencia.guardas.includes('sem-valor')
  const frases = conferencia.guardas
    .map((guarda) => fraseDaGuardaDoSaldoAnterior(guarda, somar(conferencia.parcelas.map((parcela) => parcela.valor)), conferencia.valor))
    .filter((frase): frase is string => frase !== null)
  const podeGravar = nome.trim() !== '' && (!temSaldoAnterior || conferencia.guardas.length === 0) && !gravando

  function mudarSaldo(mudanca: Partial<RascunhoDoSaldoAnterior>): void {
    if (mudanca.venceEm !== undefined) setVenceEmEditado(mudanca.venceEm)
    setSaldo((atual) => ({ ...atual, ...mudanca }))
  }

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
          data: rascunho.desde,
          parcelas: conferencia.parcelas.map(({ vencimento, valor }) => ({ vencimento, valor })),
        })
        // A cliente já está gravada; o que falhou foi o saldo. A ficha aberta mostra "Nada", e
        // isso é visível — melhor do que um cadastro duplicado numa segunda tentativa.
        if (!anterior.ok) setErro(PALAVRAS.cadastro.naoDeu)
        // A data que ela digitou vale para o próximo "Outro dia" (D-049); hoje não é digitado.
        else if (rascunho.desde !== dia) aoLembrarOutroDia(rascunho.desde)
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

      <CamposDoSaldoAnterior rotuloDoValor={PALAVRAS.cadastro.jaMeDeve} rascunho={rascunho} conferencia={conferencia} maximoDeVezes={VEZES_DO_PROTOTIPO} aoMudar={mudarSaldo} />

      {(frases.length > 0 || erro !== null) && (
        <div className="mt-4">
          {frases.map((frase) => (
            <p key={frase} className="m-0 font-semibold text-atraso">
              {frase}
            </p>
          ))}
          {erro !== null && <p className="m-0 font-semibold text-atraso">{erro}</p>}
        </div>
      )}

      <div className="rodape-acao">
        <Botao tipo="principal" aoTocar={() => void gravar()} desabilitado={!podeGravar}>
          {PALAVRAS.cadastro.pronto}
        </Botao>
      </div>
    </main>
  )
}
