FROM node:22-alpine

WORKDIR /app

# Copy root build configurations, sources, packages, and prebuilt dist
COPY package*.json tsconfig.json tsdown.config.ts ./
COPY packages/ ./packages/
COPY src/ ./src/
COPY dist/ ./dist/

RUN npm install --ignore-scripts

# Setup profiling app
WORKDIR /app/profiling
COPY profiling/package*.json profiling/tsconfig.json ./
RUN npm install

COPY profiling/src/ ./src/

EXPOSE 3000

CMD ["npm", "start"]


