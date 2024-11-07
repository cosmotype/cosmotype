import { Dict, isNullable } from 'cosmokit'
import {
  Driver, Eval, Field, flatten, isAggrExpr, isComparable, isEvalExpr, isFlat,
  Model, Modifier, Query, randomId, RegExpLike, Selection, Type, unravel,
} from 'minato'

export function escapeId(value: string) {
  return '`' + value + '`'
}

export function isBracketed(value: string) {
  return value.startsWith('(') && value.endsWith(')')
}

export function isSqlJson(type?: Type) {
  return type ? (type.type === 'json' || !!type.inner) : false
}

export type QueryOperators = {
  [K in keyof Query.FieldExpr]?: (key: string, value: NonNullable<Query.FieldExpr[K]>) => string
}

export type ExtractUnary<T> = T extends [infer U] ? U : T

export type EvalOperators = {
  [K in keyof Eval.Static as `$${K}`]?: (expr: ExtractUnary<Parameters<Eval.Static[K]>>) => string
} & { $: (expr: any) => string }

interface Transformer<S=any, T=any> {
  encode?(value: string): string
  decode?(value: string): string
  load?(value: S | null): T | null
  dump?(value: T | null): S | null
}

interface State {
  // current table ref in get()
  table?: string

  // encode format of last evaluation
  encoded?: boolean
  encodedMap?: Dict<boolean>

  // current eval expr
  expr?: Eval.Expr

  group?: boolean
  tables?: Dict<Model>

  // joined tables
  innerTables?: Dict<Model>

  // outter tables and fields within subquery
  refFields?: Dict<string>
  refTables?: Dict<Model>
  wrappedSubquery?: boolean
}

export class Builder {
  protected escapeMap = {}
  protected escapeRegExp?: RegExp
  protected createEqualQuery = this.comparator('=')
  protected queryOperators: QueryOperators
  protected evalOperators: EvalOperators
  protected state: State = {}
  protected $true = '1'
  protected $false = '0'
  protected modifiedTable?: string
  protected transformers: Dict<Transformer> = Object.create(null)

