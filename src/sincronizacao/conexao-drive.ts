import { exigirCopia, objetoCopia } from '../dados/formato-copia.ts'

/** Estado público da conexão; não inclui credencial ou identidade interna do Google. */
export type EstadoConexaoDrive = { readonly preparado: boolean; readonly vinculoId: string | null; readonly email: string | null; readonly conectadoEm: string | null }
/** Chamadas sob comando na tela de cópia, sem bloquear operações locais. */
export function criarConexaoDrive(pedir: (pedido: { acao: 'estado' | 'conectar' }) => Promise<unknown>) {
  return {
    async estado(): Promise<EstadoConexaoDrive> {
      const v = await pedir({ acao: 'estado' })
      exigirCopia(objetoCopia(v) && typeof v['preparado'] === 'boolean' &&
        (v['vinculoId'] === null || typeof v['vinculoId'] === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v['vinculoId'])) &&
        (v['email'] === null || typeof v['email'] === 'string' && v['email'].length <= 320) &&
        ((v['email'] === null) === (v['vinculoId'] === null)) &&
        (v['conectadoEm'] === null || typeof v['conectadoEm'] === 'string' && Number.isFinite(Date.parse(v['conectadoEm']))) &&
        ((v['conectadoEm'] === null) === (v['vinculoId'] === null)))
      return { preparado: v['preparado'], vinculoId: v['vinculoId'], email: v['email'], conectadoEm: v['conectadoEm'] }
    },
    async conectar(): Promise<string> {
      const v = await pedir({ acao: 'conectar' })
      exigirCopia(objetoCopia(v) && typeof v['url'] === 'string')
      const url = new URL(v['url'])
      exigirCopia(url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth' && !url.username && !url.password && !url.hash)
      return url.href
    },
  }
}
