const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
app.use(cors());

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_QUALITIES = ['360', '480', '720', '1080', '1440', '2160', 'mp3'];
const TIME_RE = /^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/;
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const JOBS_DIR = path.join(__dirname, 'downloads-tmp');
const JOB_TTL = 60 * 60 * 1000;       // finished files are deleted after 1 hour
const MAX_ACTIVE_JOBS = 3;

fs.rmSync(JOBS_DIR, { recursive: true, force: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

function isValidUrl(u) {
    try {
        const p = new URL(u);
        return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
        return false;
    }
}

function cookieArgs() {
    return fs.existsSync(COOKIES_FILE) ? ['--cookies', COOKIES_FILE] : [];
}

function shortError(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const err = [...lines].reverse().find(l => l.startsWith('ERROR')) || lines[lines.length - 1] || 'Unknown error';
    return err.replace(/^ERROR:\s*/, '').slice(0, 300);
}

function safeName(name) {
    return (name || 'video').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'video';
}

function dirSize(dir) {
    try {
        return fs.readdirSync(dir).reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(dir, f)).size; } catch { return sum; }
        }, 0);
    } catch { return 0; }
}

/* ---------------- Preview (info + playable proxy) ---------------- */

// Estimate file size for each quality option from the format list
function fmtSize(f, duration) {
    if (f.filesize) return f.filesize;
    if (f.filesize_approx) return f.filesize_approx;
    if (f.tbr && duration) return Math.round(f.tbr * 125 * duration);
    return 0;
}

function buildOptions(info) {
    const d = info.duration || 0;
    const formats = info.formats || [];
    const audios = formats.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
    const bestAudio = audios.sort((a, b) => (/mp4a/.test(b.acodec) - /mp4a/.test(a.acodec)) || ((b.abr || 0) - (a.abr || 0)))[0];
    const audioSize = bestAudio ? fmtSize(bestAudio, d) : 0;
    const videos = formats.filter(f => f.vcodec !== 'none' && f.height);
    const maxH = videos.reduce((m, f) => Math.max(m, f.height || 0), info.height || 0);

    const opts = [];
    // Some sites (direct files, simple players) report no resolution at all:
    // still offer every video option instead of hiding them.
    if (!videos.length) {
        const any = formats.filter(f => f.vcodec !== 'none').pop() || info;
        const size = fmtSize(any, d);
        for (const q of [1080, 720, 480]) opts.push({ quality: String(q), available: true, height: 0, size });
        opts.push({ quality: 'mp3', available: true, height: 0, size: d ? Math.round(190 * 125 * d) : 0 });
        return opts;
    }
    for (const q of [1080, 720, 480]) {
        // mirror the download format choice: phone-friendly (H.264 / MP4) first
        const friendly = f => /avc1/.test(f.vcodec || '') || f.ext === 'mp4';
        const all = videos.filter(f => f.height <= q);
        const pool = all.some(friendly) ? all.filter(friendly) : all;
        const cands = pool.sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));
        const v = cands[0];
        const combined = v && v.acodec !== 'none';
        const size = v ? fmtSize(v, d) + (combined ? 0 : audioSize) : 0;
        // a tier counts only if it really is better than the tier below it
        const lower = { 1080: 720, 720: 480, 480: 0 }[q];
        opts.push({ quality: String(q), available: !!v && v.height > lower, height: v ? v.height : 0, size });
    }
    opts.push({ quality: 'mp3', available: true, height: 0, size: d ? Math.round(190 * 125 * d) : audioSize });
    return opts;
}

const previewCache = new Map(); // sourceUrl -> { url, headers, expires }

