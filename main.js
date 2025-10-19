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

app.post('/upload', upload.single('file'), (req, res) => {
	if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

	const id = uuidv4();
	const ext = path.extname(req.file.originalname) || '';
	const newName = id + ext;
	const newPath = path.join(UPLOADS_DIR, newName);

	fs.renameSync(req.file.path, newPath);

	const d = readData();
	d[id] = {
		id,
		filename: newName,
		originalName: req.file.originalname,
		mime: req.file.mimetype || mime.lookup(newName) || 'application/octet-stream',
		size: req.file.size,
		createdAt: Date.now(),
	};
	writeData(d);

	const host = req.get('host');
	const protocol = req.protocol;
	const videoUrl = `${protocol}://${host}/v/${id}`;
	const shortUrl = `${protocol}://${host}/s/${id}`;

	res.json({ id, videoUrl, shortUrl, info: d[id] });
});

// Short redirect link
app.get('/s/:id', (req, res) => {
	const id = req.params.id;
	const d = readData();
	if (!d[id]) return res.status(404).send('Not found');
	res.redirect(`/v/${id}`);
});

// Serve video with Range support so Discord (and browsers) can embed/seek
app.get('/v/:id', (req, res) => {
	const id = req.params.id;
	const d = readData();
	if (!d[id]) return res.status(404).send('Not found');

	const filePath = path.join(UPLOADS_DIR, d[id].filename);
	if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
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