  constructor(protected driver: Driver, tables?: Dict<Model>) {
    this.state.tables = tables

    this.queryOperators = {
      // logical
      $or: (key, value) => this.logicalOr(value.map(value => this.parseFieldQuery(key, value))),
      $and: (key, value) => this.logicalAnd(value.map(value => this.parseFieldQuery(key, value))),
      $not: (key, value) => this.logicalNot(this.parseFieldQuery(key, value)),

      // existence
      $exists: (key, value) => this.createNullQuery(key, value),

      // comparison
      $eq: this.createEqualQuery,
      $ne: this.comparator('!='),
      $gt: this.comparator('>'),
      $gte: this.comparator('>='),
      $lt: this.comparator('<'),
      $lte: this.comparator('<='),

      // membership
      $in: (key, value) => this.createMemberQuery(key, value, ''),
      $nin: (key, value) => this.createMemberQuery(key, value, ' NOT'),

      // regexp
      $regex: (key, value) => this.createRegExpQuery(key, value),
      $regexFor: (key, value) => typeof value === 'string' ? `${this.escape(value)} collate utf8mb4_bin regexp ${key}`
        : `${this.escape(value.input)} ${value.flags?.includes('i') ? 'regexp' : 'collate utf8mb4_bin regexp'} ${key}`,

      // bitwise
      $bitsAllSet: (key, value) => `${key} & ${this.escape(value)} = ${this.escape(value)}`,
      $bitsAllClear: (key, value) => `${key} & ${this.escape(value)} = 0`,
      $bitsAnySet: (key, value) => `${key} & ${this.escape(value)} != 0`,
      $bitsAnyClear: (key, value) => `${key} & ${this.escape(value)} != ${this.escape(value)}`,

      // list
      $el: (key, value) => {
        if (Array.isArray(value)) {
          return this.logicalOr(value.map(value => this.createElementQuery(key, value)))
        } else if (typeof value !== 'number' && typeof value !== 'string') {
          throw new TypeError('query expr under $el is not supported')
        } else {
          return this.createElementQuery(key, value)
        }
      },
      $size: (key, value) => {
        if (this.isJsonQuery(key)) {
          return `${this.jsonLength(key)} = ${this.escape(value)}`
        } else {
          if (!value) return this.logicalNot(key)
          return `${key} AND LENGTH(${key}) - LENGTH(REPLACE(${key}, ${this.escape(',')}, ${this.escape('')})) = ${this.escape(value)} - 1`
        }
      },
    }

    this.evalOperators = {
      // universal
      $: (key) => this.getRecursive(key),
      $select: (args) => `${args.map(arg => this.parseEval(arg)).join(', ')}`,
      $if: (args) => `if(${args.map(arg => this.parseEval(arg)).join(', ')})`,
      $ifNull: (args) => `ifnull(${args.map(arg => this.parseEval(arg)).join(', ')})`,

      // number
      $add: (args) => `(${args.map(arg => this.parseEval(arg)).join(' + ')})`,
      $multiply: (args) => `(${args.map(arg => this.parseEval(arg)).join(' * ')})`,
      $subtract: this.binary('-'),
      $divide: this.binary('/'),
      $modulo: this.binary('%'),

      // mathemetic
      $abs: (arg) => `abs(${this.parseEval(arg)})`,
      $floor: (arg) => `floor(${this.parseEval(arg)})`,
      $ceil: (arg) => `ceil(${this.parseEval(arg)})`,
      $round: (arg) => `round(${this.parseEval(arg)})`,
      $exp: (arg) => `exp(${this.parseEval(arg)})`,
      $log: (args) => `log(${args.filter(x => !isNullable(x)).map(arg => this.parseEval(arg)).reverse().join(', ')})`,
      $power: (args) => `power(${args.map(arg => this.parseEval(arg)).join(', ')})`,
      $random: () => `rand()`,

      // string
      $concat: (args) => `concat(${args.map(arg => this.parseEval(arg)).join(', ')})`,
      $regex: ([key, value, flags]) => `(${this.parseEval(key)} ${
        (flags?.includes('i') || (value instanceof RegExp && value.flags.includes('i'))) ? 'regexp' : 'collate utf8mb4_bin regexp'
      } ${this.parseEval(value)})`,

      // logical / bitwise
      $or: (args) => {
        const type = Type.fromTerm(this.state.expr, Type.Boolean)
        if (Field.boolean.includes(type.type)) return this.logicalOr(args.map(arg => this.parseEval(arg)))
        else return `(${args.map(arg => this.parseEval(arg)).join(' | ')})`
      },
      $and: (args) => {
        const type = Type.fromTerm(this.state.expr, Type.Boolean)
        if (Field.boolean.includes(type.type)) return this.logicalAnd(args.map(arg => this.parseEval(arg)))
        else return `(${args.map(arg => this.parseEval(arg)).join(' & ')})`
      },
      $not: (arg) => {
        const type = Type.fromTerm(this.state.expr, Type.Boolean)
        if (Field.boolean.includes(type.type)) return this.logicalNot(this.parseEval(arg))
        else return `(~(${this.parseEval(arg)}))`
      },

      // boolean
      $eq: this.binary('='),
      $ne: this.binary('!='),
      $gt: this.binary('>'),
      $gte: this.binary('>='),
      $lt: this.binary('<'),
      $lte: this.binary('<='),

      // membership
      $in: ([key, value]) => this.asEncoded(this.createMemberQuery(this.parseEval(key, false), value, ''), false),
      $nin: ([key, value]) => this.asEncoded(this.createMemberQuery(this.parseEval(key, false), value, ' NOT'), false),

      // typecast
      $literal: ([value, type]) => this.escape(value, type as any),

      // aggregation
      $sum: (expr) => this.createAggr(expr, value => `ifnull(sum(${value}), 0)`),
      $avg: (expr) => this.createAggr(expr, value => `avg(${value})`),
      $min: (expr) => this.createAggr(expr, value => `min(${value})`),
      $max: (expr) => this.createAggr(expr, value => `max(${value})`),
      $count: (expr) => this.createAggr(expr, value => `count(distinct ${value})`),
      $length: (expr) => this.createAggr(expr, value => `count(${value})`, value => this.isEncoded() ? this.jsonLength(value)
        : this.asEncoded(`if(${value}, LENGTH(${value}) - LENGTH(REPLACE(${value}, ${this.escape(',')}, ${this.escape('')})) + 1, 0)`, false)),

      $object: (fields) => this.groupObject(fields),
      $array: (expr) => this.groupArray(this.transform(this.parseEval(expr, false), expr, 'encode')),
      $get: ([x, key]) => typeof key === 'string'
        ? this.asEncoded(`json_extract(${this.parseEval(x, false)}, '$.${key}')`, true)
        : this.asEncoded(`json_extract(${this.parseEval(x, false)}, concat('$[', ${this.parseEval(key)}, ']'))`, true),

      $exec: (sel) => this.parseSelection(sel as Selection),
    }
  }

