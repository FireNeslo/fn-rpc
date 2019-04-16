import value, { api } from 'fn-reval'

api.pipe = function pipe(output) {
  this(output)
  return output
}

export function duplex(read, write) {
  const target = value()

  read(target)
  
  function duplexer(value) {
    if(typeof value === 'function') {
      return read(value)
    } else {
      return write(value)
    }
  }
  return Object.assign(duplexer, target)
}

const PROXY = Symbol('proxy')
const GRAPH = Symbol('graph')

class Command {
  constructor(type, graph, target) {
    this.id = graph.nodes.push(this) - 1
    this.type = type
    this.target = target
    this[GRAPH] = graph
  }
  valueOf() {
    return this.id
  }
}

class Apply extends Command {
  constructor(graph, target, self, args, refs) {
    super('apply', graph, target)
    this.self = self
    this.args = args
    this.refs = refs
  }
}
class Get extends Command {
  constructor(graph, target, key) {
    super('get', graph, target)
    this.key = key
  }
}
class Set extends Command {
  constructor(graph, target, key, value, refs) {
    super('set', graph, target)
    this.key = key
    this.value = value
    this.refs = refs
  }
}

let CALLBACKS = new WeakMap()

function deref(value, graph, refs = [], path = []) {
  if(Array.isArray(value)) {
    return value.map((item, key) => deref(item, graph, refs, path.concat([ key ])))
  } else if(typeof value === 'object') {
    if(value === null) return value

    const target = {}

    for(const [ key, val ] of Object.entries(value)) {
      target[key] = deref(val, graph, refs, path.concat([ key ]))
    }

    return target
  } else if(typeof value === 'function') {
    const proxy = value[PROXY]

    refs.push(path.join('.'))

    if(proxy) return +proxy

    if(CALLBACKS.has(value)) {
      return +CALLBACKS.get(value)
    }
    
    const callback = graph.port(new Command('callback', graph))

    CALLBACKS.set(value, callback)

    graph.context[callback.id] = value  

    return +callback
  }

  return value
}

function reref(value, refs, context) {
  for(const ref of refs) {
    const keys = ref.split('.')
    const key = keys.pop()
    
    if(!key) {
      return context[value]
    }
    
    let val = value

    for(const key of keys) {
      val = val[key]
    }
    val[key] = context[val[key]]
  }

  return value
}

function createClient(graph, value = new Command('root', graph)) {
  function apply(...args) {
    const refs = []
    const params = deref(args, graph, refs)
    const apply = new Apply(graph, +value, +this[PROXY], params, refs)

    const proxy = createClient(graph, graph.port(apply))
    
    if(value.key === 'then') {
      graph.context[graph.nodes.length] = 'then'
    }

    return proxy
  }

  return new Proxy(apply, {
    get(_, key, context) {
      if(key === PROXY) {
        return value
      }

      if(key === 'then' && graph.context[value.id] === 'then') {
        return
      }

      return createClient(graph, graph.port(new Get(graph, +context[PROXY], key)))
    },
    set(_, key, value, context) {
      const refs = []
      const val = deref(value, graph, refs)

      return createClient(graph, graph.port(new Set(graph, +context[PROXY], key, val, refs)))
    }
  })
}

export function load(value) {
  const proxy = value[PROXY]
  const graph = proxy[GRAPH]

  return new Promise(resolve => {
    graph.context[+proxy] = resolve
    graph.port(new Command('fetch', graph, +proxy))
  })
}

export function dispose(value) {
  const proxy = value[PROXY]
  const graph = proxy[GRAPH]

  graph.nodes = []
  graph.context = {}
  graph.port(new Command('dispose', graph, +proxy))
}

export function create(api) {
  const output = value()
  const graph = window.graph = { nodes: [], context: {}, port: output }
  const client = createClient(graph)
  const context = [ api ]

  function read(target) {
    output(target)
  }

  function write(command) {
    switch(command.type) {
      case "get":
        if(command.key === 'then') {
          const value = Promise.resolve(context[command.target])
          context[command.id] = value[command.key].bind(value)
        } else {
          context[command.id] = context[command.target][command.key]
        }
      break;
      case "set":
        context[command.id] = context[command.target][command.key] = reref(command.value, command.refs, context)
      break;
      case "apply":
        context[command.id] = context[command.target].apply(context[command.self], reref(command.args, command.refs, context))
      break;
      case "callback":
        let counter = 0

        context[command.id] = function callback(...args) {
          const value = args.map(arg => {
            const id = counter++
            callback[id] = arg
            return id
          })
          
          output({ type: 'event', target: command.id, value })
        }
      break;
      case "event":
        const args = command.value.map(id => {
          return createClient(graph, output(new Get(graph, command.target, id)))
        })

        graph.context[command.target](...args)
      break;
      case "fetch":
        Promise.resolve(context[command.target]).then(value => {
          output({ type: 'load', target: command.target, value })
        })
      break;
      case "load":
        graph.context[command.target](command.value)
      break;
      case "dispose":
        context.splice(0, context.length, api)
      break;
    }
    return output
  }

  
  
  return [ duplex(read, write), client ]
}


async function exec(proxy, iterator, next) {
  let { value, done } = await next

  
  if(value && value[PROXY]) {
    value = await load(value)
  }

  if(done) {
    dispose(proxy)
    return value
  }

  return exec(proxy, iterator, iterator.next(value))
}

export default function rpc(api, generator) {

  const [ port, proxy ] = create(api)

  const iterator = generator(proxy) 

  return [ port, exec(proxy, iterator, Promise.resolve({})) ]
}