app.get('/api/info', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl || !isValidUrl(videoUrl)) return res.status(400).json({ error: 'Invalid URL' });

    const p = spawn('yt-dlp', ['-J', '--no-warnings', '--no-playlist',
        '-f', 'best[ext=mp4]/best/bestvideo+bestaudio', ...cookieArgs(), '--', videoUrl],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => !res.headersSent && res.status(500).json({ error: 'yt-dlp not available: ' + e.message }));
    req.on('close', () => { if (p.exitCode === null) p.kill('SIGKILL'); });

    p.on('close', code => {
        if (res.headersSent) return;
        if (code !== 0) {
            console.error('[info] error:', shortError(err));
            return res.status(500).json({ error: shortError(err) });
        }
        try {
            const info = JSON.parse(out);
            const single = !(info.requested_formats && info.requested_formats.length > 1);
            const playable = single && info.url && !/\.m3u8|manifest|\.mpd/i.test(info.url);
            if (playable) {
                previewCache.set(videoUrl, { url: info.url, headers: info.http_headers || {}, expires: Date.now() + JOB_TTL });
            }
            res.json({
                title: info.title || 'video',
                duration: info.duration || 0,
                thumbnail: info.thumbnail || null,
                options: buildOptions(info),
                previewUrl: playable ? `/api/preview?url=${encodeURIComponent(videoUrl)}` : null
            });
        } catch {
            res.status(500).json({ error: 'Parse error' });
        }
    });
});

app.get('/api/preview', async (req, res) => {
    const entry = previewCache.get(req.query.url);
    if (!entry || entry.expires < Date.now()) return res.status(404).send('Preview expired, reload video');

    const headers = { ...entry.headers };
    if (req.headers.range) headers.Range = req.headers.range;
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
        const upstream = await fetch(entry.url, { headers, signal: controller.signal });
        res.status(upstream.status);
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        if (!upstream.body) return res.end();
        Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
    } catch {
        if (!res.headersSent) res.status(502).send('Preview failed');
        else res.end();
    }
});

/* ---------------- Download jobs with progress ---------------- */

const jobs = new Map();

