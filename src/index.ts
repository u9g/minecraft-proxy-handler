import { Client, ClientOptions as protocolClientOptions, createClient, createServer, Server, ServerClient, states, ServerOptions as protocolServerOptions, PacketMeta } from 'minecraft-protocol'
import TypedEmitter from 'typed-emitter'
import { EventEmitter } from 'events'

interface MinecraftLogin {
  username: string
  password?: string
  auth?: 'mojang' | 'microsoft'
}

interface ServerOptions {
  loginHandler: (client: Client) => MinecraftLogin
  serverOptions?: protocolServerOptions
  clientOptions?: Partial<protocolClientOptions>
}

interface ProxyEvents {
  incoming: (data: any, meta: PacketMeta, toClient: ServerClient, toServer: Client) => void
  outgoing: (data: any, meta: PacketMeta, toClient: ServerClient, toServer: Client) => void
  start: (toClient: ServerClient, toServer: Client) => void
  end: (username: string) => void
}

export default class ProxyHandler extends (EventEmitter as new () => TypedEmitter<ProxyEvents>) {
  options: ServerOptions
  server?: Server
  toServerClients: Map<number, Client>

  constructor (options: ServerOptions) {
    super()
    this.options = options
    this.toServerClients = new Map<number, Client>()
    this.server = createServer({
      'online-mode': true,
      keepAlive: false,
      ...this.options.serverOptions
    })
    this.server.on('login', client => this.onLogin(client))
  }

  onLogin (toClient: ServerClient): void {
    // until the proxyClient logs in, lets send a login packet
    toClient.write('login', {
      entityId: toClient.id,
      gameMode: 0,
      dimension: 0,
      difficulty: 1,
      maxPlayers: 20,
      levelType: 'default',
      reducedDebugInfo: false
    })

    const toServer = createClient({
      ...this.options.clientOptions,
      keepAlive: false,
      ...this.options.loginHandler(toClient)
    })

    this.toServerClients.set(toClient.id, toServer)

    toServer.on('login', (data) => {
      if (!this.clientIsOnline(toClient)) return
      this.emit('start', toClient, toServer)
      const dimension = data.dimension === 0 ? -1 : 0
      toClient.write('respawn', {
        dimension,
        difficulty: data.difficulty,
        gamemode: data.gameMode,
        levelType: data.levelType
      })
      toClient.write('respawn', {
        dimension: data.dimension,
        difficulty: data.difficulty,
        gamemode: data.gameMode,
        levelType: data.levelType
      })
    })

    toClient.on('packet', (data, meta) => {
      if (!this.clientIsOnline(toClient)) return
      if (toServer.state === states.PLAY && meta.state === states.PLAY) {
        this.emit('outgoing', data, meta, toClient, toServer)
      }
    })

    toServer.on('packet', (data, meta) => {
      if (!this.clientIsOnline(toClient)) return
      if (meta.name === 'disconnect') {
        toClient.write('kick_disconnect', data)
      }
      if (meta.state === states.PLAY && toClient.state === states.PLAY) {
        if (meta.name === 'set_compression') {
          toClient.compressionThreshold = data.threshold // Set compression
          return
        }
        this.emit('incoming', data, meta, toClient, toServer)
      }
    })
    toClient.once('end', () => {
      this.emit('end', toServer.username)
      this.clientEnd(toClient)
    })
  }

  clientEnd (client: ServerClient): void {
    this.toServerClients.get(client.id)?.end()
    this.toServerClients.delete(client.id)
  }

  clientIsOnline (client: ServerClient): boolean {
    return !((this.server?.clients[client.id]) == null)
  }
}
