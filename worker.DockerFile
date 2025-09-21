FROM manimcommunity/manim:stable

ENV NODE_ENV=production

# Switch to root to install system-level dependencies
USER root

# Install Node.js, espeak-ng, curl, and ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        espeak-ng \
        ffmpeg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Optional: Upgrade pip (no need for moviepy anymore)
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install --no-cache-dir pyttsx3

# Create a non-root user
RUN useradd -ms /bin/bash manim

# Switch to non-root user
USER manim
WORKDIR /home/manim/app

# Copy Node.js package files and install dependencies
COPY --chown=manim:manim package*.json ./
RUN npm install --only=production

# Copy Prisma schema and generate client
COPY --chown=manim:manim prisma ./prisma
RUN npx prisma generate

# Copy compiled app and scripts
COPY --chown=manim:manim dist ./dist
COPY --chown=manim:manim scripts ./scripts

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ps aux | grep "node dist/workers/videoGeneration.worker.js" || exit 1

# Start worker
CMD ["node", "dist/workers/videoGeneration.worker.js"]
