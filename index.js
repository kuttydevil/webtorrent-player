/* global MediaMetadata, navNowPlaying */
import WebTorrent from 'webtorrent'
import { SubtitleParser, SubtitleStream } from 'matroska-subtitles'
import HybridChunkStore from 'hybrid-chunk-store'
import SubtitlesOctopus from './lib/subtitles-octopus.js'
import Peer from './lib/peer.js'

const announceList = [ // Comprehensive list of public trackers
    // WebSockets (ws://, wss://) - Preferred for browsers
    "wss://tracker.btorrent.xyz",
    "wss://tracker.openwebtorrent.com",
    "wss://wstracker.online",
    "wss://tracker.webtorrent.dev",
    "wss://tracker.fastcast.nz",
    "wss://tracker.btorrent.xyz",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.quix.cf:443/announce",

    // HTTP (http://, https://) - Fallback
    "https://tracker.ngosang.net:443/announce",
    "https://tracker.opentrackr.org:443/announce",
    "https://opentracker.i2p.rocks:443/announce",
    "https://tracker.openbittorrent.com:443/announce",
    "https://tr.v2ex.hk:443/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "http://tracker.publicbt.com:80/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "http://tracker.publicbt.com:80/announce",
    "http://tracker.files.fm:6969/announce",
    "http://tracker.dler.org:6969/announce",
    "http://tracker.coppersurfer.tk:80/announce",
    "http://tracker.leechers-paradise.org:6969/announce",
    "http://tracker.mg64.net:6881/announce",
    "http://tracker.monitor.uw.edu.pl:6969/announce",
    "http://tracker.files.fm:6969/announce",
    "http://retracker.telecom.by:80/announce",
    "http://open.acgnxtracker.com:80/announce",
    "http://bttracker.сип.рф:80/announce",
    "http://tracker.skyts.net:6969/announce",
    "http://exodus.desync.com:6969/announce",
    "http://retracker.lanta-net.ru:80/announce",
    "http://tracker.tiny-vps.com:6969/announce",

    // UDP (udp://) - Preferred for Node.js, good fallback for browsers
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.openbittorrent.com:80",
    "udp://tracker.coppersurfer.tk:6969",
    "udp://tracker.leechers-paradise.org:6969",
    "udp://tracker.zer0day.to:1337",
    "udp://explodie.org:6969",
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://tracker.coppersurfer.tk:6969/announce",
    "udp://tracker.leechers-paradise.org:6969/announce",
    "udp://9.rarbg.to:2710/announce",
    "udp://9.rarbg.me:2710/announce",
    "udp://tracker.slowcheetah.org:14710/announce",
    "udp://tracker.publicbt.com:80/announce",
    "udp://tracker.gbitt.info:80/announce",
    "udp://tracker.0x.tf:1337/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://open.stealth.si:8000/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.opentrackr.org:1337/announce",
];

const units = [' B', ' KB', ' MB', ' GB', ' TB']

function requestTimeout (callback, delay) {
  const startedAt = Date.now()
  let animationFrame = requestAnimationFrame(tick)
  function tick () {
    if (Date.now() - startedAt >= delay) {
      callback()
    } else {
      animationFrame = requestAnimationFrame(tick)
    }
  }
  return {
    clear: () => cancelAnimationFrame(animationFrame)
  }
}

function cancelTimeout (timeout) {
  if (timeout) {
    timeout.clear()
  }
}

