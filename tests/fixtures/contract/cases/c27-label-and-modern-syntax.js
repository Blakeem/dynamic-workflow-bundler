export const meta = { name: 'p', description: 'd' }
class A { static #n = 1; static get n() { return A.#n } }
outer: for (const a of [1]) { for (const b of [2]) { continue outer } }
const v = { a: { b: 1 } }?.a?.b ?? 0
const big = 2n ** 64n
async function* gen() { yield 1 }
let total = 0
for await (const n of gen()) total += n
return [A.n, v, typeof big, total, /\p{L}/v.test('a')].join(' ')
