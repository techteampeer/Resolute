// Cloud Run entrypoint: build the app and listen on $PORT (8080).
import { createServer } from './server.js'
import { config } from './config.js'

createServer().listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`)
})
