const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');

const app = express();
const upload = multer({ dest: UPLOADS_DIR });

const ffmpeg = require('fluent-ffmpeg');
const http = require('http');
const WebSocket = require('ws');
let ffmpegPath;
try {
	ffmpegPath = require('ffmpeg-static');
	if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {
	// ffmpeg-static not installed or failed; fluent-ffmpeg will try to use system ffmpeg
	ffmpegPath = null;
}

// try to set ffprobe too (ffprobe-static provides a bundled binary); fluent-ffmpeg
// will otherwise try to find a system ffprobe. If ffprobe isn't available, duration
// detection will be unreliable and progress percent can't be computed from timemark.
try {
	const ffprobeStatic = require('ffprobe-static');
	if (ffprobeStatic && ffprobeStatic.path) {
		ffmpeg.setFfprobePath(ffprobeStatic.path);
	}
} catch (e) {
	// not fatal; we'll attempt to continue and fall back to any percent provided by ffmpeg
}

function transcodeToMp4(inputPath, outputPath, jobId) {
	return new Promise((resolve, reject) => {
		// input size for progress estimation
		let inputSize = 0;
		try { inputSize = fs.statSync(inputPath).size || 0; } catch (e) { inputSize = 0; }

		const startTime = Date.now();
		let pollInterval = null;

		const proc = ffmpeg(inputPath)
			.outputOptions([
				'-y',                 // overwrite
				'-c copy',            // copy all streams (no re-encode)
				'-movflags faststart' // better for web playback
			])
			.on('start', (cmd) => {
				console.log('Remuxing (copy):', cmd);
				// initialize job entry if present
				try {
					if (jobId && transcodeJobs[jobId]) {
						transcodeJobs[jobId].progress = 0;
						transcodeJobs[jobId].message = 'remuxing (copying)';
						transcodeJobs[jobId].startedAt = Date.now();
						try { broadcastStatus(jobId); } catch (e) {}
					}
				} catch (e) {}

				// start polling output file size to estimate progress
				pollInterval = setInterval(() => {
					try {
						if (!inputSize) return;
						let outSize = 0;
						try { outSize = fs.statSync(outputPath).size || 0; } catch (e) { outSize = 0; }
						const pct = Math.min(100, Math.round((outSize / inputSize) * 100));
						if (jobId && transcodeJobs[jobId]) {
							transcodeJobs[jobId].progress = pct;
							const elapsed = Math.max(0, Math.round((Date.now() - startTime) / 1000));
							transcodeJobs[jobId].elapsed = elapsed;
							if (pct > 0) {
								const totalEst = Math.round(elapsed * (100 / pct));
								transcodeJobs[jobId].eta = Math.max(0, totalEst - elapsed);
							} else {
								transcodeJobs[jobId].eta = null;
							}
							try { broadcastStatus(jobId); } catch (e) {}
						}
					} catch (e) {}
				}, 800);
			})
			.on('progress', (p) => {
				// also update timemark if available
				try {
					if (jobId && transcodeJobs[jobId] && p && p.timemark) {
						transcodeJobs[jobId].timemark = p.timemark;
						try { broadcastStatus(jobId); } catch (e) {}
					}
				} catch (e) {}
			})
			.on('error', (err) => {
				if (pollInterval) clearInterval(pollInterval);
				return reject(new Error(err.message || String(err)));
			})
			.on('end', () => {
				if (pollInterval) clearInterval(pollInterval);
				// On end, ensure progress is 100%
				try {
					if (jobId && transcodeJobs[jobId]) {
						transcodeJobs[jobId].progress = 100;
						transcodeJobs[jobId].elapsed = Math.max(0, Math.round((Date.now() - startTime) / 1000));
						transcodeJobs[jobId].eta = 0;
						try { broadcastStatus(jobId); } catch (e) {}
					}
				} catch (e) {}
				return resolve({ outputPath });
			})
			.save(outputPath);
	});
}


// in-memory transcode job tracking
const transcodeJobs = {}; // id -> { status, progress, message }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readData() {
	try {
		return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}');
	} catch (e) {
		return {};
	}
}

function writeData(d) {
	fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8');
}

