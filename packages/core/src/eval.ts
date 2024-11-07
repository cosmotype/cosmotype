import { defineProperty, filterKeys, isNullable, mapValues } from 'cosmokit'
import { AtomicTypes, Comparable, Flatten, isComparable, isEmpty, makeRegExp, Row, Values } from './utils.ts'
import { Type } from './type.ts'
import { Field, Relation } from './model.ts'
import { Query } from './query.ts'

export function isEvalExpr(value: any): value is Eval.Expr {
  return value && Object.keys(value).some(key => key.startsWith('$'))
}

export const isUpdateExpr: (value: any) => boolean = isEvalExpr

export function isAggrExpr(expr: Eval.Expr): boolean {
  return expr['$'] || expr['$select']
}

export function hasSubquery(value: any): boolean {
  if (!isEvalExpr(value)) return false
  return Object.entries(value).filter(([k]) => k.startsWith('$')).some(([k, v]) => {
    if (isNullable(v) || isComparable(v)) return false
    if (k === '$exec') return true
    if (isEvalExpr(v)) return hasSubquery(v)
    if (Array.isArray(v)) return v.some(x => hasSubquery(x))
    if (typeof v === 'object') return Object.values(v).some(x => hasSubquery(x))
    return false
  })
}

type UnevalObject<S> = {
  [K in keyof S]?: (undefined extends S[K] ? null : never) | Uneval<Exclude<S[K], undefined>, boolean>
}

export type Uneval<U, A extends boolean> =
  | U extends Values<AtomicTypes> ? Eval.Term<U, A>
  : U extends (infer T extends object)[] ? Relation.Modifier<T> | Eval.Array<T, A>
  : U extends object ? Eval.Expr<U, A> | UnevalObject<Flatten<U>> | Relation.Modifier<U>
  : any

export type Eval<U> =
  | U extends Values<AtomicTypes> ? U
  : U extends Eval.Expr<infer T> ? T
  : never

const kExpr = Symbol('expr')
const kType = Symbol('type')
const kAggr = Symbol('aggr')

export namespace Eval {
  export interface Expr<T = any, A extends boolean = boolean> {
    [kExpr]: true
    [kType]?: T
    [kAggr]?: A
    [Type.kType]?: Type<T>
  }

  export type Any<A extends boolean = boolean> = Comparable | Expr<any, A>

  export type Term<T, A extends boolean = boolean> = T | Expr<T, A>
  export type Array<T, A extends boolean = boolean> = Term<T, A>[] | Expr<T[], A>

  export type Unary<S, R> = <T extends S, A extends boolean>(x: Term<T, A>) => Expr<R, A>
  export type Binary<S, R> = <T extends S, A extends boolean>(x: Term<T, A>, y: Term<T, A>) => Expr<R, A>
  export type Multi<S, R> = <T extends S, A extends boolean>(...args: Term<T, A>[]) => Expr<R, A>

  export interface Aggr<S> {
    <T extends S>(value: Term<T, false>): Expr<T, true>
    <T extends S, A extends boolean>(value: Array<T, A>): Expr<T, A>
  }

  export interface Branch<T, A extends boolean> {
    case: Term<boolean, A>
    then: Term<T, A>
  }

  export interface Static {
    <A extends boolean>(key: string, value: any, type: Type): Eval.Expr<any, A>

    ignoreNull<T, A extends boolean>(value: Eval.Expr<T, A>): Eval.Expr<T, A>
    select(...args: Any[]): Expr<any[], false>
    query<T extends object>(row: Row<T>, query: Query.Expr<T>, expr?: Term<boolean>): Expr<boolean, false>

    // univeral
    if<T extends Comparable, A extends boolean>(cond: Any<A>, vThen: Term<T, A>, vElse: Term<T, A>): Expr<T, A>
    ifNull<T extends Comparable, A extends boolean>(...args: Term<T, A>[]): Expr<T, A>
    switch<T, A extends boolean>(branches: Branch<T, A>[], vDefault: Term<T, A>): Expr<T, A>

    // arithmetic
    add: Multi<number, number>
    mul: Multi<number, number>
    multiply: Multi<number, number>
    sub: Binary<number, number>
    subtract: Binary<number, number>
    div: Binary<number, number>
    divide: Binary<number, number>
    mod: Binary<number, number>
    modulo: Binary<number, number>

