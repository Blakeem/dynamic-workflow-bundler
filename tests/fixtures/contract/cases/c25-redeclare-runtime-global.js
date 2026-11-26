export const meta = { name: 'p', description: 'd' }
const agent = 1
let log = 2
function phase() { return 3 }
return [typeof agent, typeof log, phase()].join(' ')
