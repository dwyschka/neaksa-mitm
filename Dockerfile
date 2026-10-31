FROM node:22-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PROXY_PORT=8999 \
    UI_PORT=8998 \
    LOG_DIR=/data \
    MAX_BODY_BYTES=262144

EXPOSE 8999 8998

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UI_PORT||8998)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