app.post('/upload', upload.single('file'), async (req, res) => {
	if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

		const id = uuidv4();
		const ext = path.extname(req.file.originalname) || '';
		const origName = req.file.originalname;
		const tempName = req.file.filename; // multer's temp name in uploads
		const tempPath = path.join(UPLOADS_DIR, tempName);

		// target filename initially same extension as original
		let finalExt = ext.toLowerCase();
		let finalName = id + finalExt;
		let finalPath = path.join(UPLOADS_DIR, finalName);

		// move multer file to the intended filename (we'll overwrite if needed)
		try {
			fs.renameSync(tempPath, finalPath);
		} catch (err) {
			// fallback: if rename fails, try copying
			fs.copyFileSync(tempPath, finalPath);
			try { fs.unlinkSync(tempPath); } catch (e) {}
		}

		let converted = false;
		let warning = null;

		// If not a supported container, try converting to mp4
		// Do NOT include .mkv here so MKV uploads are converted to MP4 for better browser/Discord support
		const supportedExts = new Set(['.mp4', '.mov', '.webm']);
			if (!supportedExts.has(finalExt)) {
				// schedule an asynchronous transcode job and return immediately. Clients can poll /transcode-status/:id
				const convertedName = id + '.mp4';
				const convertedPath = path.join(UPLOADS_DIR, convertedName);
				converted = false;
				// transcodeJobs[id] = { status: 'queued', progress: 0, message: 'queued' };

						// run conversion in background (simple flow using transcodeToMp4)
						transcodeJobs[id] = transcodeJobs[id] || { status: 'queued', progress: 0, message: 'queued' };
						(async () => {
							transcodeJobs[id].status = 'running';
							transcodeJobs[id].message = 'starting';
							try { broadcastStatus(id); } catch (e) {}
							try {
								transcodeJobs[id].message = 'remux/re-encode (simple)';
								try { broadcastStatus(id); } catch (e) {}
								await transcodeToMp4(finalPath, convertedPath, id);
								// replace final file with converted one
								try { fs.unlinkSync(finalPath); } catch (e) {}
								finalName = convertedName;
								finalPath = convertedPath;
								finalExt = '.mp4';
								converted = true;

								// update metadata on disk
								const d2 = readData();
								if (d2[id]) {
									d2[id].filename = finalName;
									d2[id].mime = mime.lookup(finalPath) || d2[id].mime;
									d2[id].size = fs.statSync(finalPath).size;
									d2[id].converted = true;
									writeData(d2);
								}
								transcodeJobs[id].status = 'done';
								transcodeJobs[id].progress = 100;
								transcodeJobs[id].message = 'finished';
								try { broadcastStatus(id); } catch (e) {}
							} catch (err) {
								transcodeJobs[id].status = 'error';
								transcodeJobs[id].message = (err && err.message) || String(err);
								console.error('Transcode error:', transcodeJobs[id].message);
								try { broadcastStatus(id); } catch (e) {}
							}
						})();
			}

		const stat = fs.statSync(finalPath);

		const d = readData();
		d[id] = {
			id,
			filename: finalName,
			originalName: origName,
			mime: mime.lookup(finalPath) || req.file.mimetype || 'application/octet-stream',
			size: stat.size,
			createdAt: Date.now(),
			converted: converted,
		};
		writeData(d);

		const host = req.get('host');
		const protocol = req.protocol;
		const videoUrl = `${protocol}://${host}/v/${id}`;
		const shortUrl = `${protocol}://${host}/s/${id}`;

		const resp = { id, videoUrl, shortUrl, info: d[id] };
		if (warning) resp.warning = warning;
		res.json(resp);
});

// Short redirect link
app.get('/s/:id', (req, res) => {
	const id = req.params.id;
	const d = readData();
	if (!d[id]) return sendInvalidEmbed(req, res);
	res.redirect(`/v/${id}`);
});

// Serve video with Range support so Discord (and browsers) can embed/seek
app.get('/v/:id', (req, res) => {
	const id = req.params.id;
	const d = readData();
	if (!d[id]) return sendInvalidEmbed(req, res);

	const filePath = path.join(UPLOADS_DIR, d[id].filename);
	if (!fs.existsSync(filePath)) return sendInvalidEmbed(req, res);

	const stat = fs.statSync(filePath);
	const fileSize = stat.size;
	const range = req.headers.range;
	const contentType = d[id].mime || mime.lookup(filePath) || 'application/octet-stream';

	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('Content-Type', contentType);

	if (range) {
		const parts = range.replace(/bytes=/, '').split('-');
		const start = parseInt(parts[0], 10);
		const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
		if (isNaN(start) || isNaN(end) || start > end) {
			return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
		}

		const chunkSize = (end - start) + 1;
		res.status(206);
		res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
		res.setHeader('Content-Length', chunkSize);

		const stream = fs.createReadStream(filePath, { start, end });
		stream.on('open', () => stream.pipe(res));
		stream.on('error', (err) => res.status(500).end(err));
	} else {
		res.setHeader('Content-Length', fileSize);
		const stream = fs.createReadStream(filePath);
		stream.on('open', () => stream.pipe(res));
		stream.on('error', (err) => res.status(500).end(err));
	}
});

// create http server so we can attach WebSocket server
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// WebSocket server for realtime transcode updates
const wss = new WebSocket.Server({ server });
// subscribers: id -> Set of ws
const subscribers = new Map();

function broadcastStatus(id) {
	const set = subscribers.get(id);
	if (!set) return;
	const job = transcodeJobs[id] || { status: 'none' };
	const msg = JSON.stringify({ type: 'status', id, job });
	for (const ws of set) {
		try {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		} catch (e) {
			// ignore send errors; individual sockets will be cleaned on close
		}
	}
}

