FROM node:22-bookworm-slim

COPY direct-denied.mjs /fixture/direct-denied.mjs
RUN node /fixture/direct-denied.mjs
