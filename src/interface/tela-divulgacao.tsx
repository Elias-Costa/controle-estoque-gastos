import { useEffect, useId, useRef, useState } from 'react'
import { leituraDivulgacao, repositorioFotos, repositorioIdentidadeLoja } from '../dados/instancia.ts'
import { mesmaPreferenciaIdentidade, type PreferenciaIdentidadeLoja } from '../dados/identidade-loja.ts'
import { IdentificacaoLoja } from './identificacao-loja.tsx'
import type { RetratoDivulgacao } from '../dados/leitura-divulgacao.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { podeCompartilharDivulgacao, compartilharDivulgacao } from '../plataforma/compartilhar-divulgacao.ts'
import { Botao } from './Botao.tsx'
import { CLASSES_DE_CAMPO } from './Campo.tsx'
import { Topo } from './Topo.tsx'
import { TelaDadosDoCliente } from './TelaDadosDoCliente.tsx'
import { TelaProduto } from './tela-produto.tsx'
import { MiniaturaProduto } from './miniatura-produto.tsx'
import { rotuloDaCategoria } from './leitura-de-produtos.ts'
import { telefoneParaWhatsApp } from './whatsapp.ts'
import { chaveDaMarca, filtrarDivulgacao, mesmasLinhasDivulgacao, relerPreviaDivulgacao, type FiltrosDivulgacao, type PreviaDivulgacao } from './divulgacao-produtos.ts'
import { prepararDivulgacao } from './preparar-divulgacao.ts'
import { PALAVRAS_DA_DIVULGACAO as P } from './palavras-da-divulgacao.ts'

type PreviaNaTela = PreviaDivulgacao & { readonly chave: string }