  protected createNullQuery(key: string, value: boolean) {
    return `${key} is ${value ? 'not ' : ''}null`
  }

  protected createMemberQuery(key: string, value: any, notStr = '') {
    if (Array.isArray(value)) {
      if (!value.length) return notStr ? this.$true : this.$false
      if (Array.isArray(value[0])) {
        return `(${key})${notStr} in (${value.map((val: any[]) => `(${val.map(x => this.escape(x)).join(', ')})`).join(', ')})`
      }
      return `${key}${notStr} in (${value.map(val => this.escape(val)).join(', ')})`
    } else if (value.$exec) {
      return `(${key})${notStr} in ${this.parseSelection(value.$exec, true)}`
    } else {
      const res = this.jsonContains(this.parseEval(value, false), this.encode(key, true, true))
      return notStr ? this.logicalNot(res) : res
    }
  }

  protected createRegExpQuery(key: string, value: string | RegExpLike) {
    if (typeof value !== 'string' && value.flags?.includes('i')) {
      return `${key} regexp ${this.escape(value.source)}`
    } else {
      return `${key} collate utf8mb4_bin regexp ${this.escape(typeof value === 'string' ? value : value.source)}`
    }
  }

  protected createElementQuery(key: string, value: any) {
    if (this.isJsonQuery(key)) {
      return this.jsonContains(key, this.encode(value, true, true))
    } else {
      return `find_in_set(${this.escape(value)}, ${key})`
    }
  }

  protected isJsonQuery(key: string) {
    return Type.fromTerm(this.state.expr)?.type === 'json' || this.isEncoded(key)
  }

  protected comparator(operator: string) {
    return (key: string, value: any) => {
      return `${key} ${operator} ${this.escape(value)}`
    }
  }

  protected binary(operator: string) {
    return ([left, right]) => {
      return `(${this.parseEval(left)} ${operator} ${this.parseEval(right)})`
    }
  }

  protected logicalAnd(conditions: string[]) {
    if (!conditions.length) return this.$true
    if (conditions.includes(this.$false)) return this.$false
    return conditions.join(' AND ')
  }

  protected logicalOr(conditions: string[]) {
    if (!conditions.length) return this.$false
    if (conditions.includes(this.$true)) return this.$true
    return `(${conditions.join(' OR ')})`
  }

  protected logicalNot(condition: string) {
    return `NOT(${condition})`
  }

  protected parseSelection(sel: Selection, inline = false) {
    const { args: [expr], ref, table, tables } = sel
    const restore = this.saveState({ tables })
    const inner = this.get(table as Selection, true, true) as string
    const output = this.parseEval(expr, false)
    const fields = expr['$select']?.map(x => this.getRecursive(x['$']))
    const where = fields && this.logicalAnd(fields.map(x => `(${x} is not null)`))
    restore()
    if (inline || !isAggrExpr(expr as any)) {
      return `(SELECT ${output} FROM ${inner} ${isBracketed(inner) ? ref : ''}${where ? ` WHERE ${where}` : ''})`
    } else {
      return [
        `(ifnull((SELECT ${this.groupArray(this.transform(output, Type.getInner(Type.fromTerm(expr)), 'encode'))}`,
        `FROM ${inner} ${isBracketed(inner) ? ref : ''}), json_array()))`,
      ].join(' ')
    }
  }

