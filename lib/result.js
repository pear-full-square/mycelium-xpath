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
//   await result.take(n)  the next n, fewer at the end
//   await result.all()    every node left
//   for await (const node of result)
import { nodeset, reader } from './nodeset.js'

export class XPathResult {
  #reading
  #at = 0
  #address
  constructor (logical, { physical = { type: 'tree' }, fixed = null, next, took, run, address = (set, path) => path, observe } = {}) {
    this.nodeset = nodeset(logical, physical, fixed)
    this.#reading = reader(this.nodeset, { next, took, run, ...(observe ? { observe } : {}) })
    this.#address = address
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
