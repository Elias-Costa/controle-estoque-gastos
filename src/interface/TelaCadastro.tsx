import { RodapeDeAcoes } from './rodape-de-acoes.tsx'
import { useRef, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { alterarCliente, cadastrarCliente, lancarSaldoAnterior } from '../dados/operacoes.ts'
import { somar } from '../dominio/dinheiro.ts'
import type { Cliente, Dia, Id } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { AvisosDoFormulario } from './avisos-do-formulario.tsx'
import { Campo } from './Campo.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { fraseDaGuardaDoSaldoAnterior } from './palavras-do-saldo-anterior.ts'
import { conferirSaldoAnterior, type RascunhoDoSaldoAnterior } from './rascunho-do-saldo-anterior.ts'
import { MAXIMO_DE_VEZES } from './Opcoes.tsx'
import { CamposDoSaldoAnterior } from './TelaSaldoAnterior.tsx'
import { Topo } from './Topo.tsx'

/**
 * Cadastro de cliente (RF-01) com o saldo anterior opcional (RF-07): a fichinha nova.
 *
 * Só o nome é obrigatório; ele já vem preenchido com o que ela digitou na busca — quem toca em
 * "+ Nova fichinha" acabou de procurar alguém e não achou (regra do protótipo). Os outros
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
  // V-01: cadastro e saldo são gravações separadas; a recuperação reutiliza o cadastro confirmado.
  const clienteCadastrada = useRef<Cliente | null>(null)
  const gravacao = useRef<'pronta' | 'gravando' | 'concluida'>('pronta')

  const rascunho: RascunhoDoSaldoAnterior = { ...saldo, venceEm: venceEmEditado ?? saldo.desde }
  const conferencia = conferirSaldoAnterior(rascunho, dia)
  // Sem valor (ou zero) é "não deve nada": cadastro sem saldo anterior, permitido. Qualquer outra guarda trava.
  const temSaldoAnterior = !conferencia.guardas.includes('sem-valor')
  const frases = conferencia.guardas
    .map((guarda) => guarda === 'parcelas-nao-fecham' ? PALAVRAS_DA_VENDA.conferirParcelas : fraseDaGuardaDoSaldoAnterior(guarda, somar(conferencia.parcelas.map((parcela) => parcela.valor)), conferencia.valor))
    .filter((frase): frase is string => frase !== null)
  const podeGravar = nome.trim() !== '' && (!temSaldoAnterior || conferencia.guardas.length === 0) && !gravando

  function mudarSaldo(mudanca: Partial<RascunhoDoSaldoAnterior>): void {
    if (mudanca.venceEm !== undefined) setVenceEmEditado(mudanca.venceEm)
    setSaldo((atual) => ({ ...atual, ...mudanca }))
  }

  async function gravar(): Promise<void> {
    if (!podeGravar || gravacao.current !== 'pronta') return
    gravacao.current = 'gravando'
    setGravando(true)
    setErro(null)
    let cliente = clienteCadastrada.current
    try {
      const entrada = {
        nome: nome.trim(),
        ...(telefone.trim() !== '' && { telefone: telefone.trim() }),
        ...(apelido.trim() !== '' && { apelido: apelido.trim() }),
        ...(observacao.trim() !== '' && { observacao: observacao.trim() }),
      }
      if (cliente === null || cliente.nome !== entrada.nome || cliente.telefone !== entrada.telefone || cliente.apelido !== entrada.apelido || cliente.observacao !== entrada.observacao) {
        // RF-01/D-050: campos continuam editáveis; mudar dados não cria outra identidade.
        const resultado = cliente === null
          ? await cadastrarCliente(repositorio, entrada)
          : await alterarCliente(repositorio, cliente, entrada)
        if (!resultado.ok) {
          setErro(resultado.motivo === 'nome-obrigatorio' ? PALAVRAS.cadastro.faltaONome : PALAVRAS.cadastro.naoDeu)
          return
        }
        cliente = resultado.valor
        clienteCadastrada.current = cliente
      }
      if (temSaldoAnterior) {
        const anterior = await lancarSaldoAnterior(repositorio, {
          clienteId: cliente.id,
          data: rascunho.desde,
          parcelas: conferencia.parcelas.map(({ vencimento, valor }) => ({ vencimento, valor })),
        })
        if (!anterior.ok) {
          setErro(PALAVRAS.cadastro.saldoNaoAnotado)
          return
        }
      }
      // Bloqueia outro toque mesmo antes de React desmontar a tela de cadastro.
      gravacao.current = 'concluida'
    } catch {
      setErro(clienteCadastrada.current === null ? PALAVRAS.cadastro.naoDeu : PALAVRAS.cadastro.saldoNaoAnotado)
      return
    } finally {
      if (gravacao.current === 'gravando') gravacao.current = 'pronta'
      setGravando(false)
    }
    // Só confirmar depois das duas operações, sem confundir falha de navegação com escrita.
    if (temSaldoAnterior && rascunho.desde !== dia) aoLembrarOutroDia(rascunho.desde)
    aoCadastrar(cliente.id)
  }

  return (
    <main className="tela">
      <Topo titulo={PALAVRAS.cadastro.titulo} aoVoltar={aoVoltar} />

      <Campo rotulo={PALAVRAS.cadastro.nome} valor={nome} aoMudar={setNome} autoFoco obrigatorio orientacao={PALAVRAS.cadastro.nomeObrigatorio} />
      <Campo rotulo={PALAVRAS.cadastro.telefone} valor={telefone} aoMudar={setTelefone} tipo="tel" />
      <Campo rotulo={PALAVRAS.cadastro.apelido} valor={apelido} aoMudar={setApelido} exemplo={PALAVRAS.cadastro.apelidoExemplo} />
      <Campo rotulo={PALAVRAS.cadastro.observacao} valor={observacao} aoMudar={setObservacao} multilinha />

      <CamposDoSaldoAnterior rotuloDoValor={PALAVRAS.cadastro.jaMeDeve} rascunho={rascunho} conferencia={conferencia} maximoDeVezes={MAXIMO_DE_VEZES} aoMudar={mudarSaldo} />

      <RodapeDeAcoes>
        <AvisosDoFormulario frases={nome.trim() === '' ? [PALAVRAS.cadastro.faltaONome, ...frases] : frases} erro={erro} />
        <Botao tipo="principal" aoTocar={() => void gravar()} desabilitado={!podeGravar}>
          {PALAVRAS.cadastro.pronto}
        </Botao>
      </RodapeDeAcoes>
    </main>
  )
}