function fmtEta(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function publicJob(j) {
    const bytes = dirSize(j.dir);
    const now = Date.now();
    let { percent, speed, eta } = j;

    // Overall progress from bytes on disk vs. expected size (works across video+audio
    // parts and for trimmed sections, where yt-dlp reports no percentage)
    if (j.status === 'running' && j.est > 0 && bytes > 0) {
        j.samples.push([now, bytes]);
        while (j.samples.length > 2 && now - j.samples[0][0] > 8000) j.samples.shift();
        const [t0, b0] = j.samples[0];
        const rate = now > t0 ? (bytes - b0) / ((now - t0) / 1000) : 0;
        percent = Math.min(99, (bytes / j.est) * 100);
        if (rate > 0) {
            speed = (rate / 1024 / 1024).toFixed(1) + ' MB/s';
            eta = percent >= 99 ? '' : fmtEta((j.est - bytes) / rate);
        }
        if (percent >= 99 && j.stage !== 'מעבד ומאחד קובץ...') j.stage = 'מעבד ומאחד קובץ...';
    }
    return {
        id: j.id, status: j.status, stage: j.stage, percent,
        speed, eta, bytes, total: j.est || 0, error: j.error,
        fileName: j.fileName, elapsed: Math.round((now - j.created) / 1000)
    };
}

app.get('/api/job/start', (req, res) => {
    const { url, start, end, quality = '720' } = req.query;
    const est = Math.max(0, parseInt(req.query.est, 10) || 0);
    if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'קישור לא תקין' });
    if (!ALLOWED_QUALITIES.includes(quality)) return res.status(400).json({ error: 'איכות לא תקינה' });
    if (start && !TIME_RE.test(start)) return res.status(400).json({ error: 'זמן התחלה לא תקין' });
    if (end && !TIME_RE.test(end)) return res.status(400).json({ error: 'זמן סיום לא תקין' });

    const active = [...jobs.values()].filter(j => j.status === 'running').length;
    if (active >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: 'יש כבר הורדות פעילות, נסה שוב בעוד רגע' });

    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir);

    const isAudio = quality === 'mp3';
    const args = [
        '--no-playlist', '--no-warnings', '-q', '--progress', '--newline',
        '--no-simulate', '--print', 'before_dl:TITLE %(title)s', '--encoding', 'utf-8',
        '--progress-template', 'download:PROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '-N', '4',                       // download 4 fragments in parallel = faster
        ...cookieArgs(),
        '-o', path.join(dir, 'file.%(ext)s')
    ];

    if (isAudio) {
        args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '2');
    } else {
        args.push(
            '-f', `bestvideo[height<=${quality}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${quality}][ext=mp4]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best[ext=mp4]/best`,
            '--merge-output-format', 'mp4'
        );
    }

    const hasStart = start && start !== '00:00:00';
    const hasEnd = end && end !== '00:00:00';
    if (hasStart || hasEnd) {
        args.push('--download-sections', `*${hasStart ? start : '00:00:00'}-${hasEnd ? end : 'inf'}`);
    }
    args.push('--', url);

    const job = {
        id, dir, status: 'running', stage: 'מתחבר לאתר...', percent: null, speed: '', eta: '',
        error: null, file: null, fileName: null, title: 'video', created: Date.now(), parts: 0, proc: null,
        est, samples: []
    };
    jobs.set(id, job);

    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = p;
    let errText = '';
    let buf = '';

    p.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
            if (line.startsWith('PROG ')) {
                const [pct, speed, eta] = line.slice(5).split('|').map(s => s.trim());
                const num = parseFloat(pct);
                if (!isNaN(num)) {
                    if (job.percent !== null && num < job.percent - 50) job.parts++;
                    job.percent = num;
                }
                job.speed = speed && speed !== 'NA' && !speed.includes('Unknown') ? speed : '';
                job.eta = eta && eta !== 'NA' && !eta.includes('Unknown') ? eta : '';
                job.stage = isAudio ? 'מוריד שמע' : (job.parts === 0 ? 'מוריד וידאו' : 'מוריד שמע');
                if (num >= 100) job.stage = 'מעבד ומאחד קובץ...';
            } else if (line.startsWith('TITLE ')) {
                job.title = line.slice(6).trim();
            }
        }
    });
    p.stderr.on('data', d => { errText += d.toString(); });
    p.on('error', e => { job.status = 'error'; job.error = 'yt-dlp not available: ' + e.message; });

    // While ffmpeg cuts a section yt-dlp reports no %, so show a "working" stage
    setTimeout(() => { if (job.status === 'running' && job.percent === null) job.stage = 'מוריד ומעבד...'; }, 4000);

    p.on('close', code => {
        job.proc = null;
        if (job.status === 'cancelled') return;
        // the finished file is the largest non-temporary file in the job folder
        const files = fs.readdirSync(dir)
            .filter(f => !/\.(part|ytdl|temp)$/i.test(f) && !f.includes('.part-') && !/\.f\d+\./.test(f))
            .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
            .sort((a, b) => b.size - a.size);
        if (files.length) job.file = path.join(dir, files[0].f);
        if (code !== 0 || !job.file) {
            job.status = 'error';
            job.error = shortError(errText) || 'ההורדה נכשלה';
            console.error('[job] error:', job.error);
            return;
        }
        job.status = 'done';
        job.percent = 100;
        job.stage = 'מוכן!';
        job.fileName = safeName(job.title) + path.extname(job.file);
    });

    res.json({ id });
});

app.get('/api/job/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'לא נמצא' });
    res.json(publicJob(job));
});

app.get('/api/job/:id/file', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !job.file) return res.status(404).send('הקובץ לא נמצא');
    res.download(job.file, job.fileName);   // sends Content-Length => real progress in the phone's downloads
});

// Stream the finished file inline (with seeking) so the page can preview it for trimming
app.get('/api/job/:id/view', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !job.file) return res.status(404).send('הקובץ לא נמצא');
    res.sendFile(job.file);
});