  protected jsonLength(value: string) {
    return this.asEncoded(`json_length(${value})`, false)
  }

  protected jsonContains(obj: string, value: string) {
    return this.asEncoded(`json_contains(${obj}, ${value})`, false)
  }

  protected asEncoded(value: string, encoded: boolean | undefined) {
    if (encoded !== undefined) this.state.encoded = encoded
    return value
  }

  protected encode(value: string, encoded: boolean, pure: boolean = false, type?: Type) {
    return this.asEncoded((encoded === this.isEncoded() && !pure) ? value
      : encoded ? `cast(${this.transform(value, type, 'encode')} as json)`
        : this.transform(`json_unquote(${value})`, type, 'decode'), pure ? undefined : encoded)
  }

  protected isEncoded(key?: string) {
    return key ? this.state.encodedMap?.[key] : this.state.encoded
  }

  protected createAggr(expr: any, aggr: (value: string) => string, nonaggr?: (value: string) => string) {
    if (this.state.group) {
      this.state.group = false
      const value = aggr(this.parseEval(expr, false))
      this.state.group = true
      // pass through sqlType of elements for variant types
      // ok to pass json on raw since mysql can treat them properly
      return value
    } else {
      const value = this.parseEval(expr, false)
      const res = nonaggr ? nonaggr(value)
        : `(select ${aggr(`json_unquote(${this.escapeId('value')})`)} from json_table(${value}, '$[*]' columns (value json path '$')) ${randomId()})`
      return res
    }
  }

  /**
   * Convert value from SQL field to JSON field
   */
  protected transform(value: string, type: Type | Eval.Expr | undefined, method: 'encode' | 'decode' | 'load' | 'dump', miss?: any) {
    type = Type.isType(type) ? type : Type.fromTerm(type)
    const transformer = this.transformers[type.type] ?? this.transformers[this.driver.newtypes[type.type]?.type!]
    return transformer?.[method] ? transformer[method]!(value) : (miss ?? value)
  }

  protected groupObject(_fields: any) {
    const _groupObject = (fields: any, type?: Type, prefix: string = '') => {
      const parse = (expr, key) => {
        const value = (!_fields[`${prefix}${key}`] && type && Type.getInner(type, key)?.inner)
          ? _groupObject(expr, Type.getInner(type, key), `${prefix}${key}.`)
          : this.parseEval(expr, false)
        return this.isEncoded() ? `json_extract(${value}, '$')` : this.transform(value, expr, 'encode')
      }
      return `json_object(` + Object.entries(fields).map(([key, expr]) => `'${key}', ${parse(expr, key)}`).join(',') + `)`
    }
    return this.asEncoded(_groupObject(unravel(_fields), Type.fromTerm(this.state.expr), ''), true)
  }

  protected groupArray(value: string) {
    return this.asEncoded(`ifnull(json_arrayagg(${value}), json_array())`, true)
  }

  protected parseFieldQuery(key: string, query: Query.Field) {
    const conditions: string[] = []

    // query shorthand
    if (Array.isArray(query)) {
      conditions.push(this.createMemberQuery(key, query))
    } else if (query instanceof RegExp) {
      conditions.push(this.createRegExpQuery(key, query))
    } else if (isComparable(query)) {
      conditions.push(this.createEqualQuery(key, query))
    } else if (isNullable(query)) {
      conditions.push(this.createNullQuery(key, false))
    } else {
      // query expression
      for (const prop in query) {
        if (prop in this.queryOperators) {
          conditions.push(this.queryOperators[prop](key, query[prop]))
        }
      }
    }

    return this.logicalAnd(conditions)
  }

