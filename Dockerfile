FROM node:22-alpine

ENV NODE_ENV=production \
    JEV_HTTP_HOST=0.0.0.0 \
    JEV_HTTP_PORT=3456

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY gateway ./gateway

USER node
EXPOSE 3456
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3456/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "gateway/src/http.js"]
