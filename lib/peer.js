export default class Peer {
  /**
   * @param {{
   *   polite: boolean,
   *   trickle: boolean,
   *   iceServers: RTCIceServer[]
   *   signal: AbortSignal
   * }} [options]
   */
  constructor (options = {}) {
    let { polite = true, trickle = true } = options

    let { port1, port2 } = new MessageChannel()
    let send = msg => port2.postMessage(JSON.stringify(msg))

    const pc = new RTCPeerConnection({
      iceServers: this.getIceServers(), // Use the dynamically generated ICE servers
      sdpSemantics: 'unified-plan',
      iceTransportPolicy: 'all'
    })

    const ctrl = new AbortController()
    const signal = { signal: ctrl.signal }

    pc.addEventListener('iceconnectionstatechange', () => {
      if (
        pc.iceConnectionState === 'disconnected' ||
        pc.iceConnectionState === 'failed'
      ) {
        ctrl.abort()
      }
    }, signal)

    const dc = pc.createDataChannel('both', { negotiated: true, id: 0 })

    this.pc = pc
    this.dc = dc
    this.signal = ctrl.signal
    this.polite = polite
    this.signalingPort = port1

    this.ready = new Promise(resolve => {
      dc.addEventListener('open', () => {
        trickle = true
        send = (msg) => dc.send(JSON.stringify(msg))
        port1.close()
        port2.close()
        this.ready = port2 = port1 = port2.onmessage = null
        resolve()
      }, { once: true, ...signal })
    })

    pc.addEventListener('icecandidate', ({ candidate }) => {
      trickle && send({ candidate })
    }, { ...signal })

    // Polite peer negotiation logic
    let makingOffer = false; let ignoreOffer = false

    pc.addEventListener('negotiationneeded', async () => {
      makingOffer = true
      const offer = await pc.createOffer()
      if (pc.signalingState !== 'stable') return
      await pc.setLocalDescription(offer)
      makingOffer = false
      if (trickle) {
        send({ description: pc.localDescription })
      } else {
        await waitToCompleteIceGathering(pc)
        const description = pc.localDescription.toJSON()
        description.sdp = description.sdp.replace(/a=ice-options:trickle\s\n/g, '')
        send({ description })
      }
    }, { ...signal })

    async function onmessage ({ data }) {
      const { description, candidate } = typeof data === 'string' ? JSON.parse(data) : data

      if (description) {
        const offerCollision = description.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable')

        ignoreOffer = !this.polite && offerCollision
        if (ignoreOffer) {
          return
        }

        if (offerCollision) {
          await pc.setLocalDescription({ type: 'rollback' })
          await pc.setRemoteDescription(description)
        } else {
          try {
            (description.type === 'answer' && pc.signalingState === 'stable') ||
              await pc.setRemoteDescription(description)
          } catch (err) { }
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer())
          if (!trickle) await waitToCompleteIceGathering(pc, 'new')
          send({ description: pc.localDescription })
        }
      } else if (candidate) {
        await pc.addIceCandidate(candidate)
      }
    }

    port2.onmessage = onmessage.bind(this)
    dc.addEventListener('message', onmessage.bind(this), { ...signal })
  }

  getIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:freestun.net:3478' },
      { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' }
    ];
  }
}

function waitToCompleteIceGathering (pc, state = pc.iceGatheringState) {
  return state !== 'complete' && new Promise(resolve => {
    pc.addEventListener('icegatheringstatechange', () => (pc.iceGatheringState === 'complete') && resolve())
  })
}
