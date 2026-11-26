export const meta = { name: 'r09-immediate-function-read', description: 'Reads a name inside a function called where it is written, before a globalThis write defines it' }
const value = (() => made)()
globalThis.made = 1
return value
