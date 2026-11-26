export const meta = { name: 'r10-immediate-function-read-after-write', description: 'Reads a name inside a function called where it is written, after a globalThis write defines it' }
globalThis.made = 1
const value = (() => made)()
const constructed = new (function () { this.value = made })()
return [value, constructed.value]