    // mathematic
    abs: Unary<number, number>
    floor: Unary<number, number>
    ceil: Unary<number, number>
    round: Unary<number, number>
    exp: Unary<number, number>
    log<A extends boolean>(x: Term<number, A>, base?: Term<number, A>): Expr<number, A>
    pow: Binary<number, number>
    power: Binary<number, number>
    random(): Expr<number, false>

    // comparison
    eq: Multi<Comparable, boolean>
    ne: Binary<Comparable, boolean>
    gt: Binary<Comparable, boolean>
    ge: Binary<Comparable, boolean>
    gte: Binary<Comparable, boolean>
    lt: Binary<Comparable, boolean>
    le: Binary<Comparable, boolean>
    lte: Binary<Comparable, boolean>

    // element
    in<T extends Comparable, A extends boolean>(x: Term<T, A>, array: Array<T, A>): Expr<boolean, A>
    in<T extends Comparable, A extends boolean>(x: Term<T, A>[], array: Array<T[], A>): Expr<boolean, A>
    nin<T extends Comparable, A extends boolean>(x: Term<T, A>, array: Array<T, A>): Expr<boolean, A>
    nin<T extends Comparable, A extends boolean>(x: Term<T, A>[], array: Array<T[], A>): Expr<boolean, A>

    // string
    concat: Multi<string, string>
    regex<A extends boolean>(x: Term<string, A>, y: RegExp): Expr<boolean, A>
    regex<A extends boolean>(x: Term<string, A>, y: Term<string, A>, flags?: string): Expr<boolean, A>

    // logical / bitwise
    and: Multi<boolean, boolean> & Multi<number, number> & Multi<bigint, bigint>
    or: Multi<boolean, boolean> & Multi<number, number> & Multi<bigint, bigint>
    not: Unary<boolean, boolean> & Unary<number, number> & Unary<bigint, bigint>
    xor: Multi<boolean, boolean> & Multi<number, number> & Multi<bigint, bigint>

    // typecast
    literal<T>(value: T, type?: Type<T> | Field.Type<T> | Field.NewType<T> | string): Expr<T, false>
    number: Unary<any, number>

    // aggregation / json
    sum: Aggr<number>
    avg: Aggr<number>
    max: Aggr<Comparable>
    min: Aggr<Comparable>
    count(value: Any<false>): Expr<number, true>
    length(value: Any<false>): Expr<number, true>
    length<A extends boolean>(value: any[] | Expr<any[], A>): Expr<number, A>

    object<T extends any>(row: Row.Cell<T>): Expr<T, false>
    object<T extends any>(row: Row<T>): Expr<T, false>
    array<T>(value: Expr<T, false>): Expr<T[], true>

    get<T extends object, K extends keyof T, A extends boolean>(x: Term<T, A>, key: K): Expr<T[K], A>
    get<T extends any, A extends boolean>(x: Array<T, A>, index: Term<number, A>): Expr<T, A>
  }
}

export const Eval = ((key, value, type) => defineProperty(defineProperty({ ['$' + key]: value }, kExpr, true), Type.kType, type)) as Eval.Static

const operators = Object.create(null) as Record<`$${keyof Eval.Static}`, (args: any, data: any) => any>

operators['$'] = getRecursive

type UnaryCallback<T> = T extends (value: infer R) => Eval.Expr<infer S> ? (value: R, data: any[]) => S : never
function unary<K extends keyof Eval.Static>(key: K, callback: UnaryCallback<Eval.Static[K]>, type: Type | ((...args: any[]) => Type)): Eval.Static[K] {
  operators[`$${key}`] = callback
  return ((value: any) => Eval(key, value, typeof type === 'function' ? type(value) : type)) as any
}

type MultivariateCallback<T> = T extends (...args: infer R) => Eval.Expr<infer S> ? (args: R, data: any) => S : never
function multary<K extends keyof Eval.Static>(
  key: K, callback: MultivariateCallback<Eval.Static[K]>,
  type: Type | ((...args: any[]) => Type),
): Eval.Static[K] {
  operators[`$${key}`] = callback
  return (...args: any) => Eval(key, args, typeof type === 'function' ? type(...args) : type) as any
}

