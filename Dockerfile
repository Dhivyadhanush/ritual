FROM node:22-alpine

# Node's Date/local-time logic needs the tz database for Asia/Kolkata.
RUN apk add --no-cache tzdata

WORKDIR /app
ENV NODE_ENV=production PORT=4322 HOST=0.0.0.0 DATA_DIR=/data TZ=Asia/Kolkata

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

VOLUME ["/data"]
EXPOSE 4322

CMD ["node", "server.js"]
