FROM manimcommunity/manim:stable

ENV NODE_ENV=production

# Switch to root to install system-level dependencies
USER root

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ffmpeg \
        ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install python packages (REMOVED moviepy)
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install --no-cache-dir piper-tts

# --- PRE-DOWNLOAD AND VERIFY PIPER VOICE MODEL ---
# This section is no longer strictly necessary but doesn't hurt to keep
# in case you want to switch back or use TTS for another purpose.
ARG MODELS_DIR=/home/manim/piper_models
RUN mkdir -p ${MODELS_DIR}
RUN curl --fail --location --output ${MODELS_DIR}/en_US-amy-medium.onnx \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"
RUN curl --fail --location --output ${MODORES_DIR}/en_US-amy-medium.onnx.json \
     "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json"
RUN ls -lh ${MODELS_DIR} && echo "Model files downloaded."

# --- USER AND PERMISSIONS SETUP ---
RUN useradd -ms /bin/bash manim
RUN chown -R manim:manim ${MODELS_DIR} && chown -R manim:manim /home/manim
USER manim
WORKDIR /home/manim/app

# --- APPLICATION SETUP ---

# Copy and install Node.js dependencies
COPY --chown=manim:manim package*.json ./
RUN npm install --only=production

# Copy and generate Prisma client
COPY --chown=manim:manim prisma ./prisma
RUN npx prisma generate

# Copy the rest of the application code
COPY --chown=manim:manim dist ./dist
COPY --chown=manim:manim scripts ./scripts

# Healthcheck to monitor the running container
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ps aux | grep "node dist/workers/videoGeneration.worker.js" || exit 1

# Command to run the worker
CMD ["node", "dist/workers/videoGeneration.worker.js"]