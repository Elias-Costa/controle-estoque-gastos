import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { operacoesEstoque, repositorioEstoque, repositorioFotos } from '../dados/instancia.ts'
import type { CatalogoProdutos } from '../dados/repositorio-estoque.ts'
import type { FotoPreparada } from '../dados/tipos-fotos.ts'
import { emReais } from '../dominio/dinheiro.ts'
import { categoriasComMesmoNome } from '../dominio/produtos.ts'
import { prepararFoto } from '../plataforma/fotos.ts'
import { Botao } from './Botao.tsx'
import { Campo, CLASSES_DE_CAMPO, Rotulo } from './Campo.tsx'
import { CampoDeDinheiro } from './CampoDeDinheiro.tsx'
import { IndicadorDeEnvio } from './IndicadorDeEnvio.tsx'
import { lerProdutos, rotuloDaCategoria, type LinhaProduto } from './leitura-de-produtos.ts'
import { MiniaturaProduto } from './miniatura-produto.tsx'
import { fraseDaGuardaDoProduto, PALAVRAS_DOS_PRODUTOS as P } from './palavras-dos-produtos.ts'
import { PALAVRAS_DO_ESTOQUE } from './palavras-do-estoque.ts'
import { conferirProduto, produtosParecidos, rascunhoDoProduto, type RascunhoDoProduto } from './rascunho-do-produto.ts'
import { Topo } from './Topo.tsx'
import { useLeitura } from './useLeitura.ts'

/** Cadastro/edição lê a base antes de abrir o formulário; nenhuma leitura aguarda rede. */
export function TelaProduto({ produtoId, aoVoltar, aoSalvar, aoEstoque }: { produtoId?: string; aoVoltar: () => void; aoSalvar: () => void; aoEstoque: () => void }) {
  const leitura = useLeitura(async () => {
    const catalogo = await repositorioEstoque.lerCatalogo()
    const linhas = lerProdutos(catalogo)
    if (produtoId && !linhas.some((linha) => linha.produto.id === produtoId)) throw new Error('Produto não encontrado')
    return { catalogo, linhas }
  }, `produto-${produtoId ?? 'novo'}`)
  return leitura.estado === 'lido'
    ? <FormularioProduto catalogo={leitura.valor.catalogo} linhas={leitura.valor.linhas} produtoId={produtoId} aoVoltar={aoVoltar} aoSalvar={aoSalvar} aoEstoque={aoEstoque} />
    : <main className="tela"><Topo titulo={produtoId ? P.editar : P.cadastro} aoVoltar={aoVoltar} /><p role="status">{leitura.estado === 'lendo' ? P.lendo : P.falhaLeitura}</p></main>
}