export default class WebTorrentPlayer extends WebTorrent {
  constructor (options = {}) {
    super({ // WebTorrent Options - Explicitly set DHT and PEX, and a torrentPort
      dht: true,
      pex: true,
      maxConns: Infinity,  // Remove max connections limit.
      torrentPort: 0,   // Let OS choose port
      announce: announceList, // Use the comprehensive tracker list
      ...options.WebTorrentOpts // Spread user-provided options
    })
    this.storeOpts = options.storeOpts || {}

    const scope = location.pathname.substr(0, location.pathname.lastIndexOf('/') + 1)
    const worker = location.origin + scope + 'sw.js' === navigator.serviceWorker?.controller?.scriptURL && navigator.serviceWorker.controller
    const handleWorker = worker => {
      const checkState = worker => {
        return worker.state === 'activated' && this.loadWorker(worker)
      }
      if (!checkState(worker)) {
        worker.addEventListener('statechange', ({ target }) => checkState(target))
      }
    }
    if (worker) {
      handleWorker(worker)
    } else {
      navigator.serviceWorker.register('sw.js', { scope }).then(reg => {
        handleWorker(reg.active || reg.waiting || reg.installing)
      }).catch(e => {
        if (String(e) === 'InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state.') {
          location.reload() // weird workaround for a weird bug
        } else {
          throw e
        }
      })
    }
    window.addEventListener('beforeunload', () => {
      this.destroy()
      this.cleanupVideo()
    })

    this.video = options.video
    this.controls = options.controls || {} // object of controls
    // playPause, playNext, playLast, openPlaylist, toggleMute, setVolume, setProgress, selectCaptions, selectAudio, toggleTheatre, toggleFullscreen, togglePopout, forward, rewind

    if (this.controls.setVolume) {
      this.controls.setVolume.addEventListener('input', e => this.setVolume(e.target.value))
      this.setVolume()
      this.oldVolume = undefined
      if ('audioTracks' in HTMLVideoElement.prototype && this.controls.audioButton) {
        this.video.addEventListener('loadedmetadata', () => {
          if (this.video.audioTracks.length > 1) {
            this.controls.audioButton.removeAttribute('disabled')
            for (const track of this.video.audioTracks) {
              this.createRadioElement(track, 'audio')
            }
          } else {
            this.controls.audioButton.setAttribute('disabled', '')
          }
        })
      }
    }
    if (this.controls.ppToggle) {
      this.controls.ppToggle.addEventListener('click', () => this.playPause())
      this.controls.ppToggle.addEventListener('dblclick', () => this.toggleFullscreen())
    }

    if (this.controls.setProgress) {
      this.controls.setProgress.addEventListener('input', e => this.setProgress(e.target.value))
      this.controls.setProgress.addEventListener('mouseup', e => this.dragBarEnd(e.target.value))
      this.controls.setProgress.addEventListener('touchend', e => this.dragBarEnd(e.target.value))
      this.controls.setProgress.addEventListener('mousedown', e => this.dragBarStart(e.target.value))
      this.video.addEventListener('timeupdate', e => {
        if (this.immerseTimeout && document.location.hash === '#player' && !this.video.paused) this.setProgress(e.target.currentTime / e.target.duration * 100)
      })
      this.video.addEventListener('ended', () => this.setProgress(100))
    }

    this.video.addEventListener('loadedmetadata', () => this.findSubtitleFiles(this.currentFile))
    this.subtitleData = {
      fonts: [],
      headers: [],
      tracks: [],
      current: undefined,
      renderer: undefined,
      stream: undefined,
      parser: undefined,
      parsed: undefined,
      timeout: undefined,
      defaultHeader: `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${options.defaultSSAStyles || 'Roboto Medium,26,&H00FFFFFF,&H000000FF,&H00020713,&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,2,20,20,23,1'}
[Events]

`
    }

    this.completed = false
    this.video.addEventListener('timeupdate', () => this.checkCompletion())

    this.nextTimeout = undefined
    if (options.autoNext) this.video.addEventListener('ended', () => this.playNext())

    this.resolveFileMedia = options.resolveFileMedia
    this.currentFile = undefined
    this.videoFile = undefined

    if (this.controls.thumbnail) {
      this.generateThumbnails = options.generateThumbnails
      const thumbCanvas = document.createElement('canvas')
      thumbCanvas.width = options.thumbnailWidth || 150
      this.thumbnailData = {
        thumbnails: [],
        canvas: thumbCanvas,
        context: thumbCanvas.getContext('2d'),
        interval: undefined,
        video: undefined
      }
      this.video.addEventListener('loadedmetadata', () => this.initThumbnail())
      this.video.addEventListener('timeupdate', () => this.createThumbnail(this.video))
    }

    if (options.visibilityLossPause) {
      this.wasPaused = true
      document.addEventListener('visibilitychange', () => {
        if (!this.video.ended) {
          if (document.visibilityState === 'hidden') {
            this.wasPaused = this.video.paused
            this.video.pause()
          } else {
            if (!this.wasPaused) this.playPause()
          }
        }
      })
    }

    this.onDone = undefined

    this.destroyStore = options.destroyStore != null ? !!options.destroyStore : true

    this.immerseTimeout = undefined
    this.immerseTime = options.immerseTime || 5

    this.playerWrapper = options.playerWrapper
    this.player = options.player
    if (this.player) {
      this.player.addEventListener('fullscreenchange', () => this.updateFullscreen())
      this.player.addEventListener('mousemove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('touchmove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('keypress', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('mouseleave', () => requestAnimationFrame(() => this.immersePlayer()))

      this.doubleTapTimeout = undefined
      this.player.addEventListener('touchend', e => {
        if (this.doubleTapTimeout) {
          e.preventDefault()
          clearTimeout(this.doubleTapTimeout)
          this.doubleTapTimeout = undefined
          this.toggleFullscreen()
        } else {
          this.doubleTapTimeout = setTimeout(() => {
            this.doubleTapTimeout = undefined
          }, 200)
        }
      })
    }

    this.bufferTimeout = undefined
    this.video.addEventListener('playing', () => this.hideBuffering())
    this.video.addEventListener('canplay', () => this.hideBuffering())
    this.video.addEventListener('loadeddata', () => this.hideBuffering())
    this.video.addEventListener('waiting', () => this.showBuffering())

    const handleAvailability = aval => {
      if (aval) {
        this.controls.toggleCast.removeAttribute('disabled')
      } else {
        this.controls.toggleCast.setAttribute('disabled', '')
      }
    }
    if ('PresentationRequest' in window) {
      this.presentationRequest = new PresentationRequest(['lib/cast.html'])
      this.presentationRequest.addEventListener('connectionavailable', e => this.initCast(e))
      this.presentationConnection = null
      navigator.presentation.defaultRequest = this.presentationRequest
      this.presentationRequest.getAvailability().then(aval => {
        aval.onchange = e => handleAvailability(e.target.value)
        handleAvailability(aval.value)
      })
    } else {
      this.controls.toggleCast.setAttribute('disabled', '')
    }

    if ('pictureInPictureEnabled' in document) {
      this.burnIn = options.burnIn
      if (this.controls.togglePopout) this.controls.togglePopout.removeAttribute('disabled')
      if (this.burnIn) this.video.addEventListener('enterpictureinpicture', () => { if (this.subtitleData.renderer) this.togglePopout() })
    } else {
      this.video.setAttribute('disablePictureInPicture', '')
      if (this.controls.togglePopout) this.controls.togglePopout.setAttribute('disabled', '')
    }

    this.seekTime = options.seekTime || 5
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.playPause())
      navigator.mediaSession.setActionHandler('pause', () => this.playPause())
      navigator.mediaSession.setActionHandler('seekbackward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('seekforward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext())
      if ('setPositionState' in navigator.mediaSession) this.video.addEventListener('timeupdate', () => this.updatePositionState())
    }

    this.subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa']
    this.videoExtensions = ['.3g2', '.3gp', '.asf', '.avi', '.dv', '.flv', '.gxf', '.m2ts', '.m4a', '.m4b', '.m4p', '.m4r', '.m4v', '.mkv', '.mov', '.mp4', '.mpd', '.mpeg', '.mpg', '.mxf', '.nut', '.ogm', '.ogv', '.swf', '.ts', '.vob', '.webm', '.wmv', '.wtv']
    this.videoFiles = undefined

    this.updateDisplay()
    this.offlineTorrents = JSON.parse(localStorage.getItem('offlineTorrents')) || {}
    // adds all offline store torrents to the client
    Object.values(this.offlineTorrents).forEach(torrentID => this.offlineDownload(new Blob([new Uint8Array(torrentID)])))

    this.streamedDownload = options.streamedDownload

    this.fps = 23.976
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.video.addEventListener('loadeddata', () => {
        this.fps = new Promise(resolve => {
          let lastmeta = null
          let waspaused = false
          let count = 0

          const handleFrames = (now, metadata) => {
            if (count) { // resolve on 2nd frame, 1st frame might be a cut-off
              if (lastmeta) {
                const msbf = (metadata.mediaTime - lastmeta.mediaTime) / (metadata.presentedFrames - lastmeta.presentedFrames)
                const rawFPS = (1 / msbf).toFixed(3)
                // this is accurate for mp4, mkv is a few ms off
                if (this.currentFile.name.endsWith('.mkv')) {
                  if (rawFPS < 25 && rawFPS > 22) {
                    resolve(23.976)
                  } else if (rawFPS < 31 && rawFPS > 28) {
                    resolve(29.97)
                  } else if (rawFPS < 62 && rawFPS > 58) {
                    resolve(59.94)
                  } else {
                    resolve(rawFPS) // smth went VERY wrong
                  }
                } else {
                  resolve(rawFPS)
                }
                if (waspaused) this.video.pause()
              } else {
                lastmeta = metadata
                this.video.requestVideoFrameCallback(handleFrames)
              }
            } else {
              count++
              if (this.video.paused) {
                waspaused = true
                this.video.play()
              }
              this.video.requestVideoFrameCallback(handleFrames)
            }
          }
          this.video.requestVideoFrameCallback(handleFrames)
        })
      })
    }

