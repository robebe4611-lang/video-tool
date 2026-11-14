FROM node:22-bookworm-slim

# ffmpeg + python (for yt-dlp)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# latest yt-dlp (refreshed on every deploy)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
