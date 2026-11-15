// A query: standard XPath's forward part, phase 1 (README.md): steps by
// name, `*` and `.`; filters on a node's leaves; name(), starts-with(),
// contains(). Generic, as select is: the tree is reached only through what
// is handed in.
//
//   query(tree, root, text) -> { found, stopped }
//     tree.children(node)   a node's children, [name, child] pairs, or null
//                           for a leaf (as select's)
//     tree.document(node)   optional: the node's document, a plain value
//                           (an object, usually), or null when it has none
//     tree.stop(ref)        optional: truthy where the query must not go on
//                           from a node (a link to elsewhere): what it says
//                           is handed back
//     tree.match(name, step) optional: replaces exact matching of a name
//     tree.step(event, data, fn) optional: each round run through it, to
//                           be measured by who calls (event: segment,
//                           filter; data a function of the round's result)
//     found     the nodes selected, references: { path, node }, the node
//               as children gave it (nothing of it read); inside a
//               document: { path, value }
//     stopped   where it had to stop with some of the query left:
//               { path, node, rest, why }: rest the query's text from
//               there on, for who goes on elsewhere
//
// Parse, process and continue: enough of the text is read to have a
// segment (steps, up to a filter or the end), it is processed, then the
// next bit is read. A segment only walks: it reads no document. A filter is
// where documents are read. Between two rounds there is a set of references
// and the rest of the text.
//
// A node's document continues the tree below it: a step that names no
// child is looked for in the document (its keys), and goes on inside it, an
// object's keys its children, a leaf its value. `*` selects children; of a
// node without any, the keys of its document.

const INSIDE = Symbol('inside a document')
const inside = value => ({ [INSIDE]: true, value })
const isInside = node => node !== null && typeof node === 'object' && node[INSIDE] === true
const isObject = v => v !== null && typeof v === 'object'
const keysOf = v => (Array.isArray(v) ? v.map((x, i) => [String(i), x]) : isObject(v) ? Object.entries(v) : [])
const exact = (name, step) => name === step
const fail = (text, at, what) => new Error(`not a query: ${what} (${text.slice(0, at)}>>>${text.slice(at)})`)

// --- reading the text ---

// The index after the bracket that closes the one at `open`, quotes minded.
function closing (text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '\'' || c === '"') quote = c
    else if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i + 1
  }
  throw fail(text, open, quote ? 'a quote not closed' : 'a filter not closed')
}

