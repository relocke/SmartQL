import http from 'http'
import fetch from 'node-fetch'
import SmartQL from '../smartql.js'

const host = 'localhost'
const port = 8080

const requestListener = function (req, res) {
  req.on('data', async d => {
    const smartql_rpc = { fetch: await fetch, rpc_url: 'http://127.0.0.1:8888' }

    const { query } = JSON.parse(d.toString())

    const data = await SmartQL(
      { query },
      {
        contracts: ['relockeblock'],
        private_keys: [process.env.developer_pk]
      },
      smartql_rpc
    )

    res.setHeader('Content-Type', 'application/json').end(JSON.stringify(data))
  })
}

const server = http.createServer(requestListener)

server.listen(port, host, () => {
  console.log(`Server is running on http://${host}:${port}`)
})