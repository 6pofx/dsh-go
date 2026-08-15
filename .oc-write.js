// Writes argv[2] JSON to .oc-probe2.json — used to observe dynamic plugin ctx.
'use strict'
const fs = require('fs')
fs.writeFileSync('G:\\dsh-go\\.oc-probe2.json', process.argv[2] || '{}')