function FormularioProduto({ catalogo, linhas, produtoId, aoVoltar, aoSalvar, aoEstoque }: {
  catalogo: CatalogoProdutos; linhas: readonly LinhaProduto[]; produtoId?: string; aoVoltar: () => void; aoSalvar: () => void; aoEstoque: () => void
}) {
  const linha = linhas.find((item) => item.produto.id === produtoId)
  // Uma releitura após sincronização atualiza avisos/custo sem apagar o que ela está digitando.
  const [original] = useState(linha?.produto)
  const [miniaturaInicial] = useState(linha?.miniatura)
  const [rascunho, setRascunho] = useState(() => rascunhoDoProduto(original))
  const [categoriasLocais, setCategoriasLocais] = useState(catalogo.categorias)
  const [nomeCategoria, setNomeCategoria] = useState<string | null>(null)
  const [foto, setFoto] = useState<FotoPreparada>()
  const [preparando, setPreparando] = useState(false)
  const [gravando, setGravando] = useState(false)
  const [criandoCategoria, setCriandoCategoria] = useState(false)
  const [fotoRetida, setFotoRetida] = useState(!original?.fotoId)
  const [falhaRetencao, setFalhaRetencao] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [erroFoto, setErroFoto] = useState<string | null>(null)
  const trava = useRef(false)
  const montado = useRef(true)
  const camera = useRef<HTMLInputElement>(null), arquivo = useRef<HTMLInputElement>(null)
  const categoriaCampo = useId(), minimoCampo = useId()
  const categorias = [...new Map([...categoriasLocais, ...catalogo.categorias].map((item) => [item.id, item])).values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR') || a.id.localeCompare(b.id))
  const custoDaCompra = linha?.custoDaCompra ?? false
  const miniaturaOriginal = linha?.produto.fotoId === original?.fotoId ? linha?.miniatura : miniaturaInicial
  const base = original && custoDaCompra ? { ...original, custoManual: linha?.produto.custoManual } : original
  const conferencia = conferirProduto(rascunho, categorias, base, custoDaCompra)
  const parecidos = produtosParecidos({ ...rascunho, id: original?.id }, catalogo.produtos)
  const ocupado = gravando || criandoCategoria || preparando

  useEffect(() => {
    montado.current = true
    return () => { montado.current = false }
  }, [])

  useEffect(() => {
    const fotoId = original?.fotoId
    if (!fotoId) return
    let ativo = true
    // Q41A: reter antes de permitir salvar uma referência mantida fora do banco.
    const uso = repositorioFotos.reterReferencia(fotoId)
    void uso.then(() => { if (ativo) setFotoRetida(true) }, () => { if (ativo) setFalhaRetencao(true) })
    return () => {
      ativo = false
      // Falha conserva a proteção durável; não fingir que foi liberada (D-025).
      void uso.then((id) => repositorioFotos.liberarUso(id)).catch(() => undefined)
    }
  }, [original?.fotoId])

  function mudar(mudanca: Partial<RascunhoDoProduto>): void { setRascunho((atual) => ({ ...atual, ...mudanca })); setErro(null) }

  async function selecionarFoto(evento: ChangeEvent<HTMLInputElement>): Promise<void> {
    const selecionada = evento.currentTarget.files?.[0]
    evento.currentTarget.value = ''
    if (!selecionada || trava.current) return
    trava.current = true; setPreparando(true); setErroFoto(null)
    try {
      const preparada = await prepararFoto(selecionada)
      if (montado.current) setFoto(preparada)
    } catch { if (montado.current) setErroFoto(P.falhaFoto) }
    finally { trava.current = false; if (montado.current) setPreparando(false) }
  }

  async function criarCategoria(): Promise<void> {
    if (!nomeCategoria?.trim() || trava.current) return
    trava.current = true; setCriandoCategoria(true); setErro(null)
    try {
      const resultado = await operacoesEstoque.cadastrarCategoria(nomeCategoria)
      if (!resultado.ok) { setErro(P.falhaGravacao); return }
      setCategoriasLocais(await repositorioEstoque.listarCategorias())
      mudar({ categoriaId: resultado.valor.id }); setNomeCategoria(null)
    } catch { setErro(P.falhaGravacao) }
    finally { trava.current = false; setCriandoCategoria(false) }
  }

  async function salvar(): Promise<void> {
    if (!conferencia.ok || !fotoRetida || trava.current) return
    trava.current = true; setGravando(true); setErro(null)
    try {
      const { id: _id, ...entrada } = conferencia.valor
      const resultado = original
        ? await operacoesEstoque.alterarProduto(conferencia.valor, foto)
        : await operacoesEstoque.cadastrarProduto(entrada, foto)
      if (!resultado.ok) { setErro(fraseDaGuardaDoProduto(resultado.motivo)); return }
      aoSalvar()
    } catch { setErro(P.falhaGravacao) }
    finally { trava.current = false; if (montado.current) setGravando(false) }
  }

  return <main className="tela">
    <Topo titulo={original ? P.editar : P.cadastro} aoVoltar={() => { if (!trava.current) aoVoltar() }} />
    <IndicadorDeEnvio />
    {original && <Botao tipo="secundario" className="mt-3" desabilitado={ocupado} aoTocar={aoEstoque}>{PALAVRAS_DO_ESTOQUE.ver}</Botao>}
    <p className="text-sm text-suave">{P.opcionais}</p>
    <fieldset className="min-w-0 border-0 p-0" disabled={ocupado}>
      <Campo rotulo={P.nome} valor={rascunho.nome} aoMudar={(nome) => mudar({ nome })} />
      <Rotulo para={categoriaCampo}>{P.categoria}</Rotulo>
      <select id={categoriaCampo} className={CLASSES_DE_CAMPO} value={rascunho.categoriaId} onChange={(evento) => mudar({ categoriaId: evento.target.value })}>
        <option value="">{P.escolherCategoria}</option>
        {categorias.map((categoria) => <option key={categoria.id} value={categoria.id}>{rotuloDaCategoria(categoria, categorias)}</option>)}
      </select>
      {nomeCategoria === null ? <Botao tipo="secundario" className="mt-2" aoTocar={() => setNomeCategoria('')}>{P.novaCategoria}</Botao> : <section>
        <Campo rotulo={P.nomeCategoria} valor={nomeCategoria} aoMudar={setNomeCategoria} />
        <Botao tipo="secundario" className="mt-2" desabilitado={!nomeCategoria.trim()} aoTocar={() => void criarCategoria()}>{criandoCategoria ? P.criandoCategoria : P.criarCategoria}</Botao>
        <Botao tipo="secundario" className="mt-2" aoTocar={() => setNomeCategoria(null)}>{P.fecharCategoria}</Botao>
      </section>}
      {categorias.some((categoria) => categoriasComMesmoNome(categoria, categorias).length > 0) && <p role="status" className="rounded-xl border border-borda p-3">{P.categoriasIguais}</p>}
      <div className="mt-5 flex items-center gap-3">
        <MiniaturaProduto binario={foto?.miniatura ?? miniaturaOriginal} nome={rascunho.nome || P.cadastro} temFoto={!!foto || !!original?.fotoId} />
        <div className="min-w-0 flex-1">
          <Botao tipo="secundario" aoTocar={() => camera.current?.click()}>{P.tirarFoto}</Botao>
          <Botao tipo="secundario" className="mt-2" aoTocar={() => arquivo.current?.click()}>{P.escolherFoto}</Botao>
        </div>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label={P.tirarFoto} onChange={(evento) => void selecionarFoto(evento)} />
      <input ref={arquivo} type="file" accept="image/*" hidden aria-label={P.escolherFoto} onChange={(evento) => void selecionarFoto(evento)} />
      {preparando && <p role="status">{P.preparando}</p>}
      {erroFoto && <p role="alert" className="text-atraso">{erroFoto}</p>}
      <Campo rotulo={P.marca} valor={rascunho.marca} aoMudar={(marca) => mudar({ marca })} />
      <Campo rotulo={P.codigo} valor={rascunho.codigoCatalogo} aoMudar={(codigoCatalogo) => mudar({ codigoCatalogo })} />
      {custoDaCompra ? <section className="mt-5 rounded-xl border border-borda bg-papel p-3" aria-label={P.custoCompra}>
        <p className="m-0">{P.custoCompra}: <strong>{linha?.custo === undefined ? P.desconhecido : emReais(linha.custo)}</strong></p>
        <p className="mb-0 text-sm text-suave">{P.corrigirCompra}</p>
      </section> : <CampoDeDinheiro rotulo={P.custo} texto={rascunho.custoTexto} aoMudar={(custoTexto) => mudar({ custoTexto })} permitirZero />}
      <CampoDeDinheiro rotulo={P.preco} texto={rascunho.precoTexto} aoMudar={(precoTexto) => mudar({ precoTexto })} permitirZero />
      {conferencia.ok && conferencia.valor.precoVenda === 0n && <p className="text-suave">{P.zero}</p>}
      <Rotulo para={minimoCampo}>{P.minimo}</Rotulo>
      <input id={minimoCampo} className={CLASSES_DE_CAMPO} type="text" inputMode="numeric" autoComplete="off" value={rascunho.minimoTexto} onChange={(evento) => mudar({ minimoTexto: evento.target.value })} />
    </fieldset>
    {parecidos.length > 0 && <section aria-label={P.parecido} className="mt-5 rounded-xl border border-borda bg-papel p-3">
      <p role="status" className="mt-0 font-semibold">{P.parecido}</p>
      {parecidos.map((produto) => <div key={produto.id} className="mt-3 flex items-center gap-3">
        <MiniaturaProduto binario={linhas.find((item) => item.produto.id === produto.id)?.miniatura} nome={produto.nome} temFoto={!!produto.fotoId} />
        <p className="min-w-0 break-words">{produto.nome}<span className="block text-sm text-suave">{[produto.marca, produto.codigoCatalogo].filter(Boolean).join(' · ')}</span></p>
      </div>)}
    </section>}
    {!conferencia.ok && <p role="status" className="font-semibold text-atraso">{fraseDaGuardaDoProduto(conferencia.motivo)}</p>}
    {!fotoRetida && <p role="status" className="font-semibold text-atraso">{falhaRetencao ? P.fotoProtegida : P.abrindoFoto}</p>}
    {erro && <p role="alert" className="font-semibold text-atraso">{erro}</p>}
    <div className="rodape-acao"><Botao tipo="principal" aoTocar={() => void salvar()} desabilitado={!conferencia.ok || ocupado || !fotoRetida}>{gravando ? P.salvando : P.salvar}</Botao></div>
  </main>
}
