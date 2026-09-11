/* ============================================================================
   WorkSuite calls — the WebRTC mesh engine (window.WSCallMesh).

   One RTCPeerConnection per other person in the call. The engine knows
   nothing about Supabase: the page hands it a `send(to, type, data)` function
   and feeds every signal it receives into `handleSignal(from, type, data)`.
   That keeps it testable with an in-memory bus (tests/ui-smoke/mesh-harness.html).

   Design choices, each one a bug the old calls had:
   - One side of every pair offers, decided by comparing session ids (the
     smaller sid offers). Both sides agree without talking, so offers never
     collide ("glare") and nothing needs rolling back.
   - The offerer opens the connection with one audio and one video
     transceiver even when the camera is off. Camera on/off, switching
     devices and screen sharing are then replaceTrack() only — no
     renegotiation, no extra round trip, nothing to go wrong mid-call.
   - Every signal carries the connection's generation (`gen`). A higher gen
     from the offerer means "throw the old connection away"; anything older
     than the current gen is ignored, so late messages cannot confuse a
     fresh connection. Generations are timestamps, so a peer rebuilt on one
     side can never restart at a number the other side already passed.
   - Offers carry a sequence number (`seq`) and answers echo it: an answer
     is only applied to the offer it was made for. Only one ICE restart runs
     at a time; a second request while one is out just repeats that offer.
   - ICE candidates are batched on the way out and buffered on the way in
     until the remote description exists (the old code dropped every
     candidate that arrived while the phone was still ringing).
   - A drop is repaired, not fatal: 'disconnected' waits 2.5 s then restarts
     ICE, 'failed' restarts at once, and after three failed restarts the
     offerer builds a new connection (next gen). Only real state changes
     count (connectionstatechange and iceconnectionstatechange both fire for
     one). A peer is only ever removed when the page says so (removePeer)
     or the other side says 'bye'; removePeer(…, { notify: true }) sends
     'reset' so the other side starts over too.

   API
     const mesh = new WSCallMesh({ selfId, sid, iceServers, localStream, send, log })
     mesh.addPeer({ userId, sid, name })      someone is in the call (presence)
     mesh.removePeer(userId, reason, { notify })   they left (the page decides); notify: tell them to reset
     mesh.handleSignal(from, type, data)      from = { userId, sid }
     mesh.setLocalTrack('audio'|'video', track|null)
     mesh.setIceServers(list)
     mesh.restartIce(userId)                  force an ICE restart (tests, "reconnect" button)
     mesh.peerCount / mesh.peerIds()
     mesh.on(event, fn) / mesh.off(event, fn)
       'stream' (userId, MediaStream)   'state' (userId, state)
       'stats'  (userId, { rtt, loss, quality, relay })   'levels' (Map userId -> 0..1)
     mesh.close({ bye })                      says 'bye' to everyone (unless bye: false) and closes
   Signal types on the wire: offer | answer | ice | ready | restart | reset | bye
   ============================================================================ */
