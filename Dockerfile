# injoy — zero-dependency Node server. There is no build step: the image is the
# repo. Nothing is installed because nothing is imported outside node: itself.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=6967 \
    DATA_DIR=/data

WORKDIR /app

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
