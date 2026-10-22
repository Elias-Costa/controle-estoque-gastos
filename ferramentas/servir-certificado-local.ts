import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'

// D-062: o primeiro acesso só entrega o certificado público, nunca um diretório de chaves.
const [, , caminho, endereco] = process.argv
if (!caminho || !endereco || isIP(endereco) !== 4 || endereco === '0.0.0.0') {
  throw new Error('Use: bun --no-env-file run ferramentas/servir-certificado-local.ts <rootCA.pem> <IPv4 do Wi-Fi>.')
}
const pem = await Bun.file(caminho).text()
if (pem.includes('PRIVATE KEY')) throw new Error('O arquivo contém chave privada. Não pode ser compartilhado.')
const certificado = new X509Certificate(pem)
if (!certificado.ca) throw new Error('Informe o certificado público da autoridade local, não o certificado do servidor.')

const servidor = Bun.serve({
  hostname: endereco,
  port: 4176,
  fetch(requisicao) {
    if (!['GET', 'HEAD'].includes(requisicao.method) || new URL(requisicao.url).pathname !== '/fichinhas-teste.crt') {
      return new Response('Não encontrado.', { status: 404 })
    }
    return new Response(requisicao.method === 'HEAD' ? null : new Uint8Array(certificado.raw), {
      headers: {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="fichinhas-teste.crt"',
        'Cache-Control': 'no-store',
      },
    })
  },
})

console.log(`Baixe no Android: http://${endereco}:${servidor.port}/fichinhas-teste.crt`)
console.log(`Impressão SHA-256 do certificado: ${certificado.fingerprint256}`)
console.log('Somente o certificado público é servido. Ctrl+C encerra este download local.')