/** RF-29: seleção local conferível; nenhuma ação de compartilhar grava venda, reserva ou envio. */
export function TelaDivulgacao({ aoVoltar }: { aoVoltar: () => void }) {
  const idCampos = useId()
  const [filtros, setFiltros] = useState<FiltrosDivulgacao>({ categoria: '', marca: '', classificacao: '' })
  const chave = JSON.stringify(filtros)
  const [retrato, setRetrato] = useState<RetratoDivulgacao>()
  const [previa, setPrevia] = useState<PreviaNaTela>()
  const [falhou, setFalhou] = useState(false)
  const [clienteId, setClienteId] = useState('')
  const [edicao, setEdicao] = useState<{ tipo: 'produto' | 'cliente'; id: string }>()
  const [ocupado, setOcupado] = useState(false)
  const [mensagem, setMensagem] = useState<string>()
  const [identidade, setIdentidade] = useState<PreferenciaIdentidadeLoja>()
  const [identidadeLida, setIdentidadeLida] = useState(false)
  const [pronto, setPronto] = useState<{ arquivo: File; previa: PreviaNaTela; geradoEm: string; identidade: PreferenciaIdentidadeLoja }>()
  const montado = useRef(true)
  const trava = useRef(false)
  useEffect(() => { montado.current = true; return () => { montado.current = false } }, [])
  useEffect(() => repositorioIdentidadeLoja.assinar((valor) => { setIdentidade(valor); setIdentidadeLida(true) }, () => { setIdentidadeLida(false); setPronto(undefined) }), [])
  useEffect(() => leituraDivulgacao.assinar((valor) => {
    try {
      const atuais = filtrarDivulgacao(valor, filtros)
      setRetrato(valor); setFalhou(false)
      setPrevia((anterior) => anterior?.chave === chave ? { ...relerPreviaDivulgacao(anterior, atuais), chave } :
        { linhas: atuais, desmarcados: anterior?.desmarcados ?? [], novos: 0, alterada: false, chave })
    } catch { setFalhou(true) }
  }, () => setFalhou(true)), [chave, filtros])

  const selecionadas = previa?.linhas.filter((linha) => !previa.desmarcados.includes(linha.produto.id)) ?? []
  const cliente = retrato?.clientes.find((item) => item.id === clienteId && !item.desativadoEm)
  const temTelefone = !!telefoneParaWhatsApp(cliente?.telefone)
  const faltamDados = selecionadas.some((linha) => linha.produto.precoVenda === undefined || !linha.foto?.length)
  const valido = !!pronto && !!previa && identidadeLida && mesmaPreferenciaIdentidade(pronto.identidade, identidade) && pronto.previa.chave === chave && mesmasLinhasDivulgacao(pronto.previa.linhas, previa.linhas) &&
    mesmasLinhasDivulgacao(pronto.previa.linhas.filter((linha) => !pronto.previa.desmarcados.includes(linha.produto.id)), selecionadas)
  const podeAbrir = valido && pronto !== undefined && podeCompartilharDivulgacao(pronto.arquivo)

  function mudarFiltro(campo: keyof FiltrosDivulgacao, valor: string) {
    setFiltros((anteriores) => ({ ...anteriores, [campo]: valor })); setPronto(undefined); setMensagem(undefined)
  }
  async function preparar() {
    if (!previa || !identidade || !identidadeLida || trava.current) return
    trava.current = true; setOcupado(true); setPronto(undefined); setMensagem(undefined)
    const geradoEm = new Date().toLocaleString('pt-BR')
    try {
      const resultado = await prepararDivulgacao(previa, filtros, { ler: leituraDivulgacao.ler, fotos: repositorioFotos,
        gerar: async (itens) => (await import('../plataforma/pdf-divulgacao.ts')).gerarPdfDivulgacao(itens, geradoEm, identidade.identidade) })
      if (!montado.current) return
      if (!mesmaPreferenciaIdentidade(identidade, await repositorioIdentidadeLoja.ler())) {
        setMensagem('A identificação da loja mudou. Confira e prepare o PDF novamente.'); return
      }
      const revisada = { ...resultado.previa, chave }
      setPrevia(revisada)
      if (resultado.estado === 'alterada') setMensagem(P.mudou)
      else setPronto({ arquivo: resultado.arquivo, previa: revisada, geradoEm, identidade })
    } catch { if (montado.current) setMensagem(P.falhaPdf) }
    finally { trava.current = false; if (montado.current) setOcupado(false) }
  }
  function compartilhar() {
    if (!pronto || !podeAbrir || trava.current) return
    trava.current = true; setOcupado(true)
    // Não aguardar geração ou leitura neste gesto: o PDF já foi relido e conferido no preparo.
    void compartilharDivulgacao(pronto.arquivo).then((resultado) => {
      if (montado.current) setMensagem(resultado === 'cancelou' ? P.cancelou : P.retornou)
    }, () => { if (montado.current) setMensagem(P.falhaEnvio) }).finally(() => {
      trava.current = false; if (montado.current) setOcupado(false)
    })
  }
  if (edicao?.tipo === 'produto') return <TelaProduto produtoId={edicao.id} aoVoltar={() => setEdicao(undefined)} aoSalvar={() => setEdicao(undefined)} />
  if (edicao?.tipo === 'cliente') return <TelaDadosDoCliente clienteId={edicao.id} aoVoltar={() => setEdicao(undefined)} aoPronto={() => setEdicao(undefined)} aoDesativar={() => { setEdicao(undefined); setClienteId('') }} />
  const marcas = new Map<string, string>()
  for (const produto of [...retrato?.produtos ?? []].sort((a, b) => a.id.localeCompare(b.id))) marcas.set(chaveDaMarca(produto.marca), produto.marca?.trim() || 'Sem marca')
  return <main className="tela [overflow-wrap:anywhere]">
    <Topo titulo={P.titulo} aoVoltar={ocupado ? undefined : aoVoltar} />
    <p>{P.explicacao}</p>
    {identidadeLida ? <IdentificacaoLoja preferencia={identidade} ocupado={ocupado} /> : <p role="status">Conferindo a identificação da loja…</p>}
    {falhou && <p role="alert">{P.falhaLeitura}</p>}
    {!retrato || !previa ? <p role="status">{P.lendo}</p> : <>
      <label className="mt-3 block" htmlFor={`${idCampos}-categoria`}>Categoria</label>
      <select id={`${idCampos}-categoria`} className={CLASSES_DE_CAMPO} disabled={ocupado} value={filtros.categoria} onChange={(e) => mudarFiltro('categoria', e.target.value)}>
        <option value="">Todas as categorias</option>
        {retrato.categorias.map((c) => <option key={c.id} value={c.id}>{rotuloDaCategoria(c, retrato.categorias)}</option>)}
      </select>
      <label className="mt-3 block" htmlFor={`${idCampos}-marca`}>Marca</label>
      <select id={`${idCampos}-marca`} className={CLASSES_DE_CAMPO} disabled={ocupado} value={filtros.marca} onChange={(e) => mudarFiltro('marca', e.target.value)}>
        <option value="">Todas as marcas</option>
        {[...marcas].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
      </select>
      <label className="mt-3 block" htmlFor={`${idCampos}-classificacao`}>Classificação</label>
      <select id={`${idCampos}-classificacao`} className={CLASSES_DE_CAMPO} disabled={ocupado} value={filtros.classificacao} onChange={(e) => mudarFiltro('classificacao', e.target.value)}>
        <option value="">Todas as classificações</option>
        <option value="feminino">Feminino (inclui unissex)</option><option value="masculino">Masculino (inclui unissex)</option>
        <option value="unissex">Unissex</option><option value="nao-se-aplica">Não se aplica</option><option value="sem-classificacao">Não informado</option>
      </select>
      <p className="font-semibold" role="status">{selecionadas.length} {selecionadas.length === 1 ? 'selecionado' : 'selecionados'} de {previa.linhas.length} {previa.linhas.length === 1 ? 'produto' : 'produtos'}</p>
      {(previa.alterada || pronto && !valido) && <p role="status" className="font-semibold">{P.mudou}</p>}
      {previa.novos > 0 && <Botao tipo="secundario" desabilitado={ocupado} aoTocar={() => { setPrevia({ ...previa, linhas: filtrarDivulgacao(retrato, filtros), novos: 0, alterada: false }); setPronto(undefined) }}>Incluir {previa.novos} {previa.novos === 1 ? 'novo produto disponível' : 'novos produtos disponíveis'}</Botao>}
      {previa.linhas.length === 0 && previa.novos === 0 && <p>{P.vazio}</p>}
      <ul className="list-none space-y-3 p-0" aria-label="Prévia dos produtos">{previa.linhas.map((linha) => <li key={linha.produto.id} data-divulgacao-id={linha.produto.id} className="rounded-xl border border-borda bg-papel p-3">
        <label className="flex min-h-11 items-center gap-3"><input className="h-6 w-6 shrink-0 accent-acento" type="checkbox" disabled={ocupado} checked={!previa.desmarcados.includes(linha.produto.id)} onChange={(e) => { const marcar = e.target.checked; setPrevia({ ...previa, desmarcados: marcar ? previa.desmarcados.filter((id) => id !== linha.produto.id) : [...previa.desmarcados, linha.produto.id] }); setPronto(undefined); setMensagem(undefined) }} /><span className="min-w-0 break-words font-semibold">{linha.produto.nome}</span></label>
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <MiniaturaProduto nome={linha.produto.nome} binario={linha.foto} temFoto={!!linha.produto.fotoId} />
          <div className="min-w-0 flex-1 basis-40 break-words">
            <p className="m-0">{linha.produto.marca || 'Marca não informada'}</p>
            <p className="my-1 [overflow-wrap:anywhere]">{linha.produto.precoVenda === undefined ? 'Preço não informado' : `${emReais(linha.produto.precoVenda)}${linha.produto.precoVenda === 0n ? ' (gratuito)' : ''}`}</p>
            <p className="my-1">Quantidade disponível: {linha.disponivel}</p>
          </div>
        </div>
        <p className="mb-0 text-sm text-suave">Em mãos: {linha.fisico} · A entregar: {linha.prometido}</p>
        {linha.contagensAfetadas && <p className="font-semibold">Contagem precisa de conferência. A quantidade é provisória.</p>}
        {linha.divergenciaFisica && <p className="font-semibold">O estoque precisa de conferência.</p>}
        {(!linha.foto?.length || linha.produto.precoVenda === undefined) && <><p>{!linha.foto?.length ? linha.produto.fotoId ? 'A foto ainda não chegou neste aparelho.' : 'Foto não informada.' : ''} {linha.produto.precoVenda === undefined ? 'Falta informar o preço.' : ''}</p><Botao tipo="secundario" desabilitado={ocupado} aoTocar={() => { setPronto(undefined); setEdicao({ tipo: 'produto', id: linha.produto.id }) }}>Completar dados de {linha.produto.nome}</Botao></>}
      </li>)}</ul>
      <label className="mt-5 block" htmlFor={`${idCampos}-cliente`}>Para qual fichinha?</label>
      <select id={`${idCampos}-cliente`} className={CLASSES_DE_CAMPO} disabled={ocupado} value={clienteId} onChange={(e) => { setClienteId(e.target.value); setPronto(undefined); setMensagem(undefined) }}>
        <option value="">Escolha uma fichinha</option>
        {retrato.clientes.filter((c) => !c.desativadoEm).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.id.localeCompare(b.id)).map((c) => <option key={c.id} value={c.id}>{c.nome}{c.apelido ? ` · ${c.apelido}` : ''}</option>)}
      </select>
      <p>{cliente ? cliente.telefone || P.faltaTelefone : P.faltaCliente}</p>
      {cliente && !temTelefone && <><p>{P.faltaTelefone}</p><Botao tipo="secundario" desabilitado={ocupado} aoTocar={() => { setPronto(undefined); setEdicao({ tipo: 'cliente', id: cliente.id }) }}>Adicionar ou corrigir telefone</Botao></>}
      <p>{P.referencia}</p>
      {faltamDados && <p role="status">{P.faltamDados}</p>}
      <Botao tipo="principal" className="mt-3" desabilitado={ocupado || falhou || !identidadeLida || !identidade || previa.chave !== chave || !selecionadas.length || faltamDados || !temTelefone} aoTocar={() => void preparar()}>{ocupado ? 'Preparando ou compartilhando…' : 'Preparar PDF'}</Botao>
      {valido && pronto && <><p role="status">PDF pronto com {selecionadas.length} produtos. Gerado em {pronto.geradoEm}.</p>{!podeAbrir && <p role="status">{P.semSuporte}</p>}<Botao tipo="principal" desabilitado={ocupado || falhou || !temTelefone || !podeAbrir} aoTocar={compartilhar}>Compartilhar PDF</Botao></>}
      {mensagem && <p role="status" className="font-semibold">{mensagem}</p>}
    </>}
  </main>
}
