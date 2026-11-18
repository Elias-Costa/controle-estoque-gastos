import { describe, expect, test } from 'bun:test'
import { criarDriveBackup, FalhaDrive } from '../nuvem/backup/drive.ts'
import { criarHandlerBackup } from '../nuvem/backup/emissor.ts'
import { criarTransporteBackup, FalhaTransporteBackup } from '../nuvem/backup/transporte.ts'
import { hashDaFoto } from '../src/plataforma/fotos.ts'
import { autorizacaoGoogleFicticia } from './fixtures/backup-google.ts'

const conta = autorizacaoGoogleFicticia.contaId, destino = autorizacaoGoogleFicticia.destino, google = autorizacaoGoogleFicticia.contaGoogleId
const captura = { id: '019a4b25-0000-7000-8000-000000000002', capturadoEm: '2026-11-05T14:00:00.000Z', dia: '2026-11-05', vinculo: { contaId: conta, destino } }
const URI = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=capacidade-apenas-ficticia'
const metadata = () => ({ id: 'arquivo', mimeType: 'application/zip', parents: ['pasta'], ownedByMe: true, shared: false, trashed: false,
  size: '524288', sha256Checksum: 'a'.repeat(64), appProperties: { fichinhas: 'backup-v1', destino, conta, captura: captura.id },
  permissions: [{ id: google, type: 'user', role: 'owner' }] })

test('transporte do Edge aceita PostgREST 204 só nas mutações void do backup', async () => {
  const { rpc } = criarTransporteBackup('http://127.0.0.1:54321', 'chave-ficticia', async () => new Response(null, { status: 204 }))
  expect(await rpc('registrar_upload_backup', {})).toBeNull()
  expect(await rpc('confirmar_backup', {})).toBeNull()
  await expect(rpc('ler_captura_backup', {})).rejects.toThrow(new FalhaTransporteBackup(204).message)
})

