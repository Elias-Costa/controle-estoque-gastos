/** Empacota somente o servidor; OAuth/credenciais vêm do Vault/ambiente do Edge em execução. */
const resultado = await Bun.build({ entrypoints: ['nuvem/backup/entrada-edge.js'], outdir: 'dist/backup',
  naming: 'index.js', target: 'browser', minify: false })
if (!resultado.success) throw new Error('Falha ao empacotar o serviço de backup')
console.log('Serviço preparado em dist/backup/index.js; nenhum segredo incluído.')
