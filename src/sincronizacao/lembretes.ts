import type { RepositorioLembretes } from '../dados/repositorio-lembretes.ts'
import type { PedidoInscricaoLembretes } from '../dados/tipos-lembretes.ts'
import type { VinculoConta } from '../dados/tipos-copia.ts'
import type { PortaPush } from '../plataforma/push.ts'

/** Canal próprio, sem token ou chave privada no documento; a conta vem da sessão real. */
export interface NuvemLembretes {
  identidade(): Promise<VinculoConta | null>
  chavePublica(): Promise<string | null>
  registrar(pedido: PedidoInscricaoLembretes): Promise<unknown>
}
function resposta(v: unknown): { revisao: number; estado: 'ativa' | 'desligada' | 'invalida' | 'conflito' } {
  if (typeof v !== 'object' || v === null || !('revisao' in v) || typeof v.revisao !== 'number' ||
    !Number.isSafeInteger(v.revisao) || v.revisao < 0 || !('estado' in v) ||
    (v.estado !== 'ativa' && v.estado !== 'desligada' && v.estado !== 'invalida' && v.estado !== 'conflito')) throw new Error('Resposta inválida')
  return { revisao: v.revisao, estado: v.estado }
}

/** Ativação contextual e retentativa independentes da escrita financeira (D-079, EL-06). */
export function criarServicoLembretes(repo: RepositorioLembretes, push: PortaPush, nuvem: NuvemLembretes | null) {
  let trabalhando: Promise<void> | null = null
  let versao = 0
  let erro: 'rede' | 'negada' | 'indisponivel' | null = null
  const ouvintes = new Set<() => void>()
  function avisar() { versao++; for (const fn of ouvintes) fn() }
  async function executar(conferir: boolean) {
    if (!nuvem) return
    try {
      const local = await repo.configuracao()
      if (!local) return
      const identidade = await nuvem.identidade()
      if (!identidade || identidade.contaId !== local.contaId || identidade.destino !== local.destino) return
      if (local.ativa && local.estado === 'solicitada' && push.permitida()) {
        const chave = await nuvem.chavePublica()
        if (!chave) { erro = 'indisponivel'; return }
        await repo.completar(local.revisao, await push.inscrever(chave))
      } else if (conferir && local.ativa && local.inscricao) {
        const real = await push.atual()
        if (!real) await repo.desligar()
        else if (real.endpoint !== local.inscricao.endpoint || real.auth !== local.inscricao.auth || real.p256dh !== local.inscricao.p256dh) {
          const nova = await repo.solicitar(); await repo.completar(nova.revisao, real)
        }
      }
      for (let i = 0; i < 2; i++) {
        const envio = await repo.capturar(conferir && i === 0)
        if (!envio) break
        const r = resposta(await nuvem.registrar(envio.pedido))
        const estado = r.estado === 'conflito' ? (r.revisao < envio.local.revisao ? 'pendente' : 'problema') : r.estado
        await repo.responder(envio.local, r.revisao, estado)
        if (estado !== 'pendente') break
      }
      if (erro !== 'negada') erro = null
    } catch { erro = 'rede' }
    finally { avisar() }
  }
  function acordar(conferir = false): Promise<void> {
    if (!trabalhando) trabalhando = executar(conferir).finally(() => { trabalhando = null })
    return trabalhando
  }
  async function ativar(): Promise<void> {
    if (!nuvem || !push.disponivel()) { erro = 'indisponivel'; avisar(); return }
    // Iniciar os dois no gesto, antes do primeiro await, conserva a permissão contextual.
    erro = null
    const gravacao = repo.solicitar(), permissao = push.pedirPermissao().catch(() => false)
    try {
      await gravacao
      if (!await permissao) { await repo.desligar(); erro = 'negada'; avisar(); void acordar(); return }
      await acordar()
    } catch { erro = 'rede'; avisar() }
  }
  async function desligar(): Promise<void> {
    await repo.desligar(); erro = null; avisar()
    // Desligar a intenção local conclui antes de qualquer chamada externa.
    void push.desligar().catch(() => undefined)
    void acordar()
  }
  return { acordar, ativar, desligar, disponivel: () => nuvem !== null && push.disponivel(), erro: () => erro,
    versao: () => versao, assinar(fn: () => void) { ouvintes.add(fn); return () => { ouvintes.delete(fn) } } }
}
