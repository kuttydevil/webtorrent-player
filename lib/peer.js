const GEO_LOC_URL = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/geoip_cache.txt";
const IPV4_URL = "https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv4s.txt";
const GEO_USER_URL = "https://geolocation-db.com/json/";

async function getClosestStunServer() {
    const geoLocs = await (await fetch(GEO_LOC_URL)).json();
    const { latitude, longitude } = await (await fetch(GEO_USER_URL)).json();
    const closestAddr = (await (await fetch(IPV4_URL)).text()).trim().split('\n')
        .map(addr => {
            const [stunLat, stunLon] = geoLocs[addr.split(':')[0]];
            const dist = ((latitude - stunLat) ** 2 + (longitude - stunLon) ** 2) ** .5;
            return [addr, dist];
        }).reduce(([addrA, distA], [addrB, distB]) => distA <= distB ? [addrA, distA] : [addrB, distB])[0];
    console.log("Closest STUN Server:", closestAddr);
    return closestAddr;
}

export default class Peer {
    /**
     * @param {{
     *   polite: boolean,
     *   trickle: boolean,
     *   iceServers: RTCIceServer[]
     *   signal: AbortSignal
     * }} [options]
     */
    constructor(options = {}) {
        let { polite = true, trickle = true } = options;

        let { port1, port2 } = new MessageChannel();
        let send = msg => port2.postMessage(JSON.stringify(msg));

        const pc = new RTCPeerConnection({
            iceServers: this.getIceServers(),
            sdpSemantics: 'unified-plan',
            iceTransportPolicy: 'all'
        });

        const ctrl = new AbortController();

        /** @type {any} dummy alias for AbortSignal to make TS happy */
        const signal = { signal: ctrl.signal };

        pc.addEventListener('iceconnectionstatechange', () => {
            if (
                pc.iceConnectionState === 'disconnected' ||
                pc.iceConnectionState === 'failed'
            ) {
                ctrl.abort();
            }
        }, { ...signal });

        const dc = pc.createDataChannel('both', { negotiated: true, id: 0 });

        this.pc = pc;
        this.dc = dc;
        this.signal = ctrl.signal;
        this.polite = polite;
        this.signalingPort = port1;

        this.ready = new Promise(resolve => {
            dc.addEventListener('open', () => {
                trickle = true;
                send = (msg) => dc.send(JSON.stringify(msg));
                port1.close();
                port2.close();
                this.ready = port2 = port1 = port2.onmessage = null;
                resolve();
            }, { once: true, ...signal });
        });

        pc.addEventListener('icecandidate', ({ candidate }) => {
            trickle && send({ candidate });
        }, { ...signal });

        let makingOffer = false;
        let ignoreOffer = false;

        pc.addEventListener('negotiationneeded', async () => {
            makingOffer = true;
            const offer = await pc.createOffer();
            if (pc.signalingState !== 'stable') return;
            await pc.setLocalDescription(offer);
            makingOffer = false;
            if (trickle) {
                send({ description: pc.localDescription });
            } else {
                //await waitToCompleteIceGathering(pc); // Removed waitToCompleteIceGathering
                const description = pc.localDescription.toJSON();
                description.sdp = description.sdp.replace(/a=ice-options:trickle\s\n/g, '');
                send({ description });
            }
        }, { ...signal });

        async function onmessage({ data }) {
            const { description, candidate } = typeof data === 'string' ? JSON.parse(data) : data;

            if (description) {
                const offerCollision = description.type === 'offer' &&
                    (makingOffer || pc.signalingState !== 'stable');

                ignoreOffer = !this.polite && offerCollision;
                if (ignoreOffer) {
                    return;
                }

                if (offerCollision) {
                    await Promise.all([
                        pc.setLocalDescription({ type: 'rollback' }),
                        pc.setRemoteDescription(description)
                    ]);
                } else {
                    try {
                        (description.type === 'answer' && pc.signalingState === 'stable') ||
                            await pc.setRemoteDescription(description);
                    } catch (err) {
                        console.error("Error setting remote description:", err);
                    }
                }
                if (description.type === 'offer') {
                    await pc.setLocalDescription(await pc.createAnswer());
                    //if (!trickle) await waitToCompleteIceGathering(pc, 'new'); // Removed waitToCompleteIceGathering
                    send({ description: pc.localDescription });
                }
            } else if (candidate) {
                await pc.addIceCandidate(candidate);
            }
        }

        port2.onmessage = onmessage.bind(this);
        dc.addEventListener('message', onmessage.bind(this), { ...signal });
    }

    getIceServers() {
        return [
            {
                urls: [
                    'stun:stun.l.google.com:19302',
                    'stun:global.stun.twilio.com:3478'
                ]
            },
            {
                urls: ['stun:freestun.net:3478'],
                username: 'free',
                credential: 'free'
            }
        ];
    }
}

// Removed waitToCompleteIceGathering function as it was not used.