wss.on('connection', (ws, req) => {
	ws.on('message', (msg) => {
		try {
			const data = JSON.parse(msg.toString());
			if (data && data.type === 'subscribe' && data.id) {
				let set = subscribers.get(data.id);
				if (!set) { set = new Set(); subscribers.set(data.id, set); }
				set.add(ws);
				ws._subscribedId = data.id;
				// send current job state immediately
				const job = transcodeJobs[data.id] || { status: 'none' };
				ws.send(JSON.stringify({ type: 'status', id: data.id, job }));
			}
			if (data && data.type === 'unsubscribe' && data.id) {
				const set = subscribers.get(data.id);
				if (set) set.delete(ws);
			}
		} catch (e) { /* ignore */ }
	});
	ws.on('close', () => {
		if (ws._subscribedId) {
			const set = subscribers.get(ws._subscribedId);
			if (set) set.delete(ws);
		}
	});
});

server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});

// Post an embed-only payload to a Discord webhook URL so the message shows an embed without the raw link
app.post('/post-webhook', express.json(), async (req, res) => {
	const { webhookUrl, id, label } = req.body || {};
	if (!webhookUrl || !id) return res.status(400).json({ error: 'webhookUrl and id required' });

	const d = readData();
	if (!d[id]) return res.status(404).json({ error: 'id not found' });

	const videoUrl = `${req.protocol}://${req.get('host')}/v/${id}`;
	const title = (label && String(label).trim()) || d[id].originalName || 'Video';

	const payload = { embeds: [{ title, url: videoUrl, description: 'Uploaded via Video Hoster' }] };

	// Try to use global fetch if available (Node 18+). Otherwise fall back to https.request.
	try {
		if (typeof fetch === 'function') {
			const r = await fetch(webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!r.ok) return res.status(502).json({ error: 'Webhook request failed', status: r.status });
			return res.json({ ok: true });
		} else {
			// fallback
			const { URL } = require('url');
			const https = require('https');
			const u = new URL(webhookUrl);
			const opts = {
				hostname: u.hostname,
				path: u.pathname + (u.search || ''),
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
				},
			};

			const req2 = https.request(opts, (r2) => {
				let data = '';
				r2.on('data', (c) => data += c.toString());
				r2.on('end', () => {
					if (r2.statusCode >= 200 && r2.statusCode < 300) return res.json({ ok: true });
					return res.status(502).json({ error: 'Webhook request failed', status: r2.statusCode, body: data });
				});
			});
			req2.on('error', (err) => res.status(500).json({ error: err.message }));
			req2.write(JSON.stringify(payload));
			req2.end();
		}
	} catch (err) {
		return res.status(500).json({ error: err.message });
	}
});

// Endpoint to check transcode status
app.get('/transcode-status/:id', (req, res) => {
	const id = req.params.id;
	const job = transcodeJobs[id];
	if (!job) return res.json({ status: 'none' });
	return res.json(job);
});

// Return stored info and generated URLs for a given id
app.get('/info/:id', (req, res) => {
	const id = req.params.id;
	const d = readData();
	if (!d[id]) return res.status(404).json({ error: 'not found' });
	const protocol = req.protocol;
	const host = req.get('host');
	const videoUrl = `${protocol}://${host}/v/${id}`;
	const shortUrl = `${protocol}://${host}/s/${id}`;
	return res.json({ id, videoUrl, shortUrl, info: d[id] });
});

// Serve a simple placeholder PNG (1x1 transparent or small image). We'll serve a tiny embedded PNG.
app.get('/invalid.png', (req, res) => {
	// Prefer the workspace image at public/Invalid.png (case-sensitive on some systems)
	const candidate = path.join(__dirname, 'public', 'Invalid.png');
	if (fs.existsSync(candidate)) {
		res.setHeader('Content-Type', 'image/png');
		// let caches revalidate quickly
		res.setHeader('Cache-Control', 'public, max-age=60');
		const stream = fs.createReadStream(candidate);
		return stream.pipe(res);
	}

	// Fallback: tiny 1x1 transparent PNG (base64)
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=',
		'base64'
	);
	res.setHeader('Content-Type', 'image/png');
	res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
	res.send(png);
});

function sendInvalidEmbed(req, res) {
	// Return a minimal HTML page with Open Graph tags so Discord will create an embed with the image
	const host = req.get('host');
	const protocol = req.protocol;
	const imgUrl = `${protocol}://${host}/invalid.png`;
	// Provide only the image meta so Discord will preferably show an image-only embed.
	const html = `<!doctype html><html><head>
		<meta property="og:image" content="${imgUrl}" />
		<meta property="og:image:type" content="image/png" />
		<meta name="twitter:card" content="summary_large_image" />
		<link rel="image_src" href="${imgUrl}" />
		</head><body></body></html>`;
	res.setHeader('Content-Type', 'text/html');
	res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
	res.status(200).send(html);
}
