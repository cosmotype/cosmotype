import { Builder, escapeId } from '@minatojs/sql-utils'
import { Binary, Dict, isNullable } from 'cosmokit'
import { Driver, Field, Model, randomId, RegExpLike, Type } from 'minato'

export class SQLiteBuilder extends Builder {
  protected escapeMap = {
    "'": "''",
  }

  constructor(protected driver: Driver, tables?: Dict<Model>) {
    super(driver, tables)

    this.queryOperators.$regexFor = (key, value) => typeof value === 'string' ? `${this.escape(value)} regexp ${key}`
      : value.flags?.includes('i') ? `regexp2(${key}, ${this.escape(value.input)}, 'i')`
        : `${this.escape(value.input)} regexp ${key}`

    this.evalOperators.$if = (args) => `iif(${args.map(arg => this.parseEval(arg)).join(', ')})`
    this.evalOperators.$regex = ([key, value, flags]) => (flags?.includes('i') || (value instanceof RegExp && value.flags?.includes('i')))
      ? `regexp2(${this.parseEval(value)}, ${this.parseEval(key)}, ${this.escape(flags ?? (value as any).flags)})`
      : `regexp(${this.parseEval(value)}, ${this.parseEval(key)})`

    this.evalOperators.$concat = (args) => `(${args.map(arg => this.parseEval(arg)).join('||')})`
    this.evalOperators.$modulo = ([left, right]) => `modulo(${this.parseEval(left)}, ${this.parseEval(right)})`
    this.evalOperators.$log = ([left, right]) => isNullable(right)
      ? `log(${this.parseEval(left)})`
      : `log(${this.parseEval(left)}) / log(${this.parseEval(right)})`
    this.evalOperators.$length = (expr) => this.createAggr(expr, value => `count(${value})`, value => this.isEncoded() ? this.jsonLength(value)
      : this.asEncoded(`iif(${value}, LENGTH(${value}) - LENGTH(REPLACE(${value}, ${this.escape(',')}, ${this.escape('')})) + 1, 0)`, false))
    this.evalOperators.$number = (arg) => {
      const type = Type.fromTerm(arg)
      const value = this.parseEval(arg)
      const res = Field.date.includes(type.type as any) ? `cast(${value} / 1000 as integer)` : `cast(${this.parseEval(arg)} as double)`
      return this.asEncoded(`ifnull(${res}, 0)`, false)
    }

    const binaryXor = (left: string, right: string) => `((${left} & ~${right}) | (~${left} & ${right}))`
    this.evalOperators.$xor = (args) => {
      const type = Type.fromTerm(this.state.expr, Type.Boolean)
      if (Field.boolean.includes(type.type)) return args.map(arg => this.parseEval(arg)).reduce((prev, curr) => `(${prev} != ${curr})`)
      else return args.map(arg => this.parseEval(arg)).reduce((prev, curr) => binaryXor(prev, curr))
    }

    this.transformers['bigint'] = {
      encode: value => `cast(${value} as text)`,
      decode: value => `cast(${value} as integer)`,
      load: value => isNullable(value) ? value : BigInt(value),
      dump: value => isNullable(value) ? value : `${value}`,
    }

    this.transformers['binary'] = {
      encode: value => `hex(${value})`,
      decode: value => `unhex(${value})`,
      load: value => isNullable(value) || typeof value === 'object' ? value : Binary.fromHex(value),
      dump: value => isNullable(value) || typeof value === 'string' ? value : Binary.toHex(value),
    }
  }

  escapePrimitive(value: any, type?: Type) {
    if (value instanceof Date) value = +value
    else if (value instanceof RegExp) value = value.source
    else if (Binary.is(value)) return `X'${Binary.toHex(value)}'`
    else if (Binary.isSource(value)) return `X'${Binary.toHex(Binary.fromSource(value))}'`
    return super.escapePrimitive(value, type)
  }

  protected createElementQuery(key: string, value: any) {
    if (this.isJsonQuery(key)) {
      return this.jsonContains(key, this.escape(value, 'json'))
    } else {
      return `(',' || ${key} || ',') LIKE ${this.escape('%,' + value + ',%')}`
    }
  }

  protected createRegExpQuery(key: string, value: string | RegExpLike) {
    if (typeof value !== 'string' && value.flags?.includes('i')) {
      return `regexp2(${this.escape(typeof value === 'string' ? value : value.source)}, ${key}, ${this.escape(value.flags)})`
    } else {
      return `regexp(${this.escape(typeof value === 'string' ? value : value.source)}, ${key})`
    }
  }

  protected jsonLength(value: string) {
    return this.asEncoded(`json_array_length(${value})`, false)
  }

  protected jsonContains(obj: string, value: string) {
    return this.asEncoded(`json_array_contains(${obj}, ${value})`, false)
  }

  protected encode(value: string, encoded: boolean, pure: boolean = false, type?: Type) {
    return encoded ? super.encode(value, encoded, pure, type)
      : (encoded === this.isEncoded() && !pure) ? value
        : this.asEncoded(this.transform(`(${value} ->> '$')`, type, 'decode'), pure ? undefined : false)
  }

  protected createAggr(expr: any, aggr: (value: string) => string, nonaggr?: (value: string) => string) {
    if (!this.state.group && !nonaggr) {
      const value = this.parseEval(expr, false)
      return `(select ${aggr(escapeId('value'))} from json_each(${value}) ${randomId()})`
    } else {
      return super.createAggr(expr, aggr, nonaggr)
    }
  }

  protected groupArray(value: string) {
    const res = this.isEncoded() ? `('[' || group_concat(${value}) || ']')` : `('[' || group_concat(json_quote(${value})) || ']')`
    return this.asEncoded(`ifnull(${res}, json_array())`, true)
  }

  protected transformJsonField(obj: string, path: string) {
    return this.asEncoded(`(${obj} -> '$${path}')`, true)
  }
}