type BinaryCallback<T> = T extends (...args: any[]) => Eval.Expr<infer S> ? (...args: any[]) => S : never
function comparator<K extends keyof Eval.Static>(key: K, callback: BinaryCallback<Eval.Static[K]>): Eval.Static[K] {
  operators[`$${key}`] = (args, data) => {
    const left = executeEval(data, args[0])
    const right = executeEval(data, args[1])
    if (isNullable(left) || isNullable(right)) return true
    return callback(left.valueOf(), right.valueOf())
  }
  return (...args: any) => Eval(key, args, Type.Boolean) as any
}

Eval.switch = (branches, vDefault) => Eval('switch', { branches, default: vDefault }, Type.fromTerm(branches[0]))
operators.$switch = (args, data) => {
  for (const branch of args.branches) {
    if (executeEval(data, branch.case)) return executeEval(data, branch.then)
  }
  return executeEval(data, args.default)
}

// special forms
Eval.ignoreNull = (expr) => (expr['$ignoreNull'] = true, expr[Type.kType]!.ignoreNull = true, expr)
Eval.select = multary('select', (args, table) => args.map(arg => executeEval(table, arg)), Type.Array())
Eval.query = (row, query, expr = true) => ({ $expr: expr, ...query }) as any
Eval.exec = unary('exec', (expr, data) => (expr.driver as any).executeSelection(expr, data), (expr) => Type.fromTerm(expr.args[0]))

// univeral
Eval.if = multary('if', ([cond, vThen, vElse], data) => executeEval(data, cond) ? executeEval(data, vThen)
  : executeEval(data, vElse), (cond, vThen, vElse) => Type.fromTerm(vThen))
Eval.ifNull = multary('ifNull', ([value, fallback], data) => executeEval(data, value) ?? executeEval(data, fallback), (value) => Type.fromTerm(value))

// arithmetic
Eval.add = multary('add', (args, data) => args.reduce<number>((prev, curr) => prev + executeEval(data, curr), 0), Type.Number)
Eval.mul = Eval.multiply = multary('multiply', (args, data) => args.reduce<number>((prev, curr) => prev * executeEval(data, curr), 1), Type.Number)
Eval.sub = Eval.subtract = multary('subtract', ([left, right], data) => executeEval(data, left) - executeEval(data, right), Type.Number)
Eval.div = Eval.divide = multary('divide', ([left, right], data) => executeEval(data, left) / executeEval(data, right), Type.Number)
Eval.mod = Eval.modulo = multary('modulo', ([left, right], data) => executeEval(data, left) % executeEval(data, right), Type.Number)

// mathematic
Eval.abs = unary('abs', (arg, data) => Math.abs(executeEval(data, arg)), Type.Number)
Eval.floor = unary('floor', (arg, data) => Math.floor(executeEval(data, arg)), Type.Number)
Eval.ceil = unary('ceil', (arg, data) => Math.ceil(executeEval(data, arg)), Type.Number)
Eval.round = unary('round', (arg, data) => Math.round(executeEval(data, arg)), Type.Number)
Eval.exp = unary('exp', (arg, data) => Math.exp(executeEval(data, arg)), Type.Number)
Eval.log = multary('log', ([left, right], data) => Math.log(executeEval(data, left)) / Math.log(executeEval(data, right ?? Math.E)), Type.Number)
Eval.pow = Eval.power = multary('power', ([left, right], data) => Math.pow(executeEval(data, left), executeEval(data, right)), Type.Number)
Eval.random = () => Eval('random', {}, Type.Number)
operators.$random = () => Math.random()

// comparison
Eval.eq = comparator('eq', (left, right) => left === right)
Eval.ne = comparator('ne', (left, right) => left !== right)
Eval.gt = comparator('gt', (left, right) => left > right)
Eval.ge = Eval.gte = comparator('gte', (left, right) => left >= right)
Eval.lt = comparator('lt', (left, right) => left < right)
Eval.le = Eval.lte = comparator('lte', (left, right) => left <= right)

