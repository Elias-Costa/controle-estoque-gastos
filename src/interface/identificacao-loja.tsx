import { useId, useState } from 'react'
import { repositorioIdentidadeLoja } from '../dados/instancia.ts'
import type { PreferenciaIdentidadeLoja } from '../dados/identidade-loja.ts'
import { Botao } from './Botao.tsx'
import { Campo, CLASSES_DE_CAMPO } from './Campo.tsx'
import { RecorteLogo } from './recorte-logo.tsx'

/** D-076: editor local; rascunho permanece diante de falha ou edição concorrente. */
export function IdentificacaoLoja({ preferencia, ocupado }: { preferencia: PreferenciaIdentidadeLoja | undefined; ocupado: boolean }) {
  const id = useId()
  const [editando, setEditando] = useState(false)
  const [base, setBase] = useState<PreferenciaIdentidadeLoja>()
  const [nome, setNome] = useState(''), [descricao, setDescricao] = useState(''), [logo, setLogo] = useState<string>()
  const [recorte, setRecorte] = useState<Blob | string>()
  const [salvando, setSalvando] = useState(false), [conflito, setConflito] = useState(false), [erro, setErro] = useState<string>()
  function carregar(valor: PreferenciaIdentidadeLoja | undefined) {
    setBase(valor); setNome(valor?.identidade.nome ?? ''); setDescricao(valor?.identidade.descricao ?? '')
    setLogo(valor?.identidade.logo); setRecorte(undefined); setConflito(false); setErro(undefined); setEditando(true)
  }
  async function salvar() {
    if (salvando || ocupado || recorte || !nome.trim()) return
    setSalvando(true); setErro(undefined)
    try {
      const resultado = await repositorioIdentidadeLoja.salvar({ nome: nome.trim(), descricao: descricao.trim(), ...(logo ? { logo } : {}) }, base)
      if (!resultado.ok) { setBase(resultado.atual); setConflito(true); return }
      setConflito(false); setEditando(false)
    } catch { setErro('Não consegui guardar a identificação. Seus dados continuam aqui. Tente novamente.') }
    finally { setSalvando(false) }
  }
  return <section className="my-4 min-w-0 rounded-xl border border-borda bg-papel p-3" aria-label="Identificação da loja">
    <h2 className="mt-0 text-lg font-semibold">Identificação da loja</h2>
    {!editando ? <>
      {preferencia ? <><p className="break-words">{preferencia.identidade.nome}</p>{preferencia.identidade.descricao && <p className="break-words">{preferencia.identidade.descricao}</p>}
        {preferencia.identidade.logo && <img src={preferencia.identidade.logo} alt="Logo da loja" className="my-3 h-20 w-20 max-w-full rounded-full object-contain" />}</> : <p>Informe o nome da loja ou da sua marca para identificar o PDF.</p>}
      <Botao tipo="secundario" desabilitado={ocupado} aoTocar={() => carregar(preferencia)}>{preferencia ? 'Editar identificação' : 'Identificar loja'}</Botao>
    </> : <fieldset disabled={salvando || ocupado} className="m-0 min-w-0 border-0 p-0">
      <Campo rotulo="Nome da loja ou marca" valor={nome} aoMudar={setNome} />
      <Campo rotulo="Descrição da loja (opcional)" valor={descricao} aoMudar={setDescricao} multilinha />
      {recorte ? <RecorteLogo origem={recorte} aoUsar={(nova) => { setLogo(nova); setRecorte(undefined) }} aoCancelar={() => setRecorte(undefined)} /> : <>
      <label htmlFor={id} className="mt-4 block">Logo da loja (opcional)</label>
      <input id={id} aria-label="Escolher logo" className={`${CLASSES_DE_CAMPO} py-3`} type="file" accept="image/*" onChange={(e) => {
        const arquivo = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (arquivo) { setErro(undefined); setRecorte(arquivo) }
      }} />
      {logo && <><img src={logo} alt="Prévia da logo da loja" className="my-3 h-20 w-20 max-w-full rounded-full object-contain" />
        <Botao tipo="secundario" aoTocar={() => setRecorte(logo)}>Ajustar logo</Botao>
        <Botao tipo="secundario" aoTocar={() => setLogo(undefined)}>Remover logo</Botao></>}
      </>}
      {conflito && !recorte && <><p role="alert">A identificação mudou em outro lugar. Seu texto continua aqui. Confira antes de substituir.</p>
        <Botao tipo="secundario" aoTocar={() => carregar(preferencia)}>Usar a identificação guardada</Botao></>}
      {erro && <p role="alert">{erro}</p>}
      <div className="mt-3 flex flex-wrap gap-3"><Botao tipo="principal" desabilitado={!nome.trim() || !!recorte} aoTocar={() => void salvar()}>{conflito ? 'Salvar a minha identificação' : 'Salvar identificação'}</Botao>
        <Botao tipo="secundario" desabilitado={!!recorte} aoTocar={() => { setEditando(false); setErro(undefined) }}>Cancelar</Botao></div>
    </fieldset>}
  </section>
}