  parseQuery(query: Query.Expr) {
    const conditions: string[] = []
    for (const key in query) {
      // logical expression
      if (key === '$not') {
        conditions.push(this.logicalNot(this.parseQuery(query.$not!)))
      } else if (key === '$and') {
        conditions.push(this.logicalAnd(query.$and!.map(this.parseQuery.bind(this))))
      } else if (key === '$or') {
        conditions.push(this.logicalOr(query.$or!.map(this.parseQuery.bind(this))))
      } else if (key === '$expr') {
        conditions.push(this.parseEval(query.$expr))
      } else {
        const flattenQuery = isFlat(query[key]) ? { [key]: query[key] } : flatten(query[key], `${key}.`)
        for (const key in flattenQuery) {
          const model = this.state.tables![this.state.table!] ?? Object.values(this.state.tables!)[0]
          const expr = Eval('', [this.state.table ?? Object.keys(this.state.tables!)[0], key], model.getType(key)!)
          conditions.push(this.parseFieldQuery(this.parseEval(expr), flattenQuery[key]))
        }
      }
    }

    return this.logicalAnd(conditions)
  }

  protected parseEvalExpr(expr: any) {
    this.state.encoded = false
    for (const key in expr) {
      if (key in this.evalOperators) {
        this.state.expr = expr
        return this.evalOperators[key](expr[key])
      }
    }
    return this.escape(expr)
  }

  protected transformJsonField(obj: string, path: string) {
    return this.asEncoded(`json_extract(${obj}, '$${path}')`, true)
  }

  protected transformKey(key: string, fields: Field.Config, prefix: string) {
    if (key in fields || !key.includes('.')) {
      return this.asEncoded(prefix + this.escapeId(key), this.isEncoded(key) ?? isSqlJson(fields[key]?.type))
    }
    const field = Object.keys(fields).find(k => key.startsWith(k + '.')) || key.split('.')[0]
    const rest = key.slice(field.length + 1).split('.')
    return this.transformJsonField(`${prefix}${this.escapeId(field)}`, rest.map(key => `.${this.escapeKey(key)}`).join(''))
  }

  protected getRecursive(args: string | string[]) {
    if (typeof args === 'string') {
      return this.getRecursive(['_', args])
    }
    const [table, key] = args
    const fields = this.state.tables?.[table]?.fields || {}
    const fkey = Object.keys(fields).find(field => key === field || key.startsWith(field + '.'))
    if (fkey && fields[fkey]?.expr) {
      if (key === fkey) {
        return this.parseEvalExpr(fields[fkey]?.expr)
      } else {
        const field = this.parseEvalExpr(fields[fkey]?.expr)
        const rest = key.slice(fkey.length + 1).split('.')
        return this.transformJsonField(`${field}`, rest.map(key => `.${this.escapeKey(key)}`).join(''))
      }
    }
    const prefix = this.modifiedTable ? `${this.escapeId(this.state.tables?.[table]?.name ?? this.modifiedTable)}.`
      : (!this.state.tables || table === '_' || key in fields || table in this.state.tables ? '' : `${this.escapeId(table)}.`)

    if (!(table in (this.state.tables || {})) && (table in (this.state.innerTables || {}))) {
      const fields = this.state.innerTables?.[table]?.fields || {}
      const res = (fields[key]?.expr) ? this.parseEvalExpr(fields[key]?.expr)
        : this.transformKey(key, fields, `${this.escapeId(table)}.`)
      return res
    }

    // field from outer selection
    if (!(table in (this.state.tables || {})) && (table in (this.state.refTables || {}))) {
      const fields = this.state.refTables?.[table]?.fields || {}
      const res = (fields[key]?.expr) ? this.parseEvalExpr(fields[key]?.expr)
        : this.transformKey(key, fields, `${this.escapeId(table)}.`)
      if (this.state.wrappedSubquery) {
        if (res in (this.state.refFields ?? {})) return this.state.refFields![res]
        const key = `minato_tvar_${randomId()}`
        ;(this.state.refFields ??= {})[res] = key
        return this.asEncoded(this.escapeId(key), true)
      } else return res
    }
    return this.transformKey(key, fields, prefix)
  }

