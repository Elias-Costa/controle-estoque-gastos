/** Empacota o servidor para Deno, preservando a API nativa de SHA-256 do runtime. */
const resultado = await Bun.build({ entrypoints: ['nuvem/backup/entrada-edge.js'], outdir: 'dist/backup',
  naming: 'index.js', target: 'node', minify: false })
if (!resultado.success) throw new Error('Falha ao empacotar o serviço de backup')
console.log('Serviço preparado em dist/backup/index.js; nenhum segredo incluído.')