// Trim an already-downloaded file - no re-download, runs on the local copy
app.get('/api/job/:id/trim', (req, res) => {
    const src = jobs.get(req.params.id);
    if (!src || src.status !== 'done' || !src.file) return res.status(404).json({ error: 'הקובץ לא נמצא' });
    const { start = '', end = '' } = req.query;
    if ((start && !TIME_RE.test(start)) || (end && !TIME_RE.test(end))) return res.status(400).json({ error: 'זמן לא תקין' });

    const toSec = s => s ? s.split(':').map(Number).reduce((a, v) => a * 60 + v, 0) : 0;
    const s = toSec(start), e = toSec(end);
    if (e && e <= s) return res.status(400).json({ error: 'זמן הסיום חייב להיות אחרי ההתחלה' });

    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir);
    const ext = path.extname(src.file);
    const out = path.join(dir, 'file' + ext);

    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
    if (s) args.push('-ss', String(s));
    if (e) args.push('-to', String(e));
    args.push('-i', src.file);
    // Stream copy: fast and light on memory (re-encoding crashed the small cloud server).
    // Video cuts land on the nearest keyframe, usually within a few seconds.
    args.push('-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero');
    if (ext.toLowerCase() === '.mp4') args.push('-movflags', '+faststart');
    args.push('-y', out);

    const total = (e || src.duration || 0) - s;
    const job = {
        id, dir, status: 'running', stage: 'חותך...', percent: total > 0 ? 0 : null, speed: '', eta: '',
        error: null, file: null, fileName: null, title: src.title, created: Date.now(), parts: 0, proc: null,
        est: 0, samples: []
    };
    jobs.set(id, job);

    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = p;
    let errText = '';
    p.stdout.on('data', d => {
        const m = /out_time_us=(\d+)/.exec(d.toString());
        if (m && total > 0) job.percent = Math.min(99, (Number(m[1]) / 1e6 / total) * 100);
    });
    p.stderr.on('data', d => { errText += d; });
    p.on('error', err => { job.status = 'error'; job.error = 'ffmpeg not available: ' + err.message; });
    p.on('close', code => {
        job.proc = null;
        if (job.status === 'cancelled') return;
        if (code !== 0 || !fs.existsSync(out)) {
            job.status = 'error';
            job.error = shortError(errText) || 'החיתוך נכשל';
            return;
        }
        job.file = out;
        job.status = 'done';
        job.percent = 100;
        job.stage = 'מוכן!';
        const tag = `${start || '00:00:00'}-${end || 'end'}`.replace(/:/g, '.');
        job.fileName = safeName(src.title) + ' (' + tag + ')' + ext;
    });

    res.json({ id });
});

app.get('/api/job/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'לא נמצא' });
    if (job.proc) { job.status = 'cancelled'; job.proc.kill('SIGKILL'); }
    res.json({ ok: true });
});

// Cleanup old jobs and their files
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        // never touch a running job; delete finished files 1 hour after they finished
        if (job.status === 'running') continue;
        if (!job.finishedAt) job.finishedAt = now;
        if (now - job.finishedAt > JOB_TTL) {
            fs.rm(job.dir, { recursive: true, force: true }, () => {});
            jobs.delete(id);
        }
    }
    for (const [k, v] of previewCache) if (v.expires < now) previewCache.delete(k);
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, (err) => {
    if (err) return console.error('Server failed to start:', err.message);
    console.log(`Server running on http://localhost:${PORT}`);
    // addresses for phones on the same Wi-Fi (much faster than the tunnel)
    const lan = Object.values(require('os').networkInterfaces()).flat()
        .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
    if (lan.length) console.log('Same Wi-Fi (fast): ' + lan.join('  '));
    console.log(fs.existsSync(COOKIES_FILE) ? 'cookies.txt found - logged-in sites enabled' : 'No cookies.txt (optional)');
});