  parseEval(expr: any, unquote: boolean = true): string {
    this.state.encoded = false
    if (typeof expr === 'string' || typeof expr === 'number' || typeof expr === 'boolean' || expr instanceof Date || expr instanceof RegExp) {
      return this.escape(expr)
    }
    return unquote ? this.encode(this.parseEvalExpr(expr), false, false, Type.fromTerm(expr)) : this.parseEvalExpr(expr)
  }

  protected saveState(extra: Partial<State> = {}) {
    const thisState = this.state
    this.state = { refTables: { ...(this.state.refTables || {}), ...(this.state.tables || {}) }, ...extra }
    return () => {
      thisState.encoded = this.state.encoded
      this.state = thisState
    }
  }

  suffix(modifier: Modifier) {
    const { limit, offset, sort, group, having } = modifier
    let sql = ''
    if (group?.length) {
      sql += ` GROUP BY ${group.map(this.escapeId).join(', ')}`
      const filter = this.parseEval(having)
      if (filter !== this.$true) sql += ` HAVING ${filter}`
    }
    if (sort.length) {
      sql += ' ORDER BY ' + sort.map(([expr, dir]) => {
        return `${this.parseEval(expr)} ${dir.toUpperCase()}`
      }).join(', ')
    }
    if (limit < Infinity) sql += ' LIMIT ' + limit
    if (offset > 0) sql += ' OFFSET ' + offset
    return sql
  }

  get(sel: Selection.Immutable, inline = false, group = false, addref = true) {
    const { args, table, query, ref, model } = sel
    this.state.table = ref

    // get prefix
    let prefix: string | undefined
    if (typeof table === 'string') {
      prefix = this.escapeId(table)
    } else if (Selection.is(table)) {
      prefix = this.get(table, true)
      if (!prefix) return
    } else {
      this.state.innerTables = Object.fromEntries(Object.values(table).map(t => [t.ref, t.model]))
      const joins: [string, string][] = Object.entries(table).map(([key, table]) => {
        const restore = this.saveState({ tables: { ...table.tables } })
        const t = `${this.get(table, true, false, false)} AS ${this.escapeId(table.ref)}`
        restore()
        return [key, t]
      })

      prefix = [
        // the leading space is to prevent from being parsed as bracketed and added ref
        ' ',
        joins[0][1],
        ...joins.slice(1, -1).map(([key, join]) => `${args[0].optional?.[key] ? 'LEFT' : ''} JOIN ${join} ON ${this.$true}`),
        `${args[0].optional?.[joins.at(-1)![0]] ? 'LEFT ' : ''}JOIN`,
        joins.at(-1)![1],
      ].join(' ')
      const filter = this.parseEval(args[0].having)
      prefix += ` ON ${filter}`
    }

    const filter = this.parseQuery(query)
    if (filter === this.$false) return

    this.state.group = group || !!args[0].group
    const encodedMap: Dict<boolean> = {}
    const fields = args[0].fields ?? Object.fromEntries(Object
      .entries(model.fields)
      .filter(([, field]) => Field.available(field))
      .map(([key, field]) => [key, field!.expr ? field!.expr : Eval('', [ref, key], Type.fromField(field!))]))
    const keys = Object.entries(fields).map(([key, value]) => {
      value = this.parseEval(value, false)
      encodedMap![key] = this.state.encoded!
      return this.escapeId(key) === value ? this.escapeId(key) : `${value} AS ${this.escapeId(key)}`
    }).join(', ')

    // get suffix
    let suffix = this.suffix(args[0])
    this.state.encodedMap = encodedMap

    if (filter !== this.$true) {
      suffix = ` WHERE ${filter}` + suffix
    }

    if (inline && !args[0].fields && !suffix && (typeof table === 'string' || Selection.is(table))) {
      return (addref && isBracketed(prefix)) ? `${prefix} ${ref}` : prefix
    }

    if (!prefix.includes(' ') || isBracketed(prefix)) {
      suffix = ` ${ref}` + suffix
    }

    const result = `SELECT ${keys} FROM ${prefix}${suffix}`
    return inline ? `(${result})` : result
  }

