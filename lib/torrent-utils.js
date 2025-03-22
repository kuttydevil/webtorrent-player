// lib/torrent-utils.js
export function generatePeerId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let peerId = '-XB0010-'; // Example prefix, you can customize
  for (let i = 0; i < 12; i++) {
    peerId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return peerId;
}

export function parsePeerId(peerId) {
  const prefix = peerId.substring(0, 8);
  const clientIdentifier = peerId.substring(1, 3);
  const clientVersion = peerId.substring(3, 7);
  const isLite = clientIdentifier === 'XL'; // Example of identifying "lite" peers

  return {
    prefix,
    clientIdentifier,
    clientVersion,
    isLite,
  };
}