// The steps of a segment: text up to a filter or the end -> { steps, at }:
// at the index it ended (a '[', or the end).
function segment (text, from) {
  let at = from
  while (at < text.length && text[at] !== '[') at++
  const steps = text.slice(from, at).split('/').filter(Boolean)
  for (const s of steps) if (/[\]()=<>!,'"|\s]/.test(s) || s.startsWith('@')) throw fail(text, from, `not a step: ${s}`)
  return { steps, at }
}

// A filter's expression, between its brackets -> a tree of
//   { or: [..] } | { and: [..] } | { not: e } | { compare: op, left, right }
//   | { exists: operand }
// an operand: { literal } | { path: [steps] } | { fn, args }
const OPS = ['!=', '<=', '>=', '=', '<', '>']
const FUNCTIONS = { name: 0, 'starts-with': 2, contains: 2 }
function expression (text, from, to) {
  let at = from
  const space = () => { while (at < to && /\s/.test(text[at])) at++ }
  const word = w => { space(); const m = text.slice(at, to).match(new RegExp(`^${w}(?![\\w-])`)); if (!m) return false; at += w.length; return true }
  const sign = s => { space(); if (text.startsWith(s, at) && at + s.length <= to) { at += s.length; return true } return false }
  const expect = s => { if (!sign(s)) throw fail(text, at, `expected ${s}`) }

  function operand () {
    space()
    if (at >= to) throw fail(text, at, 'something expected')
    const c = text[at]
    if (c === '\'' || c === '"') {
      const end = text.indexOf(c, at + 1)
      if (end < 0 || end >= to) throw fail(text, at, 'a quote not closed')
      const literal = text.slice(at + 1, end)
      at = end + 1
      return { literal }
    }
    const number = text.slice(at, to).match(/^-?\d+(\.\d+)?(?![\w-])/)
    if (number) { at += number[0].length; return { literal: Number(number[0]) } }
    const call = text.slice(at, to).match(/^([a-z][a-z-]*)\s*\(/)
    if (call) {
      const fn = call[1]
      if (!(fn in FUNCTIONS)) throw fail(text, at, `not a function of this phase: ${fn} (${Object.keys(FUNCTIONS).join(', ')}; not)`)
      at += call[0].length
      const args = []
      space()
      if (text[at] !== ')') { args.push(operand()); while (sign(',')) args.push(operand()) }
      expect(')')
      if (args.length !== FUNCTIONS[fn]) throw fail(text, at, `${fn}() takes ${FUNCTIONS[fn]} argument${FUNCTIONS[fn] === 1 ? '' : 's'}`)
      return { fn, args }
    }
    // a path: steps, relative to the node filtered
    const m = text.slice(at, to).match(/^[^\s=<>!,()'"|[\]]+/)
    if (!m) throw fail(text, at, 'a leaf, a value or a function expected')
    at += m[0].length
    if (text[at] === '[') throw fail(text, at, 'a filter inside a filter: not in this phase')
    const steps = m[0].split('/').filter(Boolean).map(s => (s.startsWith('@') ? s.slice(1) : s))
    if (!steps.length) throw fail(text, at, 'a leaf expected')
    return { path: steps }
  }

  function comparison () {
    const left = operand()
    space()
    const op = OPS.find(o => text.startsWith(o, at) && at + o.length <= to)
    if (!op) return { exists: left }
    at += op.length
    return { compare: op, left, right: operand() }
  }

  function unary () {
    space()
    const call = text.slice(at, to).match(/^not\s*\(/)
    if (call) { at += call[0].length; const e = or(); expect(')'); return { not: e } }
    if (text[at] === '(') { at++; const e = or(); expect(')'); return e }
    return comparison()
  }
  function and () { const all = [unary()]; while (word('and')) all.push(unary()); return all.length === 1 ? all[0] : { and: all } }
  function or () { const all = [and()]; while (word('or')) all.push(and()); return all.length === 1 ? all[0] : { or: all } }

  const e = or()
  space()
  if (at < to) throw fail(text, at, 'not understood')
  return e
}

// --- processing ---

export async function query (tree, root, text) {
  if (typeof text !== 'string') throw new Error('not a query: its text')
  const match = tree.match ?? exact
  const round = tree.step ?? ((event, data, fn) => fn())
  const documents = new Map()
  // a node's document, read once a query
  const documentOf = async ref => {
    if (!tree.document || isInside(ref.node)) return null
    if (!documents.has(ref.node)) documents.set(ref.node, (await tree.document(ref.node)) ?? null)
    return documents.get(ref.node)
  }
  const nameOf = ref => ref.path.slice(ref.path.lastIndexOf('/') + 1)
  const at = (ref, name) => (ref.path === '/' ? '' : ref.path) + '/' + name

  // One step from one reference -> the references it leads to.
  async function take (ref, step) {
    if (step === '.') return [ref]
    if (isInside(ref.node)) {
      return keysOf(ref.node.value).filter(([k]) => step === '*' || k === step).map(([k, v]) => ({ path: at(ref, k), node: inside(v) }))
    }
    const children = (await tree.children(ref.node)) || []
    const found = children.filter(([n]) => step === '*' || match(n, step)).map(([n, child]) => ({ path: at(ref, n), node: child }))
    if (found.length || (step === '*' && children.length)) return found
    // nothing of that name in the tree: the node's document goes on below it
    const doc = await documentOf(ref)
    return keysOf(doc).filter(([k]) => step === '*' || k === step).map(([k, v]) => ({ path: at(ref, k), node: inside(v) }))
  }

  // A filter's operand at a node -> its values (those of the nodes a path
  // leads to: leaves; a node that is no leaf has no value).
  async function values (ref, operand) {
    if ('literal' in operand) return [operand.literal]
    if (operand.fn === 'name') return [nameOf(ref)]
    if (operand.fn) {
      const [a, b] = await Promise.all(operand.args.map(x => values(ref, x)))
      if (!a.length || !b.length) return [false]
      const [x, y] = [String(a[0]), String(b[0])]
      return [operand.fn === 'starts-with' ? x.startsWith(y) : x.includes(y)]
    }
    let refs = [ref]
    for (const step of operand.path) refs = (await Promise.all(refs.map(r => take(r, step)))).flat()
    return refs.map(r => (isInside(r.node) && !isObject(r.node.value) ? r.node.value : undefined)).filter(v => v !== undefined)
  }
  // a path's nodes, for [path]: is anything there
  async function reaches (ref, operand) {
    if (!operand.path) return (await values(ref, operand)).some(Boolean)
    let refs = [ref]
    for (const step of operand.path) refs = (await Promise.all(refs.map(r => take(r, step)))).flat()
    return refs.length > 0
  }
  const COMPARE = {
    '=': (a, b) => a === b,
    '!=': (a, b) => a !== b,
    '<': (a, b) => a < b,
    '<=': (a, b) => a <= b,
    '>': (a, b) => a > b,
    '>=': (a, b) => a >= b
  }
  async function holds (ref, e) {
    if (e.or) { for (const x of e.or) if (await holds(ref, x)) return true; return false }
    if (e.and) { for (const x of e.and) if (!await holds(ref, x)) return false; return true }
    if (e.not) return !await holds(ref, e.not)
    if (e.exists) return reaches(ref, e.exists)
    const [left, right] = [await values(ref, e.left), await values(ref, e.right)]
    // as XPath compares: numbers when a side is one, or the order is asked;
    // else as text; true when any pair holds
    const numeric = ['<', '<=', '>', '>='].includes(e.compare) || [...left, ...right].some(v => typeof v === 'number')
    const as = v => (numeric ? Number(v) : String(v))
    return left.some(a => right.some(b => COMPARE[e.compare](as(a), as(b))))
  }

  let refs = [{ path: '/', node: root }]
  const stopped = []
  let at0 = 0
  while (at0 < text.length) {
    if (text[at0] === '[') {
      // a filter: the documents read, the set made smaller
      const end = closing(text, at0)
      const e = expression(text, at0 + 1, end - 1)
      const before = refs.length
      refs = await round('filter', kept => ({ filter: text.slice(at0, end), in: before, out: kept.length }), async () => {
        const kept = []
        for (const ref of refs) if (await holds(ref, e)) kept.push(ref)
        return kept
      })
      at0 = end
      continue
    }
    // a segment: steps walked, a reference each node, nothing read
    const { steps, at: end } = segment(text, at0)
    const from = at0
    const before = refs.length
    refs = await round('segment', next => ({ steps: steps.join('/'), in: before, out: next.length }), async () => {
      let now = refs
      let done = from
      for (const step of steps) {
        // where the text of this step starts: what is left from here on
        done = text.indexOf(step, done)
        const next = []
        for (const ref of now) {
          const why = step !== '.' && tree.stop && !isInside(ref.node) ? await tree.stop(ref) : null
          if (why) { stopped.push({ path: ref.path, node: ref.node, rest: text.slice(done), why }); continue }
          next.push(...await take(ref, step))
        }
        now = next
        done += step.length
      }
      return now
    })
    at0 = end
  }
  return {
    found: refs.map(r => (isInside(r.node) ? { path: r.path, value: r.node.value } : { path: r.path, node: r.node })),
    stopped
  }
}