// element
Eval.in = (value, array) => Eval('in', [Array.isArray(value) ? Eval.select(...value) : value, array], Type.Boolean)
operators.$in = ([value, array], data) => {
  const val = executeEval(data, value), arr = executeEval(data, array)
  if (typeof val === 'object') return arr.includes(val) || arr.map(JSON.stringify).includes(JSON.stringify(val))
  return arr.includes(val)
}
Eval.nin = (value, array) => Eval('nin', [Array.isArray(value) ? Eval.select(...value) : value, array], Type.Boolean)
operators.$nin = ([value, array], data) => {
  const val = executeEval(data, value), arr = executeEval(data, array)
  if (typeof val === 'object') return !arr.includes(val) && !arr.map(JSON.stringify).includes(JSON.stringify(val))
  return !arr.includes(val)
}

// string
Eval.concat = multary('concat', (args, data) => args.map(arg => executeEval(data, arg)).join(''), Type.String)
Eval.regex = multary('regex', ([value, regex, flags], data) => makeRegExp(executeEval(data, regex), flags).test(executeEval(data, value)), Type.Boolean)

// logical / bitwise
Eval.and = multary('and', (args, data) => {
  const type = Type.fromTerms(args, Type.Boolean)
  if (Field.boolean.includes(type.type)) return args.every(arg => executeEval(data, arg))
  else if (Field.number.includes(type.type)) return args.map(arg => executeEval(data, arg)).reduce((prev, curr) => prev & curr)
  else if (type.type === 'bigint') return args.map(arg => BigInt(executeEval(data, arg) ?? 0)).reduce((prev, curr) => prev & curr)
}, (...args) => Type.fromTerms(args, Type.Boolean))
Eval.or = multary('or', (args, data) => {
  const type = Type.fromTerms(args, Type.Boolean)
  if (Field.boolean.includes(type.type)) return args.some(arg => executeEval(data, arg))
  else if (Field.number.includes(type.type)) return args.map(arg => executeEval(data, arg)).reduce((prev, curr) => prev | curr)
  else if (type.type === 'bigint') return args.map(arg => BigInt(executeEval(data, arg) ?? 0)).reduce((prev, curr) => prev | curr)
}, (...args) => Type.fromTerms(args, Type.Boolean))
Eval.not = unary('not', (value, data) => {
  const type = Type.fromTerms([value], Type.Boolean)
  if (Field.boolean.includes(type.type)) return !executeEval(data, value)
  else if (Field.number.includes(type.type)) return ~executeEval(data, value) as any
  else if (type.type === 'bigint') return ~BigInt(executeEval(data, value) ?? 0)
}, (value) => Type.fromTerms([value], Type.Boolean))
Eval.xor = multary('xor', (args, data) => {
  const type = Type.fromTerms(args, Type.Boolean)
  if (Field.boolean.includes(type.type)) return args.map(arg => executeEval(data, arg)).reduce((prev, curr) => prev !== curr)
  else if (Field.number.includes(type.type)) return args.map(arg => executeEval(data, arg)).reduce((prev, curr) => prev ^ curr)
  else if (type.type === 'bigint') return args.map(arg => BigInt(executeEval(data, arg) ?? 0)).reduce((prev, curr) => prev ^ curr)
}, (...args) => Type.fromTerms(args, Type.Boolean))

// typecast
Eval.literal = multary('literal', ([value, type]) => value, (value, type) => type ? Type.fromField(type) : Type.fromTerm(value))
Eval.number = unary('number', (arg, data) => {
  const value = executeEval(data, arg)
  return value instanceof Date ? Math.floor(value.valueOf() / 1000) : Number(value)
}, Type.Number)

const unwrapAggr = (expr: any, def?: Type) => {
  let type = Type.fromTerm(expr)
  type = Type.getInner(type) ?? type
  return (def && type.type === 'expr') ? def : type
}

// aggregation
Eval.sum = unary('sum', (expr, table) => Array.isArray(table)
  ? table.reduce<number>((prev, curr) => prev + executeAggr(expr, curr), 0)
  : Array.from<number>(executeEval(table, expr)).reduce((prev, curr) => prev + curr, 0), Type.Number)
