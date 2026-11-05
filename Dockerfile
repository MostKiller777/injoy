# injoy — zero-dependency Node server. There is no build step: the image is the
# repo. Nothing is installed because nothing is imported outside node: itself.
#
# Chromium is deliberately absent. The resolver drives a headless browser to
# turn a provider page into a direct URL, and on a 512 MB free instance that
# browser is what gets the container killed; the providers also refuse datacenter
# addresses, so the forbidden manifest could not be fetched even when found.
# Without a browser every title answers with an embed at once, which is honest
# and keeps the service up. Run the server on a machine with Chrome (or point
# the resolver at one) to get direct playback there.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6967 \
    DATA_DIR=/data

WORKDIR /app

# ffmpeg is the ingest pipeline's engine: ffprobe validates the upload and
# ffmpeg builds the ladder. It is only needed when a file is ingested, so an
# idle service pays nothing but the image size.
RUN apk add --no-cache ffmpeg

COPY package.json ./
COPY server ./server
COPY public ./public

# The data volume is mounted here at runtime; create it owned by the runtime
# user so the store and the media index can write to it.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 6967

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6967)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