(function (root) {
    'use strict';

    const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    const READY_AFTER_MS = 1500;       // answerer asks for an offer if none arrived by then
    const READY_EVERY_MS = 3000;
    const CONNECT_TIMEOUT_MS = 12000;  // offerer rebuilds a connection that never came up
    const DISCONNECT_GRACE_MS = 2500;  // 'disconnected' often heals by itself
    const RESTART_TIMEOUT_MS = 8000;
    const MAX_RESTARTS = 3;
    const FAILED_AFTER_MS = 30000;     // report 'failed' (still retrying) after this long without media
    const STATS_EVERY_MS = 2000;
    const LEVELS_EVERY_MS = 250;
    const RETIRE_MS = 15000;

    function videoBitrate(peers, screen) {
        if (screen) return peers <= 1 ? 2500000 : peers === 2 ? 1500000 : 1000000;
        if (peers <= 1) return 1500000;
        if (peers === 2) return 900000;
        if (peers <= 4) return 600000;
        return 400000;
    }

    function plainDescription(d) { return d ? { type: d.type, sdp: d.sdp } : null; }
    function randomInst() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

    class Peer {
        constructor(mesh, remote) {
            this.mesh = mesh;
            this.userId = remote.userId;
            this.sid = remote.sid;
            this.name = remote.name || '';
            this.offerer = mesh.sid === remote.sid ? mesh.selfId < remote.userId : mesh.sid < remote.sid;
            this.gen = 0;
            this.inst = randomInst();   // this Peer object; a new one means "I started over"
            this.remoteInst = null;     // offerer: the answering Peer we last heard from
            this.seq = 0;               // offerer: offers made on the current connection
            this.pendingSeq = null;     // offerer: the offer waiting for its answer
            this.answeredSeq = null;    // answerer: the last offer answered
            this.lastConn = null;       // the last connection state acted on
            this.restartPending = false;
            this.pc = null;
            this.stream = null;
            this.state = 'connecting';
            this.everConnected = false;
            this.downSince = Date.now();
            this.restarts = 0;
            this.makingOffer = false;
            this.pendingIn = [];        // remote candidates waiting for a remote description
            this.early = new Map();     // gen -> candidates that arrived before that gen's offer
            this.outQueue = [];
            this.timers = {};
            this.chain = Promise.resolve();
            this.closed = false;
            this.lastLoss = null;
        }

        log(...a) { this.mesh.log(`[${this.name || this.userId.slice(0, 6)}]`, ...a); }
        send(type, data) { this.mesh.sendTo(this, type, data); }
        setTimer(key, ms, fn) { this.clearTimer(key); this.timers[key] = setTimeout(() => { delete this.timers[key]; if (!this.closed) fn(); }, ms); }
        clearTimer(key) { if (this.timers[key]) { clearTimeout(this.timers[key]); delete this.timers[key]; } }
        /** Signals are handled strictly one at a time: ICE that lands mid-offer waits its turn. */
        enqueue(fn) {
            this.chain = this.chain.then(() => (this.closed ? null : fn())).catch(e => this.log('signal error', e && e.message || e));
            return this.chain;
        }

        start() {
            if (this.offerer) this.rebuild();
            else this.armReady();
        }

        armReady() {
            this.setTimer('ready', READY_AFTER_MS, () => {
                if (this.pc && this.pc.remoteDescription) return;
                this.send('ready', { gen: this.gen, inst: this.inst });
                this.setTimer('ready', READY_EVERY_MS, () => this.armReady());
            });
        }

        setState(s) {
            if (this.state === s || this.closed && s !== 'closed') return;
            this.state = s;
            if (s !== 'connected' && !this.downSince) this.downSince = Date.now();
            this.mesh.emit('state', this.userId, s);
        }

        /* ---------------------------------------------------------- connection */
        makePc(gen) {
            this.dropPc();
            this.gen = gen;
            this.seq = 0;
            this.pendingSeq = null;
            this.answeredSeq = null;
            this.lastConn = null;
            const pc = new RTCPeerConnection({ iceServers: this.mesh.iceServers, bundlePolicy: 'max-bundle' });
            this.pc = pc;
            this.stream = new MediaStream();
            this.pendingIn = this.early.get(gen) || [];
            for (const g of [...this.early.keys()]) if (g <= gen) this.early.delete(g);
            this.downSince = Date.now();
            if (this.state !== 'connecting') this.setState(this.everConnected ? 'reconnecting' : 'connecting');

            pc.onicecandidate = (e) => {
                if (!e.candidate || pc !== this.pc) return;
                this.outQueue.push(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
                if (!this.timers.ice) this.setTimer('ice', 50, () => this.flushCandidates());
            };
            pc.ontrack = (e) => {
                if (pc !== this.pc) return;
                const s = this.stream;
                s.getTracks().filter(t => t.kind === e.track.kind && t !== e.track).forEach(t => s.removeTrack(t));
                if (!s.getTracks().includes(e.track)) s.addTrack(e.track);
                this.mesh.emit('stream', this.userId, s);
            };
            const onState = () => { if (pc === this.pc) this.onConnectionState(); };
            pc.onconnectionstatechange = onState;
            pc.oniceconnectionstatechange = onState;
            pc.onnegotiationneeded = () => {
                if (pc !== this.pc) return;
                if (this.offerer) this.enqueue(() => this.negotiate());
            };
            return pc;
        }

        dropPc() {
            if (!this.pc) return;
            const pc = this.pc;
            this.pc = null;
            this.outQueue = [];
            this.clearTimer('ice');
            try { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onnegotiationneeded = null; } catch (e) { /* closed */ }
            try { pc.close(); } catch (e) { /* already closed */ }
        }

        /** Offerer only: a fresh connection at the next generation. */
        rebuild() {
            if (!this.offerer || this.closed) return;
            const pc = this.makePc(this.mesh.nextGen(this.gen));
            const stream = this.mesh.localStream;
            for (const kind of ['audio', 'video']) {
                const track = this.mesh.localTrack(kind);
                pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: [stream] });
            }
            // negotiationneeded fires by itself; the watchdog covers an offer or answer lost on the way.
            this.setTimer('connect', CONNECT_TIMEOUT_MS, () => {
                if (this.state !== 'connected') { this.log('never connected, rebuilding'); this.rebuild(); }
            });
        }

        async negotiate(opts) {
            const pc = this.pc;
            if (!this.offerer || !pc || this.closed) return;
            const iceRestart = !!(opts && opts.iceRestart);
            if (pc.signalingState === 'have-local-offer') {
                // An offer is already out (it, or its answer, may have been lost). Repeat that one:
                // replacing it would leave its answer arriving for an offer that no longer exists.
                if (pc.localDescription) this.sendOffer();
                return;
            }
            if (pc.signalingState !== 'stable' || this.makingOffer) return;
            this.makingOffer = true;
            try {
                const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
                if (pc !== this.pc || pc.signalingState !== 'stable') return;
                await pc.setLocalDescription(offer);
                this.pendingSeq = ++this.seq;
                this.sendOffer();
            } finally {
                this.makingOffer = false;
            }
        }

        sendOffer() {
            if (!this.pc || !this.pc.localDescription) return;
            this.send('offer', { gen: this.gen, seq: this.pendingSeq, sdp: plainDescription(this.pc.localDescription) });
        }

        flushCandidates() {
            if (!this.outQueue.length || !this.pc) return;
            const candidates = this.outQueue;
            this.outQueue = [];
            this.send('ice', { gen: this.gen, candidates });
        }

        async addCandidates(list) {
            const pc = this.pc;
            for (const c of list) {
                try { await pc.addIceCandidate(c); }
                catch (e) { if (pc === this.pc) this.log('candidate rejected', e && e.message); }
            }
        }

        onConnectionState() {
            const pc = this.pc;
            let s = pc.connectionState;
            if (!s) {
                // Browsers without connectionState: derive it from ICE.
                const ice = pc.iceConnectionState;
                s = ice === 'completed' ? 'connected' : ice === 'checking' ? 'connecting' : ice;
            } else if (s === 'connected' && pc.iceConnectionState === 'disconnected') {
                s = 'disconnected';
            }
            // connectionstatechange and iceconnectionstatechange both report one change: act once.
            if (s === this.lastConn) return;
            this.lastConn = s;
            if (s === 'connected') {
                this.everConnected = true;
                this.restarts = 0;
                this.downSince = 0;
                this.restartPending = false;
                ['connect', 'restart', 'disconnect', 'ready'].forEach(k => this.clearTimer(k));
                this.setState('connected');
                this.mesh.applyBitrates();
            } else if (s === 'disconnected') {
                this.setState('reconnecting');
                this.setTimer('disconnect', DISCONNECT_GRACE_MS, () => { if (this.state !== 'connected') this.restart(); });
            } else if (s === 'failed') {
                this.setState('reconnecting');
                this.restart();
            } else if (s === 'connecting' || s === 'new' || s === 'checking') {
                if (!this.everConnected) this.setState('connecting');
            }
        }

        /** Repair a dropped connection: ICE restart first, a whole new connection if that keeps failing. */
        restart(full) {
            if (this.closed) return;
            if (!full && this.restartPending) return;          // one repair at a time
            this.restarts++;
            const rebuild = full || this.restarts > MAX_RESTARTS;
            if (rebuild) this.restarts = 0;
            this.restartPending = true;
            this.log(rebuild ? 'reconnecting from scratch' : `ICE restart #${this.restarts}`);
            if (this.offerer) {
                if (rebuild || !this.pc) this.rebuild();
                else this.enqueue(() => this.negotiate({ iceRestart: true }));
            } else {
                this.send('restart', { gen: this.gen, inst: this.inst, seen: this.answeredSeq, full: rebuild || !this.pc });
            }
            this.setTimer('restart', RESTART_TIMEOUT_MS, () => {
                this.restartPending = false;
                if (this.state !== 'connected') this.restart();
            });
        }

        /* ------------------------------------------------------------- signals */
        async onSignal(type, data) {
            data = data || {};
            const gen = Number(data.gen) || 0;
            if (type === 'offer') {
                if (this.offerer) { this.log('ignoring an offer: this side offers'); return; }
                if (gen < this.gen) return;
                if (gen > this.gen || !this.pc) this.makePc(gen);
                const pc = this.pc;
                const seq = data.seq == null ? null : Number(data.seq);
                if (seq != null && this.answeredSeq != null) {
                    if (seq < this.answeredSeq) return;                       // an older offer, late
                    if (seq === this.answeredSeq) {
                        // The same offer again: our answer went missing. Repeat it.
                        if (pc.signalingState === 'stable' && pc.localDescription && pc.localDescription.type === 'answer') {
                            this.send('answer', { gen: this.gen, seq, inst: this.inst, sdp: plainDescription(pc.localDescription) });
                        }
                        return;
                    }
                }
                await pc.setRemoteDescription(data.sdp);
                if (pc !== this.pc) return;
                this.clearTimer('ready');
                for (const t of pc.getTransceivers()) {
                    const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
                    if (!kind || t.stopped || t.currentDirection === 'stopped') continue;
                    const track = this.mesh.localTrack(kind);
                    if (t.sender.track !== track) await t.sender.replaceTrack(track);
                    if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
                    if (t.sender.setStreams && this.mesh.localStream) { try { t.sender.setStreams(this.mesh.localStream); } catch (e) { /* optional */ } }
                }
                const answer = await pc.createAnswer();
                if (pc !== this.pc) return;
                await pc.setLocalDescription(answer);
                this.answeredSeq = seq;
                this.restartPending = false;
                this.send('answer', { gen: this.gen, seq, inst: this.inst, sdp: plainDescription(pc.localDescription) });
                const queued = this.pendingIn; this.pendingIn = [];
                await this.addCandidates(queued);
                // Nothing connected after a while even though offer and answer went through: ask for a rebuild.
                if (!this.everConnected) this.setTimer('connect', CONNECT_TIMEOUT_MS + 3000, () => { if (this.state !== 'connected') this.restart(true); });
            } else if (type === 'answer') {
                if (!this.offerer || gen !== this.gen || !this.pc) return;
                const pc = this.pc;
                if (pc.signalingState !== 'have-local-offer') return;
                if (data.seq != null && Number(data.seq) !== this.pendingSeq) { this.log('dropping an answer to an older offer'); return; }
                await pc.setRemoteDescription(data.sdp);
                if (data.inst) this.remoteInst = data.inst;
                this.pendingSeq = null;
                this.restartPending = false;           // the restart went through; the 'restart' timer still checks the result
                const queued = this.pendingIn; this.pendingIn = [];
                await this.addCandidates(queued);
            } else if (type === 'ice') {
                const list = Array.isArray(data.candidates) ? data.candidates : [];
                if (gen > this.gen) {
                    if (this.offerer) return;               // the offerer owns generations
                    this.early.set(gen, (this.early.get(gen) || []).concat(list));
                    return;
                }
                if (gen < this.gen || !this.pc) return;
                if (!this.pc.remoteDescription) { this.pendingIn.push(...list); return; }
                await this.addCandidates(list);
            } else if (type === 'ready') {
                if (!this.offerer) return;
                // A 'ready' from a Peer we already answered with is just late; one from a new Peer means
                // the other side started over (its page rebuilt it), so start over too.
                const fresh = !!(data.inst && this.remoteInst && data.inst !== this.remoteInst);
                if (fresh) { this.remoteInst = null; this.rebuild(); return; }
                if (this.state === 'connected') return;
                if (this.pc && this.pc.signalingState === 'have-local-offer') this.sendOffer();
                else this.rebuild();
            } else if (type === 'restart') {
                if (!this.offerer) return;
                if (data.inst && this.remoteInst && data.inst !== this.remoteInst) { this.remoteInst = null; this.rebuild(); return; }
                if (gen !== this.gen) return;                            // about a connection already replaced
                if (data.full || !this.pc) { this.rebuild(); return; }
                // Already repairing, or they have not seen our newest offer yet: that offer is the answer.
                if (this.restartPending || this.pc.signalingState === 'have-local-offer') return;
                if (data.seen != null && this.seq > Number(data.seen)) return;
                this.restart();
            }
        }

        /* --------------------------------------------------------------- media */
        transceiver(kind) {
            if (!this.pc) return null;
            return this.pc.getTransceivers().find(t => !t.stopped && t.receiver && t.receiver.track && t.receiver.track.kind === kind) || null;
        }

        async replaceTrack(kind, track) {
            const t = this.transceiver(kind);
            if (!t || t.sender.track === track) return;
            try { await t.sender.replaceTrack(track); }
            catch (e) { this.log('replaceTrack failed', e && e.message); }
        }

        applyBitrate(bps) {
            const t = this.transceiver('video');
            if (!t || !t.sender.getParameters) return;
            try {
                const p = t.sender.getParameters();
                if (!p.encodings || !p.encodings.length) return;   // before negotiation there is nothing to cap
                if (p.encodings[0].maxBitrate === bps) return;
                p.encodings[0].maxBitrate = bps;
                t.sender.setParameters(p).catch(() => {});
            } catch (e) { /* not supported */ }
        }

        async readStats() {
            const pc = this.pc;
            if (!pc || this.state === 'closed') return;
            let report;
            try { report = await pc.getStats(); } catch (e) { return; }
            let pair = null, lost = 0, received = 0;
            const byId = new Map();
            report.forEach(r => byId.set(r.id, r));
            report.forEach(r => {
                if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair;
                if (r.type === 'inbound-rtp' && !r.isRemote) { lost += r.packetsLost || 0; received += r.packetsReceived || 0; }
            });
            if (!pair) report.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
            const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
            const local = pair && byId.get(pair.localCandidateId);
            const remote = pair && byId.get(pair.remoteCandidateId);
            const relay = !!((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay'));
            let loss = 0;
            if (this.lastLoss) {
                const dl = lost - this.lastLoss.lost, dr = received - this.lastLoss.received;
                loss = dl + dr > 0 ? Math.max(0, Math.round((dl / (dl + dr)) * 1000) / 10) : 0;
            }
            this.lastLoss = { lost, received };
            let quality = 'good';
            if ((rtt !== null && rtt > 400) || loss > 8) quality = 'poor';
            else if ((rtt !== null && rtt > 150) || loss > 2) quality = 'fair';
            if (this.state !== 'connected') quality = 'poor';
            if (this.state !== 'connected' && this.downSince && Date.now() - this.downSince > FAILED_AFTER_MS) this.setState('failed');
            this.mesh.emit('stats', this.userId, { rtt, loss, quality, relay });
        }

        level() {
            const pc = this.pc;
            if (!pc || this.state !== 'connected') return 0;
            const r = pc.getReceivers().find(x => x.track && x.track.kind === 'audio');
            if (!r || !r.getSynchronizationSources) return 0;
            let lvl = 0;
            try { r.getSynchronizationSources().forEach(s => { if (typeof s.audioLevel === 'number' && Date.now() - s.timestamp < 1000) lvl = Math.max(lvl, s.audioLevel); }); }
            catch (e) { /* not supported */ }
            return lvl;
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            Object.keys(this.timers).forEach(k => this.clearTimer(k));
            this.dropPc();
            if (this.stream) this.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* remote track */ } });
            this.state = 'closed';
        }
    }

    class CallMesh {
        constructor(opts) {
            if (!opts || !opts.selfId || !opts.sid || typeof opts.send !== 'function') throw new Error('WSCallMesh needs selfId, sid and send');
            this.selfId = opts.selfId;
            this.sid = opts.sid;
            this.iceServers = opts.iceServers && opts.iceServers.length ? opts.iceServers : DEFAULT_ICE;
            this.localStream = opts.localStream || new MediaStream();
            this._send = opts.send;
            this._log = typeof opts.log === 'function' ? opts.log : null;
            this.peers = new Map();
            this.retired = new Map();       // sid -> time it left (late signals from it are ignored)
            this.handlers = new Map();
            this.closed = false;
            this.lastGen = 0;
            this.statsTimer = setInterval(() => this.peers.forEach(p => p.readStats()), STATS_EVERY_MS);
            this.levelsTimer = setInterval(() => {
                if (!this.peers.size || !this.handlers.get('levels')) return;
                const m = new Map();
                this.peers.forEach(p => m.set(p.userId, p.level()));
                this.emit('levels', m);
            }, LEVELS_EVERY_MS);
        }

        log(...a) { if (this._log) this._log(...a); }
        on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev).add(fn); return this; }
        off(ev, fn) { const s = this.handlers.get(ev); if (s) s.delete(fn); return this; }
        emit(ev, ...args) {
            const s = this.handlers.get(ev);
            if (s) s.forEach(fn => { try { fn(...args); } catch (e) { this.log('handler error', ev, e); } });
        }

        get peerCount() { return this.peers.size; }
        peerIds() { return [...this.peers.keys()]; }
        peerState(userId) { const p = this.peers.get(userId); return p ? p.state : null; }
        /** For diagnostics and tests: the live RTCPeerConnection. */
        connectionOf(userId) { const p = this.peers.get(userId); return p ? p.pc : null; }

        /** Generations only ever go up, across every Peer this page makes (the offerer's clock). */
        nextGen(prev) {
            this.lastGen = Math.max(Date.now(), this.lastGen + 1, (prev || 0) + 1);
            return this.lastGen;
        }

        sendTo(peer, type, data) {
            if (this.closed && type !== 'bye') return;
            try { this._send({ userId: peer.userId, sid: peer.sid }, type, data); }
            catch (e) { this.log('send failed', type, e); }
        }

        localTrack(kind) {
            const list = kind === 'audio' ? this.localStream.getAudioTracks() : this.localStream.getVideoTracks();
            return list.find(t => t.readyState === 'live') || null;
        }

        isRetired(sid) {
            const at = this.retired.get(sid);
            if (!at) return false;
            if (Date.now() - at > RETIRE_MS) { this.retired.delete(sid); return false; }
            return true;
        }

        addPeer(remote) {
            if (this.closed || !remote || !remote.userId || !remote.sid || remote.userId === this.selfId) return null;
            const existing = this.peers.get(remote.userId);
            if (existing) {
                if (remote.name) existing.name = remote.name;
                if (existing.sid === remote.sid) return existing;
                this.removePeer(remote.userId, 'replaced');       // the same person on a new device
            }
            this.retired.delete(remote.sid);
            const peer = new Peer(this, remote);
            this.peers.set(remote.userId, peer);
            this.emit('state', peer.userId, 'connecting');
            peer.start();
            this.applyBitrates();
            return peer;
        }

        removePeer(userId, reason, opts) {
            const peer = this.peers.get(userId);
            if (!peer) return;
            if (opts && opts.notify) this.sendTo(peer, 'reset', {});
            this.peers.delete(userId);
            this.retired.set(peer.sid, Date.now());
            peer.close();
            this.log('peer removed', userId, reason || '');
            this.emit('state', userId, 'closed');
            this.applyBitrates();
        }

        handleSignal(from, type, data) {
            if (this.closed || !from || !from.userId || !from.sid || from.userId === this.selfId) return;
            let peer = this.peers.get(from.userId);
            if (type === 'bye') {
                if (peer && peer.sid === from.sid) this.removePeer(from.userId, 'bye');
                return;
            }
            if (type === 'reset') {
                // The other side dropped its connection to us: drop ours and start again from nothing.
                if (peer && peer.sid === from.sid) {
                    const again = { userId: peer.userId, sid: peer.sid, name: peer.name };
                    this.removePeer(from.userId, 'reset');
                    this.addPeer(again);
                }
                return;
            }
            if (!peer || peer.sid !== from.sid) {
                // Presence can lag behind signalling, and a person can reappear on a new device.
                if (this.isRetired(from.sid)) return;
                peer = this.addPeer({ userId: from.userId, sid: from.sid });
                if (!peer) return;
            }
            peer.enqueue(() => peer.onSignal(type, data));
        }

        async setLocalTrack(kind, track) {
            const stream = this.localStream;
            (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())
                .filter(t => t !== track).forEach(t => stream.removeTrack(t));
            if (track && !stream.getTracks().includes(track)) stream.addTrack(track);
            await Promise.all([...this.peers.values()].map(p => p.replaceTrack(kind, track || null)));
            if (kind === 'video') this.applyBitrates();
        }

        setIceServers(list) {
            if (!Array.isArray(list) || !list.length) return;
            this.iceServers = list;
            // Takes effect on the next ICE restart for connections that already exist.
            this.peers.forEach(p => { if (p.pc && p.pc.setConfiguration) { try { p.pc.setConfiguration({ ...p.pc.getConfiguration(), iceServers: list }); } catch (e) { /* older browsers */ } } });
        }

        restartIce(userId) {
            const p = this.peers.get(userId);
            if (p) p.restart();
        }

        applyBitrates() {
            const v = this.localTrack('video');
            const bps = videoBitrate(this.peers.size, !!(v && v.contentHint === 'detail'));
            this.peers.forEach(p => p.applyBitrate(bps));
        }

        /** close({ bye: false }) leaves without telling anyone — for when this device was replaced by another. */
        close(opts) {
            if (this.closed) return;
            if (!opts || opts.bye !== false) this.peers.forEach(p => this.sendTo(p, 'bye', {}));
            this.closed = true;
            clearInterval(this.statsTimer);
            clearInterval(this.levelsTimer);
            [...this.peers.keys()].forEach(id => this.removePeer(id, 'hangup'));
            this.handlers.clear();
        }
    }

    CallMesh.DEFAULT_ICE = DEFAULT_ICE;
    CallMesh.videoBitrate = videoBitrate;
    if (typeof module === 'object' && module.exports) module.exports = CallMesh;
    else root.WSCallMesh = CallMesh;
})(typeof self !== 'undefined' ? self : this);