  /**
   * Convert value from Type to Field.Type.
   * @param root indicate whether the context is inside json
   */
  dump(value: any, type: Model | Type | Eval.Expr | undefined, root: boolean = true): any {
    if (!type) return value

    if (Type.isType(type) || isEvalExpr(type)) {
      type = Type.isType(type) ? type : Type.fromTerm(type)
      const converter = (type.inner || type.type === 'json') ? (root ? this.driver.types['json'] : undefined) : this.driver.types[type.type]
      if (type.inner || type.type === 'json') root = false
      let res = value
      res = Type.transform(res, type, (value, type) => this.dump(value, type, root))
      res = converter?.dump ? converter.dump(res) : res
      const ancestor = this.driver.newtypes[type.type]?.type
      if (!root && !ancestor) res = this.transform(res, type, 'dump')
      res = this.dump(res, ancestor ? Type.fromField(ancestor) : undefined, root)
      return res
    }

    value = type.format(value)
    const result = {}
    for (const key in value) {
      const { type: ftype } = type.fields[key]!
      result[key] = this.dump(value[key], ftype)
    }
    return result
  }

  /**
   * Convert value from Field.Type to Type.
   */
  load(value: any, type: Model | Type | Eval.Expr | undefined, root: boolean = true): any {
    if (!type) return value

    if (Type.isType(type) || isEvalExpr(type)) {
      type = Type.isType(type) ? type : Type.fromTerm(type)
      const converter = this.driver.types[(root && value && type.type === 'json') ? 'json' : type.type]
      const ancestor = this.driver.newtypes[type.type]?.type
      let res = this.load(value, ancestor ? Type.fromField(ancestor) : undefined, root)
      res = this.transform(res, type, 'load')
      res = converter?.load ? converter.load(res) : res
      res = Type.transform(res, type, (value, type) => this.load(value, type, false))
      return (!isNullable(res) && type.inner && !Type.isArray(type)) ? unravel(res) : res
    }

    const result = {}
    for (const key in value) {
      if (!(key in type.fields)) continue
      result[key] = value[key]
      let subroot = root
      if (subroot && result[key] && this.isEncoded(key)) {
        subroot = false
        result[key] = this.driver.types['json'].load(result[key])
      }
      result[key] = this.load(result[key], type.fields[key]!.type, subroot)
    }
    return type.parse(result)
  }

  /**
   * Convert value from Type to SQL.
   */
  escape(value: any, type?: Field | Field.Type | Type) {
    type &&= Type.fromField(type)
    return this.escapePrimitive(type ? this.dump(value, type) : value, type)
  }

  /**
   * Convert value from Field.Type to SQL.
   */
  escapePrimitive(value: any, type?: Type) {
    if (isNullable(value)) return 'NULL'

    switch (typeof value) {
      case 'boolean':
      case 'number':
      case 'bigint':
        return value + ''
      case 'object':
        return this.quote(JSON.stringify(value))
      default:
        return this.quote(value)
    }
  }

  escapeId(value: string) {
    return escapeId(value)
  }

  escapeKey(value: string) {
    return `"${value}"`
  }

  quote(value: string) {
    this.escapeRegExp ??= new RegExp(`[${Object.values(this.escapeMap).join('')}]`, 'g')
    let chunkIndex = this.escapeRegExp.lastIndex = 0
    let escapedVal = ''
    let match: RegExpExecArray | null

    while ((match = this.escapeRegExp.exec(value))) {
      escapedVal += value.slice(chunkIndex, match.index) + this.escapeMap[match[0]]
      chunkIndex = this.escapeRegExp.lastIndex
    }

    if (chunkIndex === 0) {
      return "'" + value + "'"
    }

    if (chunkIndex < value.length) {
      return "'" + escapedVal + value.slice(chunkIndex) + "'"
    }

    return "'" + escapedVal + "'"
  }
}
