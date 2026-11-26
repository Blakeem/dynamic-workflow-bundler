export const meta = { name: 'p', description: 'd' }
const circular = {}
circular.self = circular
return { f: () => 1, big: 1n, d: new Date(0), m: new Map([[1, 2]]), u: undefined, s: Symbol('x'), nan: NaN, circular }
