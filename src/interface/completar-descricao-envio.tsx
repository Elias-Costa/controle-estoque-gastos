import { useState } from 'react'
import { correcaoDescricaoEnvio } from '../dados/instancia.ts'
import type { VendaSemDescricao } from '../dados/completar-descricao-envio.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { descricaoDoItemPreenchida, totalDaVenda } from '../dominio/ficha.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { diaCurto } from './datas.ts'
import { useLeitura } from './useLeitura.ts'

/** D-078: conferência local explícita, sem inventar nomes nem depender da rede para salvar. */
export function CompletarDescricaoEnvio() {
  const [emEdicao, setEmEdicao] = useState<readonly VendaSemDescricao[]>(), [geracao, setGeracao] = useState(0)
  const leitura = useLeitura(() => correcaoDescricaoEnvio.ler(), String(geracao))
  if (emEdicao === undefined && (leitura.estado !== 'lido' || leitura.valor.length === 0)) return null
  function fechar() { setEmEdicao(undefined); setGeracao((atual) => atual + 1) }
  return <section aria-label="Completar anotação" className="my-3">
    {emEdicao === undefined ? <Botao tipo="secundario" aoTocar={() => { if (leitura.estado === 'lido') setEmEdicao(leitura.valor) }}>Completar o que foi vendido</Botao>
      : emEdicao.map((retrato) => <Formulario key={`${retrato.fila.ordem}:${retrato.fila.versao ?? 0}`} retrato={retrato} aoFechar={fechar} />)}
  </section>
}

function Formulario({ retrato, aoFechar }: { retrato: VendaSemDescricao; aoFechar: () => void }) {
  const [descricoes, setDescricoes] = useState<Record<number, string>>({})
  const [gravando, setGravando] = useState(false), [erro, setErro] = useState<string>()
  const faltantes = retrato.venda.itens.flatMap((item, posicao) => descricaoDoItemPreenchida(item.descricao) ? [] : [{ item, posicao }])
  const podeSalvar = !gravando && faltantes.every(({ posicao }) => descricaoDoItemPreenchida(descricoes[posicao] ?? ''))
  async function salvar() {
    if (!podeSalvar) return
    setGravando(true); setErro(undefined)
    try {
      const resultado = await correcaoDescricaoEnvio.completar(retrato, descricoes)
      if (resultado.ok) aoFechar()
      else setErro(resultado.motivo === 'mudou' ? 'Essa anotação mudou. Feche e confira de novo antes de completar.' : 'Informe o que foi vendido em cada item.')
    } catch { setErro('Não deu para salvar. O que você digitou continua aqui para tentar de novo.') }
    finally { setGravando(false) }
  }
  return <fieldset className="my-3 min-w-0 rounded-xl border border-borda p-3">
    <legend className="max-w-full break-words">Completar o que foi vendido</legend>
    <p>{retrato.cliente} · {diaCurto(retrato.venda.data)} · {emReais(totalDaVenda(retrato.venda))}</p>
    <p>Faltou dizer o que foi vendido. Complete os itens abaixo. Valores, datas e parcelas continuam como foram anotados.</p>
    {faltantes.map(({ item, posicao }) => <label key={posicao} className="my-3 block">Item {posicao + 1} · {emReais(item.preco)}
      <input className={CLASSES_DE_CAMPO} aria-label={`O que foi vendido no item ${posicao + 1}`} value={descricoes[posicao] ?? ''}
        onChange={(e) => setDescricoes((atuais) => ({ ...atuais, [posicao]: e.target.value }))} />
    </label>)}
    {erro && <p role="status" className="text-atraso">{erro}</p>}
    <Botao tipo="principal" aoTocar={() => void salvar()} desabilitado={!podeSalvar}>{gravando ? 'Salvando…' : 'Salvar e tentar enviar'}</Botao>
    <Botao tipo="secundario" className="mt-2" aoTocar={aoFechar} desabilitado={gravando}>Deixar como está</Botao>
  </fieldset>
}
