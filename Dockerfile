FROM node:22-slim
WORKDIR /app
COPY . .
RUN node build.js
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
