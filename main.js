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