Eval.avg = unary('avg', (expr, table) => {
  if (Array.isArray(table)) return table.reduce((prev, curr) => prev + executeAggr(expr, curr), 0) / table.length
  else {
    const array = Array.from<number>(executeEval(table, expr))
    return array.reduce((prev, curr) => prev + curr, 0) / array.length
  }
}, Type.Number)
Eval.max = unary('max', (expr, table) => Array.isArray(table)
  ? table.map(data => executeAggr(expr, data)).reduce((x, y) => x > y ? x : y, -Infinity)
  : Array.from<number>(executeEval(table, expr)).reduce((x, y) => x > y ? x : y, -Infinity), (expr) => unwrapAggr(expr, Type.Number))
Eval.min = unary('min', (expr, table) => Array.isArray(table)
  ? table.map(data => executeAggr(expr, data)).reduce((x, y) => x < y ? x : y, Infinity)
  : Array.from<number>(executeEval(table, expr)).reduce((x, y) => x < y ? x : y, Infinity), (expr) => unwrapAggr(expr, Type.Number))
Eval.count = unary('count', (expr, table) => new Set(table.map(data => executeAggr(expr, data))).size, Type.Number)
defineProperty(Eval, 'length', unary('length', (expr, table) => Array.isArray(table)
  ? table.map(data => executeAggr(expr, data)).length
  : Array.from(executeEval(table, expr)).length, Type.Number))

operators.$object = (field, table) => mapValues(field, value => executeAggr(value, table))
Eval.object = (fields: any) => {
  if (fields.$model) {
    const modelFields: [string, Field][] = Object.entries(fields.$model.fields)
    const prefix: string = fields.$prefix
    fields = Object.fromEntries(modelFields
      .filter(([, field]) => Field.available(field))
      .filter(([path]) => path.startsWith(prefix))
      .map(([k]) => [k.slice(prefix.length), fields[k.slice(prefix.length)]]))
    return Object.assign(Eval('object', fields, Type.Object(mapValues(fields, (value) => Type.fromTerm(value)))), fields)
  }
  // filter out nested spread $object
  fields = filterKeys(fields, key => key !== '$object')
  return Object.assign(Eval('object', fields, Type.Object(mapValues(fields, (value) => Type.fromTerm(value)))), fields)
}

Eval.array = unary('array', (expr, table) => Array.isArray(table)
  ? table.map(data => executeAggr(expr, data)).filter(x => !expr[Type.kType]?.ignoreNull || !isEmpty(x))
  : Array.from(executeEval(table, expr)).filter(x => !expr[Type.kType]?.ignoreNull || !isEmpty(x)), (expr) => Type.Array(Type.fromTerm(expr)))

Eval.get = multary('get', ([x, key], data) => executeEval(data, x)?.[executeEval(data, key)], (x, key) => Type.getInner(Type.fromTerm(x), key) ?? Type.Any)

export { Eval as $ }

export type Update<T = any> = UnevalObject<Flatten<T>>

function getRecursive(args: string | string[], data: any): any {
  if (typeof args === 'string') {
    // for backwards compatibility, TODO remove in v2
    return getRecursive(['_', args], data)
  }

  const [ref, path] = args
  let value = data[ref]
  if (!value) return value
  if (path in value) return value[path]
  const prefix = Object.keys(value).find(s => path.startsWith(s + '.')) || path.split('.', 1)[0]
  const rest = path.slice(prefix.length + 1).split('.').filter(Boolean)
  rest.unshift(prefix)
  for (const key of rest) {
    value = value[key]
    if (!value) return value
  }
  return value
}

function executeEvalExpr(expr: any, data: any) {
  for (const key in expr) {
    if (key in operators) {
      return operators[key](expr[key], data)
    }
  }
  return expr
}

function executeAggr(expr: any, data: any) {
  if (typeof expr === 'string') {
    return getRecursive(expr, data)
  }
  return executeEvalExpr(expr, data)
}

export function executeEval(data: any, expr: any) {
  if (isComparable(expr) || isNullable(expr)) {
    return expr
  }
  if (Array.isArray(expr)) {
    return expr.map(item => executeEval(data, item))
  }
  return executeEvalExpr(expr, data)
}

export function executeUpdate(data: any, update: any, ref: string) {
  for (const key in update) {
    let root = data
    const path = key.split('.')
    const last = path.pop()!
    for (const key of path) {
      root = root[key] ||= {}
    }
    root[last] = executeEval({ [ref]: data, _: data }, update[key])
  }
  return data
}
