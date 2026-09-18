import { useEffect, useState } from 'react'
import { repositorio } from '../dados/instancia.ts'
import { alterarCliente, desativarCliente, reativarCliente } from '../dados/operacoes.ts'
import type { Cliente, Id } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { Campo } from './Campo.tsx'
import { hoje } from './datas.ts'
import { PALAVRAS } from './palavras-da-ficha.ts'
import { PALAVRAS_DA_VENDA } from './palavras-da-venda.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/**
 * "Mudar dados" (E-16, RF-01, D-050 item 8): os quatro campos do cadastro, preenchidos, e
 * "Pronto" — que volta à ficha, onde o nome no topo é a confirmação (D-044). Abre pelo "Mudar
 * dados ›" do cabeçalho da ficha; fora do caminho cronometrado. Sem "Já me deve": o saldo
 * anterior tem o caminho próprio (D-049).
 *
 * No fim, "Desativar a fichinha" (item 6) com segundo toque, ou "Reativar a fichinha" quando já
 * está desativada. Desativar é marca, nunca apagar (D-041): a fichinha some das listas e volta
 * por "Ver as fichinhas desativadas (N)" na tela inicial. Os dois gravam antes o que ela mudou
 * nos campos — nada que ela digitou se perde em silêncio. Desativar volta à tela inicial (a
 * ficha sumiu da lista); reativar volta à ficha.
 */
export function TelaDadosDoCliente({
  clienteId,
  aoVoltar,
  aoPronto,
  aoDesativar,
}: {
  clienteId: Id
  aoVoltar: () => void
  aoPronto: () => void
  aoDesativar: () => void
}) {
  const leitura = useLeitura(() => repositorio.lerCliente(clienteId), clienteId)
  const cliente = leitura.estado === 'lido' ? (leitura.valor ?? null) : null

  // Cliente que sumiu entre um toque e outro (só por outro aparelho): a lista é o lugar certo.
  const sumiu = leitura.estado === 'lido' && leitura.valor === undefined
  useEffect(() => {
    if (sumiu) aoVoltar()
  }, [sumiu, aoVoltar])

  if (cliente === null) {
    return (
      <main className="tela">
        <Topo titulo={PALAVRAS.dados.titulo} aoVoltar={aoVoltar} />
        {leitura.estado === 'falhou' && <p className="text-atraso">{PALAVRAS.naoDeuParaAbrir}</p>}
      </main>
    )
  }
  return <Formulario cliente={cliente} aoVoltar={aoVoltar} aoPronto={aoPronto} aoDesativar={aoDesativar} />
}

/** O formulário, montado só depois de ler: o estado dos campos nasce do cliente lido. */
function Formulario({ cliente, aoVoltar, aoPronto, aoDesativar }: { cliente: Cliente; aoVoltar: () => void; aoPronto: () => void; aoDesativar: () => void }) {
  const [nome, setNome] = useState(cliente.nome)
  const [telefone, setTelefone] = useState(cliente.telefone ?? '')
  const [apelido, setApelido] = useState(cliente.apelido ?? '')
  const [observacao, setObservacao] = useState(cliente.observacao ?? '')
  const [confirmando, setConfirmando] = useState(false)
  const [gravando, setGravando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const desativada = cliente.desativadoEm !== undefined

  /** Grava os campos como estão; devolve o cliente gravado, ou `null` com o erro já na tela. */
  async function gravarCampos(): Promise<Cliente | null> {
    const resultado = await alterarCliente(repositorio, cliente, {
      nome,
      ...(telefone.trim() !== '' && { telefone: telefone.trim() }),
      ...(apelido.trim() !== '' && { apelido: apelido.trim() }),
      ...(observacao.trim() !== '' && { observacao: observacao.trim() }),
    })
    if (resultado.ok) return resultado.valor
    setErro(resultado.motivo === 'nome-obrigatorio' ? PALAVRAS.cadastro.faltaONome : PALAVRAS.cadastro.naoDeu)
    return null
  }

  async function executar(acao: (gravado: Cliente) => Promise<void>): Promise<void> {
    setGravando(true)
    setErro(null)
    try {
      const gravado = await gravarCampos()
      if (gravado !== null) await acao(gravado)
    } catch {
      // A base local não gravou (EL-06): dito na tela, com palavras dela; nada foi perdido em silêncio.
      setErro(PALAVRAS.cadastro.naoDeu)
    } finally {
      setGravando(false)
    }
  }

  const pronto = () => executar(async () => aoPronto())
  const desativar = () =>
    executar(async (gravado) => {
      await desativarCliente(repositorio, gravado, hoje())
      aoDesativar()
    })
  const reativar = () =>
    executar(async (gravado) => {
      await reativarCliente(repositorio, gravado)
      aoPronto()
    })

  return (
    <main className="tela">
      <Topo titulo={PALAVRAS.dados.titulo} subtitulo={cliente.nome} aoVoltar={aoVoltar} />
      {desativada && <p className="mt-0 mb-3 text-[0.95rem] font-semibold text-suave">{PALAVRAS.fichinhaDesativada}</p>}

      <Campo rotulo={PALAVRAS.cadastro.nome} valor={nome} aoMudar={setNome} />
      <Campo rotulo={PALAVRAS.cadastro.telefone} valor={telefone} aoMudar={setTelefone} tipo="tel" />
      <Campo rotulo={PALAVRAS.cadastro.apelido} valor={apelido} aoMudar={setApelido} exemplo={PALAVRAS.cadastro.apelidoExemplo} />
      <Campo rotulo={PALAVRAS.cadastro.observacao} valor={observacao} aoMudar={setObservacao} multilinha />

      {confirmando && <p className="mt-5 mb-0 font-semibold">{PALAVRAS.dados.desativarMesmo}</p>}
      {erro !== null && <p className="mt-4 mb-0 font-semibold text-atraso">{erro}</p>}

      <div className="rodape-acao">
        {confirmando ? (
          <>
            <Botao tipo="principal" aoTocar={() => void desativar()} desabilitado={gravando}>
              {PALAVRAS.dados.simDesativar}
            </Botao>
            <Botao tipo="secundario" aoTocar={() => setConfirmando(false)}>
              {PALAVRAS_DA_VENDA.anotacao.deixarComoEsta}
            </Botao>
          </>
        ) : (
          <>
            <Botao tipo="principal" aoTocar={() => void pronto()} desabilitado={gravando || nome.trim() === ''}>
              {PALAVRAS.cadastro.pronto}
            </Botao>
            {desativada ? (
              <Botao tipo="secundario" aoTocar={() => void reativar()} desabilitado={gravando}>
                {PALAVRAS.dados.reativar}
              </Botao>
            ) : (
              <Botao tipo="secundario" aoTocar={() => setConfirmando(true)}>
                {PALAVRAS.dados.desativar}
              </Botao>
            )}
          </>
        )}
      </div>
    </main>
  )
}
