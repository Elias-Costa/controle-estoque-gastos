import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { liveQuery } from 'dexie'
import { banco } from '../dados/instancia.ts'
import { criarRepositorioCopia } from '../dados/repositorio-copia.ts'
import { backupAparelho, conexaoDrive, conta, copia } from '../sincronizacao/instancia.ts'
import type { EstadoConexaoDrive } from '../sincronizacao/conexao-drive.ts'
import { Botao } from './Botao.tsx'

const repo = criarRepositorioCopia(banco)
const data = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Fortaleza' })
const hora = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Fortaleza' })

/** RF-30/D-085: identidade do Drive junto da confirmação do vínculo corrente. */
export function CopiaNoDrive({ aoEntrar }: { readonly aoEntrar: () => void }) {
  const sessao = useSyncExternalStore(conta.assinar, conta.estado)
  const [conexao, mostrar] = useState<EstadoConexaoDrive>()
  const [estado, atualizar] = useState<Awaited<ReturnType<typeof repo.lerEstadoBackup>>>()
  const [aviso, avisar] = useState<string>(), [revisao, reler] = useState(0)
  const [abrindo, abrir] = useState(false), iniciando = useRef(false)
  useEffect(() => {
    const inscricao = liveQuery(repo.lerEstadoBackup).subscribe({ next: atualizar, error: () => atualizar(undefined) })
    return () => inscricao.unsubscribe()
  }, [])
  useEffect(() => {
    let ativa = true
    const conferir = async () => {
      if (!conexaoDrive || sessao !== 'entrou') return
      try {
        const c = await conexaoDrive.estado()
        if (!ativa) return
        if (c.vinculoId) {
          await copia.vinculo()
          if (!await repo.vincularDrive(c.vinculoId, c.conectadoEm ?? '') ||
            !await repo.guardarConexaoDrive({ vinculoId: c.vinculoId, conectadoEm: c.conectadoEm ?? '', email: c.email ?? '' })) return
        }
        if (!ativa) return
        mostrar(c); avisar(undefined)
        void backupAparelho?.acordar()
      } catch { if (ativa) avisar('Não deu para conferir a conta do Drive. Com internet, toque em Conferir conexão para tentar novamente.') }
    }
    void conferir()
    window.addEventListener('focus', conferir)
    window.addEventListener('online', conferir)
    return () => { ativa = false; window.removeEventListener('focus', conferir); window.removeEventListener('online', conferir) }
  }, [sessao, revisao])
  async function conectar() {
    if (!conexaoDrive || iniciando.current) return
    iniciando.current = true; abrir(true); avisar(undefined)
    try { window.location.assign(await conexaoDrive.conectar()) }
    catch { avisar('Não deu para abrir o Google. Confira a internet e tente novamente.'); iniciando.current = false; abrir(false) }
  }
  const conhecida = conexao ?? (estado?.conexaoDrive && { preparado: true, ...estado.conexaoDrive })
  const corrente = conhecida?.vinculoId && conhecida.vinculoId === estado?.vinculoId
  const ultima = corrente ? estado.ultima : undefined
  const instante = ultima ? new Date(ultima.capturadoEm) : null
  return <section aria-label="Cópia no Drive" className="my-6 space-y-3 rounded-xl border border-borda bg-papel p-4">
    <h2 className="text-xl">Cópia no Drive</h2>
    {sessao !== 'entrou' ? <>
      <p>Entre na sua conta para conectar e conferir seu Google Drive.</p>
      {sessao !== 'sem-nuvem' && <Botao tipo="secundario" aoTocar={aoEntrar}>Entrar na sua conta</Botao>}
    </> : <>
      {conhecida?.email ? <p className="break-words">{conexao ? 'Google Drive conectado:' : 'Última conta do Drive conferida neste aparelho:'} <strong>{conhecida.email}</strong></p>
        : conhecida?.preparado ? <p>Escolha sua conta no Google para guardar as próximas cópias no seu Drive. As cópias anteriores ficam preservadas onde foram feitas.</p>
          : conhecida ? <p>A conexão com o Google Drive ainda precisa ser preparada. Peça ajuda ao responsável pelo aplicativo.</p> : !aviso && <p role="status">Conferindo a conta do Drive…</p>}
      {conhecida?.preparado && <Botao tipo="secundario" aoTocar={() => { void conectar() }} desabilitado={abrindo}>{abrindo ? 'Abrindo o Google…' : 'Conectar Google Drive'}</Botao>}
      {aviso && <><p role="alert">{aviso}</p><Botao tipo="secundario" aoTocar={() => reler((n) => n + 1)}>Conferir conexão</Botao></>}
    </>}
    {sessao === 'entrou' && conhecida?.vinculoId && <div role="status" className="space-y-2">
      {ultima && instante ? <>
        <p>Última cópia confirmada <time className="block" dateTime={ultima.capturadoEm}>{data.format(instante)} às {hora.format(instante)}</time></p>
        <p>{ultima.origem === 'servidor' ? 'Feita com as anotações já enviadas à sua conta.' : 'Feita a partir das anotações de um aparelho.'}</p>
      </> : <p>Ainda não há confirmação de uma cópia neste Google Drive.</p>}
      {corrente && estado.tentativa && <p>{estado.tentativa.falhou ? 'Não deu para terminar a cópia do aparelho. O app vai tentar de novo quando estiver aberto e com internet.' : 'A cópia do aparelho está pendente. O app continua a tentativa quando estiver aberto e com internet.'}</p>}
    </div>}
    <p className="text-suave">As anotações mais recentes podem ficar só no aparelho até a próxima cópia.</p>
  </section>
}