    for (const [functionName, elements] of Object.entries(this.controls)) {
      if (this[functionName]) {
        if (elements.constructor === Array) {
          for (const element of elements) {
            element.addEventListener('click', e => {
              this[functionName](e.target.value)
            })
          }
        } else {
          elements.addEventListener('click', e => {
            this[functionName](e.target.value)
          })
        }
      }
    }
    document.addEventListener('keydown', a => {
      if (a.key === 'F5') {
        a.preventDefault()
      }
      if (location.hash === '#player') {
        switch (a.key) {
          case ' ':
            this.playPause()
            break
          case 'n':
            this.playNext()
            break
          case 'm':
            this.toggleMute()
            break
          case 'p':
            this.togglePopout()
            break
          case 't':
            this.toggleTheatre()
            break
          case 'c':
            this.captions()
            break
          case 'f':
            this.toggleFullscreen()
            break
          case 's':
            this.seek(85)
            break
          case 'ArrowLeft':
            this.seek(-this.seekTime)
            break
          case 'ArrowRight':
            this.seek(this.seekTime)
            break
          case 'ArrowUp':
            this.setVolume(Number(this.controls.setVolume.value) + 5)
            break
          case 'ArrowDown':
            this.setVolume(Number(this.controls.setVolume.value) - 5)
            break
          case 'Escape':
            location.hash = '#home'
            break
        }
      }
    })
  }

  // Remove all limitations to number of connections
  maxConns = Infinity; // Remove max connections limit.
  _rechokeNumSlots = Infinity;  //Allow all peers to upload.  VERY aggressive.
  _rechokeOptimisticTime = 0;  //Disable optimistic unchoking
  _rechoke () { return; } //Disable rechoking entirely

  _request (wire, pieceIndex) {
    if (this.bitfield.get(pieceIndex)) return false // we already have this piece
    const piece = this.pieces[pieceIndex]

    let reservation = wire.type === 'webSeed'
      ? piece.reserveRemaining()
      : piece.reserve()

    if (reservation === -1) return false

    let reservationObj = this._reservations[pieceIndex]
    if (!reservationObj) {
      reservationObj = this._reservations[pieceIndex] = []
    }
    let reservationIndex = reservationObj.indexOf(null)
    if (reservationIndex === -1) reservationIndex = reservationObj.length
    reservationObj[reservationIndex] = wire

    const offset = piece.chunkOffset(reservation)
    const length = wire.type === 'webSeed'
      ? piece.chunkLengthRemaining(reservation)
      : piece.chunkLength(reservation)
    const cb = (err, buf) => {
      if (this.destroyed) return

      if (!this.ready) return this.once('ready', () => { cb(err, buf) })

      reservationObj[reservationIndex] = null // remove from reservations

      if (piece !== this.pieces[pieceIndex]) return this._update()

      if (err) {
        this._debug(
          'error getting piece %s (offset: %s length: %s) from %s: %s',
          pieceIndex, offset, length, `${wire.remoteAddress}:${wire.remotePort}`, err.message
        )
        if (wire.type === 'webSeed') {
          piece.cancelRemaining(reservation)
        } else {
          piece.cancel(reservation)
        }
        return this._update()
      }

      this._debug(
        'got piece %s (offset: %s length: %s) from %s',
        pieceIndex, offset, length, `${wire.remoteAddress}:${wire.remotePort}`
      )

      if (!piece.set(reservation, buf, wire)) return this._update()

      const hash = piece.flush()
      I(hash, err => {
        if (this.destroyed) return

        if (err) {
          this.pieces[pieceIndex] = new S(piece.length) // reset piece
          this.emit('warning', new Error(`Piece ${pieceIndex} failed verification`))
          this._update()
        } else {
          this._debug('piece verified %s', pieceIndex)
          this.pieces[pieceIndex] = null
          this._markVerified(pieceIndex)
          this.wires.forEach(wire => {
            wire.have(pieceIndex)
          })
          if (this._checkDone() && !this.destroyed) this.discovery.complete()
        }
      })
    }
      // Send the request
        wire.request(pieceIndex, offset, length, cb)
      return true
    }
  _updateWire (wire) {
    if (wire.destroyed) return false

    // Don't request more if we aren't interested
    if (!this._amInterested) return

    // Don't request more if the peer doesn't have any pieces
    if (!wire.peerPieces.some()) return

    // Don't request more if this peer is a seeder (for this torrent)
    if (wire.isSeeder) return

    // If no files are selected, then try to start the torrent off by downloading
    // a piece, otherwise we won't have any metadata to use to select files.
    const hasSelections = this._selections.some(s => s.to - s.from > s.offset)
    if (!hasSelections && this.metadata) return

    // Send requests to the peer
    let numRequests = 0
    while (wire.requests.length < Infinity) { // Remove request limit
      const piece = this._pickPiece(wire)
      if (piece === -1) break // no piece to request
      const rejected = !this._request(wire, piece, false) // Always attempt request
      if (!rejected) {
        numRequests++
      }
    }

    if (numRequests) {
      this._debug('requesting %s pieces from %s', numRequests, wire.remoteAddress)
      return true
    } else {
      return false
    }
  }

  buildVideo (torrent, opts = {}) { // sets video source and creates a bunch of other media stuff
    // play wanted episode from opts, or the 1st episode, or 1st file [batches: plays wanted episode, single: plays the only episode, manually added: plays first or only file]
    this.cleanupVideo()

    // Deselect the previous file if it exists
    if (this.currentFile && this.currentFile._torrent) { // Make sure currentFile and its torrent exist
      this.currentFile.deselect() // Deselect the previously playing file
    }

    if (opts.file) {
      this.currentFile = opts.file
    } else if (this.videoFiles.length > 1) {
      this.currentFile = this.videoFiles.find(async file => await this.resolveFileMedia({ fileName: file.name }).then(FileMedia => (Number(FileMedia.episodeNumber) === Number(opts.episode || 1)) || (FileMedia === opts.media))) || this.videoFiles[0]
    } else {
      this.currentFile = this.videoFiles[0]
    }
    // opts.media: mediaTitle, episodeNumber, episodeTitle, episodeThumbnail, mediaCover, name
    (async () => { // Wrap the problematic line in an async function
      this.nowPlaying = (options.media && (this.videoFiles.length === 1 || (options.forceMedia && options.file))) ? options.media : this.resolveFileMedia ? await this.resolveFileMedia({ fileName: this.currentFile.name, method: 'SearchName' }) : undefined
    if (this.nowPlaying) {
      if (navNowPlaying) navNowPlaying.classList.remove('d-none')

      const episodeInfo = [this.nowPlaying.episodeNumber, this.nowPlaying.episodeTitle].filter(s => s).join(' - ')

      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.nowPlaying.mediaTitle || this.nowPlaying.name || 'WebTorrentPlayer',
          artist: 'Episode ' + episodeInfo,
          album: this.nowPlaying.name || 'WebTorrentPlayer',
          artwork: [{
            src: this.nowPlaying.episodeThumbnail || this.nowPlaying.mediaCover || '',
            sizes: '256x256',
            type: 'image/jpg'
          }]
        })
      }
      if (this.nowPlaying.episodeThumbnail) this.video.poster = this.nowPlaying.episodeThumbnail

      this.changeControlsIcon('nowPlaying', 'EP ' + episodeInfo)
      document.title = [this.nowPlaying.mediaTitle, episodeInfo ? 'EP ' + episodeInfo : false, this.nowPlaying.name || 'WebTorrentPlayer'].filter(s => s).join(' - ')
    }
    if (this.currentFile.name.endsWith('mkv')) {
      let initStream = null
      this.currentFile.on('stream', ({ stream }) => {
        initStream = stream
      })
      this.initParser(this.currentFile).then(() => {
        this.currentFile.on('stream', ({ stream, req }, cb) => {
          if (req.destination === 'video' && !this.subtitleData.parsed) {
            this.subtitleData.stream = new SubtitleStream(this.subtitleData.stream)
            this.handleSubtitleParser(this.subtitleData.stream, true)
            stream.pipe(this.subtitleData.stream)
            cb(this.subtitleData.stream)
          }
        })
        initStream?.destroy()
      })
    }
    await navigator.serviceWorker.ready
    if (this.currentFile.done) {
      this.postDownload()
    } else {
      this.onDone = this.currentFile.on('done', () => this.postDownload())
    }

    this.currentFile.streamTo(this.video)
    this.video.load()
    this.playVideo()

    if (this.controls.downloadFile) {
      this.currentFile.getStreamURL((_err, url) => {
        this.controls.downloadFile.href = url
      })
    }
  }

  cleanupVideo () { // cleans up objects, attemps to clear as much video caching as possible
    this.presentationConnection?.terminate()
    if (document.pictureInPictureElement) document.exitPictureInPicture()
    this.subtitleData.renderer?.destroy()
        this.subtitleData = {
      fonts: [],
      headers: [],
      tracks: [],
      current: undefined,
      renderer: undefined,
      stream: undefined,
      parser: undefined,
      parsed: undefined,
      timeout: undefined,
      defaultHeader: `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${options.defaultSSAStyles || 'Roboto Medium,26,&H00FFFFFF,&H000000FF,&H00020713,&H00000000,0,0,0,0,100,100,0,0,1,1.3,0,2,20,20,23,1'}
[Events]

`
    }

    this.completed = false
    this.video.addEventListener('timeupdate', () => this.checkCompletion())

    this.nextTimeout = undefined
    if (options.autoNext) this.video.addEventListener('ended', () => this.playNext())

    this.resolveFileMedia = options.resolveFileMedia
    this.currentFile = undefined
    this.videoFile = undefined

    if (this.controls.thumbnail) {
      this.generateThumbnails = options.generateThumbnails
      const thumbCanvas = document.createElement('canvas')
      thumbCanvas.width = options.thumbnailWidth || 150
      this.thumbnailData = {
        thumbnails: [],
        canvas: thumbCanvas,
        context: thumbCanvas.getContext('2d'),
        interval: undefined,
        video: undefined
      }
      this.video.addEventListener('loadedmetadata', () => this.initThumbnail())
      this.video.addEventListener('timeupdate', () => this.createThumbnail(this.video))
    }

    if (options.visibilityLossPause) {
      this.wasPaused = true
      document.addEventListener('visibilitychange', () => {
        if (!this.video.ended) {
          if (document.visibilityState === 'hidden') {
            this.wasPaused = this.video.paused
            this.video.pause()
          } else {
            if (!this.wasPaused) this.playPause()
          }
        }
      })
    }

    this.onDone = undefined

    this.destroyStore = options.destroyStore != null ? !!options.destroyStore : true

    this.immerseTimeout = undefined
    this.immerseTime = options.immerseTime || 5

    this.playerWrapper = options.playerWrapper
    this.player = options.player
    if (this.player) {
      this.player.addEventListener('fullscreenchange', () => this.updateFullscreen())
      this.player.addEventListener('mousemove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('touchmove', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('keypress', () => requestAnimationFrame(() => this.resetImmerse()))
      this.player.addEventListener('mouseleave', () => requestAnimationFrame(() => this.immersePlayer()))

      this.doubleTapTimeout = undefined
      this.player.addEventListener('touchend', e => {
        if (this.doubleTapTimeout) {
          e.preventDefault()
          clearTimeout(this.doubleTapTimeout)
          this.doubleTapTimeout = undefined
          this.toggleFullscreen()
        } else {
          this.doubleTapTimeout = setTimeout(() => {
            this.doubleTapTimeout = undefined
          }, 200)
        }
      })
    }

    this.bufferTimeout = undefined
    this.video.addEventListener('playing', () => this.hideBuffering())
    this.video.addEventListener('canplay', () => this.hideBuffering())
    this.video.addEventListener('loadeddata', () => this.hideBuffering())
    this.video.addEventListener('waiting', () => this.showBuffering())

    const handleAvailability = aval => {
      if (aval) {
        this.controls.toggleCast.removeAttribute('disabled')
      } else {
        this.controls.toggleCast.setAttribute('disabled', '')
      }
    }
    if ('PresentationRequest' in window) {
      this.presentationRequest = new PresentationRequest(['lib/cast.html'])
      this.presentationRequest.addEventListener('connectionavailable', e => this.initCast(e))
      this.presentationConnection = null
      navigator.presentation.defaultRequest = this.presentationRequest
      this.presentationRequest.getAvailability().then(aval => {
        aval.onchange = e => handleAvailability(e.target.value)
        handleAvailability(aval.value)
      })
    } else {
      this.controls.toggleCast.setAttribute('disabled', '')
    }

    if ('pictureInPictureEnabled' in document) {
      this.burnIn = options.burnIn
      if (this.controls.togglePopout) this.controls.togglePopout.removeAttribute('disabled')
      if (this.burnIn) this.video.addEventListener('enterpictureinpicture', () => { if (this.subtitleData.renderer) this.togglePopout() })
    } else {
      this.video.setAttribute('disablePictureInPicture', '')
      if (this.controls.togglePopout) this.controls.togglePopout.setAttribute('disabled', '')
    }

    this.seekTime = options.seekTime || 5
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.playPause())
      navigator.mediaSession.setActionHandler('pause', () => this.playPause())
      navigator.mediaSession.setActionHandler('seekbackward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('seekforward', () => this.seek(this.seekTime))
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNext())
      if ('setPositionState' in navigator.mediaSession) this.video.addEventListener('timeupdate', () => this.updatePositionState())
    }

    this.subtitleExtensions = ['.srt', '.vtt', '.ass', '.ssa']
    this.videoExtensions = ['.3g2', '.3gp', '.asf', '.avi', '.dv', '.flv', '.gxf', '.m2ts', '.m4a', '.m4b', '.m4p', '.m4r', '.m4v', '.mkv', '.mov', '.mp4', '.mpd', '.mpeg', '.mpg', '.mxf', '.nut', '.ogm', '.ogv', '.swf', '.ts', '.vob', '.webm', '.wmv', '.wtv']
    this.videoFiles = undefined

    this.updateDisplay()
    this.offlineTorrents = JSON.parse(localStorage.getItem('offlineTorrents')) || {}
    // adds all offline store torrents to the client
    Object.values(this.offlineTorrents).forEach(torrentID => this.offlineDownload(new Blob([new Uint8Array(torrentID)])))

    this.streamedDownload = options.streamedDownload

    this.fps = 23.976
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.video.addEventListener('loadeddata', () => {
        this.fps = new Promise(resolve => {
          let lastmeta = null
          let waspaused = false
          let count = 0

          const handleFrames = (now, metadata) => {
            if (count) { // resolve on 2nd frame, 1st frame might be a cut-off
              if (lastmeta) {
                const msbf = (metadata.mediaTime - lastmeta.mediaTime) / (metadata.presentedFrames - lastmeta.presentedFrames)
                const rawFPS = (1 / msbf).toFixed(3)
                // this is accurate for mp4, mkv is a few ms off
                if (this.currentFile.name.endsWith('.mkv')) {
                  if (rawFPS < 25 && rawFPS > 22) {
                    resolve(23.976)
                  } else if (rawFPS < 31 && rawFPS > 28) {
                    resolve(29.97)
                  } else if (rawFPS < 62 && rawFPS > 58) {
                    resolve(59.94)
                  } else {
                    resolve(rawFPS) // smth went VERY wrong
                  }
                } else {
                  resolve(rawFPS)
                }
                if (waspaused) this.video.pause()
              } else {
                lastmeta = metadata
                this.video.requestVideoFrameCallback(handleFrames)
              }
            } else {
              count++
              if (this.video.paused) {
                waspaused = true
                this.video.play()
              }
              this.video.requestVideoFrameCallback(handleFrames)
            }
          }
          this.video.requestVideoFrameCallback(handleFrames)
        })
      })
    }

    for (const [functionName, elements] of Object.entries(this.controls)) {
      if (this[functionName]) {
        if (elements.constructor === Array) {
          for (const element of elements) {
            element.addEventListener('click', e => {
              this[functionName](e.target.value)
            })
          }
        } else {
          elements.addEventListener('click', e => {
            this[functionName](e.target.value)
          })
        }
      }
    }
    document.addEventListener('keydown', a => {
      if (a.key === 'F5') {
        a.preventDefault()
      }
      if (location.hash === '#player') {
        switch (a.key) {
          case ' ':
            this.playPause()
            break
          case 'n':
            this.playNext()
            break
          case 'm':
            this.toggleMute()
            break
          case 'p':
            this.togglePopout()
            break
          case 't':
            this.toggleTheatre()
            break
          case 'c':
            this.captions()
            break
          case 'f':
            this.toggleFullscreen()
            break
          case 's':
            this.seek(85)
            break
          case 'ArrowLeft':
            this.seek(-this.seekTime)
            break
          case 'ArrowRight':
            this.seek(this.seekTime)
            break
          case 'ArrowUp':
            this.setVolume(Number(this.controls.setVolume.value) + 5)
            break
          case 'ArrowDown':
            this.setVolume(Number(this.controls.setVolume.value) - 5)
            break
          case 'Escape':
            location.hash = '#home'
            break
        }
      }
    })
  }

  playTorrent (torrentID, opts = {}) { // TODO: clean this up
    const handleTorrent = (torrent, opts) => {
      torrent.on('noPeers', () => {
        this.emit('no-peers', torrent)
      })
      if (this.streamedDownload) {
        torrent.files.forEach(file => file.deselect())
        torrent.deselect(0, torrent.pieces.length - 1, false)
      }
      this.videoFiles = torrent.files.filter(file => this.videoExtensions.some(ext => file.name.endsWith(ext)))
      this.emit('video-files', { files: this.videoFiles, torrent: torrent })
      if (this.videoFiles.length > 1) {
        torrent.files.forEach(file => file.deselect())
      }
      if (this.videoFiles) {
        this.buildVideo(torrent, opts)
      } else {
        this.emit('no-file', torrent)
        this.cleanupTorrents()
      }
    }
    document.location.hash = '#player'
    this.cleanupVideo()
    this.cleanupTorrents()
    if (torrentID instanceof Object) {
      handleTorrent(torrentID, opts)
    } else if (this.get(torrentID)) {
      handleTorrent(this.get(torrentID), opts)
    } else {
      this.add(torrentID, {
        destroyStoreOnDestroy: this.destroyStore,
        storeOpts: this.storeOpts,
        storeCacheSlots: 0,
        store: HybridChunkStore,
        announce: announceList,
      }, torrent => {
        handleTorrent(torrent, opts)
      })
    }
  }

  // cleanup torrent and store
  cleanupTorrents () {
  // creates an array of all non-offline store torrents and removes them
    this.torrents.filter(torrent => !this.offlineTorrents[torrent.infoHash]).forEach(torrent => torrent.destroy())
  }

  // add torrent for offline download
  offlineDownload (torrentID) {
    const torrent = this.add(torrentID, {
      storeOpts: this.storeOpts,
      store: HybridChunkStore,
      storeCacheSlots: 0,
      announce: announceList
    })
    torrent.on('metadata', () => {
      if (!this.offlineTorrents[torrent.infoHash]) {
        this.offlineTorrents[torrent.infoHash] = Array.from(torrent.torrentFile)
        localStorage.setItem('offlineTorrents', JSON.stringify(this.offlineTorrents))
      }
      this.emit('offline-torrent', torrent)
    })
  }
}
