# Discord-friendly video host

Simple Node.js app that accepts video uploads and serves them with HTTP Range support so Discord (and browsers) can embed them as playable videos.

Quick start

1. Install dependencies

```pwsh
npm install
```

2. Start server

```pwsh
npm start
```

3. Open http://localhost:3000 and upload a video. Copy the Short URL and paste it into Discord — if your server is reachable from the internet Discord will embed it.

Notes on sharing to Discord

- Discord needs to be able to reach your host. For local testing you can use a tunneling service like ngrok or Cloudflare Tunnel to expose http(s) endpoints.
- Use HTTPS when possible — Discord prefers secure links for embedding.
- Files are stored in `uploads/` and metadata in `data.json`.

Security and production

This project is intentionally minimal. For production consider:
- Adding authentication and rate-limiting
- Virus scanning and file type checks
- Size limits and storage on S3 or similar
- Automatic cleanup/expiration of old uploads
