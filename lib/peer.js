function waitToCompleteIceGathering(pc, state = pc.iceGatheringState) {
  return state !== 'complete' && new Promise(resolve => {
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', handler)
  })
}

export default class Peer {
  constructor(options = {}) {
    const { polite = true, trickle = true, maxParallel = 4 } = options

    // Server configuration
    const stunServers = [
      { urls: 'stun:stun01.sipphone.com' },
      { urls: 'stun:stun.ekiga.net' },
      { urls: 'stun:stun.fwdnet.net' },
      { urls: 'stun:stun.ideasip.com' },
      { urls: 'stun:stun.iptel.org' },
      { urls: 'stun:stun.rixtelecom.se' },
      { urls: 'stun:stun.schlund.de' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stunserver.org' },
      { urls: 'stun:stun.softjoys.com' },
      { urls: 'stun:stun.voiparound.com' },
      { urls: 'stun:stun.voipbuster.com' },
      { urls: 'stun:stun.voipstunt.com' },
      { urls: 'stun:stun.voxgratia.org' },
      { urls: 'stun:stun.xten.com' },
      { urls: 'stun:something.meteredstun.ca:89032' }
    ]

    const turnServers = [
      {
        urls: 'turn:global.relay.metered.ca:80',
        username: 'f6507426c0f4f89d0bda02e2',
        credential: '7YF0907XexAfvkbL'
      },
      {
        urls: 'turn:global.relay.metered.ca:80?transport=tcp',
        username: 'f6507426c0f4f89d0bda02e2',
        credential: '7YF0907XexAfvkbL'
      },
      {
        urls: 'turn:global.relay.metered.ca:443',
        username: 'f6507426c0f4f89d0bda02e2',
        credential: '7YF0907XexAfvkbL'
      },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: 'f6507426c0f4f89d0bda02e2',
        credential: '7YF0907XexAfvkbL'
      },
      {
        urls: 'turn:numb.viagenie.ca',
        credential: 'muazkh',
        username: 'webrtc@live.com'
      },
      {
        urls: 'turn:192.158.29.39:3478?transport=udp',
        credential: 'JZEOEt2V3Qb0y27GRntt2u2PAYA=',
        username: '28224511:1379330808'
      },
      {
        urls: 'turn:192.158.29.39:3478?transport=tcp',
        credential: 'JZEOEt2V3Qb0y27GRntt2u2PAYA=',
        username: '28224511:1379330808'
      }
    ]

    // Track all event listeners
    this.listeners = new Map()

    // Main connection
    const pc = new RTCPeerConnection({ iceServers: stunServers })
    this.pc = pc

    // Parallel connections
    this.parallelPCs = []
    const connectionPool = [pc]

    // Create parallel connections
    const createParallelConnection = (servers) => {
      const pc = new RTCPeerConnection({ iceServers: servers })
      pc.createDataChannel('parallel')
      return pc
    }

    // Initialize parallel connections
    stunServers.slice(0, maxParallel).forEach(server => {
      const parallelPC = createParallelConnection([server])
      this.parallelPCs.push(parallelPC)
      connectionPool.push(parallelPC)
    })

    // TURN fallback connection
    const turnPC = createParallelConnection(turnServers)
    let usingTurn = false

    // Shared candidate handler
    const handleCandidate = (candidate, sourcePC) => {
      if (!candidate) return
      connectionPool.forEach(pc => {
        if (pc !== sourcePC && pc.connectionState !== 'closed') {
          pc.addIceCandidate(candidate).catch(() => {})
        }
      })
    }

    // Track event listeners
    const addListener = (target, type, listener, options) => {
      target.addEventListener(type, listener, options)
      const listeners = this.listeners.get(target) || []
      listeners.push({ type, listener })
      this.listeners.set(target, listeners)
    }

    // Setup ICE candidates
    const setupIceHandlers = (pc) => {
      addListener(pc, 'icecandidate', ({ candidate }) => {
        handleCandidate(candidate, pc)
      })
    }

    connectionPool.forEach(setupIceHandlers)
    setupIceHandlers(turnPC)

    // Connection state management
    const ctrl = new AbortController()
    this.signal = ctrl.signal

    addListener(pc, 'iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed' && !usingTurn) {
        console.log('Activating TURN fallback')
        usingTurn = true
        pc.setConfiguration({ iceServers: [...stunServers, ...turnServers] })
        connectionPool.push(turnPC)
        turnPC.createOffer().then(offer => turnPC.setLocalDescription(offer))
      }

      if (['disconnected', 'failed'].includes(pc.iceConnectionState)) {
        this.cleanup()
      }
    })

    // Data channel setup
    const dc = pc.createDataChannel('main', { negotiated: true, id: 0 })
    this.dc = dc

    const { port1, port2 } = new MessageChannel()
    this.signalingPort = port1
    let send = msg => port2.postMessage(JSON.stringify(msg))

    // Ready promise
    this.ready = new Promise(resolve => {
      addListener(dc, 'open', () => {
        send = msg => dc.send(JSON.stringify(msg))
        port1.close()
        port2.close()
        this.cleanupParallel()
        resolve()
      }, { once: true })
    })

    // Negotiation needed handler
    let makingOffer = false, ignoreOffer = false

    addListener(pc, 'negotiationneeded', async () => {
      makingOffer = true
      const offer = await pc.createOffer()
      if (pc.signalingState !== 'stable') return
      await pc.setLocalDescription(offer)
      makingOffer = false
      send({ description: pc.localDescription })
    })

    // Message handling
    const messageHandler = async ({ data }) => {
      const msg = typeof data === 'string' ? JSON.parse(data) : data
      
      if (msg.description) {
        const description = msg.description
        const offerCollision = description.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable')

        ignoreOffer = !this.polite && offerCollision
        if (ignoreOffer) return

        if (offerCollision) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(description)
          ])
        } else {
          try {
            await pc.setRemoteDescription(description)
          } catch (err) { console.error('Set remote description failed:', err) }
        }

        if (description.type === 'offer') {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          send({ description: pc.localDescription })
        }
      } else if (msg.candidate) {
        connectionPool.forEach(pc => pc.addIceCandidate(msg.candidate))
      }
    }

    addListener(port2, 'message', messageHandler.bind(this))
    addListener(dc, 'message', messageHandler.bind(this))

    // Start parallel connections
    this.parallelPCs.forEach(pc => {
      pc.createOffer().then(offer => pc.setLocalDescription(offer))
    })
  }

  cleanup() {
    // Remove all event listeners
    this.listeners.forEach((listeners, target) => {
      listeners.forEach(({ type, listener }) => {
        target.removeEventListener(type, listener)
      })
    })
    this.listeners.clear()

    // Close connections
    this.cleanupParallel()
    this.pc.close()
    this.dc.close()
    this.signalingPort.close()

    // Clear references
    this.pc = null
    this.dc = null
    this.signalingPort = null
    this.parallelPCs = []
  }

  cleanupParallel() {
    this.parallelPCs.forEach(pc => {
      pc.close()
      // Remove any remaining listeners
      const listeners = this.listeners.get(pc) || []
      listeners.forEach(({ type, listener }) => {
        pc.removeEventListener(type, listener)
      })
    })
    this.parallelPCs = []
  }
}

window.Peer = Peer
