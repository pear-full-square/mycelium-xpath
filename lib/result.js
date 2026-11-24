// XPathResult: what a query hands back. The result of an XPath as an
// iterator (the standard's iterator form: the next node asked for, fetched
// as it goes), over a node set (lib/nodeset.js). It is where logical and
// physical meet: whoever reads it sees the logical side only, a sequence
// of nodes at their logical addresses; underneath it turns the logical
// query into the physical queries that fetch its slices (the storage's
// structure type gives them, mycelium-xpath-physical), runs them when the
// reading reaches the end of the slice in hand, and gives each node found
// its logical address. How many nodes a reader takes is the reader's own:
// it has nothing to do with the slices.
//   new XPathResult(logical, { physical, fixed, next, took, run, address, observe })
//     logical   { query, mode, layer }: the request
//     physical  { type, ... }: its storage's structure type and what its
//               generator needs ({ type: 'tree' } when none is given)
//     fixed     the moment it is made (a topic: its latest offset)
//     next, took         the structure type's (mycelium-xpath-physical)
//     run(text)          a physical query executed: { found, stopped }
//     address(set, path) a stored path as its logical address (the
//                        structure type's; the path itself when none)
//     observe(event, fn) optional: each physical query run through it
//   result.nodeset        the node set, as data: what was asked, how far it
//                         is read, its storage, what is loaded
//   result.stopped        where it stopped at a shortcut
//   await result.iterateNext()  the next node: { path, stored, node } or
//                         { path, stored, value }: path its logical
//                         address, stored where it is stored; null at
//                         the end
//   await result.slice()  the nodes of its next slice: what one answer carries
//   result.metadata       its node set as data, its nodes left out
//   await result.take(n)  the next n, fewer at the end
//   await result.all()    every node left
//   for await (const node of result)
import { nodeset, reader } from './nodeset.js'

export class XPathResult {
  #reading
  #at = 0
  #address
  // (id: the node set's identity; resume: a node set's data (its metadata,
  // from who holds it): the result goes on from where that one has read
  // to, its nodes those fetched from here on)
  constructor (logical, { physical = { type: 'tree' }, fixed = null, id = null, resume = null, next, took, run, address = (set, path) => path, observe } = {}) {
    this.nodeset = resume
      ? { id: resume.id ?? null, logical: resume.logical, fixed: resume.fixed ?? null, reached: resume.reached ?? null, physical: resume.physical, nodes: [], stopped: [], done: resume.done === true }
      : nodeset(logical, physical, fixed, id)
    this.#reading = reader(this.nodeset, { next, took, run, ...(observe ? { observe } : {}) })
    this.#address = address
  }

  // its node set as data, its nodes left out: what travels with a slice
  get metadata () {
    const { id, logical, fixed, reached, physical, done } = this.nodeset
    return { id, logical, fixed, reached, physical, done }
  }

  // one slice: what the next physical batch gives (several, where a batch
  // gives nothing of what is asked and there is more)
  async slice () {
    const out = []
    while (!out.length && !this.nodeset.done) {
      await this.#reading.more()
      for (let node; this.#at < this.nodeset.nodes.length && (node = await this.iterateNext()) !== null;) out.push(node)
    }
    return out
  }

  get stopped () { return this.nodeset.stopped }
  // read to its end: nothing left to fetch, nothing left to hand over
  get done () { return this.nodeset.done && this.#at >= this.nodeset.nodes.length }

  async iterateNext () {
    // the slice in hand used up: the next fetched, under the hood
    while (this.#at >= this.nodeset.nodes.length && !this.nodeset.done) await this.#reading.more()
    if (this.#at >= this.nodeset.nodes.length) return null
    const { path, ...rest } = this.nodeset.nodes[this.#at++]
    return { path: this.#address(this.nodeset, path), stored: path, ...rest }
  }

  async take (n) {
    const out = []
    for (let node; out.length < n && (node = await this.iterateNext()) !== null;) out.push(node)
    return out
  }

  all () { return this.take(Infinity) }

  async * [Symbol.asyncIterator] () {
    for (let node; (node = await this.iterateNext()) !== null;) yield node
  }
}

// A result held by who asked, outside the request that made it: an answer
// carries a node set's metadata and one slice of its nodes, as they were
// answered ({ nodeset, nodes }); iterated the same way; at the end of the
// slice in hand the next is asked for under the hood, more(metadata) ->
// the next answer, merged by the node set's id. A plain answer (an array:
// all of it) is a result with nothing more to ask.
//   const result = answered(answer, more)
//   await result.iterateNext(), take(n), all(), for await: as XPathResult
//   result.nodeset   the metadata as last answered
export function answered (answer, more = null) {
  let set = Array.isArray(answer) ? { id: null, done: true } : answer.nodeset
  let nodes = Array.isArray(answer) ? [...answer] : [...answer.nodes]
  let at = 0
  const self = {
    get nodeset () { return set },
    get done () { return set.done && at >= nodes.length },
    async iterateNext () {
      while (at >= nodes.length && !set.done) {
        if (!more) throw new Error('a result with more to ask and no way to ask it')
        const next = await more(set)
        if (next?.nodeset?.id !== set.id) throw new Error(`not a slice of this node set: ${next?.nodeset?.id} (${set.id})`)
        set = next.nodeset
        nodes = [...next.nodes]
        at = 0
      }
      return at < nodes.length ? nodes[at++] : null
    },
    async take (n) { const out = []; for (let node; out.length < n && (node = await self.iterateNext()) !== null;) out.push(node); return out },
    all: () => self.take(Infinity),
    async * [Symbol.asyncIterator] () { for (let node; (node = await self.iterateNext()) !== null;) yield node }
  }
  return self
}
