'use strict'

const sharkd_dict = require('../custom_module/sharkd_dict')

function parseValue(label = '') {
  const idx = label.indexOf(':')
  if (idx === -1) return ''
  return label.slice(idx + 1).trim()
}

function parseAvpsFromDiameterNode(diameterNode) {
  const rows = []

  function walkAvp(node, prefix = '') {
    if (!node || node.fn !== 'diameter.avp') return

    const label = node.l || ''
    const avpName = (label.split(':')[0] || '').trim() || 'Unknown-AVP'
    const pathName = prefix ? `${prefix} > ${avpName}` : avpName

    let flags = ''
    let content = parseValue(label)

    for (const child of node.n || []) {
      if (!child || typeof child !== 'object') continue
      if (child.fn === 'diameter.avp.flags') flags = parseValue(child.l)

      // For grouped AVP with no direct value, pick first meaningful leaf value
      if (!content && child.fn && !child.fn.startsWith('diameter.avp') && child.l && child.l.includes(':')) {
        content = parseValue(child.l)
      }
    }

    rows.push({
      avpName: pathName,
      avpContent: content || '',
      avpFlags: flags || ''
    })

    for (const child of node.n || []) {
      if (child && child.fn === 'diameter.avp') {
        walkAvp(child, pathName)
      }
    }
  }

  for (const child of diameterNode.n || []) {
    if (child && child.fn === 'diameter.avp') walkAvp(child)
  }

  return rows
}

function findDiameterNode(tree = []) {
  return tree.find((n) => n && typeof n === 'object' && typeof n.l === 'string' && n.l.startsWith('Diameter Protocol'))
}

module.exports = function (fastify, opts, next) {
  fastify.get('/webshark/diameter-avps', async function (request, reply) {
    try {
      const capture = request.query.capture
      const frame = request.query.frame

      if (!capture || !frame) {
        return reply.code(400).send({ err: 1, errstr: 'capture and frame are required' })
      }

      const raw = await sharkd_dict.send_req({
        method: 'frame',
        capture,
        frame,
        proto: true
      })

      const parsed = JSON.parse(raw)
      const diameterNode = findDiameterNode(parsed.tree || [])

      if (!diameterNode) {
        return reply.send({ capture, frame: Number(frame), rows: [], note: 'No Diameter protocol in this frame' })
      }

      const rows = parseAvpsFromDiameterNode(diameterNode)
      return reply.send({ capture, frame: Number(frame), rows })
    } catch (err) {
      return reply.code(500).send({ err: 1, errstr: err.message || 'diameter parse failed' })
    }
  })

  next()
}
