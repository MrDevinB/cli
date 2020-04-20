'use strict'

const os = require('os')
const path = require('path')
const pacote = require('pacote')
const table = require('text-table')
const color = require('ansicolors')
const styles = require('ansistyles')
const npa = require('npm-package-arg')
const pickManifest = require('npm-pick-manifest')
const uniqBy = require('lodash').uniqBy

const Arborist = require('@npmcli/arborist')

const npm = require('./npm.js')
const output = require('./utils/output.js')
const ansiTrim = require('./utils/ansi-trim.js')

cmd.usage = 'npm outdated [[<@scope>/]<pkg> ...]'
cmd.completion = require('./utils/completion/installed-deep.js')

module.exports = cmd
function cmd (args, silent, cb) {
  if (typeof cb !== 'function') {
    cb = silent
    silent = false
  }
  outdated(args, silent, cb)
    .then(() => cb())
    .catch(cb)
}

async function outdated (args, silent) {
  const opts = npm.flatOptions
  const global = path.resolve(npm.globalDir, '..')
  const where = opts.global
    ? global
    : npm.prefix

  const arb = new Arborist({
    ...opts,
    path: where
  })

  const tree = await arb.loadActual()

  const packageDeps = {
    ...tree.package.dependencies,
    ...tree.package.devDependencies,
    ...tree.package.optionalDependencies
  }
  const deps = !args.length ? Object.keys(packageDeps) : args
  const depth = opts.depth === Infinity ? 0 : opts.depth
  const list = await outdated_(tree, deps, depth)

  // sorts list alphabetically
  const outdated = list.sort((a, b) => a.name.localeCompare(b.name))

  // return if silent or no outdated packages
  if (silent || (list.length === 0 && !opts.json)) {
    return
  }

  // display results
  if (opts.json) {
    output(makeJSON(outdated, opts))
  } else if (opts.parseable) {
    output(makeParseable(outdated, opts))
  } else {
    const outList = outdated.map(x => makePretty(x, opts))
    const outHead = ['Package',
      'Current',
      'Wanted',
      'Latest',
      'Location'
    ]

    if (opts.long) outHead.push('Package Type', 'Homepage')
    const outTable = [outHead].concat(outList)

    if (opts.color) {
      outTable[0] = outTable[0].map(heading => styles.underline(heading))
    }

    const tableOpts = {
      align: ['l', 'r', 'r', 'r', 'l'],
      stringLength: s => ansiTrim(s).length
    }
    output(table(outTable, tableOpts))
  }

  process.exitCode = outdated.length ? 1 : 0
}

async function outdated_ (tree, deps, depth, root = '') {
  const list = []
  let sublist = []

  const prod = tree.package.dependencies
  const dev = tree.package.devDependencies
  const optional = tree.package.optional

  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i]
    const spec = npa(dep)
    const node = tree.children.get(dep)
    const location = root || tree.package.name

    const type = (
      (prod[dep] && 'dependencies') ||
      (dev[dep] && 'devDependencies') ||
      (optional[dep] && 'optionalDependencies')
    )

    try {
      let path, current, homepage, expected
      // if dep is installed
      if (node) {
        path = node.path
        current = node.package.version
        homepage = node.package.homepage
        expected = node.package[type] && node.package[type][dep]
      }

      const packument = await pacote.packument(spec, { 'prefer-online': true })
      const wanted = pickManifest(packument, expected)
      const latest = pickManifest(packument, 'latest')

      // devDependencies not currently installed
      // are not included in the output
      if (!current && type === 'devDependencies') continue

      if (
        !current ||
        current !== wanted.version ||
        wanted.version !== latest.version
      ) {
        list.push({
          name: dep,
          type,
          path,
          current,
          homepage,
          wanted: wanted.version,
          latest: latest.version,
          location
        })
      }
    } catch (err) {
      // silently catch and ignore ETARGET, E403 &
      // E404 errors, deps are just skipped
      if (!(
        err.code === 'ETARGET' ||
        err.code === 'E403' ||
        err.code === 'E404')
      ) {
        throw (err)
      }
    }

    // continue with deeper depths
    if (depth > 0) {
      if (node && type === 'dependencies') {
        const dependencies = Object.keys(node.package.dependencies || {})
        const sub = await outdated_(tree, dependencies, depth - 1, `${location} > ${node.name}`)
        sublist = uniqBy([...sublist, ...sub], 'name')
      }
    }
  }
  return [...list, ...sublist]
}

// formatting functions
function makePretty (dep, opts) {
  const {
    current = 'MISSING',
    location = 'global',
    homepage = '',
    name,
    wanted,
    latest,
    type
  } = dep

  const columns = [name, current, wanted, latest, location]

  if (opts.long) {
    columns[5] = type
    columns[6] = homepage
  }

  if (opts.color) {
    columns[0] = color[current === wanted ? 'yellow' : 'red'](columns[0]) // current
    columns[2] = color.green(columns[2]) // wanted
    columns[3] = color.magenta(columns[3]) // latest
  }

  return columns
}

// --parseable creates output like this:
// <fullpath>:<name@wanted>:<name@installed>:<name@latest>
function makeParseable (list, opts) {
  return list.map(dep => {
    const { name, current, wanted, latest, path, type, homepage } = dep
    const out = [
      path,
      name + '@' + wanted,
      current ? (name + '@' + current) : 'MISSING',
      name + '@' + latest
    ]
    if (opts.long) out.push(type, homepage)

    return out.join(':')
  }).join(os.EOL)
}

function makeJSON (list, opts) {
  const out = {}
  list.forEach(dep => {
    const { name, current, wanted, latest, path, type, homepage } = dep
    out[name] = {
      current,
      wanted,
      latest,
      location: path
    }
    if (opts.long) {
      out[name].type = type
      out[name].homepage = homepage
    }
  })
  return JSON.stringify(out, null, 2)
}
