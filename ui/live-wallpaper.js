/* ============================================================================
   WorkSuite — live wallpapers (Bitrix24-style animated backgrounds)

   WSLiveWall.start(key) draws an animated scene on a fixed canvas behind the
   whole app, over the scene's CSS gradient (ui/b24.css, --wall-<key>), and
   WSLiveWall.stop() removes it. ui/shell.js calls these when the wallpaper
   changes. The page never depends on it: without the script, or with
   "reduce motion" on, the same gradient shows still.

   Kind to the machine: at most 30 frames a second, paused while the tab is
   hidden, one frame only when the system asks for reduced motion, and the
   canvas at no more than 1.5x the CSS pixel size.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSLiveWall) return;

    var SCENES = {};
    var S = { key: null, canvas: null, ctx: null, raf: 0, last: 0, t: 0, w: 0, h: 0, dpr: 1, data: null };
    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    var rnd = function (a, b) { return a + Math.random() * (b - a); };

    /* ------------------------------------------------------------ scenes */
    // Each scene: init(w, h) -> state, draw(ctx, state, t seconds, w, h).

    // Starfall: a night sky, twinkling stars, now and then a shooting star.
    SCENES.starfall = {
        init: function (w, h) {
            var n = Math.round(w * h / 5200), stars = [];
            for (var i = 0; i < n; i++) stars.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.3, 1.5), p: rnd(0, 6.28), s: rnd(0.6, 2.2) });
            return { stars: stars, shots: [], next: 1.5 };
        },
        draw: function (c, d, t, w, h, dt) {
            c.clearRect(0, 0, w, h);
            d.stars.forEach(function (s) {
                var a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.s + s.p));
                c.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
                c.beginPath(); c.arc(s.x, s.y, s.r, 0, 6.2832); c.fill();
            });
            d.next -= dt;
            if (d.next <= 0) { d.shots.push({ x: rnd(w * 0.2, w), y: rnd(0, h * 0.4), vx: -rnd(500, 800), vy: rnd(180, 320), life: 1 }); d.next = rnd(2.5, 6); }
            d.shots = d.shots.filter(function (s) {
                s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt * 0.9;
                var g = c.createLinearGradient(s.x, s.y, s.x - s.vx * 0.18, s.y - s.vy * 0.18);
                g.addColorStop(0, 'rgba(255,255,255,' + Math.max(0, s.life).toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
                c.strokeStyle = g; c.lineWidth = 2; c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x - s.vx * 0.18, s.y - s.vy * 0.18); c.stroke();
                return s.life > 0 && s.x > -200 && s.y < h + 200;
            });
        },
    };

    // Northern lights: slow ribbons of green and violet light.
    SCENES.northern = {
        init: function () { return { bands: [
            { hue: 150, y: 0.30, amp: 0.08, len: 0.9, speed: 0.12, alpha: 0.35 },
            { hue: 175, y: 0.38, amp: 0.10, len: 1.3, speed: 0.08, alpha: 0.28 },
            { hue: 275, y: 0.24, amp: 0.07, len: 0.7, speed: 0.10, alpha: 0.24 },
        ] }; },
        draw: function (c, d, t, w, h) {
            c.clearRect(0, 0, w, h);
            c.globalCompositeOperation = 'lighter';
            d.bands.forEach(function (b, i) {
                var top = [], step = Math.max(8, w / 90);
                for (var x = 0; x <= w + step; x += step) {
                    var k = x / w;
                    top.push(h * (b.y + b.amp * Math.sin(k * 6.2832 * b.len + t * b.speed * 6.2832 + i) + 0.03 * Math.sin(k * 23 + t * 0.9)));
                }
                var height = h * 0.34;
                var g = c.createLinearGradient(0, h * (b.y - b.amp), 0, h * (b.y + b.amp) + height);
                // Bright at the ribbon's upper edge, gone well before its lower one: light, not hills.
                g.addColorStop(0, 'hsla(' + b.hue + ',90%,65%,0)');
                g.addColorStop(0.18, 'hsla(' + b.hue + ',95%,66%,' + b.alpha + ')');
                g.addColorStop(0.45, 'hsla(' + (b.hue + 10) + ',90%,55%,' + (b.alpha * 0.35).toFixed(3) + ')');
                g.addColorStop(0.75, 'hsla(' + (b.hue + 20) + ',90%,50%,0)');
                c.fillStyle = g;
                c.beginPath();
                top.forEach(function (y, j) { var x = j * step; if (j) c.lineTo(x, y); else c.moveTo(x, y); });
                for (var j = top.length - 1; j >= 0; j--) c.lineTo(j * step, top[j] + height * (0.7 + 0.3 * Math.sin(j * 0.21 + t * 0.6 + i)));
                c.closePath(); c.fill();
            });
            c.globalCompositeOperation = 'source-over';
        },
    };

    // Ocean: layered waves rolling along the bottom of the screen.
    SCENES.ocean = {
        init: function () { return { layers: [
            { y: 0.62, amp: 18, len: 520, speed: 30, color: 'rgba(120,210,235,0.18)' },
            { y: 0.70, amp: 22, len: 640, speed: -22, color: 'rgba(60,170,215,0.24)' },
            { y: 0.79, amp: 26, len: 760, speed: 18, color: 'rgba(20,110,170,0.32)' },
            { y: 0.88, amp: 20, len: 580, speed: -14, color: 'rgba(8,60,110,0.45)' },
        ] }; },
        draw: function (c, d, t, w, h) {
            c.clearRect(0, 0, w, h);
            d.layers.forEach(function (l) {
                c.fillStyle = l.color; c.beginPath(); c.moveTo(0, h);
                for (var x = 0; x <= w + 10; x += 10) {
                    var p = (x + t * l.speed) / l.len * 6.2832;
                    c.lineTo(x, h * l.y + Math.sin(p) * l.amp + Math.sin(p * 2.3 + t * 0.7) * l.amp * 0.3);
                }
                c.lineTo(w, h); c.closePath(); c.fill();
            });
        },
    };

    // Bokeh: soft warm lights drifting upwards, as in a city at dusk.
    SCENES.bokeh = {
        init: function (w, h) {
            var n = Math.max(18, Math.round(w * h / 42000)), dots = [];
            var hues = [28, 40, 330, 350, 200];
            for (var i = 0; i < n; i++) dots.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(14, 60), vy: rnd(6, 22), vx: rnd(-6, 6), hue: hues[i % hues.length], a: rnd(0.08, 0.22), p: rnd(0, 6.28) });
            return { dots: dots };
        },
        draw: function (c, d, t, w, h, dt) {
            c.clearRect(0, 0, w, h);
            d.dots.forEach(function (o) {
                o.y -= o.vy * dt; o.x += (o.vx + Math.sin(t * 0.5 + o.p) * 4) * dt;
                if (o.y < -o.r) { o.y = h + o.r; o.x = rnd(0, w); }
                var g = c.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r);
                g.addColorStop(0, 'hsla(' + o.hue + ',95%,72%,' + (o.a * (0.8 + 0.2 * Math.sin(t + o.p))).toFixed(3) + ')');
                g.addColorStop(0.7, 'hsla(' + o.hue + ',95%,65%,' + (o.a * 0.5).toFixed(3) + ')');
                g.addColorStop(1, 'hsla(' + o.hue + ',95%,60%,0)');
                c.fillStyle = g; c.beginPath(); c.arc(o.x, o.y, o.r, 0, 6.2832); c.fill();
            });
        },
    };

    // Fireflies: a dark forest with small glowing lights wandering about.
    SCENES.fireflies = {
        init: function (w, h) {
            var n = Math.max(30, Math.round(w * h / 26000)), f = [];
            for (var i = 0; i < n; i++) f.push({ x: rnd(0, w), y: rnd(h * 0.25, h), a: rnd(0, 6.28), sp: rnd(12, 32), p: rnd(0, 6.28), s: rnd(0.8, 2.2) });
            return { f: f };
        },
        draw: function (c, d, t, w, h, dt) {
            c.clearRect(0, 0, w, h);
            d.f.forEach(function (o) {
                o.a += (Math.sin(t * 0.7 + o.p) * 0.9) * dt;
                o.x += Math.cos(o.a) * o.sp * dt; o.y += Math.sin(o.a) * o.sp * dt * 0.6;
                if (o.x < -20) o.x = w + 20; if (o.x > w + 20) o.x = -20;
                if (o.y < h * 0.15) o.y = h * 0.15; if (o.y > h + 20) o.y = h * 0.3;
                var glow = Math.max(0, Math.sin(t * o.s + o.p));
                var r = 10 + glow * 10;
                var g = c.createRadialGradient(o.x, o.y, 0, o.x, o.y, r);
                g.addColorStop(0, 'rgba(230,255,150,' + (0.15 + 0.75 * glow).toFixed(3) + ')');
                g.addColorStop(1, 'rgba(200,255,120,0)');
                c.fillStyle = g; c.beginPath(); c.arc(o.x, o.y, r, 0, 6.2832); c.fill();
            });
        },
    };

    /* ------------------------------------------------------------ engine */
    function size() {
        if (!S.canvas) return;
        S.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        S.w = window.innerWidth; S.h = window.innerHeight;
        S.canvas.width = Math.round(S.w * S.dpr); S.canvas.height = Math.round(S.h * S.dpr);
        S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        S.data = SCENES[S.key].init(S.w, S.h);
        frame(performance.now(), true);
    }
    function frame(now, force) {
        if (!S.canvas) return;
        var dt = S.last ? Math.min(0.1, (now - S.last) / 1000) : 0.033;
        if (!force && now - S.last < 33) { S.raf = requestAnimationFrame(frame); return; }
        S.last = now; S.t += dt;
        try { SCENES[S.key].draw(S.ctx, S.data, S.t, S.w, S.h, dt); } catch (e) { stop(); return; }
        if (!reduce.matches && !document.hidden) S.raf = requestAnimationFrame(frame);
    }
    function onVisible() {
        if (!S.canvas) return;
        cancelAnimationFrame(S.raf);
        if (!document.hidden && !reduce.matches) { S.last = 0; S.raf = requestAnimationFrame(frame); }
    }
    function start(key) {
        if (!SCENES[key]) return stop();
        if (S.key === key && S.canvas) return;
        stop();
        var cv = document.createElement('canvas');
        cv.id = 'ws-live-wall';
        cv.setAttribute('aria-hidden', 'true');
        // Negative z-index: over the body's gradient (painted on the root), under the whole page.
        cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;';
        document.body.insertBefore(cv, document.body.firstChild);
        S.key = key; S.canvas = cv; S.ctx = cv.getContext('2d'); S.t = rnd(0, 100); S.last = 0;
        document.documentElement.classList.add('ws-live-wall');
        size();
        window.addEventListener('resize', size);
        document.addEventListener('visibilitychange', onVisible);
        if (reduce.addEventListener) reduce.addEventListener('change', onVisible);
    }
    function stop() {
        cancelAnimationFrame(S.raf);
        if (S.canvas) S.canvas.remove();
        S.canvas = S.ctx = S.data = null; S.key = null;
        document.documentElement.classList.remove('ws-live-wall');
        window.removeEventListener('resize', size);
        document.removeEventListener('visibilitychange', onVisible);
    }

    window.WSLiveWall = { start: start, stop: stop, has: function (k) { return !!SCENES[k]; }, SCENES: Object.keys(SCENES) };
})();