describe('BA-02 protocolo Drive controlado — não prova Google real', () => {
  test('não substitui/remove arquivo de outra conta, compartilhado, movido ou alheio ao catálogo', async () => {
    for (const extra of [{ ownedByMe: false }, { shared: true }, { parents: ['outra-pasta'] }, { appProperties: { fichinhas: 'outro' } },
      { permissions: [{ id: google, type: 'user', role: 'owner' }, { id: 'outro', type: 'anyone', role: 'reader' }] }]) {
      const metodos: string[] = []
      const drive = criarDriveBackup('acesso-ficticio', google, destino, conta, async (_u, o) => { metodos.push(o.method ?? 'GET'); return Response.json({ ...metadata(), ...extra }) })
      await expect(drive.remover('arquivo', 'pasta', captura.id)).rejects.toThrow()
      expect(metodos).toEqual(['GET'])
    }
  })
  test('início preserva id prealocado; offset vem do Range e bloco respeita limites do protocolo', async () => {
    const ranges: string[] = [], metodos: string[] = []
    const drive = criarDriveBackup('acesso-ficticio', google, destino, conta, async (url, o) => {
      expect(url).not.toContain('acesso-ficticio'); expect(new Headers(o.headers).get('authorization')).toBe('Bearer acesso-ficticio')
      expect(o.redirect).toBe(o.method === 'PUT' ? 'manual' : 'error')
      metodos.push(o.method ?? 'GET')
      if (o.method === 'POST') {
        expect(JSON.parse(String(o.body)).id).toBe('arquivo')
        return new Response(null, { status: 200, headers: { location: URI } })
      }
      if (o.method === 'PUT') {
        const range = new Headers(o.headers).get('content-range') ?? ''; ranges.push(range)
        return range.startsWith('bytes 262144-') ? new Response(null, { status: 200 }) : new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } })
      }
      return new Response(null, { status: 404 })
    })
    const uri = await drive.iniciarSessao('arquivo', 'pasta', captura, 524288)
    expect(uri).toBe(URI); expect(await drive.consultarPosicao(uri, 524288)).toBe(262144)
    expect(await drive.enviarBloco(uri, new Blob([new Uint8Array(524288)]), 262144, 262144)).toBe(524288)
    expect(ranges).toEqual(['bytes */524288', 'bytes 262144-524287/524288'])
    expect(metodos.filter((m) => m === 'POST')).toHaveLength(1)
  })
  test('fetch real lê 308 de retomada e não segue 308 com Location', async () => {
    let visitouOutro = false
    const http = Bun.serve({ hostname: '127.0.0.1', port: 0, development: false, fetch(req) {
      const caminho = new URL(req.url).pathname
      if (caminho === '/outro') { visitouOutro = true; return new Response(null) }
      return new Response(null, { status: 308, headers: { range: 'bytes=0-262143', ...(caminho === '/desvio' ? { location: '/outro' } : {}) } })
    } })
    try {
      const drive = (rota: string) => criarDriveBackup('acesso-ficticio', google, destino, conta, (_u, o) => fetch(`http://127.0.0.1:${http.port}${rota}`, o))
      expect(await drive('/retomada').consultarPosicao(URI, 524288)).toBe(262144)
      await expect(drive('/desvio').consultarPosicao(URI, 524288)).rejects.toThrow(new FalhaDrive(308).message)
      expect(visitouOutro).toBe(false)
    } finally { await http.stop(true) }
  })
  test('sessão expirada é retomável; resposta perdida nunca reflete capacidade privada', async () => {
    const drive = criarDriveBackup('acesso-ficticio', google, destino, conta, async (_u, o) => {
      if (new Headers(o.headers).get('content-range')?.startsWith('bytes */')) return new Response(null, { status: 410 })
      throw new Error(URI + ' segredo')
    })
    expect(await drive.consultarPosicao(URI, 524288)).toBeNull()
    await expect(drive.enviarBloco(URI, new Blob([new Uint8Array(524288)]), 0, 262144)).rejects.toThrow(new FalhaDrive(0).message)
    await expect(drive.consultarPosicao('https://fraude.example/?upload_id=x', 1)).rejects.toThrow()
  })
  test('resposta perdida após commit é resolvida consultando o mesmo id, sem novo POST', async () => {
    const metodos: string[] = []
    const drive = criarDriveBackup('acesso-ficticio', google, destino, conta, async (_u, o) => { metodos.push(o.method ?? 'GET'); return Response.json(metadata()) })
    expect((await drive.consultar('arquivo', 'pasta', captura.id))?.sha256).toBe('a'.repeat(64))
    expect(metodos).toEqual(['GET'])
  })
  test('remoção é limitada à candidata liberada e exige confirmar ausência após o DELETE', async () => {
    let apagado = false
    const drive = criarDriveBackup('acesso-ficticio', google, destino, conta, async (_u, o) => {
      if (o.method === 'DELETE') { apagado = true; return new Response(null, { status: 204 }) }
      return apagado ? new Response(null, { status: 404 }) : Response.json(metadata())
    })
    await drive.remover('arquivo', 'pasta', captura.id); expect(apagado).toBe(true)
  })
  test('handler recusa token/corpo e nunca aceita conta ou horário escolhidos no pedido', async () => {
    const token = 'a'.repeat(64), hashToken = await hashDaFoto(new TextEncoder().encode(token)); let chamadas = 0
    const handler = criarHandlerBackup({ hashToken, destino, agora: () => captura.capturadoEm, baixarOriginal: async () => new Uint8Array(),
      rpc: async () => { chamadas++; return autorizacaoGoogleFicticia } })
    const req = (body: string, autorizacao = '') => new Request('https://teste.example', { method: 'POST', headers: { authorization: autorizacao }, body })
    expect((await handler(req('{}'))).status).toBe(401); expect(chamadas).toBe(0)
    expect((await handler(req('{"conta":"outra"}', 'Bearer ' + token))).status).toBe(400); expect(chamadas).toBe(0)
    const r = await handler(req('{"verificar":true}', 'Bearer ' + token))
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ pronto: true, alcance: 'configuracao_e_banco', arquivosEnviados: 0, segredosImpressos: false })
    expect(chamadas).toBe(1)
  })
})
