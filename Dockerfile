FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY cloud ./cloud
USER node
ENV PORT=4100
EXPOSE 4100
CMD ["node", "cloud/http.mjs"]
