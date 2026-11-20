FROM node:22-bookworm-slim

# ffmpeg + python (for yt-dlp)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg aria2 python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# latest yt-dlp with browser impersonation (curl-cffi) - needed by many sites
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default,curl-cffi]" \
 && ln -s /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
