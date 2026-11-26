export const meta = { name: 'r08-inherited-global-names', description: 'Reads each name the global object inherits from Object.prototype' }
const inherited = [toString, hasOwnProperty, valueOf, constructor, isPrototypeOf, propertyIsEnumerable, toLocaleString, __defineGetter__, __defineSetter__, __lookupGetter__, __lookupSetter__]
const proto = __proto__
return inherited.map((value) => typeof value).join(' ') + ' ' + typeof proto + ' ' + (proto === Object.prototype) + ' ' + (constructor === Object)
